-- POC-02C.2B — VERIFICAÇÃO ENTRE MIGRAÇÕES, SOMENTE LEITURA. Rodar depois de CADA passo da aplicação
-- (0100, depois 0200, depois 0300), antes do próximo. Tolera objetos que ainda não existem.
-- Saída: step, item, status (PASS/FAIL/PENDING). PENDING = pertence a um passo ainda não aplicado.
-- Critério do passo N: nenhuma linha FAIL e nenhuma linha PENDING com step <= N.
-- O pós-voo completo (01_postflight.sql) vem só depois do passo 3.

begin;
set transaction read only;

with
tables(t) as (values ('creator_grants'), ('creator_invites'), ('rooms'), ('room_members'), ('room_invites'),
                     ('room_sessions'), ('pair_counters'), ('signal_log')),
client_roles(r) as (values ('anon'), ('authenticated'), ('service_role')),
has_oryn as (select pg_catalog.to_regnamespace('oryn') is not null as ok),
has_fns as (select pg_catalog.to_regprocedure('public.join_room(uuid)') is not null as ok),
c(step, item, ok, present) as (
  -- Passo 1 (0100): schema, tabelas, RLS, nenhum acesso de cliente.
  select 1, 'oryn: 8 tabelas',
         (select pg_catalog.count(*) = 8 from pg_catalog.pg_class k join pg_catalog.pg_namespace n on n.oid = k.relnamespace
           where n.nspname = 'oryn' and k.relkind = 'r'), (select ok from has_oryn)
  union all
  select 1, 'oryn.' || t || ': RLS ligado e dono = ' || current_user,
         coalesce((select k.relrowsecurity and k.relowner = (select oid from pg_catalog.pg_roles where rolname = current_user)
                     from pg_catalog.pg_class k where k.oid = pg_catalog.to_regclass('oryn.' || t)), false),
         (select ok from has_oryn)
    from tables
  union all
  select 1, 'nenhum privilégio de ' || r || ' nas tabelas de oryn',
         not exists (select 1 from pg_catalog.pg_class k join pg_catalog.pg_namespace n on n.oid = k.relnamespace,
                            pg_catalog.aclexplode(coalesce(k.relacl, pg_catalog.acldefault('r', k.relowner))) a
                      where n.nspname = 'oryn' and a.grantee = (select oid from pg_catalog.pg_roles where rolname = r)),
         (select ok from has_oryn)
    from client_roles
  union all
  select 1, 'sem USAGE de ' || r || ' no schema oryn',
         case when (select ok from has_oryn) then not pg_catalog.has_schema_privilege(r, 'oryn', 'USAGE') else false end,
         (select ok from has_oryn)
    from client_roles
  union all
  -- Passo 2 (0200): exatamente as 12 RPCs, EXECUTE do contrato, search_path vazio.
  select 2, 'public: exatamente 12 funções, todas SECURITY DEFINER com search_path vazio',
         (select pg_catalog.count(*) = 12 and pg_catalog.bool_and(p.prosecdef and 'search_path=""' = any (coalesce(p.proconfig, '{}')))
            from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'),
         (select ok from has_fns)
  union all
  select 2, 'anon sem EXECUTE em nenhuma função de public/oryn/oryn_realtime',
         not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                      where n.nspname in ('public', 'oryn', 'oryn_realtime') and pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')),
         (select ok from has_fns)
  union all
  select 2, 'set_signal_state só para service_role',
         case when (select ok from has_fns) then
           pg_catalog.has_function_privilege('service_role', 'public.set_signal_state(uuid,text)', 'EXECUTE')
           and not pg_catalog.has_function_privilege('authenticated', 'public.set_signal_state(uuid,text)', 'EXECUTE')
         else false end,
         (select ok from has_fns)
  union all
  select 2, 'can_receive_topic: authenticated sim, anon não',
         case when pg_catalog.to_regprocedure('oryn_realtime.can_receive_topic(text)') is not null then
           pg_catalog.has_function_privilege('authenticated', 'oryn_realtime.can_receive_topic(text)', 'EXECUTE')
           and not pg_catalog.has_function_privilege('anon', 'oryn_realtime.can_receive_topic(text)', 'EXECUTE')
         else false end,
         (select ok from has_fns)
  union all
  -- Passo 3 (0300): 4 políticas da Oryn (3 restritivas) e RLS de realtime.messages intocado.
  select 3, 'realtime.messages: 4 políticas oryn_* (3 restritivas)',
         (select pg_catalog.count(*) = 4 and pg_catalog.count(*) filter (where permissive = 'RESTRICTIVE') = 3
            from pg_catalog.pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname like 'oryn_%'),
         exists (select 1 from pg_catalog.pg_policies where schemaname = 'realtime' and policyname like 'oryn_%')
  union all
  select 3, 'realtime.messages: RLS ligado',
         (select relrowsecurity from pg_catalog.pg_class where oid = 'realtime.messages'::regclass),
         exists (select 1 from pg_catalog.pg_policies where schemaname = 'realtime' and policyname like 'oryn_%')
)
select step, item, case when not present then 'PENDING' when ok then 'PASS' else 'FAIL' end as status
  from c
 order by step, (case when not present then 'PENDING' when ok then 'PASS' else 'FAIL' end) <> 'FAIL', item;

rollback;
