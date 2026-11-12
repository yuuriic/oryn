-- Etapa 10 (capacidade 5, 1000): pré-voo. SELECT somente leitura, só de catálogo e histórico:
-- não chama RPCs nem lê dados de usuários. Gerado por capacity-10-artifacts.mjs. Qualquer FAIL impede prosseguir.
WITH checks AS (SELECT
  (SELECT array_agg(version || '_' || name ORDER BY version) FROM supabase_migrations.schema_migrations) = ARRAY['20261023000100_oryn_schema','20261023000200_oryn_functions','20261023000300_oryn_realtime','20261028000400_oryn_room_management','20261106000500_oryn_room_messages','20261107000600_oryn_room_membership','20261108000700_oryn_soundboard','20261109224924_oryn_account_display_name','20261110000900_oryn_channels']::text[] AS history_ok,
  (SELECT count(*) = 1 AND bool_and(
    pg_get_userbyid(p.proowner) = current_user
    AND pg_get_function_identity_arguments(p.oid) = '' AND pg_get_function_result(p.oid) = 'trigger'
    AND md5(p.prosrc) = '559a427e8e202f0ce3ee6f1d54e98e43' AND p.provolatile = 'v' AND NOT p.prosecdef
    AND p.proconfig = ARRAY['search_path=""']::text[]
    AND NOT has_function_privilege('anon',p.oid,'EXECUTE')
    AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')
    AND NOT has_function_privilege('service_role',p.oid,'EXECUTE')
    AND NOT EXISTS (SELECT FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee <> p.proowner OR a.privilege_type <> 'EXECUTE' OR a.is_grantable)
  ) FROM pg_proc p WHERE p.oid = to_regprocedure('oryn.enforce_room_capacity()')) AS function_ok,
  (SELECT count(*) = 1 FROM pg_trigger t
    WHERE t.tgrelid = to_regclass('oryn.rooms') AND NOT t.tgisinternal AND t.tgname = 'oryn_room_capacity'
      AND t.tgfoid = to_regprocedure('oryn.enforce_room_capacity()') AND t.tgenabled = 'O' AND t.tgtype = 7)
    AND (SELECT count(*) = 1 FROM pg_trigger t WHERE t.tgrelid = to_regclass('oryn.rooms') AND NOT t.tgisinternal
      AND t.tgfoid = to_regprocedure('oryn.enforce_room_capacity()')) AS trigger_ok,
  (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
    WHERE c.conrelid = to_regclass('oryn.rooms') AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%max_members%')
    = 'CHECK (((max_members >= 2) AND (max_members <= 10)))' AS table_ok,
  has_schema_privilege(current_user,'oryn','USAGE')
    AND has_schema_privilege(current_user,'oryn','CREATE')
    AND has_table_privilege(current_user,'supabase_migrations.schema_migrations','INSERT')
    AND has_table_privilege(current_user,'supabase_migrations.schema_migrations','DELETE')
    AND NOT EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='oryn' AND c.relkind='r' AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname=current_user)) AS permissions_ok
)
SELECT CASE WHEN history_ok AND function_ok AND trigger_ok AND table_ok AND permissions_ok
  THEN 'oryn-capacity-10-preflight-ok' ELSE 'oryn-capacity-10-preflight-FAIL' END AS result, checks.* FROM checks;
