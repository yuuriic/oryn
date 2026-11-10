-- Etapa 9 (canais, 0900): SELECT somente leitura; não chama RPCs nem lê conteúdo de usuários (só agregados).
-- Gerado por channels-09-artifacts.mjs. Qualquer FAIL impede prosseguir.
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
  THEN 'oryn-channels-09-postflight-ok' ELSE 'oryn-channels-09-postflight-FAIL' END AS result, checks.* FROM checks;
