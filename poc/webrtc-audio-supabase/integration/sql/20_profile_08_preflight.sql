-- PR #23: SELECT somente leitura; não chama RPCs nem consulta dados pessoais.
-- Gerado por profile-08-artifacts.mjs. Qualquer FAIL impede prosseguir.
WITH expected(signature,identity_args,full_args,result_type,body_md5,volatility,definer,client_execute) AS (VALUES
('public.join_room(uuid)','p_room_id uuid','p_room_id uuid','TABLE(session_id uuid, topic text)','29d2268b30924ff9751e284b5bf90593','v',true,true),
('public.get_roster(uuid)','p_room_id uuid','p_room_id uuid','TABLE(session_id uuid, display_name text, is_self boolean, joined_at timestamp with time zone)','642282efa95ab352c503b2cde4551cdc','s',true,true),
('public.send_room_message(uuid,uuid,text)','p_room_id uuid, p_client_nonce uuid, p_body text','p_room_id uuid, p_client_nonce uuid, p_body text','TABLE(seq bigint, display_name text, is_mine boolean, client_nonce uuid, body text, created_at timestamp with time zone)','d83f5aa6d948af1a1c34d5764633bbec','v',true,true),
('public.list_room_messages(uuid,bigint,bigint,integer)','p_room_id uuid, p_before_seq bigint, p_after_seq bigint, p_limit integer','p_room_id uuid, p_before_seq bigint DEFAULT NULL::bigint, p_after_seq bigint DEFAULT NULL::bigint, p_limit integer DEFAULT 50','TABLE(seq bigint, display_name text, is_mine boolean, client_nonce uuid, body text, created_at timestamp with time zone)','468017d7009b3c8d0266d160236502c7','s',true,true),
('public.list_room_members(uuid)','p_room_id uuid','p_room_id uuid','TABLE(member_ref text, display_name text, role text, is_self boolean, in_call boolean, joined_at timestamp with time zone)','827359d2431c70f3e91f9a41f046be65','s',true,true),
('public.get_voice_participants(uuid)','p_room_id uuid','p_room_id uuid','TABLE(session_id uuid, participant_ref text, display_name text, is_self boolean, joined_at timestamp with time zone)','fe3d1b43cb31c5d33903c20bc9b49a22','s',true,true)
), checks AS (SELECT
  (SELECT array_agg(version || '_' || name ORDER BY version) FROM supabase_migrations.schema_migrations) = ARRAY['20261023000100_oryn_schema','20261023000200_oryn_functions','20261023000300_oryn_realtime','20261028000400_oryn_room_management','20261106000500_oryn_room_messages','20261107000600_oryn_room_membership','20261108000700_oryn_soundboard']::text[] AS history_ok,
  (SELECT count(*) = 6 AND bool_and(
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
  (SELECT count(*) = 0 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='oryn' AND p.proname IN ('normalize_account_name','account_display_name','validate_account_name')) AS helpers_ok,
  (SELECT count(*) = 6 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('join_room','get_roster','list_room_members','get_voice_participants','send_room_message','list_room_messages')) AS rpc_overloads_ok,
  NOT EXISTS (SELECT FROM pg_trigger WHERE tgrelid='auth.users'::regclass AND tgname='oryn_validate_account_name') AS trigger_ok,
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
  THEN 'oryn-profile-08-preflight-ok' ELSE 'oryn-profile-08-preflight-FAIL' END AS result, checks.* FROM checks;
