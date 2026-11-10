-- RECUPERAÇÃO ETAPA 9 (canais): requer autorização própria e cliente publicado sem canais.
-- Recuperação funcional: devolve os 7 corpos anteriores e tira o EXECUTE das 7 RPCs novas. Mantém tabela, colunas,
-- índices e gatilhos: os gatilhos levam toda gravação dos corpos antigos ao canal padrão.
-- Transação única, sem DROP, CASCADE, DML de dados de usuário ou alteração do histórico.
-- Mantém a versão 20261110000900 registrada: nova aplicação fica bloqueada. Não é um rollback geral.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $recovery$
begin
  if not coalesce((select result = 'oryn-channels-09-postflight-ok' from (
WITH expected(signature,identity_args,full_args,result_type,body_md5,volatility,definer,client_execute) AS (VALUES
('public.join_room(uuid)','p_room_id uuid','p_room_id uuid','TABLE(session_id uuid, topic text)','c8c2dcbc2691d086874882a338125e97','v',true,true),
('public.get_roster(uuid)','p_room_id uuid','p_room_id uuid','TABLE(session_id uuid, display_name text, is_self boolean, joined_at timestamp with time zone)','5c4ea94ac50cf48716ad5b64c7dd13af','s',true,true),
('public.get_voice_participants(uuid)','p_room_id uuid','p_room_id uuid','TABLE(session_id uuid, participant_ref text, display_name text, is_self boolean, joined_at timestamp with time zone)','3d625898e989a60f56602e41cdfa0fe5','s',true,true),
('public.leave_room(uuid)','p_session_id uuid','p_session_id uuid','void','e43aad01ff5164760697ebcbfc4576ac','v',true,true),
('public.authorize_signal(uuid,uuid,uuid,text,integer,integer)','p_session_id uuid, p_to_session_id uuid, p_client_msg_id uuid, p_kind text, p_pair_epoch integer, p_payload_bytes integer','p_session_id uuid, p_to_session_id uuid, p_client_msg_id uuid, p_kind text, p_pair_epoch integer, p_payload_bytes integer','TABLE(msg_id uuid, seq bigint, from_user uuid, room_id uuid, state text, duplicate boolean, accepted_at timestamp with time zone)','5eea469bda1db9383d5497dc0c4bd8ae','v',true,true),
('public.send_room_message(uuid,uuid,text)','p_room_id uuid, p_client_nonce uuid, p_body text','p_room_id uuid, p_client_nonce uuid, p_body text','TABLE(seq bigint, display_name text, is_mine boolean, client_nonce uuid, body text, created_at timestamp with time zone)','ec5be03036d79c9d49ad082e320f3df7','v',true,true),
('public.list_room_messages(uuid,bigint,bigint,integer)','p_room_id uuid, p_before_seq bigint, p_after_seq bigint, p_limit integer','p_room_id uuid, p_before_seq bigint DEFAULT NULL::bigint, p_after_seq bigint DEFAULT NULL::bigint, p_limit integer DEFAULT 50','TABLE(seq bigint, display_name text, is_mine boolean, client_nonce uuid, body text, created_at timestamp with time zone)','1c7dabbcb3ba096b92d07ab03d5d2c21','s',true,true),
('public.list_channels(uuid)','p_room_id uuid','p_room_id uuid','TABLE(channel_id uuid, kind text, name text, "position" integer, is_default boolean, archived_at timestamp with time zone, created_at timestamp with time zone)','87b66360ce5817f371c5b6f9ccec3345','s',true,true),
('public.create_channel(uuid,text,text)','p_room_id uuid, p_name text, p_kind text','p_room_id uuid, p_name text, p_kind text','uuid','ae7ce20de97c19f75c7e8a452a7a571e','v',true,true),
('public.archive_channel(uuid)','p_channel_id uuid','p_channel_id uuid','timestamp with time zone','bba3a6a3b8619d51363237f090a11730','v',true,true),
('public.send_channel_message(uuid,uuid,text)','p_channel_id uuid, p_client_nonce uuid, p_body text','p_channel_id uuid, p_client_nonce uuid, p_body text','TABLE(seq bigint, display_name text, is_mine boolean, client_nonce uuid, body text, created_at timestamp with time zone)','9eb2f871cf886d95a324167ead925437','v',true,true),
('public.list_channel_messages(uuid,bigint,bigint,integer)','p_channel_id uuid, p_before_seq bigint, p_after_seq bigint, p_limit integer','p_channel_id uuid, p_before_seq bigint DEFAULT NULL::bigint, p_after_seq bigint DEFAULT NULL::bigint, p_limit integer DEFAULT 50','TABLE(seq bigint, display_name text, is_mine boolean, client_nonce uuid, body text, created_at timestamp with time zone)','33527fae2dce4bf0f858ed7e19e607ff','s',true,true),
('public.join_voice_channel(uuid)','p_channel_id uuid','p_channel_id uuid','TABLE(session_id uuid, topic text)','41ef451aa52b1fd7523b5a7d8dba7564','v',true,true),
('public.get_channel_participants(uuid)','p_channel_id uuid','p_channel_id uuid','TABLE(session_id uuid, participant_ref text, display_name text, is_self boolean, joined_at timestamp with time zone)','cf9d9771710c40af61dbb03ade8e83ea','s',true,true),
('oryn.default_channel(uuid,text)','p_room uuid, p_kind text','p_room uuid, p_kind text','uuid','0b59c68913a0e65632e0897a39cc58c2','s',false,false),
('oryn.create_default_channels()','','','trigger','d13b3377869d18d25550d58fbdd4b446','v',false,false),
('oryn.fill_message_channel()','','','trigger','56a5b55e8e257a347eabd0c79d7f56ca','v',false,false),
('oryn.fill_session_channel()','','','trigger','0f5ff03408b4fcd3632c7ee68ac1ab44','v',false,false),
('oryn.publish_channel_control(uuid,uuid,text,jsonb)','p_channel uuid, p_except uuid, p_event text, p_payload jsonb','p_channel uuid, p_except uuid, p_event text, p_payload jsonb','void','de06241eda339667c91625154d0eb946','v',false,false),
('oryn.open_voice_session(uuid,uuid,uuid)','p_room uuid, p_channel uuid, p_uid uuid','p_room uuid, p_channel uuid, p_uid uuid','TABLE(session_id uuid, topic text)','6d3e29e4fe2ad1201c7a963595bd1166','v',false,false),
('oryn.post_message(uuid,uuid,uuid,uuid,text)','p_room uuid, p_channel uuid, p_uid uuid, p_client_nonce uuid, p_body text','p_room uuid, p_channel uuid, p_uid uuid, p_client_nonce uuid, p_body text','TABLE(seq bigint, display_name text, is_mine boolean, client_nonce uuid, body text, created_at timestamp with time zone)','2c46557dc1af268eec87373e0324db66','v',false,false),
('oryn.channel_messages(uuid,uuid,uuid,bigint,bigint,integer)','p_room uuid, p_channel uuid, p_uid uuid, p_before_seq bigint, p_after_seq bigint, p_limit integer','p_room uuid, p_channel uuid, p_uid uuid, p_before_seq bigint, p_after_seq bigint, p_limit integer','TABLE(seq bigint, display_name text, is_mine boolean, client_nonce uuid, body text, created_at timestamp with time zone)','05ea505997efd9ad19132413e9a0d963','s',false,false)
), checks AS (SELECT
  (SELECT array_agg(version || '_' || name ORDER BY version) FROM supabase_migrations.schema_migrations) = ARRAY['20261023000100_oryn_schema','20261023000200_oryn_functions','20261023000300_oryn_realtime','20261028000400_oryn_room_management','20261106000500_oryn_room_messages','20261107000600_oryn_room_membership','20261108000700_oryn_soundboard','20261109224924_oryn_account_display_name','20261110000900_oryn_channels']::text[] AS history_ok,
  (SELECT count(*) = 22 AND bool_and(
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
  (SELECT to_regclass('oryn.channels') IS NOT NULL
    AND (SELECT c.relrowsecurity AND NOT c.relforcerowsecurity FROM pg_class c WHERE c.oid=to_regclass('oryn.channels'))
    AND NOT EXISTS (SELECT FROM pg_policies WHERE schemaname='oryn')
    AND NOT EXISTS (SELECT FROM pg_class c, aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      WHERE c.oid=to_regclass('oryn.channels') AND a.grantee <> c.relowner)
    AND (SELECT count(*) = 2 FROM pg_attribute a WHERE a.attname='channel_id' AND a.attnotnull AND NOT a.attisdropped
      AND a.attrelid IN (to_regclass('oryn.room_messages'), to_regclass('oryn.room_sessions')))
    AND (SELECT count(*) = 2 FROM pg_constraint k WHERE k.contype='f' AND k.confrelid=to_regclass('oryn.channels')
      AND k.conname IN ('room_messages_channel_fk','room_sessions_channel_fk') AND array_length(k.conkey,1)=2 AND k.confdeltype='c')
    AND EXISTS (SELECT FROM pg_constraint k WHERE k.conrelid=to_regclass('oryn.channels') AND k.contype='u' AND array_length(k.conkey,1)=2)
    AND (SELECT count(*) = 3 FROM pg_class i WHERE i.relkind='i' AND i.relname IN ('channels_one_default_idx','channels_active_name_idx','channels_room_order_idx')
      AND i.relnamespace='oryn'::regnamespace)
    AND (SELECT count(*) = 3 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgenabled='O'
      AND (t.tgname, t.tgrelid, t.tgfoid) IN (('oryn_room_default_channels', to_regclass('oryn.rooms'), to_regprocedure('oryn.create_default_channels()')),
        ('oryn_message_channel', to_regclass('oryn.room_messages'), to_regprocedure('oryn.fill_message_channel()')),
        ('oryn_session_channel', to_regclass('oryn.room_sessions'), to_regprocedure('oryn.fill_session_channel()'))))
    AND EXISTS (SELECT FROM pg_constraint k WHERE k.conrelid=to_regclass('oryn.room_sessions') AND k.conname='room_sessions_revoke_reason_check'
      AND pg_get_constraintdef(k.oid) LIKE '%channel-archived%')) AS structure_ok,
  (SELECT NOT EXISTS (SELECT FROM oryn.rooms r WHERE (SELECT count(*) FROM oryn.channels c WHERE c.room_id=r.id AND c.is_default AND c.kind='text') <> 1
      OR (SELECT count(*) FROM oryn.channels c WHERE c.room_id=r.id AND c.is_default AND c.kind='voice') <> 1)
    AND NOT EXISTS (SELECT FROM oryn.room_messages m JOIN oryn.channels c ON c.id=m.channel_id WHERE c.kind <> 'text' OR c.room_id <> m.room_id)
    AND NOT EXISTS (SELECT FROM oryn.room_sessions s JOIN oryn.channels c ON c.id=s.channel_id WHERE c.kind <> 'voice' OR c.room_id <> s.room_id)) AS data_ok,
  has_schema_privilege(current_user,'oryn','USAGE')
    AND has_schema_privilege(current_user,'oryn','CREATE')
    AND has_schema_privilege(current_user,'public','USAGE')
    AND has_schema_privilege(current_user,'public','CREATE')
    AND has_table_privilege(current_user,'supabase_migrations.schema_migrations','INSERT')
    AND NOT EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='oryn' AND c.relkind='r' AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname=current_user)) AS permissions_ok
)
SELECT CASE WHEN history_ok AND functions_ok AND structure_ok AND data_ok AND permissions_ok
  THEN 'oryn-channels-09-postflight-ok' ELSE 'oryn-channels-09-postflight-FAIL' END AS result, checks.* FROM checks
  ) checked),false) then
    raise exception 'channels-09-recovery: estado divergente; nada revertido';
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

create or replace function public.leave_room(p_session_id uuid) returns void
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

create or replace function public.authorize_signal(
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

revoke execute on function public.list_channels(uuid), public.create_channel(uuid,text,text), public.archive_channel(uuid), public.send_channel_message(uuid,uuid,text), public.list_channel_messages(uuid,bigint,bigint,integer), public.join_voice_channel(uuid), public.get_channel_participants(uuid) from authenticated;
do $verify$
begin
  if not coalesce((select result = 'oryn-channels-09-recovered-ok' from (
WITH expected(signature,identity_args,full_args,result_type,body_md5,volatility,definer,client_execute) AS (VALUES
('public.join_room(uuid)','p_room_id uuid','p_room_id uuid','TABLE(session_id uuid, topic text)','a4d04cced690ae711110145fe13c2be0','v',true,true),
('public.get_roster(uuid)','p_room_id uuid','p_room_id uuid','TABLE(session_id uuid, display_name text, is_self boolean, joined_at timestamp with time zone)','d7ecf1a75d78faea2e8fe0388a1c515c','s',true,true),
('public.get_voice_participants(uuid)','p_room_id uuid','p_room_id uuid','TABLE(session_id uuid, participant_ref text, display_name text, is_self boolean, joined_at timestamp with time zone)','3cc6a8d82c6bae115d7e00951b349e15','s',true,true),
('public.leave_room(uuid)','p_session_id uuid','p_session_id uuid','void','d5190811aacc7dfbc03c20a9702d9157','v',true,true),
('public.authorize_signal(uuid,uuid,uuid,text,integer,integer)','p_session_id uuid, p_to_session_id uuid, p_client_msg_id uuid, p_kind text, p_pair_epoch integer, p_payload_bytes integer','p_session_id uuid, p_to_session_id uuid, p_client_msg_id uuid, p_kind text, p_pair_epoch integer, p_payload_bytes integer','TABLE(msg_id uuid, seq bigint, from_user uuid, room_id uuid, state text, duplicate boolean, accepted_at timestamp with time zone)','abbd567f14392bc89aa1931bf11faf10','v',true,true),
('public.send_room_message(uuid,uuid,text)','p_room_id uuid, p_client_nonce uuid, p_body text','p_room_id uuid, p_client_nonce uuid, p_body text','TABLE(seq bigint, display_name text, is_mine boolean, client_nonce uuid, body text, created_at timestamp with time zone)','af50e983d502e53fd6349f870ad2e287','v',true,true),
('public.list_room_messages(uuid,bigint,bigint,integer)','p_room_id uuid, p_before_seq bigint, p_after_seq bigint, p_limit integer','p_room_id uuid, p_before_seq bigint DEFAULT NULL::bigint, p_after_seq bigint DEFAULT NULL::bigint, p_limit integer DEFAULT 50','TABLE(seq bigint, display_name text, is_mine boolean, client_nonce uuid, body text, created_at timestamp with time zone)','6e54038f91a61f1016181d49e43a29c1','s',true,true),
('public.list_channels(uuid)','p_room_id uuid','p_room_id uuid','TABLE(channel_id uuid, kind text, name text, "position" integer, is_default boolean, archived_at timestamp with time zone, created_at timestamp with time zone)','87b66360ce5817f371c5b6f9ccec3345','s',true,false),
('public.create_channel(uuid,text,text)','p_room_id uuid, p_name text, p_kind text','p_room_id uuid, p_name text, p_kind text','uuid','ae7ce20de97c19f75c7e8a452a7a571e','v',true,false),
('public.archive_channel(uuid)','p_channel_id uuid','p_channel_id uuid','timestamp with time zone','bba3a6a3b8619d51363237f090a11730','v',true,false),
('public.send_channel_message(uuid,uuid,text)','p_channel_id uuid, p_client_nonce uuid, p_body text','p_channel_id uuid, p_client_nonce uuid, p_body text','TABLE(seq bigint, display_name text, is_mine boolean, client_nonce uuid, body text, created_at timestamp with time zone)','9eb2f871cf886d95a324167ead925437','v',true,false),
('public.list_channel_messages(uuid,bigint,bigint,integer)','p_channel_id uuid, p_before_seq bigint, p_after_seq bigint, p_limit integer','p_channel_id uuid, p_before_seq bigint DEFAULT NULL::bigint, p_after_seq bigint DEFAULT NULL::bigint, p_limit integer DEFAULT 50','TABLE(seq bigint, display_name text, is_mine boolean, client_nonce uuid, body text, created_at timestamp with time zone)','33527fae2dce4bf0f858ed7e19e607ff','s',true,false),
('public.join_voice_channel(uuid)','p_channel_id uuid','p_channel_id uuid','TABLE(session_id uuid, topic text)','41ef451aa52b1fd7523b5a7d8dba7564','v',true,false),
('public.get_channel_participants(uuid)','p_channel_id uuid','p_channel_id uuid','TABLE(session_id uuid, participant_ref text, display_name text, is_self boolean, joined_at timestamp with time zone)','cf9d9771710c40af61dbb03ade8e83ea','s',true,false),
('oryn.default_channel(uuid,text)','p_room uuid, p_kind text','p_room uuid, p_kind text','uuid','0b59c68913a0e65632e0897a39cc58c2','s',false,false),
('oryn.create_default_channels()','','','trigger','d13b3377869d18d25550d58fbdd4b446','v',false,false),
('oryn.fill_message_channel()','','','trigger','56a5b55e8e257a347eabd0c79d7f56ca','v',false,false),
('oryn.fill_session_channel()','','','trigger','0f5ff03408b4fcd3632c7ee68ac1ab44','v',false,false),
('oryn.publish_channel_control(uuid,uuid,text,jsonb)','p_channel uuid, p_except uuid, p_event text, p_payload jsonb','p_channel uuid, p_except uuid, p_event text, p_payload jsonb','void','de06241eda339667c91625154d0eb946','v',false,false),
('oryn.open_voice_session(uuid,uuid,uuid)','p_room uuid, p_channel uuid, p_uid uuid','p_room uuid, p_channel uuid, p_uid uuid','TABLE(session_id uuid, topic text)','6d3e29e4fe2ad1201c7a963595bd1166','v',false,false),
('oryn.post_message(uuid,uuid,uuid,uuid,text)','p_room uuid, p_channel uuid, p_uid uuid, p_client_nonce uuid, p_body text','p_room uuid, p_channel uuid, p_uid uuid, p_client_nonce uuid, p_body text','TABLE(seq bigint, display_name text, is_mine boolean, client_nonce uuid, body text, created_at timestamp with time zone)','2c46557dc1af268eec87373e0324db66','v',false,false),
('oryn.channel_messages(uuid,uuid,uuid,bigint,bigint,integer)','p_room uuid, p_channel uuid, p_uid uuid, p_before_seq bigint, p_after_seq bigint, p_limit integer','p_room uuid, p_channel uuid, p_uid uuid, p_before_seq bigint, p_after_seq bigint, p_limit integer','TABLE(seq bigint, display_name text, is_mine boolean, client_nonce uuid, body text, created_at timestamp with time zone)','05ea505997efd9ad19132413e9a0d963','s',false,false)
), checks AS (SELECT
  (SELECT array_agg(version || '_' || name ORDER BY version) FROM supabase_migrations.schema_migrations) = ARRAY['20261023000100_oryn_schema','20261023000200_oryn_functions','20261023000300_oryn_realtime','20261028000400_oryn_room_management','20261106000500_oryn_room_messages','20261107000600_oryn_room_membership','20261108000700_oryn_soundboard','20261109224924_oryn_account_display_name','20261110000900_oryn_channels']::text[] AS history_ok,
  (SELECT count(*) = 22 AND bool_and(
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
  (SELECT to_regclass('oryn.channels') IS NOT NULL
    AND (SELECT c.relrowsecurity AND NOT c.relforcerowsecurity FROM pg_class c WHERE c.oid=to_regclass('oryn.channels'))
    AND NOT EXISTS (SELECT FROM pg_policies WHERE schemaname='oryn')
    AND NOT EXISTS (SELECT FROM pg_class c, aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      WHERE c.oid=to_regclass('oryn.channels') AND a.grantee <> c.relowner)
    AND (SELECT count(*) = 2 FROM pg_attribute a WHERE a.attname='channel_id' AND a.attnotnull AND NOT a.attisdropped
      AND a.attrelid IN (to_regclass('oryn.room_messages'), to_regclass('oryn.room_sessions')))
    AND (SELECT count(*) = 2 FROM pg_constraint k WHERE k.contype='f' AND k.confrelid=to_regclass('oryn.channels')
      AND k.conname IN ('room_messages_channel_fk','room_sessions_channel_fk') AND array_length(k.conkey,1)=2 AND k.confdeltype='c')
    AND EXISTS (SELECT FROM pg_constraint k WHERE k.conrelid=to_regclass('oryn.channels') AND k.contype='u' AND array_length(k.conkey,1)=2)
    AND (SELECT count(*) = 3 FROM pg_class i WHERE i.relkind='i' AND i.relname IN ('channels_one_default_idx','channels_active_name_idx','channels_room_order_idx')
      AND i.relnamespace='oryn'::regnamespace)
    AND (SELECT count(*) = 3 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgenabled='O'
      AND (t.tgname, t.tgrelid, t.tgfoid) IN (('oryn_room_default_channels', to_regclass('oryn.rooms'), to_regprocedure('oryn.create_default_channels()')),
        ('oryn_message_channel', to_regclass('oryn.room_messages'), to_regprocedure('oryn.fill_message_channel()')),
        ('oryn_session_channel', to_regclass('oryn.room_sessions'), to_regprocedure('oryn.fill_session_channel()'))))
    AND EXISTS (SELECT FROM pg_constraint k WHERE k.conrelid=to_regclass('oryn.room_sessions') AND k.conname='room_sessions_revoke_reason_check'
      AND pg_get_constraintdef(k.oid) LIKE '%channel-archived%')) AS structure_ok,
  (SELECT NOT EXISTS (SELECT FROM oryn.rooms r WHERE (SELECT count(*) FROM oryn.channels c WHERE c.room_id=r.id AND c.is_default AND c.kind='text') <> 1
      OR (SELECT count(*) FROM oryn.channels c WHERE c.room_id=r.id AND c.is_default AND c.kind='voice') <> 1)
    AND NOT EXISTS (SELECT FROM oryn.room_messages m JOIN oryn.channels c ON c.id=m.channel_id WHERE c.kind <> 'text' OR c.room_id <> m.room_id)
    AND NOT EXISTS (SELECT FROM oryn.room_sessions s JOIN oryn.channels c ON c.id=s.channel_id WHERE c.kind <> 'voice' OR c.room_id <> s.room_id)) AS data_ok,
  has_schema_privilege(current_user,'oryn','USAGE')
    AND has_schema_privilege(current_user,'oryn','CREATE')
    AND has_schema_privilege(current_user,'public','USAGE')
    AND has_schema_privilege(current_user,'public','CREATE')
    AND has_table_privilege(current_user,'supabase_migrations.schema_migrations','INSERT')
    AND NOT EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='oryn' AND c.relkind='r' AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname=current_user)) AS permissions_ok
)
SELECT CASE WHEN history_ok AND functions_ok AND structure_ok AND data_ok AND permissions_ok
  THEN 'oryn-channels-09-recovered-ok' ELSE 'oryn-channels-09-recovered-FAIL' END AS result, checks.* FROM checks
  ) checked),false) then
    raise exception 'channels-09-recovery: verificação final falhou; nada revertido';
  end if;
end $verify$;
commit;
