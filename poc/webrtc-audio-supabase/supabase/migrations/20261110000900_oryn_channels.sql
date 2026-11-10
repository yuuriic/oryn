-- Canais persistentes de texto e voz dentro de cada sala (I-1). Cada linha de oryn.rooms é um espaço;
-- oryn.room_members segue sendo a lista de membros; oryn.channels guarda os canais do espaço.
--
-- Aditiva quanto aos dados: nenhuma linha é apagada ou renumerada. Cria 1 tabela, 2 colunas (preenchidas e depois
-- NOT NULL), 3 gatilhos, 8 funções privadas e 7 RPCs; redefine 7 RPCs mantendo assinatura, retorno e códigos de erro.
-- Convites, membros, soundboard, criador, Storage e Realtime (tópicos por sessão) não mudam.
--
-- Compatibilidade com o cliente publicado: toda sala tem exatamente um canal padrão de texto e um de voz. As RPCs
-- antigas (send_room_message, list_room_messages, join_room, get_roster, get_voice_participants) passam a usar esses
-- canais. Gatilhos BEFORE INSERT preenchem o canal padrão quando channel_id vem nulo: inserções que não conhecem
-- canais (inclusive corpos anteriores restaurados por uma recuperação) continuam válidas.
--
-- Isolamento: UNIQUE (room_id, id) em oryn.channels e chaves estrangeiras compostas (room_id, channel_id) impedem, no
-- próprio banco, mensagem ou sessão ligada a canal de outro espaço. O tipo do canal é conferido no gatilho.
--
-- Voz: hello/bye e sinalização ficam restritos ao canal. Um usuário não mantém sessões vivas em dois canais de voz do
-- mesmo espaço (in-other-channel); entre espaços diferentes nada muda. O limite de 2 sessões por usuário por sala e a
-- capacidade de membros (até 4) não mudam.
--
-- Travas: join_room/join_voice_channel travam a linha de membro e depois o canal (FOR SHARE); archive_channel trava a
-- sala e depois o canal (UPDATE). Entrada e arquivamento se serializam pelo canal: ninguém entra num canal que acabou
-- de ser arquivado, e o arquivamento revoga quem entrou antes. Envio e arquivamento se serializam pela sala.
begin;

-- ---------------------------------------------------------------- tabela de canais --------------------

create table oryn.channels (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  room_id uuid not null references oryn.rooms (id) on delete cascade,
  kind text not null check (kind in ('text', 'voice')),
  name text not null check (pg_catalog.char_length(name) between 1 and 40 and name !~ '[[:cntrl:]]'),
  position integer not null default 0 check (position between 0 and 1000),
  is_default boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  archived_at timestamptz,
  unique (room_id, id),
  check (not (is_default and archived_at is not null))
);
-- Exatamente um padrão por tipo em cada sala; nomes únicos entre os canais ativos do mesmo tipo.
create unique index channels_one_default_idx on oryn.channels (room_id, kind) where is_default;
create unique index channels_active_name_idx on oryn.channels (room_id, kind, pg_catalog.lower(name)) where archived_at is null;
create index channels_room_order_idx on oryn.channels (room_id, position, created_at);

alter table oryn.channels enable row level security;
revoke all on table oryn.channels from public, anon, authenticated, service_role;

-- Canais padrão das salas existentes (abertas e encerradas), com a data da sala.
insert into oryn.channels (room_id, kind, name, position, is_default, created_by, created_at)
select r.id, k.kind, k.name, 0, true, r.owner_id, r.created_at
  from oryn.rooms r cross join (values ('text', 'conversa'), ('voice', 'voz')) as k (kind, name);

-- ---------------------------------------------------------------- auxiliares (schema oryn) ----------

-- Canal padrão de um tipo; null se a sala não existe.
create function oryn.default_channel(p_room uuid, p_kind text) returns uuid
language sql stable set search_path = '' as $$
  select c.id from oryn.channels c where c.room_id = p_room and c.kind = p_kind and c.is_default
$$;

-- Toda sala nova nasce com os dois canais padrão: create_room não muda.
create function oryn.create_default_channels() returns trigger
language plpgsql set search_path = '' as $$
begin
  insert into oryn.channels (room_id, kind, name, position, is_default, created_by, created_at)
  values (new.id, 'text', 'conversa', 0, true, new.owner_id, new.created_at),
         (new.id, 'voice', 'voz', 0, true, new.owner_id, new.created_at);
  return null;
end $$;

-- Mensagem sem canal vai para o texto padrão; com canal, ele precisa ser de texto (a chave composta confere o espaço).
create function oryn.fill_message_channel() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.channel_id is null then
    new.channel_id := oryn.default_channel(new.room_id, 'text');
  elsif not exists (select 1 from oryn.channels c where c.id = new.channel_id and c.room_id = new.room_id and c.kind = 'text') then
    raise exception 'invalid-argument' using errcode = 'P0001';
  end if;
  return new;
end $$;

-- Sessão sem canal vai para a voz padrão; com canal, ele precisa ser de voz.
create function oryn.fill_session_channel() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.channel_id is null then
    new.channel_id := oryn.default_channel(new.room_id, 'voice');
  elsif not exists (select 1 from oryn.channels c where c.id = new.channel_id and c.room_id = new.room_id and c.kind = 'voice') then
    raise exception 'invalid-argument' using errcode = 'P0001';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- mensagens e sessões por canal -------

alter table oryn.room_messages add column channel_id uuid;
update oryn.room_messages m set channel_id = c.id
  from oryn.channels c where c.room_id = m.room_id and c.kind = 'text' and c.is_default;
alter table oryn.room_messages alter column channel_id set not null;
alter table oryn.room_messages add constraint room_messages_channel_fk
  foreign key (room_id, channel_id) references oryn.channels (room_id, id) on delete cascade;
create index room_messages_channel_idx on oryn.room_messages (channel_id, seq);

alter table oryn.room_sessions add column channel_id uuid;
update oryn.room_sessions s set channel_id = c.id
  from oryn.channels c where c.room_id = s.room_id and c.kind = 'voice' and c.is_default;
alter table oryn.room_sessions alter column channel_id set not null;
alter table oryn.room_sessions add constraint room_sessions_channel_fk
  foreign key (room_id, channel_id) references oryn.channels (room_id, id) on delete cascade;
create index room_sessions_live_channel_idx on oryn.room_sessions (channel_id) where revoked_at is null;
-- Novo motivo de revogação: canal de voz arquivado. Os quatro motivos existentes continuam válidos.
alter table oryn.room_sessions drop constraint room_sessions_revoke_reason_check;
alter table oryn.room_sessions add constraint room_sessions_revoke_reason_check
  check (revoke_reason in ('left', 'expired', 'removed', 'room-closed', 'channel-archived'));

create trigger oryn_room_default_channels after insert on oryn.rooms
  for each row execute function oryn.create_default_channels();
create trigger oryn_message_channel before insert on oryn.room_messages
  for each row execute function oryn.fill_message_channel();
create trigger oryn_session_channel before insert on oryn.room_sessions
  for each row execute function oryn.fill_session_channel();

-- hello/bye só para as sessões vivas do mesmo canal.
create function oryn.publish_channel_control(p_channel uuid, p_except uuid, p_event text, p_payload jsonb) returns void
language plpgsql set search_path = '' as $$
declare v_sid uuid;
begin
  for v_sid in
    select s.id from oryn.room_sessions s
     where s.channel_id = p_channel and s.revoked_at is null and s.id is distinct from p_except
       and oryn.session_is_fresh(s.last_seen_at)
  loop
    perform realtime.send(p_payload, p_event, 'oryn:s:' || v_sid::text, true);
  end loop;
end $$;

-- Núcleo de entrar na voz (join_room e join_voice_channel), com o chamador já derivado do JWT.
create function oryn.open_voice_session(p_room uuid, p_channel uuid, p_uid uuid) returns table (session_id uuid, topic text)
language plpgsql set search_path = '' as $$
declare v_kind text; v_archived timestamptz; v_live integer; v_sid uuid; v_label text;
begin
  -- 02C.2B (M5): trava a linha de membro (sala, usuário) ANTES de contar e conferir. Entradas simultâneas do MESMO
  -- usuário no mesmo espaço ficam em fila (vale também entre canais diferentes); a pertença é conferida de novo.
  perform 1 from oryn.room_members m
   where m.room_id = p_room and m.user_id = p_uid and m.removed_at is null
   for no key update;
  if not found or not oryn.is_active_member(p_room, p_uid) then
    raise exception 'not-member' using errcode = '42501';
  end if;
  -- Trava compartilhada do canal: espera um arquivamento em curso e relê o estado depois dele.
  select c.kind, c.archived_at into v_kind, v_archived from oryn.channels c
   where c.id = p_channel and c.room_id = p_room for share;
  if not found or v_kind <> 'voice' then
    raise exception 'invalid-argument' using errcode = 'P0001';
  end if;
  if v_archived is not null then
    raise exception 'channel-archived' using errcode = 'P0001';
  end if;
  -- Expira só as PRÓPRIAS sessões sem batimento deste espaço (como antes; nenhuma linha alheia é travada).
  update oryn.room_sessions set revoked_at = pg_catalog.now(), revoke_reason = 'expired'
   where room_id = p_room and user_id = p_uid and revoked_at is null and not oryn.session_is_fresh(last_seen_at);
  -- Uma voz por usuário em cada espaço: sessões vivas noutro canal impedem a entrada (sair antes).
  if exists (select 1 from oryn.room_sessions s
              where s.room_id = p_room and s.user_id = p_uid and s.revoked_at is null and s.channel_id <> p_channel) then
    raise exception 'in-other-channel' using errcode = 'P0001';
  end if;
  select pg_catalog.count(*) into v_live from oryn.room_sessions
   where room_id = p_room and user_id = p_uid and revoked_at is null;
  if v_live >= 2 then
    raise exception 'limit-reached' using errcode = 'P0001';
  end if;
  insert into oryn.room_sessions (room_id, user_id, channel_id) values (p_room, p_uid, p_channel) returning id into v_sid;
  select oryn.account_display_name(m.user_id, m.display_name) into v_label from oryn.room_members m where m.room_id = p_room and m.user_id = p_uid;
  perform oryn.publish_channel_control(p_channel, v_sid, 'hello', pg_catalog.jsonb_build_object('session_id', v_sid, 'label', v_label));
  session_id := v_sid;
  topic := 'oryn:s:' || v_sid::text;
  return next;
end $$;

-- Núcleo do envio (send_room_message e send_channel_message). A sala é travada como antes: seq, idempotência, limite
-- de taxa, sala encerrada e canal arquivado ficam exatos sob concorrência. O seq continua sendo a ordem total do
-- espaço (nunca reutilizado); cada canal vê uma subsequência crescente dele.
create function oryn.post_message(p_room uuid, p_channel uuid, p_uid uuid, p_client_nonce uuid, p_body text)
returns table (seq bigint, display_name text, is_mine boolean, client_nonce uuid, body text, created_at timestamptz)
language plpgsql set search_path = '' as $$
declare
  v_name text;
  v_closed timestamptz;
  v_archived timestamptz;
  v_seq bigint;
  v_body text;
  v_at timestamptz;
  v_chan uuid;
  v_recent integer;
begin
  if p_client_nonce is null or p_body is null
     or pg_catalog.char_length(p_body) not between 1 and 4000
     or pg_catalog.btrim(p_body, E' \n\t') = ''
     or p_body ~ E'[\\x01-\\x08\\x0B-\\x1F\\x7F]' then
    raise exception 'invalid-argument' using errcode = 'P0001';
  end if;

  select r.closed_at into v_closed from oryn.rooms r where r.id = p_room for no key update;
  select oryn.account_display_name(m.user_id, m.display_name) into v_name from oryn.room_members m
   where m.room_id = p_room and m.user_id = p_uid and m.removed_at is null;
  if not found then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  select c.archived_at into v_archived from oryn.channels c where c.id = p_channel and c.room_id = p_room and c.kind = 'text';
  if not found then
    raise exception 'invalid-argument' using errcode = 'P0001';
  end if;

  -- Repetição (resposta perdida): devolve a original, mesmo com sala encerrada ou canal arquivado. O mesmo
  -- identificador com outro texto ou noutro canal é recusado.
  select m.seq, m.body, m.created_at, m.channel_id into v_seq, v_body, v_at, v_chan from oryn.room_messages m
   where m.room_id = p_room and m.author_id = p_uid and m.client_nonce = p_client_nonce;
  if found then
    if v_body <> p_body or v_chan <> p_channel then
      raise exception 'invalid-argument' using errcode = 'P0001';
    end if;
  else
    if v_closed is not null then
      raise exception 'room-closed' using errcode = 'P0001';
    end if;
    if v_archived is not null then
      raise exception 'channel-archived' using errcode = 'P0001';
    end if;
    select pg_catalog.count(*) into v_recent from oryn.room_messages m
     where m.room_id = p_room and m.author_id = p_uid and m.created_at > pg_catalog.clock_timestamp() - interval '60 seconds';
    if v_recent >= 30 then
      raise exception 'rate-limited' using errcode = 'P0001';
    end if;
    insert into oryn.room_message_counters as c (room_id, last_seq) values (p_room, 1)
    on conflict (room_id) do update set last_seq = c.last_seq + 1
    returning c.last_seq into v_seq;
    v_body := p_body;
    v_at := pg_catalog.clock_timestamp();
    insert into oryn.room_messages (room_id, seq, author_id, client_nonce, body, created_at, channel_id)
    values (p_room, v_seq, p_uid, p_client_nonce, v_body, v_at, p_channel);
  end if;

  seq := v_seq;
  display_name := v_name;
  is_mine := true;
  client_nonce := p_client_nonce;
  body := v_body;
  created_at := v_at;
  return next;
end $$;

-- Núcleo da leitura paginada de um canal de texto (pertença já conferida pela RPC).
create function oryn.channel_messages(p_room uuid, p_channel uuid, p_uid uuid, p_before_seq bigint, p_after_seq bigint, p_limit integer)
returns table (seq bigint, display_name text, is_mine boolean, client_nonce uuid, body text, created_at timestamptz)
language plpgsql stable set search_path = '' as $$
begin
  if p_limit is null or p_limit not between 1 and 100 or (p_before_seq is not null and p_after_seq is not null) then
    raise exception 'invalid-argument' using errcode = 'P0001';
  end if;
  if p_after_seq is not null then
    return query
      select m.seq, oryn.account_display_name(a.user_id, a.display_name) as display_name, m.author_id = p_uid, case when m.author_id = p_uid then m.client_nonce end, m.body, m.created_at
        from oryn.room_messages m join oryn.room_members a on a.room_id = m.room_id and a.user_id = m.author_id
       where m.room_id = p_room and m.channel_id = p_channel and m.seq > p_after_seq
       order by m.seq
       limit p_limit;
  else
    return query
      select x.seq, x.display_name, x.is_mine, x.client_nonce, x.body, x.created_at
        from (select m.seq, oryn.account_display_name(a.user_id, a.display_name) as display_name, m.author_id = p_uid as is_mine,
                     case when m.author_id = p_uid then m.client_nonce end as client_nonce, m.body, m.created_at
                from oryn.room_messages m join oryn.room_members a on a.room_id = m.room_id and a.user_id = m.author_id
               where m.room_id = p_room and m.channel_id = p_channel and (p_before_seq is null or m.seq < p_before_seq)
               order by m.seq desc
               limit p_limit) x
       order by x.seq;
  end if;
end $$;

-- ---------------------------------------------------------------- RPCs antigas (canais padrão) --------

create or replace function public.join_room(p_room_id uuid) returns table (session_id uuid, topic text)
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid();
begin
  -- Cliente sem canais: a voz padrão do espaço. Sala alheia ou inexistente segue em not-member.
  return query select v.session_id, v.topic from oryn.open_voice_session(p_room_id, oryn.default_channel(p_room_id, 'voice'), v_uid) v;
end $$;

create or replace function public.get_roster(p_room_id uuid)
returns table (session_id uuid, display_name text, is_self boolean, joined_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid();
begin
  if not oryn.is_active_member(p_room_id, v_uid) then
    raise exception 'not-member' using errcode = '42501';
  end if;
  return query
    select s.id, oryn.account_display_name(m.user_id, m.display_name), s.user_id = v_uid, s.created_at
      from oryn.room_sessions s
      join oryn.room_members m on m.room_id = s.room_id and m.user_id = s.user_id and m.removed_at is null
     where s.room_id = p_room_id and s.channel_id = oryn.default_channel(p_room_id, 'voice')
       and s.revoked_at is null and oryn.session_is_fresh(s.last_seen_at)
     order by s.created_at;
end $$;

create or replace function public.get_voice_participants(p_room_id uuid)
returns table (session_id uuid, participant_ref text, display_name text, is_self boolean, joined_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid();
begin
  if not oryn.is_active_member(p_room_id, v_uid) then
    raise exception 'not-member' using errcode = '42501';
  end if;
  return query
    select s.id, oryn.member_ref(s.room_id, s.user_id), oryn.account_display_name(m.user_id, m.display_name), s.user_id = v_uid, s.created_at
      from oryn.room_sessions s
      join oryn.room_members m on m.room_id = s.room_id and m.user_id = s.user_id and m.removed_at is null
     where s.room_id = p_room_id and s.channel_id = oryn.default_channel(p_room_id, 'voice')
       and s.revoked_at is null and oryn.session_is_fresh(s.last_seen_at)
     order by s.created_at, s.id;
end $$;

-- Sai da sessão; o bye vai só para o canal dela.
create or replace function public.leave_room(p_session_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid(); v_channel uuid; v_revoked timestamptz;
begin
  select s.channel_id, s.revoked_at into v_channel, v_revoked from oryn.room_sessions s
   where s.id = p_session_id and s.user_id = v_uid for no key update;
  if not found then
    raise exception 'session-invalid' using errcode = '42501';
  end if;
  if v_revoked is not null then
    return;
  end if;
  update oryn.room_sessions set revoked_at = pg_catalog.now(), revoke_reason = 'left' where id = p_session_id;
  perform oryn.publish_channel_control(v_channel, p_session_id, 'bye', pg_catalog.jsonb_build_object('session_id', p_session_id));
end $$;

-- Igual à 0200, com uma regra a mais: remetente e destinatário no MESMO canal de voz (antes: mesma sala).
create or replace function public.authorize_signal(
  p_session_id uuid, p_to_session_id uuid, p_client_msg_id uuid, p_kind text, p_pair_epoch integer, p_payload_bytes integer)
returns table (msg_id uuid, seq bigint, from_user uuid, room_id uuid, state text, duplicate boolean, accepted_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := oryn.require_uid();
  v_room uuid; v_last timestamptz; v_channel uuid; v_to_room uuid; v_to_last timestamptz; v_to_channel uuid; v_recent integer; v_seq bigint;
  v_existing oryn.signal_log%rowtype;
begin
  if p_session_id is null or p_to_session_id is null or p_client_msg_id is null or p_session_id = p_to_session_id
     or p_kind is null or p_kind not in ('offer', 'answer', 'candidate', 'end-of-candidates', 'restart-request')
     or p_pair_epoch is null or p_pair_epoch < 0
     or p_payload_bytes is null or p_payload_bytes not between 1 and 16384 then
    raise exception 'invalid-argument' using errcode = 'P0001';
  end if;
  -- Remetente: sessão DO CHAMADOR, viva, de membro ativo, travada até o fim (02C.2B: FOR NO KEY UPDATE).
  select s.room_id, s.last_seen_at, s.channel_id into v_room, v_last, v_channel from oryn.room_sessions s
   where s.id = p_session_id and s.user_id = v_uid and s.revoked_at is null
   for no key update;
  if not found or not oryn.session_is_fresh(v_last) or not oryn.is_active_member(v_room, v_uid) then
    raise exception 'session-invalid' using errcode = '42501';
  end if;
  -- Destinatário: sessão viva do MESMO canal de voz, de membro ativo.
  select s.room_id, s.last_seen_at, s.channel_id into v_to_room, v_to_last, v_to_channel from oryn.room_sessions s
   where s.id = p_to_session_id and s.revoked_at is null
     and exists (select 1 from oryn.room_members m where m.room_id = s.room_id and m.user_id = s.user_id and m.removed_at is null);
  if not found or v_to_room <> v_room or v_to_channel <> v_channel or not oryn.session_is_fresh(v_to_last) then
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

create or replace function public.send_room_message(p_room_id uuid, p_client_nonce uuid, p_body text)
returns table (seq bigint, display_name text, is_mine boolean, client_nonce uuid, body text, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid();
begin
  perform 1 from oryn.room_members m where m.room_id = p_room_id and m.user_id = v_uid and m.removed_at is null;
  if not found then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  -- Cliente sem canais: o texto padrão do espaço.
  return query select x.seq, x.display_name, x.is_mine, x.client_nonce, x.body, x.created_at
    from oryn.post_message(p_room_id, oryn.default_channel(p_room_id, 'text'), v_uid, p_client_nonce, p_body) x;
end $$;

create or replace function public.list_room_messages(p_room_id uuid, p_before_seq bigint default null, p_after_seq bigint default null, p_limit integer default 50)
returns table (seq bigint, display_name text, is_mine boolean, client_nonce uuid, body text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid();
begin
  perform 1 from oryn.room_members m where m.room_id = p_room_id and m.user_id = v_uid and m.removed_at is null;
  if not found then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  return query select x.seq, x.display_name, x.is_mine, x.client_nonce, x.body, x.created_at
    from oryn.channel_messages(p_room_id, oryn.default_channel(p_room_id, 'text'), v_uid, p_before_seq, p_after_seq, p_limit) x;
end $$;

-- ---------------------------------------------------------------- RPCs novas (canais) ----------------

-- Canais do espaço (inclusive arquivados, com a data), para membro ativo; sala encerrada continua legível como o
-- histórico. Sala alheia ou inexistente: mesma resposta.
create function public.list_channels(p_room_id uuid)
returns table (channel_id uuid, kind text, name text, "position" integer, is_default boolean, archived_at timestamptz, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid();
begin
  perform 1 from oryn.room_members m where m.room_id = p_room_id and m.user_id = v_uid and m.removed_at is null;
  if not found then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  return query
    select c.id, c.kind, c.name, c.position, c.is_default, c.archived_at, c.created_at
      from oryn.channels c
     where c.room_id = p_room_id
     order by c.archived_at is not null, c.kind = 'voice', c.position, c.created_at, c.id;
end $$;

-- Cria canal (só o dono, sala aberta). Até 20 canais ativos por espaço; nome único entre os ativos do mesmo tipo.
create function public.create_channel(p_room_id uuid, p_name text, p_kind text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid(); v_closed timestamptz; v_active integer; v_position integer; v_id uuid;
begin
  select r.closed_at into v_closed from oryn.rooms r where r.id = p_room_id and r.owner_id = v_uid for no key update;
  if not found or not exists (select 1 from oryn.room_members m where m.room_id = p_room_id and m.user_id = v_uid and m.removed_at is null) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if v_closed is not null then
    raise exception 'room-closed' using errcode = 'P0001';
  end if;
  if not oryn.valid_label(p_name, 40) or p_kind is null or p_kind not in ('text', 'voice') then
    raise exception 'invalid-argument' using errcode = 'P0001';
  end if;
  select pg_catalog.count(*) into v_active from oryn.channels c where c.room_id = p_room_id and c.archived_at is null;
  if v_active >= 20 then
    raise exception 'limit-reached' using errcode = 'P0001';
  end if;
  select coalesce(pg_catalog.max(c.position), 0) + 1 into v_position from oryn.channels c where c.room_id = p_room_id and c.kind = p_kind;
  begin
    insert into oryn.channels (room_id, kind, name, position, created_by)
    values (p_room_id, p_kind, p_name, least(v_position, 1000), v_uid) returning id into v_id;
  exception when unique_violation then
    raise exception 'name-taken' using errcode = 'P0001';
  end;
  return v_id;
end $$;

-- Arquiva canal (só o dono, sala aberta; os padrões não são arquiváveis). Idempotente. Num canal de voz, avisa e
-- revoga as sessões vivas dele. O histórico de texto continua legível.
create function public.archive_channel(p_channel_id uuid) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid(); v_room uuid; v_closed timestamptz; v_kind text; v_default boolean; v_archived timestamptz; v_sid uuid;
begin
  select c.room_id into v_room from oryn.channels c where c.id = p_channel_id;
  if not found then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  select r.closed_at into v_closed from oryn.rooms r where r.id = v_room and r.owner_id = v_uid for no key update;
  if not found then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  select c.kind, c.is_default, c.archived_at into v_kind, v_default, v_archived from oryn.channels c where c.id = p_channel_id for no key update;
  if v_archived is not null then
    return v_archived;
  end if;
  if v_closed is not null then
    raise exception 'room-closed' using errcode = 'P0001';
  end if;
  if v_default then
    raise exception 'invalid-argument' using errcode = 'P0001';
  end if;
  if v_kind = 'voice' then
    for v_sid in
      select s.id from oryn.room_sessions s
       where s.channel_id = p_channel_id and s.revoked_at is null and oryn.session_is_fresh(s.last_seen_at)
       order by s.id
    loop
      perform oryn.publish_channel_control(p_channel_id, v_sid, 'bye', pg_catalog.jsonb_build_object('session_id', v_sid));
    end loop;
    update oryn.room_sessions set revoked_at = pg_catalog.now(), revoke_reason = 'channel-archived'
     where channel_id = p_channel_id and revoked_at is null;
  end if;
  update oryn.channels set archived_at = pg_catalog.now() where id = p_channel_id returning channels.archived_at into v_archived;
  return v_archived;
end $$;

create function public.send_channel_message(p_channel_id uuid, p_client_nonce uuid, p_body text)
returns table (seq bigint, display_name text, is_mine boolean, client_nonce uuid, body text, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid(); v_room uuid; v_kind text;
begin
  select c.room_id, c.kind into v_room, v_kind from oryn.channels c where c.id = p_channel_id;
  if not found or not exists (select 1 from oryn.room_members m where m.room_id = v_room and m.user_id = v_uid and m.removed_at is null) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if v_kind <> 'text' then
    raise exception 'invalid-argument' using errcode = 'P0001';
  end if;
  return query select x.seq, x.display_name, x.is_mine, x.client_nonce, x.body, x.created_at
    from oryn.post_message(v_room, p_channel_id, v_uid, p_client_nonce, p_body) x;
end $$;

create function public.list_channel_messages(p_channel_id uuid, p_before_seq bigint default null, p_after_seq bigint default null, p_limit integer default 50)
returns table (seq bigint, display_name text, is_mine boolean, client_nonce uuid, body text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid(); v_room uuid; v_kind text;
begin
  select c.room_id, c.kind into v_room, v_kind from oryn.channels c where c.id = p_channel_id;
  if not found or not exists (select 1 from oryn.room_members m where m.room_id = v_room and m.user_id = v_uid and m.removed_at is null) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if v_kind <> 'text' then
    raise exception 'invalid-argument' using errcode = 'P0001';
  end if;
  return query select x.seq, x.display_name, x.is_mine, x.client_nonce, x.body, x.created_at
    from oryn.channel_messages(v_room, p_channel_id, v_uid, p_before_seq, p_after_seq, p_limit) x;
end $$;

create function public.join_voice_channel(p_channel_id uuid) returns table (session_id uuid, topic text)
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid(); v_room uuid;
begin
  select c.room_id into v_room from oryn.channels c where c.id = p_channel_id;
  if not found then
    raise exception 'not-member' using errcode = '42501';
  end if;
  return query select v.session_id, v.topic from oryn.open_voice_session(v_room, p_channel_id, v_uid) v;
end $$;

-- Participantes vivos de um canal de voz (só para membro ativo do espaço).
create function public.get_channel_participants(p_channel_id uuid)
returns table (session_id uuid, participant_ref text, display_name text, is_self boolean, joined_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid(); v_room uuid; v_kind text;
begin
  select c.room_id, c.kind into v_room, v_kind from oryn.channels c where c.id = p_channel_id;
  if not found or not oryn.is_active_member(v_room, v_uid) then
    raise exception 'not-member' using errcode = '42501';
  end if;
  if v_kind <> 'voice' then
    raise exception 'invalid-argument' using errcode = 'P0001';
  end if;
  return query
    select s.id, oryn.member_ref(s.room_id, s.user_id), oryn.account_display_name(m.user_id, m.display_name), s.user_id = v_uid, s.created_at
      from oryn.room_sessions s
      join oryn.room_members m on m.room_id = s.room_id and m.user_id = s.user_id and m.removed_at is null
     where s.channel_id = p_channel_id and s.revoked_at is null and oryn.session_is_fresh(s.last_seen_at)
     order by s.created_at, s.id;
end $$;

-- ---------------------------------------------------------------- permissões explícitas ---------------

revoke all on function oryn.default_channel(uuid, text), oryn.create_default_channels(), oryn.fill_message_channel(),
  oryn.fill_session_channel(), oryn.publish_channel_control(uuid, uuid, text, jsonb), oryn.open_voice_session(uuid, uuid, uuid),
  oryn.post_message(uuid, uuid, uuid, uuid, text), oryn.channel_messages(uuid, uuid, uuid, bigint, bigint, integer)
from public, anon, authenticated, service_role;

revoke all on function public.list_channels(uuid), public.create_channel(uuid, text, text), public.archive_channel(uuid),
  public.send_channel_message(uuid, uuid, text), public.list_channel_messages(uuid, bigint, bigint, integer),
  public.join_voice_channel(uuid), public.get_channel_participants(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.list_channels(uuid), public.create_channel(uuid, text, text), public.archive_channel(uuid),
  public.send_channel_message(uuid, uuid, text), public.list_channel_messages(uuid, bigint, bigint, integer),
  public.join_voice_channel(uuid), public.get_channel_participants(uuid)
to authenticated;

commit;
