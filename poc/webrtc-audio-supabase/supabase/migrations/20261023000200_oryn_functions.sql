-- POC-02C.1A — funções de domínio (RPC) e auxiliares.
--
-- Regras para TODAS as funções:
-- - SECURITY DEFINER apenas quando precisam ler/escrever o schema privado `oryn`; `set search_path = ''`
--   e nomes totalmente qualificados (evita sequestro de search_path).
-- - EXECUTE revogado de PUBLIC/anon e concedido explicitamente: usuários → `authenticated`;
--   transições de publicação → só `service_role` (Edge Function); emissão de convite de criador → só o
--   dono do banco (administrador, pelo SQL editor).
-- - Erros com códigos curtos e genéricos (não revelam se um convite existiu, expirou ou foi usado).
-- - Remetente/destinatário SEMPRE derivados de auth.uid() e das sessões no banco; nunca do cliente.
-- - Nenhum SDP/candidato é recebido ou gravado aqui: só metadados (tipo, epoch, tamanho).

-- ---------------------------------------------------------------- auxiliares (schema oryn) ----------

-- Token de 256 bits nominais em base64url (43 caracteres). Fonte: dois UUID v4 do gerador do Postgres
-- (gen_random_uuid, CSPRNG) = 244 bits aleatórios; sem depender de extensões.
create function oryn.new_token() returns text
language sql volatile set search_path = '' as $$
  select pg_catalog.translate(
    pg_catalog.encode(
      pg_catalog.decode(
        pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '') ||
        pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''), 'hex'),
      'base64'),
    '+/=', '-_')
$$;

create function oryn.token_hash(p_token text) returns bytea
language sql immutable set search_path = '' as $$
  select pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8'))
$$;

create function oryn.is_token(p_token text) returns boolean
language sql immutable set search_path = '' as $$
  select p_token is not null and p_token ~ '^[A-Za-z0-9_-]{43}$'
$$;

create function oryn.valid_label(p_text text, p_max integer) returns boolean
language sql immutable set search_path = '' as $$
  select p_text is not null and pg_catalog.char_length(p_text) between 1 and p_max and p_text !~ '[[:cntrl:]]'
$$;

create function oryn.require_uid() returns uuid
language plpgsql stable set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  return v_uid;
end $$;

-- Sessão "viva": não revogada e com batimento nos últimos 90 s.
create function oryn.session_is_fresh(p_last_seen timestamptz) returns boolean
language sql stable set search_path = '' as $$
  select p_last_seen > pg_catalog.now() - interval '90 seconds'
$$;

-- Membro ativo de sala aberta?
create function oryn.is_active_member(p_room uuid, p_uid uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (
    select 1 from oryn.room_members m join oryn.rooms r on r.id = m.room_id
    where m.room_id = p_room and m.user_id = p_uid and m.removed_at is null and r.closed_at is null)
$$;

-- Publica um evento de CONTROLE (sem dados de rede) no tópico privado de cada sessão ativa da sala.
-- Conteúdo: tipo, UUID da sessão e rótulo curto. ATENÇÃO: realtime.send persiste a mensagem por 72 h a
-- 4 dias (documentação oficial); por isso NUNCA é usado para SDP/candidatos.
create function oryn.publish_control(p_room uuid, p_except uuid, p_event text, p_payload jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare v_sid uuid;
begin
  for v_sid in
    select s.id from oryn.room_sessions s
    where s.room_id = p_room and s.revoked_at is null and s.id is distinct from p_except
      and oryn.session_is_fresh(s.last_seen_at)
  loop
    perform realtime.send(p_payload, p_event, 'oryn:s:' || v_sid::text, true);
  end loop;
end $$;

-- Usada pela política RLS de realtime.messages (avaliada como o usuário conectado): o tópico privado
-- oryn:s:{sessão} só pode ser assinado pelo dono de uma sessão ativa, de membro ativo, em sala aberta.
-- Fica num schema PRÓPRIO e mínimo (oryn_realtime): `authenticated` recebe USAGE só nele, nunca no schema
-- privado `oryn`. Também NÃO deve ser exposto na Data API.
create schema if not exists oryn_realtime;
revoke all on schema oryn_realtime from public;

create function oryn_realtime.can_receive_topic(p_topic text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_sid uuid;
begin
  if v_uid is null or p_topic is null or p_topic !~ '^oryn:s:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  v_sid := pg_catalog.substr(p_topic, 8)::uuid;
  return exists (
    select 1 from oryn.room_sessions s
    where s.id = v_sid and s.user_id = v_uid and s.revoked_at is null
      and oryn.session_is_fresh(s.last_seen_at) and oryn.is_active_member(s.room_id, v_uid));
end $$;

-- ADMINISTRADOR (SQL editor, papel dono do banco): emite convite de criador de salas. Sem EXECUTE para
-- anon/authenticated/service_role. Devolve o token UMA vez; só o hash é guardado.
create function oryn.admin_issue_creator_invite(p_ttl_minutes integer default 60, p_max_open_rooms integer default 2) returns text
language plpgsql volatile set search_path = '' as $$
declare v_token text := oryn.new_token();
begin
  if p_ttl_minutes is null or p_ttl_minutes not between 5 and 1440 then
    raise exception 'invalid-argument' using errcode = 'P0001';
  end if;
  insert into oryn.creator_invites (token_hash, max_open_rooms, expires_at)
  values (oryn.token_hash(v_token), p_max_open_rooms, pg_catalog.now() + pg_catalog.make_interval(mins => p_ttl_minutes));
  return v_token;
end $$;

-- ---------------------------------------------------------------- RPCs de usuário (schema public) -----

-- Resgata convite de criador (uso único, atômico) e concede o direito de criar salas.
create function public.redeem_creator_invite(p_token text) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid(); v_max integer;
begin
  if not oryn.is_token(p_token) then
    raise exception 'invite-invalid' using errcode = 'P0001';
  end if;
  update oryn.creator_invites
     set used_at = pg_catalog.now(), used_by = v_uid
   where token_hash = oryn.token_hash(p_token)
     and used_at is null and revoked_at is null and expires_at > pg_catalog.now()
  returning max_open_rooms into v_max;
  if not found then
    raise exception 'invite-invalid' using errcode = 'P0001';
  end if;
  insert into oryn.creator_grants (user_id, max_open_rooms) values (v_uid, v_max)
  on conflict (user_id) do update set max_open_rooms = greatest(oryn.creator_grants.max_open_rooms, excluded.max_open_rooms);
  return v_max;
end $$;

-- Cria sala: só quem tem concessão de criador, até o limite de salas abertas.
create function public.create_room(p_name text, p_display_name text, p_max_members integer default 3) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid(); v_limit integer; v_open integer; v_room uuid;
begin
  -- Trava a concessão: criações simultâneas do mesmo usuário são serializadas (limite exato).
  select max_open_rooms into v_limit from oryn.creator_grants where user_id = v_uid for update;
  if not found then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if not oryn.valid_label(p_name, 40) or not oryn.valid_label(p_display_name, 32)
     or p_max_members is null or p_max_members not between 2 and 10 then
    raise exception 'invalid-argument' using errcode = 'P0001';
  end if;
  select pg_catalog.count(*) into v_open from oryn.rooms where owner_id = v_uid and closed_at is null;
  if v_open >= v_limit then
    raise exception 'limit-reached' using errcode = 'P0001';
  end if;
  insert into oryn.rooms (owner_id, name, max_members) values (v_uid, p_name, p_max_members) returning id into v_room;
  insert into oryn.room_members (room_id, user_id, role, display_name) values (v_room, v_uid, 'owner', p_display_name);
  return v_room;
end $$;

-- Emite convite de sala (só o dono, sala aberta, com vaga; no máximo 3 convites pendentes).
create function public.create_room_invite(p_room_id uuid, p_ttl_minutes integer default 10)
returns table (token text, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid(); v_max integer; v_active integer; v_pending integer; v_token text; v_exp timestamptz;
begin
  select r.max_members into v_max from oryn.rooms r
   where r.id = p_room_id and r.owner_id = v_uid and r.closed_at is null for no key update;
  if not found or not oryn.is_active_member(p_room_id, v_uid) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_ttl_minutes is null or p_ttl_minutes not between 1 and 60 then
    raise exception 'invalid-argument' using errcode = 'P0001';
  end if;
  select pg_catalog.count(*) into v_active from oryn.room_members where room_id = p_room_id and removed_at is null;
  if v_active >= v_max then
    raise exception 'room-full' using errcode = 'P0001';
  end if;
  select pg_catalog.count(*) into v_pending from oryn.room_invites i
   where i.room_id = p_room_id and i.used_at is null and i.revoked_at is null and i.expires_at > pg_catalog.now();
  if v_pending >= 3 then
    raise exception 'limit-reached' using errcode = 'P0001';
  end if;
  v_token := oryn.new_token();
  v_exp := pg_catalog.now() + pg_catalog.make_interval(mins => p_ttl_minutes);
  insert into oryn.room_invites (room_id, token_hash, created_by, expires_at) values (p_room_id, oryn.token_hash(v_token), v_uid, v_exp);
  token := v_token;
  expires_at := v_exp;
  return next;
end $$;

-- Revoga um convite pendente (só o dono da sala).
create function public.revoke_room_invite(p_room_id uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid(); v_count integer;
begin
  if not exists (select 1 from oryn.rooms where id = p_room_id and owner_id = v_uid) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  -- Só convites ainda utilizáveis (pendentes e não expirados): o total devolvido é o que foi cancelado.
  update oryn.room_invites set revoked_at = pg_catalog.now()
   where room_id = p_room_id and used_at is null and revoked_at is null and expires_at > pg_catalog.now();
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Resgata convite de sala: consumo ATÔMICO (linha travada), uso único, expiração, capacidade.
-- Já membro ativo → erro sem consumir o convite.
create function public.redeem_room_invite(p_token text, p_display_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid(); v_invite uuid; v_room uuid; v_max integer; v_active integer;
begin
  if not oryn.is_token(p_token) then
    raise exception 'invite-invalid' using errcode = 'P0001';
  end if;
  if not oryn.valid_label(p_display_name, 32) then
    raise exception 'invalid-argument' using errcode = 'P0001';
  end if;
  select i.id, i.room_id into v_invite, v_room from oryn.room_invites i
   where i.token_hash = oryn.token_hash(p_token)
     and i.used_at is null and i.revoked_at is null and i.expires_at > pg_catalog.now()
   for update;
  if not found then
    raise exception 'invite-invalid' using errcode = 'P0001';
  end if;
  select r.max_members into v_max from oryn.rooms r where r.id = v_room and r.closed_at is null for no key update;
  if not found then
    raise exception 'invite-invalid' using errcode = 'P0001';
  end if;
  if oryn.is_active_member(v_room, v_uid) then
    raise exception 'already-member' using errcode = 'P0001';
  end if;
  select pg_catalog.count(*) into v_active from oryn.room_members where room_id = v_room and removed_at is null;
  if v_active >= v_max then
    raise exception 'room-full' using errcode = 'P0001';
  end if;
  update oryn.room_invites set used_at = pg_catalog.now(), used_by = v_uid where id = v_invite;
  insert into oryn.room_members (room_id, user_id, role, display_name) values (v_room, v_uid, 'member', p_display_name)
  on conflict (room_id, user_id) do update set removed_at = null, display_name = excluded.display_name, joined_at = pg_catalog.now();
  return v_room;
end $$;

-- Abre uma sessão (conexão) na sala; no máximo 2 sessões vivas por usuário por sala. Avisa as demais.
create function public.join_room(p_room_id uuid) returns table (session_id uuid, topic text)
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid(); v_live integer; v_sid uuid; v_label text;
begin
  -- 02C.2B (M5): trava a linha de membro (sala, usuário) ANTES de contar. Entradas simultâneas do MESMO
  -- usuário nesta sala ficam em fila; outros usuários e outras salas não esperam. FOR NO KEY UPDATE não
  -- conflita com as travas KEY SHARE das chaves estrangeiras. A pertença é conferida de novo depois da
  -- espera (pode ter sido removida enquanto aguardava).
  perform 1 from oryn.room_members m
   where m.room_id = p_room_id and m.user_id = v_uid and m.removed_at is null
   for no key update;
  if not found or not oryn.is_active_member(p_room_id, v_uid) then
    raise exception 'not-member' using errcode = '42501';
  end if;
  -- Expira (revoga) só as PRÓPRIAS sessões sem batimento desta sala: nenhuma linha de outro usuário é
  -- travada aqui (evita esperas e impasses entre entradas de usuários diferentes). Sessões alheias
  -- vencidas já são ignoradas por roster, publicação, assinatura e sinalização (filtro de batimento).
  update oryn.room_sessions set revoked_at = pg_catalog.now(), revoke_reason = 'expired'
   where room_id = p_room_id and user_id = v_uid and revoked_at is null and not oryn.session_is_fresh(last_seen_at);
  select pg_catalog.count(*) into v_live from oryn.room_sessions
   where room_id = p_room_id and user_id = v_uid and revoked_at is null;
  if v_live >= 2 then
    raise exception 'limit-reached' using errcode = 'P0001';
  end if;
  insert into oryn.room_sessions (room_id, user_id) values (p_room_id, v_uid) returning id into v_sid;
  select m.display_name into v_label from oryn.room_members m where m.room_id = p_room_id and m.user_id = v_uid;
  perform oryn.publish_control(p_room_id, v_sid, 'hello', pg_catalog.jsonb_build_object('session_id', v_sid, 'label', v_label));
  session_id := v_sid;
  topic := 'oryn:s:' || v_sid::text;
  return next;
end $$;

-- Batimento da própria sessão. Sessão revogada/expirada → erro (o cliente precisa entrar de novo).
create function public.touch_session(p_session_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid(); v_last timestamptz; v_room uuid;
begin
  select s.last_seen_at, s.room_id into v_last, v_room from oryn.room_sessions s
   where s.id = p_session_id and s.user_id = v_uid and s.revoked_at is null for no key update;
  if not found or not oryn.is_active_member(v_room, v_uid) then
    raise exception 'session-invalid' using errcode = '42501';
  end if;
  -- 02C.3D.1 (F1): sem gravar a revogação aqui. O erro desfaz tudo o que a chamada escreveu, então ela
  -- nunca persistia. A sessão sem batimento já é recusada em todo caminho (filtro de batimento) e não volta
  -- a valer: só esta função e authorize_signal renovam last_seen_at, ambas depois de conferir o batimento.
  -- A revogação 'expired' que persiste é a do join_room, nas sessões do próprio usuário.
  if not oryn.session_is_fresh(v_last) then
    raise exception 'session-invalid' using errcode = '42501';
  end if;
  update oryn.room_sessions set last_seen_at = pg_catalog.now() where id = p_session_id;
end $$;

-- Sai da sala (encerra a própria sessão). Idempotente; avisa as demais sessões.
create function public.leave_room(p_session_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid(); v_room uuid; v_revoked timestamptz;
begin
  select s.room_id, s.revoked_at into v_room, v_revoked from oryn.room_sessions s
   where s.id = p_session_id and s.user_id = v_uid for no key update;
  if not found then
    raise exception 'session-invalid' using errcode = '42501';
  end if;
  if v_revoked is not null then
    return;
  end if;
  update oryn.room_sessions set revoked_at = pg_catalog.now(), revoke_reason = 'left' where id = p_session_id;
  perform oryn.publish_control(v_room, p_session_id, 'bye', pg_catalog.jsonb_build_object('session_id', p_session_id));
end $$;

-- Participantes vivos da sala (só para membro ativo). Sem dados de rede.
create function public.get_roster(p_room_id uuid)
returns table (session_id uuid, display_name text, is_self boolean, joined_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid();
begin
  if not oryn.is_active_member(p_room_id, v_uid) then
    raise exception 'not-member' using errcode = '42501';
  end if;
  return query
    select s.id, m.display_name, s.user_id = v_uid, s.created_at
      from oryn.room_sessions s
      join oryn.room_members m on m.room_id = s.room_id and m.user_id = s.user_id and m.removed_at is null
     where s.room_id = p_room_id and s.revoked_at is null and oryn.session_is_fresh(s.last_seen_at)
     order by s.created_at;
end $$;

-- ---------------------------------------------------------------- sinalização (Edge Function `signal`) -

-- Autoriza e REGISTRA (sem payload) uma mensagem de sinalização. Chamada pela Edge Function COM O JWT
-- DO USUÁRIO. Remetente = sessão do próprio usuário; destinatário = sessão viva da MESMA sala.
-- Idempotente por (sessão, client_msg_id): repetição devolve o mesmo msg_id/seq e o estado atual.
create function public.authorize_signal(
  p_session_id uuid, p_to_session_id uuid, p_client_msg_id uuid, p_kind text, p_pair_epoch integer, p_payload_bytes integer)
returns table (msg_id uuid, seq bigint, from_user uuid, room_id uuid, state text, duplicate boolean, accepted_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := oryn.require_uid();
  v_room uuid; v_last timestamptz; v_to_room uuid; v_to_last timestamptz; v_recent integer; v_seq bigint;
  v_existing oryn.signal_log%rowtype;
begin
  if p_session_id is null or p_to_session_id is null or p_client_msg_id is null or p_session_id = p_to_session_id
     or p_kind is null or p_kind not in ('offer', 'answer', 'candidate', 'end-of-candidates', 'restart-request')
     or p_pair_epoch is null or p_pair_epoch < 0
     or p_payload_bytes is null or p_payload_bytes not between 1 and 16384 then
    raise exception 'invalid-argument' using errcode = 'P0001';
  end if;
  -- Remetente: sessão DO CHAMADOR, viva, de membro ativo.
  -- 02C.2B: a linha da sessão remetente fica TRAVADA até o fim da chamada. Chamadas simultâneas da MESMA
  -- sessão são serializadas: a idempotência por client_msg_id e o limite de taxa ficam exatos, e uma
  -- repetição concorrente devolve "duplicate" em vez do erro bruto de chave única. Outras sessões não
  -- esperam. FOR NO KEY UPDATE (e não FOR UPDATE): não conflita com o KEY SHARE que as chaves estrangeiras
  -- de signal_log/pair_counters tomam na sessão do DESTINO. Com FOR UPDATE, A→B e B→A simultâneos se
  -- travariam mutuamente (impasse).
  select s.room_id, s.last_seen_at into v_room, v_last from oryn.room_sessions s
   where s.id = p_session_id and s.user_id = v_uid and s.revoked_at is null
   for no key update;
  if not found or not oryn.session_is_fresh(v_last) or not oryn.is_active_member(v_room, v_uid) then
    raise exception 'session-invalid' using errcode = '42501';
  end if;
  -- Destinatário: sessão viva da MESMA sala, de membro ativo.
  select s.room_id, s.last_seen_at into v_to_room, v_to_last from oryn.room_sessions s
   where s.id = p_to_session_id and s.revoked_at is null
     and exists (select 1 from oryn.room_members m where m.room_id = s.room_id and m.user_id = s.user_id and m.removed_at is null);
  if not found or v_to_room <> v_room or not oryn.session_is_fresh(v_to_last) then
    raise exception 'recipient-invalid' using errcode = '42501';
  end if;
  -- Idempotência.
  select * into v_existing from oryn.signal_log l where l.session_id = p_session_id and l.client_msg_id = p_client_msg_id;
  if found then
    if v_existing.to_session_id <> p_to_session_id or v_existing.kind <> p_kind
       or v_existing.pair_epoch <> p_pair_epoch or v_existing.payload_bytes <> p_payload_bytes then
      raise exception 'idempotency-conflict' using errcode = 'P0001';
    end if;
    msg_id := v_existing.msg_id; seq := v_existing.seq; from_user := v_uid; room_id := v_room;
    state := v_existing.state; duplicate := true; accepted_at := v_existing.created_at;
    return next;
    return;
  end if;
  -- Limite de taxa: 40 mensagens por sessão em 10 s.
  select pg_catalog.count(*) into v_recent from oryn.signal_log l
   where l.session_id = p_session_id and l.created_at > pg_catalog.now() - interval '10 seconds';
  if v_recent >= 40 then
    raise exception 'rate-limited' using errcode = 'P0001';
  end if;
  insert into oryn.pair_counters (from_session, to_session, last_seq) values (p_session_id, p_to_session_id, 1)
  on conflict (from_session, to_session) do update set last_seq = oryn.pair_counters.last_seq + 1
  returning last_seq into v_seq;
  insert into oryn.signal_log (session_id, to_session_id, client_msg_id, kind, pair_epoch, seq, payload_bytes)
  values (p_session_id, p_to_session_id, p_client_msg_id, p_kind, p_pair_epoch, v_seq, p_payload_bytes)
  returning signal_log.msg_id, signal_log.created_at into msg_id, accepted_at;
  update oryn.room_sessions set last_seen_at = pg_catalog.now() where id = p_session_id;
  seq := v_seq; from_user := v_uid; room_id := v_room; state := 'accepted'; duplicate := false;
  return next;
end $$;

-- Transições de publicação (SÓ service_role, isto é, a Edge Function):
--   accepted → publishing → published | failed;  failed|publishing → publishing (retentativa, até 5).
-- Repetir o estado atual é idempotente. "acknowledged" é definido só pelo destinatário (ack_signals).
create function public.set_signal_state(p_msg_id uuid, p_state text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_cur text; v_attempts integer;
begin
  select l.state, l.attempts into v_cur, v_attempts from oryn.signal_log l where l.msg_id = p_msg_id for update;
  if not found then
    raise exception 'not-found' using errcode = 'P0001';
  end if;
  if p_state = v_cur and p_state <> 'publishing' then
    return v_cur;
  end if;
  -- publishing → publishing = retentativa após uma execução interrompida no meio da publicação
  -- (pode gerar publicação duplicada; o destinatário descarta por msg_id).
  if not (
       (v_cur = 'accepted' and p_state = 'publishing')
    or (v_cur = 'failed' and p_state = 'publishing')
    or (v_cur = 'publishing' and p_state in ('publishing', 'published', 'failed'))) then
    raise exception 'invalid-transition' using errcode = 'P0001';
  end if;
  if p_state = 'publishing' then
    if v_attempts >= 5 then
      raise exception 'retry-limit' using errcode = 'P0001';
    end if;
    v_attempts := v_attempts + 1;
  end if;
  update oryn.signal_log set state = p_state, attempts = v_attempts, updated_at = pg_catalog.now() where msg_id = p_msg_id;
  return p_state;
end $$;

-- Confirmação de recebimento pelo DESTINATÁRIO (sua própria sessão viva). Só published → acknowledged.
create function public.ack_signals(p_session_id uuid, p_msg_ids uuid[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid(); v_count integer;
begin
  if p_msg_ids is null or pg_catalog.cardinality(p_msg_ids) not between 1 and 64 then
    raise exception 'invalid-argument' using errcode = 'P0001';
  end if;
  if not exists (select 1 from oryn.room_sessions s where s.id = p_session_id and s.user_id = v_uid and s.revoked_at is null) then
    raise exception 'session-invalid' using errcode = '42501';
  end if;
  update oryn.signal_log set state = 'acknowledged', updated_at = pg_catalog.now()
   where msg_id = any (p_msg_ids) and to_session_id = p_session_id and state = 'published';
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ---------------------------------------------------------------- permissões explícitas ---------------

revoke all on all functions in schema oryn from public, anon, authenticated, service_role;
revoke all on function
  public.redeem_creator_invite(text), public.create_room(text, text, integer), public.create_room_invite(uuid, integer),
  public.revoke_room_invite(uuid), public.redeem_room_invite(text, text), public.join_room(uuid),
  public.touch_session(uuid), public.leave_room(uuid), public.get_roster(uuid),
  public.authorize_signal(uuid, uuid, uuid, text, integer, integer), public.set_signal_state(uuid, text),
  public.ack_signals(uuid, uuid[])
from public, anon, authenticated, service_role;

grant execute on function
  public.redeem_creator_invite(text), public.create_room(text, text, integer), public.create_room_invite(uuid, integer),
  public.revoke_room_invite(uuid), public.redeem_room_invite(text, text), public.join_room(uuid),
  public.touch_session(uuid), public.leave_room(uuid), public.get_roster(uuid),
  public.authorize_signal(uuid, uuid, uuid, text, integer, integer), public.ack_signals(uuid, uuid[])
to authenticated;
grant execute on function public.set_signal_state(uuid, text) to service_role;

-- A política de realtime.messages é avaliada como o usuário: ele precisa só de USAGE no schema mínimo
-- oryn_realtime e EXECUTE no predicado. Nenhum papel de cliente tem USAGE no schema `oryn`.
revoke all on function oryn_realtime.can_receive_topic(text) from public, anon, authenticated, service_role;
grant usage on schema oryn_realtime to authenticated;
grant execute on function oryn_realtime.can_receive_topic(text) to authenticated;
