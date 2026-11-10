-- RECUPERAÇÃO PR #23: requer autorização própria e cliente Gold restaurado.
-- Recuperação funcional: mantém os helpers privados e o gatilho, com validador inerte.
-- Não depende de ser dono de auth.users (DROP TRIGGER exigiria esse privilégio).
-- Transação única, sem CASCADE, DML de dados de usuário ou alteração do histórico.
-- Mantém a versão 20261109224924 registrada: nova aplicação fica bloqueada.
-- Gerado a partir das seis definições anteriores aprovadas; não é um rollback geral.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $recovery$
begin
  if not coalesce((select result = 'oryn-profile-08-postflight-ok' from (
WITH expected(signature,identity_args,full_args,result_type,body_md5,volatility,definer,client_execute) AS (VALUES
('oryn.normalize_account_name(text)','p_name text','p_name text','text','13edf4616e947d7a8cb9fecea5d16765','i',false,false),
('oryn.account_display_name(uuid,text)','p_user uuid, p_legacy text','p_user uuid, p_legacy text','text','eff03cb32d5dd2e1efc8f2be787426c2','s',false,false),
('oryn.validate_account_name()','','','trigger','3ffa2b1c46cb04f0104b030a60fa44cb','v',true,false),
('public.join_room(uuid)','p_room_id uuid','p_room_id uuid','TABLE(session_id uuid, topic text)','a4d04cced690ae711110145fe13c2be0','v',true,true),
('public.get_roster(uuid)','p_room_id uuid','p_room_id uuid','TABLE(session_id uuid, display_name text, is_self boolean, joined_at timestamp with time zone)','d7ecf1a75d78faea2e8fe0388a1c515c','s',true,true),
('public.list_room_members(uuid)','p_room_id uuid','p_room_id uuid','TABLE(member_ref text, display_name text, role text, is_self boolean, in_call boolean, joined_at timestamp with time zone)','69701802d44607fdecaa998735323ac2','s',true,true),
('public.get_voice_participants(uuid)','p_room_id uuid','p_room_id uuid','TABLE(session_id uuid, participant_ref text, display_name text, is_self boolean, joined_at timestamp with time zone)','3cc6a8d82c6bae115d7e00951b349e15','s',true,true),
('public.send_room_message(uuid,uuid,text)','p_room_id uuid, p_client_nonce uuid, p_body text','p_room_id uuid, p_client_nonce uuid, p_body text','TABLE(seq bigint, display_name text, is_mine boolean, client_nonce uuid, body text, created_at timestamp with time zone)','af50e983d502e53fd6349f870ad2e287','v',true,true),
('public.list_room_messages(uuid,bigint,bigint,integer)','p_room_id uuid, p_before_seq bigint, p_after_seq bigint, p_limit integer','p_room_id uuid, p_before_seq bigint DEFAULT NULL::bigint, p_after_seq bigint DEFAULT NULL::bigint, p_limit integer DEFAULT 50','TABLE(seq bigint, display_name text, is_mine boolean, client_nonce uuid, body text, created_at timestamp with time zone)','6e54038f91a61f1016181d49e43a29c1','s',true,true)
), checks AS (SELECT
  (SELECT array_agg(version || '_' || name ORDER BY version) FROM supabase_migrations.schema_migrations) = ARRAY['20261023000100_oryn_schema','20261023000200_oryn_functions','20261023000300_oryn_realtime','20261028000400_oryn_room_management','20261106000500_oryn_room_messages','20261107000600_oryn_room_membership','20261108000700_oryn_soundboard','20261109224924_oryn_account_display_name']::text[] AS history_ok,
  (SELECT count(*) = 9 AND bool_and(
    p.oid IS NOT NULL AND pg_get_userbyid(p.proowner) = current_user
    AND pg_get_function_identity_arguments(p.oid) = e.identity_args
    AND pg_get_function_arguments(p.oid) = e.full_args
    AND pg_get_function_result(p.oid) = e.result_type
    AND md5(p.prosrc) = e.body_md5 AND p.provolatile::text = e.volatility
    AND p.prosecdef = e.definer AND p.proconfig = ARRAY['search_path=""']::text[]
    AND has_function_privilege('authenticated',p.oid,'EXECUTE') = e.client_execute
    AND NOT has_function_privilege('anon',p.oid,'EXECUTE')
    AND NOT has_function_privilege('service_role',p.oid,'EXECUTE')
    AND NOT EXISTS (SELECT FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee NOT IN (p.proowner, CASE WHEN e.client_execute THEN 'authenticated'::regrole::oid ELSE p.proowner END)
         OR a.privilege_type <> 'EXECUTE' OR a.is_grantable)
  ) FROM expected e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature)) AS functions_ok,
  (SELECT count(*) = 3 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='oryn' AND p.proname IN ('normalize_account_name','account_display_name','validate_account_name')) AS helpers_ok,
  (SELECT count(*) = 6 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('join_room','get_roster','list_room_members','get_voice_participants','send_room_message','list_room_messages')) AS rpc_overloads_ok,
  (SELECT count(*) = 1 AND bool_and(t.tgtype=23 AND t.tgenabled='O'
      AND t.tgfoid=to_regprocedure('oryn.validate_account_name()') AND t.tgnargs=0 AND t.tgqual IS NULL
      AND NOT t.tgisinternal AND t.tgconstraint=0
      AND t.tgattr::text=(SELECT attnum::text FROM pg_attribute WHERE attrelid='auth.users'::regclass AND attname='raw_user_meta_data'))
    FROM pg_trigger t WHERE t.tgrelid='auth.users'::regclass AND t.tgname='oryn_validate_account_name') AS trigger_ok,
  has_table_privilege(current_user,'auth.users','TRIGGER')
    AND has_column_privilege(current_user,'auth.users','id','SELECT')
    AND has_column_privilege(current_user,'auth.users','raw_user_meta_data','SELECT')
    AND has_schema_privilege(current_user,'oryn','USAGE')
    AND has_schema_privilege(current_user,'oryn','CREATE')
    AND has_schema_privilege(current_user,'public','USAGE')
    AND has_schema_privilege(current_user,'public','CREATE')
    AND has_schema_privilege(current_user,'auth','USAGE')
    AND has_table_privilege(current_user,'supabase_migrations.schema_migrations','INSERT') AS permissions_ok
)
SELECT CASE WHEN history_ok AND functions_ok AND helpers_ok AND rpc_overloads_ok AND trigger_ok AND permissions_ok
  THEN 'oryn-profile-08-postflight-ok' ELSE 'oryn-profile-08-postflight-FAIL' END AS result, checks.* FROM checks
  ) checked),false) then
    raise exception 'profile-08-recovery: estado divergente; nada revertido';
  end if;
end $recovery$;
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
  select m.display_name into v_label from oryn.room_members m where m.room_id = p_room_id and m.user_id = v_uid;
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
    select s.id, m.display_name, s.user_id = v_uid, s.created_at
      from oryn.room_sessions s
      join oryn.room_members m on m.room_id = s.room_id and m.user_id = s.user_id and m.removed_at is null
     where s.room_id = p_room_id and s.revoked_at is null and oryn.session_is_fresh(s.last_seen_at)
     order by s.created_at;
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
  select m.display_name into v_name from oryn.room_members m
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
      select m.seq, a.display_name, m.author_id = v_uid, case when m.author_id = v_uid then m.client_nonce end, m.body, m.created_at
        from oryn.room_messages m join oryn.room_members a on a.room_id = m.room_id and a.user_id = m.author_id
       where m.room_id = p_room_id and m.seq > p_after_seq
       order by m.seq
       limit p_limit;
  else
    return query
      select x.seq, x.display_name, x.is_mine, x.client_nonce, x.body, x.created_at
        from (select m.seq, a.display_name, m.author_id = v_uid as is_mine,
                     case when m.author_id = v_uid then m.client_nonce end as client_nonce, m.body, m.created_at
                from oryn.room_messages m join oryn.room_members a on a.room_id = m.room_id and a.user_id = m.author_id
               where m.room_id = p_room_id and (p_before_seq is null or m.seq < p_before_seq)
               order by m.seq desc
               limit p_limit) x
       order by x.seq;
  end if;
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
    select oryn.member_ref(m.room_id, m.user_id), m.display_name, m.role, m.user_id = v_uid,
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
    select s.id, oryn.member_ref(s.room_id, s.user_id), m.display_name, s.user_id = v_uid, s.created_at
      from oryn.room_sessions s
      join oryn.room_members m on m.room_id = s.room_id and m.user_id = s.user_id and m.removed_at is null
     where s.room_id = p_room_id and s.revoked_at is null and oryn.session_is_fresh(s.last_seen_at)
     order by s.created_at, s.id;
end $$;
create or replace function oryn.validate_account_name() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  return new;
end $$;
do $verify$
begin
  if not coalesce((select result = 'oryn-profile-08-recovered-ok' from (
WITH expected(signature,identity_args,full_args,result_type,body_md5,volatility,definer,client_execute) AS (VALUES
('public.join_room(uuid)','p_room_id uuid','p_room_id uuid','TABLE(session_id uuid, topic text)','29d2268b30924ff9751e284b5bf90593','v',true,true),
('public.get_roster(uuid)','p_room_id uuid','p_room_id uuid','TABLE(session_id uuid, display_name text, is_self boolean, joined_at timestamp with time zone)','642282efa95ab352c503b2cde4551cdc','s',true,true),
('public.send_room_message(uuid,uuid,text)','p_room_id uuid, p_client_nonce uuid, p_body text','p_room_id uuid, p_client_nonce uuid, p_body text','TABLE(seq bigint, display_name text, is_mine boolean, client_nonce uuid, body text, created_at timestamp with time zone)','d83f5aa6d948af1a1c34d5764633bbec','v',true,true),
('public.list_room_messages(uuid,bigint,bigint,integer)','p_room_id uuid, p_before_seq bigint, p_after_seq bigint, p_limit integer','p_room_id uuid, p_before_seq bigint DEFAULT NULL::bigint, p_after_seq bigint DEFAULT NULL::bigint, p_limit integer DEFAULT 50','TABLE(seq bigint, display_name text, is_mine boolean, client_nonce uuid, body text, created_at timestamp with time zone)','468017d7009b3c8d0266d160236502c7','s',true,true),
('public.list_room_members(uuid)','p_room_id uuid','p_room_id uuid','TABLE(member_ref text, display_name text, role text, is_self boolean, in_call boolean, joined_at timestamp with time zone)','827359d2431c70f3e91f9a41f046be65','s',true,true),
('public.get_voice_participants(uuid)','p_room_id uuid','p_room_id uuid','TABLE(session_id uuid, participant_ref text, display_name text, is_self boolean, joined_at timestamp with time zone)','fe3d1b43cb31c5d33903c20bc9b49a22','s',true,true),
('oryn.normalize_account_name(text)','p_name text','p_name text','text','13edf4616e947d7a8cb9fecea5d16765','i',false,false),
('oryn.account_display_name(uuid,text)','p_user uuid, p_legacy text','p_user uuid, p_legacy text','text','eff03cb32d5dd2e1efc8f2be787426c2','s',false,false),
('oryn.validate_account_name()','','','trigger','c557bae29cb665384877acdd6c55df92','v',true,false)
), checks AS (SELECT
  (SELECT array_agg(version || '_' || name ORDER BY version) FROM supabase_migrations.schema_migrations) = ARRAY['20261023000100_oryn_schema','20261023000200_oryn_functions','20261023000300_oryn_realtime','20261028000400_oryn_room_management','20261106000500_oryn_room_messages','20261107000600_oryn_room_membership','20261108000700_oryn_soundboard','20261109224924_oryn_account_display_name']::text[] AS history_ok,
  (SELECT count(*) = 9 AND bool_and(
    p.oid IS NOT NULL AND pg_get_userbyid(p.proowner) = current_user
    AND pg_get_function_identity_arguments(p.oid) = e.identity_args
    AND pg_get_function_arguments(p.oid) = e.full_args
    AND pg_get_function_result(p.oid) = e.result_type
    AND md5(p.prosrc) = e.body_md5 AND p.provolatile::text = e.volatility
    AND p.prosecdef = e.definer AND p.proconfig = ARRAY['search_path=""']::text[]
    AND has_function_privilege('authenticated',p.oid,'EXECUTE') = e.client_execute
    AND NOT has_function_privilege('anon',p.oid,'EXECUTE')
    AND NOT has_function_privilege('service_role',p.oid,'EXECUTE')
    AND NOT EXISTS (SELECT FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee NOT IN (p.proowner, CASE WHEN e.client_execute THEN 'authenticated'::regrole::oid ELSE p.proowner END)
         OR a.privilege_type <> 'EXECUTE' OR a.is_grantable)
  ) FROM expected e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature)) AS functions_ok,
  (SELECT count(*) = 3 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='oryn' AND p.proname IN ('normalize_account_name','account_display_name','validate_account_name')) AS helpers_ok,
  (SELECT count(*) = 6 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('join_room','get_roster','list_room_members','get_voice_participants','send_room_message','list_room_messages')) AS rpc_overloads_ok,
  (SELECT count(*) = 1 AND bool_and(t.tgtype=23 AND t.tgenabled='O'
      AND t.tgfoid=to_regprocedure('oryn.validate_account_name()') AND t.tgnargs=0 AND t.tgqual IS NULL
      AND NOT t.tgisinternal AND t.tgconstraint=0
      AND t.tgattr::text=(SELECT attnum::text FROM pg_attribute WHERE attrelid='auth.users'::regclass AND attname='raw_user_meta_data'))
    FROM pg_trigger t WHERE t.tgrelid='auth.users'::regclass AND t.tgname='oryn_validate_account_name') AS trigger_ok,
  has_table_privilege(current_user,'auth.users','TRIGGER')
    AND has_column_privilege(current_user,'auth.users','id','SELECT')
    AND has_column_privilege(current_user,'auth.users','raw_user_meta_data','SELECT')
    AND has_schema_privilege(current_user,'oryn','USAGE')
    AND has_schema_privilege(current_user,'oryn','CREATE')
    AND has_schema_privilege(current_user,'public','USAGE')
    AND has_schema_privilege(current_user,'public','CREATE')
    AND has_schema_privilege(current_user,'auth','USAGE')
    AND has_table_privilege(current_user,'supabase_migrations.schema_migrations','INSERT') AS permissions_ok
)
SELECT CASE WHEN history_ok AND functions_ok AND helpers_ok AND rpc_overloads_ok AND trigger_ok AND permissions_ok
  THEN 'oryn-profile-08-recovered-ok' ELSE 'oryn-profile-08-recovered-FAIL' END AS result, checks.* FROM checks
  ) checked),false) then
    raise exception 'profile-08-recovery: verificação final falhou; nada revertido';
  end if;
end $verify$;
commit;
