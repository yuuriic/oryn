-- Identidade da conta: Auth é a única origem global. Nenhuma tabela de perfil, nova RPC,
-- alteração de papel, identificador, mensagem, convite ou sessão. room_members.display_name
-- permanece como fallback legado. Nunca usar raw_user_meta_data para autorização.
begin;

create function oryn.normalize_account_name(p_name text) returns text
language plpgsql immutable set search_path = '' as $$
declare v_name text;
begin
  -- C0, DEL e C1: controles são recusados ANTES de normalizar os espaços Unicode.
  if p_name is null or p_name ~ ( '[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']' ) then
    return null;
  end if;
  v_name := pg_catalog.btrim(pg_catalog.regexp_replace(p_name,
    U&'[ \00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+', ' ', 'g'), ' ');
  if pg_catalog.char_length(v_name) not between 1 and 32 then return null; end if;
  return v_name;
end $$;

-- Chamada apenas dentro das RPCs que já autorizaram acesso à sala. Sem acesso direto
-- ao Auth para clientes e sem retornar e-mail, UUID ou o restante dos metadados.
create function oryn.account_display_name(p_user uuid, p_legacy text) returns text
language sql stable set search_path = '' as $$
  select coalesce((select case when pg_catalog.jsonb_typeof(u.raw_user_meta_data -> 'display_name') = 'string'
                               then oryn.normalize_account_name(u.raw_user_meta_data ->> 'display_name') end
                    from auth.users u where u.id = p_user), p_legacy)
$$;

create function oryn.validate_account_name() returns trigger
language plpgsql set search_path = '' as $$
declare v_name text;
begin
  if tg_op = 'UPDATE' and (new.raw_user_meta_data -> 'display_name') is not distinct from
                         (old.raw_user_meta_data -> 'display_name') then return new; end if;
  if not (coalesce(new.raw_user_meta_data, '{}'::jsonb) ? 'display_name') then
    -- Contas antigas podem continuar sem nome. Depois de escolhido, não pode ser apagado.
    if tg_op = 'UPDATE' and old.raw_user_meta_data ? 'display_name' then
      raise exception 'invalid-display-name' using errcode = '22023';
    end if;
    return new;
  end if;
  if pg_catalog.jsonb_typeof(new.raw_user_meta_data -> 'display_name') <> 'string' then
    raise exception 'invalid-display-name' using errcode = '22023';
  end if;
  v_name := oryn.normalize_account_name(new.raw_user_meta_data ->> 'display_name');
  if v_name is null then raise exception 'invalid-display-name' using errcode = '22023'; end if;
  new.raw_user_meta_data := pg_catalog.jsonb_set(new.raw_user_meta_data, '{display_name}', pg_catalog.to_jsonb(v_name));
  return new;
end $$;

-- Definer necessário: o Auth não recebe USAGE/EXECUTE no schema privado. A função só
-- normaliza NEW; não consulta contas nem concede acesso ao domínio.
alter function oryn.validate_account_name() security definer;
revoke all on function oryn.normalize_account_name(text), oryn.account_display_name(uuid,text), oryn.validate_account_name()
  from public, anon, authenticated, service_role;
create trigger oryn_validate_account_name before insert or update of raw_user_meta_data on auth.users
  for each row execute function oryn.validate_account_name();

-- As funções abaixo preservam assinaturas, autorização e privilégios. Só a resolução
-- do nome passa a preferir o Auth. Clientes antigos escrevem apenas o fallback da sala;
-- nunca conseguem sobrescrever o nome global por create_room/redeem_room_invite.

create or replace function public.join_room(p_room_id uuid) returns table (session_id uuid, topic text)
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
  select oryn.account_display_name(m.user_id, m.display_name) into v_label from oryn.room_members m where m.room_id = p_room_id and m.user_id = v_uid;
  perform oryn.publish_control(p_room_id, v_sid, 'hello', pg_catalog.jsonb_build_object('session_id', v_sid, 'label', v_label));
  session_id := v_sid;
  topic := 'oryn:s:' || v_sid::text;
  return next;
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
     where s.room_id = p_room_id and s.revoked_at is null and oryn.session_is_fresh(s.last_seen_at)
     order by s.created_at;
end $$;


create or replace function public.list_room_members(p_room_id uuid)
returns table (member_ref text, display_name text, role text, is_self boolean, in_call boolean, joined_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := oryn.require_uid();
begin
  perform 1 from oryn.room_members m where m.room_id = p_room_id and m.user_id = v_uid and m.removed_at is null;
  if not found then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  return query
    select oryn.member_ref(m.room_id, m.user_id), oryn.account_display_name(m.user_id, m.display_name), m.role, m.user_id = v_uid,
           exists (select 1 from oryn.room_sessions s
                    where s.room_id = m.room_id and s.user_id = m.user_id and s.revoked_at is null
                      and oryn.session_is_fresh(s.last_seen_at)),
           m.joined_at
      from oryn.room_members m
     where m.room_id = p_room_id and m.removed_at is null
     order by m.role = 'owner' desc, m.joined_at, m.user_id;
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
     where s.room_id = p_room_id and s.revoked_at is null and oryn.session_is_fresh(s.last_seen_at)
     order by s.created_at, s.id;
end $$;


create or replace function public.send_room_message(p_room_id uuid, p_client_nonce uuid, p_body text)
returns table (seq bigint, display_name text, is_mine boolean, client_nonce uuid, body text, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := oryn.require_uid();
  v_name text;
  v_closed timestamptz;
  v_seq bigint;
  v_body text;
  v_at timestamptz;
  v_recent integer;
begin
  perform 1 from oryn.room_members m where m.room_id = p_room_id and m.user_id = v_uid and m.removed_at is null;
  if not found then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_client_nonce is null or p_body is null
     or pg_catalog.char_length(p_body) not between 1 and 4000
     or pg_catalog.btrim(p_body, E' \n\t') = ''
     or p_body ~ E'[\\x01-\\x08\\x0B-\\x1F\\x7F]' then
    raise exception 'invalid-argument' using errcode = 'P0001';
  end if;

  select r.closed_at into v_closed from oryn.rooms r where r.id = p_room_id for no key update;
  select oryn.account_display_name(m.user_id, m.display_name) into v_name from oryn.room_members m
   where m.room_id = p_room_id and m.user_id = v_uid and m.removed_at is null;
  if not found then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select m.seq, m.body, m.created_at into v_seq, v_body, v_at from oryn.room_messages m
   where m.room_id = p_room_id and m.author_id = v_uid and m.client_nonce = p_client_nonce;
  if found then
    if v_body <> p_body then
      raise exception 'invalid-argument' using errcode = 'P0001';
    end if;
  else
    if v_closed is not null then
      raise exception 'room-closed' using errcode = 'P0001';
    end if;
    select pg_catalog.count(*) into v_recent from oryn.room_messages m
     where m.room_id = p_room_id and m.author_id = v_uid and m.created_at > pg_catalog.clock_timestamp() - interval '60 seconds';
    if v_recent >= 30 then
      raise exception 'rate-limited' using errcode = 'P0001';
    end if;
    insert into oryn.room_message_counters as c (room_id, last_seq) values (p_room_id, 1)
    on conflict (room_id) do update set last_seq = c.last_seq + 1
    returning c.last_seq into v_seq;
    v_body := p_body;
    v_at := pg_catalog.clock_timestamp();
    insert into oryn.room_messages (room_id, seq, author_id, client_nonce, body, created_at)
    values (p_room_id, v_seq, v_uid, p_client_nonce, v_body, v_at);
  end if;

  seq := v_seq;
  display_name := v_name;
  is_mine := true;
  client_nonce := p_client_nonce;
  body := v_body;
  created_at := v_at;
  return next;
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
  if p_limit is null or p_limit not between 1 and 100 or (p_before_seq is not null and p_after_seq is not null) then
    raise exception 'invalid-argument' using errcode = 'P0001';
  end if;
  if p_after_seq is not null then
    return query
      select m.seq, oryn.account_display_name(a.user_id, a.display_name) as display_name, m.author_id = v_uid, case when m.author_id = v_uid then m.client_nonce end, m.body, m.created_at
        from oryn.room_messages m join oryn.room_members a on a.room_id = m.room_id and a.user_id = m.author_id
       where m.room_id = p_room_id and m.seq > p_after_seq
       order by m.seq
       limit p_limit;
  else
    return query
      select x.seq, x.display_name, x.is_mine, x.client_nonce, x.body, x.created_at
        from (select m.seq, oryn.account_display_name(a.user_id, a.display_name) as display_name, m.author_id = v_uid as is_mine,
                     case when m.author_id = v_uid then m.client_nonce end as client_nonce, m.body, m.created_at
                from oryn.room_messages m join oryn.room_members a on a.room_id = m.room_id and a.user_id = m.author_id
               where m.room_id = p_room_id and (p_before_seq is null or m.seq < p_before_seq)
               order by m.seq desc
               limit p_limit) x
       order by x.seq;
  end if;
end $$;

commit;
