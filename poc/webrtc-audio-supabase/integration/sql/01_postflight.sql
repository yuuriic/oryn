-- POC-02C.1B — PÓS-VOO, SOMENTE LEITURA. Rodar logo DEPOIS das migrações, no mesmo projeto/branch, como o
-- papel que aplicou as migrações (postgres). Reproduz no catálogo REAL as asserções dos testes locais.
-- Saída: item, expected, actual, status. status:
--   PASS / FAIL    — verificação objetiva no catálogo;
--   NOT VERIFIED   — o catálogo não basta (ex.: schemas da Data API); exige painel ou harness. NUNCA conta como PASS;
--   INFO           — fato do Supabase registrado na evidência (ex.: EXECUTE padrão em realtime.send).
-- Critério (02C.2B): ZERO linhas FAIL; cada NOT VERIFIED resolvido pela evidência indicada no item.
-- Ordenado: FAIL, NOT VERIFIED, INFO, PASS. Transação READ ONLY e ROLLBACK no fim.

begin;
set transaction read only;

with
user_rpcs(sig) as (values
  ('public.redeem_creator_invite(text)'), ('public.create_room(text,text,integer)'),
  ('public.create_room_invite(uuid,integer)'), ('public.revoke_room_invite(uuid)'),
  ('public.redeem_room_invite(text,text)'), ('public.join_room(uuid)'), ('public.touch_session(uuid)'),
  ('public.leave_room(uuid)'), ('public.get_roster(uuid)'),
  ('public.authorize_signal(uuid,uuid,uuid,text,integer,integer)'), ('public.ack_signals(uuid,uuid[])')),
internal_fns(sig) as (values
  ('oryn.admin_issue_creator_invite(integer,integer)'), ('oryn.publish_control(uuid,uuid,text,jsonb)'),
  ('oryn.new_token()'), ('oryn.token_hash(text)'), ('oryn.is_active_member(uuid,uuid)'), ('oryn.require_uid()')),
client_roles(role) as (values ('anon'), ('authenticated'), ('service_role')),
table_privs(priv) as (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')),
domain_tables(t) as (
  select c.oid::regclass::text from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'oryn' and c.relkind = 'r'),
-- proacl NULL significa "privilégios padrão" (PUBLIC executa): por isso acldefault no lugar do NULL.
fn_acl as (
  select p.oid, a.grantee, a.privilege_type
    from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a),
checks(item, expected, actual) as (
  select 'EXECUTE authenticated ' || sig, true, pg_catalog.has_function_privilege('authenticated', sig, 'EXECUTE') from user_rpcs
  union all
  select 'EXECUTE anon ' || sig, false, pg_catalog.has_function_privilege('anon', sig, 'EXECUTE') from user_rpcs
  union all
  select 'EXECUTE PUBLIC ' || sig, false,
         exists (select 1 from fn_acl f where f.oid = sig::regprocedure and f.grantee = 0 and f.privilege_type = 'EXECUTE')
    from user_rpcs
  union all
  select 'EXECUTE service_role public.set_signal_state', true,
         pg_catalog.has_function_privilege('service_role', 'public.set_signal_state(uuid,text)', 'EXECUTE')
  union all
  select 'EXECUTE ' || role || ' public.set_signal_state', false,
         pg_catalog.has_function_privilege(role, 'public.set_signal_state(uuid,text)', 'EXECUTE')
    from client_roles where role <> 'service_role'
  union all
  select 'EXECUTE PUBLIC public.set_signal_state', false,
         exists (select 1 from fn_acl f where f.oid = 'public.set_signal_state(uuid,text)'::regprocedure and f.grantee = 0)
  union all
  select 'EXECUTE ' || role || ' ' || sig, false, pg_catalog.has_function_privilege(role, sig, 'EXECUTE')
    from internal_fns, client_roles
  union all
  select 'EXECUTE authenticated oryn_realtime.can_receive_topic', true,
         pg_catalog.has_function_privilege('authenticated', 'oryn_realtime.can_receive_topic(text)', 'EXECUTE')
  union all
  select 'EXECUTE ' || role || ' oryn_realtime.can_receive_topic', false,
         pg_catalog.has_function_privilege(role, 'oryn_realtime.can_receive_topic(text)', 'EXECUTE')
    from client_roles where role <> 'authenticated'
  union all
  select 'USAGE ' || role || ' schema oryn', false, pg_catalog.has_schema_privilege(role, 'oryn', 'USAGE') from client_roles
  union all
  select 'USAGE authenticated schema oryn_realtime', true, pg_catalog.has_schema_privilege('authenticated', 'oryn_realtime', 'USAGE')
  union all
  select 'USAGE ' || role || ' schema oryn_realtime', false, pg_catalog.has_schema_privilege(role, 'oryn_realtime', 'USAGE')
    from client_roles where role <> 'authenticated'
  union all
  select priv || ' ' || role || ' ' || t, false, pg_catalog.has_table_privilege(role, t, priv)
    from domain_tables, client_roles, table_privs
  union all
  select 'tabelas de domínio = 8', true, (select pg_catalog.count(*) = 8 from domain_tables)
  union all
  select 'RLS ligado em ' || t, true, (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = t::regclass)
    from domain_tables
  union all
  select 'nenhuma política no schema oryn', true,
         not exists (select 1 from pg_catalog.pg_policies where schemaname = 'oryn')
  union all
  select 'política ' || pol || ' em realtime.messages', true,
         exists (select 1 from pg_catalog.pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = pol)
    from (values ('oryn_receive_own_session_topic'), ('oryn_topics_read_guard'), ('oryn_topics_read_guard_anon'),
                 ('oryn_topics_no_client_write')) v(pol)
  union all
  select 'políticas restritivas da Oryn = 3', true,
         (select pg_catalog.count(*) = 3 from pg_catalog.pg_policies
           where schemaname = 'realtime' and tablename = 'messages' and policyname like 'oryn_%' and permissive = 'RESTRICTIVE')
  union all
  select 'RLS ligado em realtime.messages', true,
         (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'realtime.messages'::regclass)
  union all
  select 'SECURITY DEFINER com search_path vazio: ' || p.oid::regprocedure::text, true,
         coalesce('search_path=""' = any (p.proconfig), false)
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where p.prosecdef and (n.nspname in ('oryn', 'oryn_realtime')
                          or p.oid in (select sig::regprocedure from user_rpcs)
                          or p.oid = 'public.set_signal_state(uuid,text)'::regprocedure)
  union all
  -- Auditoria 02C.1B.0A: o conjunto exposto em public é EXATAMENTE o contrato (num projeto novo, public
  -- começa vazio; qualquer função a mais precisa de revisão antes de seguir).
  select 'public contém só as 12 RPCs do contrato', true,
         (select pg_catalog.count(*) = 12 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public')
         and not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'public' and not p.prosecdef)
  union all
  select 'PUBLIC sem EXECUTE em ' || p.oid::regprocedure::text, false,
         exists (select 1 from fn_acl f where f.oid = p.oid and f.grantee = 0 and f.privilege_type = 'EXECUTE')
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('oryn', 'oryn_realtime', 'public')
  union all
  select 'RPC de usuário deriva o chamador de oryn.require_uid(): ' || sig, true,
         (select p.prosrc ~ 'v_uid uuid := oryn\.require_uid\(\)' from pg_catalog.pg_proc p where p.oid = sig::regprocedure)
    from user_rpcs
  union all
  select 'tabelas de oryn sem FORCE ROW LEVEL SECURITY (proteção = lógica das RPCs)', true,
         not exists (select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'oryn' and c.relforcerowsecurity)
  union all
  select 'anon/authenticated não herdam de nenhum papel', true,
         not exists (select 1 from pg_catalog.pg_auth_members m
                      where pg_catalog.pg_get_userbyid(m.member) in ('anon', 'authenticated'))
  union all
  -- 02C.2B: compensações do EXECUTE padrão de realtime.send (INFO abaixo). O cliente pode até executar a
  -- função se alcançar SQL, mas a barreira restritiva nega a escrita em oryn:* para anon e authenticated.
  select 'barreira restritiva de escrita em oryn:* cobre anon e authenticated', true,
         exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'realtime' and tablename = 'messages' and policyname = 'oryn_topics_no_client_write'
                    and permissive = 'RESTRICTIVE' and cmd = 'INSERT'
                    and roles @> array['anon', 'authenticated']::name[])
  union all
  select 'tabelas da Oryn pertencem ao papel que migrou (' || current_user || ')', true,
         not exists (select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'oryn' and c.relkind = 'r' and c.relowner <> (select oid from pg_catalog.pg_roles where rolname = current_user))
  union all
  -- 02C.2B (M5): travas por linha que serializam a mesma sessão/usuário sem impasse com as chaves estrangeiras.
  select 'join_room trava a linha de membro (FOR NO KEY UPDATE) antes de contar sessões', true,
         (select p.prosrc ~* 'from oryn\.room_members m.*for no key update.*count' from pg_catalog.pg_proc p where p.oid = 'public.join_room(uuid)'::regprocedure)
  union all
  select 'authorize_signal trava a sessão remetente (FOR NO KEY UPDATE)', true,
         (select p.prosrc ~* 's\.id = p_session_id and s\.user_id = v_uid and s\.revoked_at is null\s+for no key update' from pg_catalog.pg_proc p
           where p.oid = 'public.authorize_signal(uuid,uuid,uuid,text,integer,integer)'::regprocedure)
  union all
  select 'nenhuma coluna de payload/SDP/ICE em oryn', true,
         not exists (select 1 from information_schema.columns
                      where table_schema = 'oryn' and column_name ~* '(sdp|candidate|payload$|ice|ip_|address)')
),
db_schemas as (
  select cfg from pg_catalog.pg_roles r, pg_catalog.unnest(r.rolconfig) cfg
   where r.rolname = 'authenticator' and cfg like 'pgrst.db_schemas=%'),
-- Itens que o catálogo não decide sozinho, ou fatos do Supabase a registrar.
notes(item, expected, actual, status) as (
  select 'Data API: schemas expostos sem oryn/oryn_realtime/realtime',
         'só public, graphql_public',
         coalesce((select pg_catalog.string_agg(cfg, '; ') from db_schemas), 'configuração fora do banco'),
         case
           when not exists (select 1 from db_schemas) then 'NOT VERIFIED' -- painel Settings > Data API + teste #3
           when exists (select 1 from db_schemas where cfg ~ '(^|[=, ])(oryn|oryn_realtime|realtime)($|[, ])') then 'FAIL'
           else 'PASS' end
  union all
  select 'Realtime: "Allow public access" desligado', 'desligado', 'configuração fora do banco', 'NOT VERIFIED' -- painel + teste #7
  union all
  select 'realtime.send: EXECUTE para anon/authenticated (padrão do Supabase)', 'informativo',
         'anon=' || pg_catalog.has_function_privilege('anon', 'realtime.send(jsonb,text,text,boolean)', 'EXECUTE')::text
           || ', authenticated=' || pg_catalog.has_function_privilege('authenticated', 'realtime.send(jsonb,text,text,boolean)', 'EXECUTE')::text,
         'INFO'
  union all
  select 'realtime.messages: dono (gerido pelo Supabase; a migração não altera)', 'informativo',
         (select pg_catalog.pg_get_userbyid(c.relowner)::text from pg_catalog.pg_class c where c.oid = 'realtime.messages'::regclass), 'INFO'
  union all
  select 'realtime.messages: políticas PERMISSIVAS de INSERT de terceiros', 'informativo (oryn:* fica negado pela barreira)',
         (select pg_catalog.count(*)::text from pg_catalog.pg_policies
           where schemaname = 'realtime' and tablename = 'messages' and permissive = 'PERMISSIVE' and cmd in ('INSERT', 'ALL')
             and policyname not like 'oryn_%'), 'INFO'
  union all
  select 'realtime.messages: partições existentes (sem partição, realtime.send perde o evento em silêncio)', 'informativo',
         (select pg_catalog.count(*)::text from pg_catalog.pg_inherits where inhparent = 'realtime.messages'::regclass), 'INFO'
)
select item, expected, actual, status from (
  select item, expected::text as expected, actual::text as actual,
         case when expected is not distinct from actual then 'PASS' else 'FAIL' end as status
    from checks
  union all
  select item, expected, actual, status from notes
) r
 order by array_position(array['FAIL', 'NOT VERIFIED', 'INFO', 'PASS'], r.status), r.item;

rollback;
