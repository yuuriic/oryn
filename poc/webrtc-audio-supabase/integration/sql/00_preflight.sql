-- POC-02C.1B — PRÉ-VOO, SOMENTE LEITURA. Rodar no SQL editor (ou psql) do projeto/branch ALVO, ANTES das
-- migrações. A transação é READ ONLY e termina em ROLLBACK: qualquer escrita acidental falha.
-- Não lê nem imprime segredos (nenhuma tabela de chaves, vault ou auth.* além de metadados de catálogo).
-- Cada consulta tem o resultado ESPERADO no comentário; divergência = NO-GO até análise do arquiteto.

begin;
set transaction read only;

-- P1. Versão e papel que aplicará as migrações.
-- Esperado: PostgreSQL 17.x; current_user = postgres; rolsuper = false; rolbypassrls = qualquer (anotar).
select pg_catalog.version() as version,
       current_user,
       r.rolsuper,
       r.rolbypassrls,
       r.rolcreaterole
  from pg_catalog.pg_roles r where r.rolname = current_user;

-- P2. Banco "limpo" para a Oryn. Esperado: 0 linhas (nenhum schema oryn/oryn_realtime).
select nspname from pg_catalog.pg_namespace where nspname in ('oryn', 'oryn_realtime');

-- P3. Nenhuma função de mesmo nome já em public (conflito com CREATE FUNCTION sem OR REPLACE).
-- Esperado: 0 linhas.
select p.oid::regprocedure as existing
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('redeem_creator_invite', 'create_room', 'create_room_invite', 'revoke_room_invite',
                     'redeem_room_invite', 'join_room', 'touch_session', 'leave_room', 'get_roster',
                     'authorize_signal', 'set_signal_state', 'ack_signals');

-- P4. Dependências do Supabase usadas pelas migrações. Esperado: todas true.
select pg_catalog.to_regprocedure('auth.uid()') is not null                                   as has_auth_uid,
       pg_catalog.to_regclass('auth.users') is not null                                       as has_auth_users,
       pg_catalog.to_regclass('realtime.messages') is not null                                as has_realtime_messages,
       pg_catalog.to_regprocedure('realtime.topic()') is not null                             as has_realtime_topic,
       pg_catalog.to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null       as has_realtime_send;

-- P5. Dono de realtime.messages e capacidade do papel atual de criar políticas / ligar RLS (exige ser dono
-- ou membro do papel dono). Esperado: can_manage = true; rls_enabled = true (já vem ligado no Supabase).
select pg_catalog.pg_get_userbyid(c.relowner)                                                as owner,
       c.relrowsecurity                                                                       as rls_enabled,
       pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE')                              as can_manage
  from pg_catalog.pg_class c where c.oid = 'realtime.messages'::regclass;

-- P6. Privilégios que as migrações e o Realtime precisam. Esperado:
--   owner_send = true; owner_references_users = true;
--   authenticated_select/insert = true (o Realtime avalia RLS como o usuário); anon_* = anotar.
select pg_catalog.has_function_privilege(current_user, 'realtime.send(jsonb,text,text,boolean)', 'EXECUTE') as owner_send,
       pg_catalog.has_table_privilege(current_user, 'auth.users', 'REFERENCES')                as owner_references_users,
       pg_catalog.has_table_privilege('authenticated', 'realtime.messages', 'SELECT')         as authenticated_select,
       pg_catalog.has_table_privilege('authenticated', 'realtime.messages', 'INSERT')         as authenticated_insert,
       pg_catalog.has_table_privilege('anon', 'realtime.messages', 'SELECT')                  as anon_select,
       pg_catalog.has_table_privilege('anon', 'realtime.messages', 'INSERT')                  as anon_insert,
       pg_catalog.has_function_privilege('authenticated', 'realtime.topic()', 'EXECUTE')      as authenticated_topic,
       pg_catalog.has_function_privilege('authenticated', 'realtime.send(jsonb,text,text,boolean)', 'EXECUTE') as authenticated_send;

-- P7. Políticas já existentes em realtime.messages. Esperado: 0 linhas. Se houver política permissiva genérica
-- (ex.: "using (true)"), anotar: as barreiras restritivas da migração 0300 devem continuar fechando oryn:*.
select policyname, permissive, roles, cmd, qual, with_check
  from pg_catalog.pg_policies where schemaname = 'realtime' and tablename = 'messages';

-- P8. Privilégios PADRÃO reais (o que o shim reproduz). Anotar a saída inteira na evidência (teste #2).
select coalesce(n.nspname, '(global)') as schema,
       pg_catalog.pg_get_userbyid(d.defaclrole) as for_role,
       d.defaclobjtype as objtype,
       d.defaclacl::text as acl
  from pg_catalog.pg_default_acl d left join pg_catalog.pg_namespace n on n.oid = d.defaclnamespace
 order by 1, 2, 3;

-- P9. Schemas expostos pela Data API (configuração do PostgREST guardada no papel authenticator).
-- Esperado: pgrst.db_schemas sem 'oryn', 'oryn_realtime' nem 'realtime'. Se nada aparecer, conferir no painel
-- (Settings > Data API) e registrar a captura de tela.
select r.rolname, cfg
  from pg_catalog.pg_roles r, pg_catalog.unnest(r.rolconfig) cfg
 where r.rolname = 'authenticator' and cfg like 'pgrst.%';

-- P10. Histórico de migrações do Supabase. Esperado: tabela inexistente ou 0 linhas (projeto novo).
select pg_catalog.to_regclass('supabase_migrations.schema_migrations') as migrations_table;

-- P11. Extensões relevantes (pg_graphql expõe RPCs de public também por GraphQL; anotar).
select extname, extversion from pg_catalog.pg_extension
 where extname in ('pg_graphql', 'pgcrypto', 'pg_net', 'supabase_vault') order by 1;

rollback;
