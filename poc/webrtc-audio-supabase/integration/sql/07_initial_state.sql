-- POC-02C.3A.1 — REGISTRO AUDITÁVEL DO ESTADO, SOMENTE LEITURA. Substitui o `supabase db dump` (que exige
-- Docker) como registro do estado ANTES da Etapa 1.
--
-- ⚠ NÃO É BACKUP: não contém dados nem definições completas e NÃO permite restaurar nada. Serve para
--   (1) provar o estado de partida e (2) comparar depois de uma reversão (90_rollback.sql).
--
-- Uso: rodar no SQL editor (ou MCP execute_sql), copiar a linha JSON para
-- integration/evidence/estado-inicial-<data>.json (pasta fora do Git). Comparar depois da reversão:
-- `oryn_scope_fingerprint` tem de voltar ao valor inicial.
--
-- 02C.3B.1 — o que cada campo pode fazer (tabela completa em DEPLOY-CHECKLIST-02C.md, seção 1c):
--   oryn_scope_fingerprint   muda a cada etapa APLICADA; nunca num dry-run; volta ao inicial após o 90_rollback.
--   platform_fingerprint     relações do Supabase (auth, storage, realtime…) SEM as duas mudanças esperadas
--                            abaixo. Não deve mudar em nenhum momento: mudou = INTERROMPER e investigar.
--   supabase_migrations_relacoes  [] até a Etapa 1; depois, exatamente schema_migrations (r) e
--                            schema_migrations_pkey (i), criados pelo `db push`. Ficam após a reversão.
--   realtime_messages.particoes   pode crescer: as partições diárias são criadas pelo serviço Realtime.
-- Excluir esses dois conjuntos não altera o valor registrado antes de existirem (ambos vazios).

begin;
set transaction read only;

with
-- Objetos no escopo da Oryn: schemas public/oryn/oryn_realtime e políticas oryn_* em realtime.messages.
oryn_scope as (
  select 'rel:' || n.nspname || '.' || c.relname || ':' || c.relkind::text as o
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'oryn', 'oryn_realtime')
  union all
  select 'fn:' || p.oid::regprocedure::text || ':' || pg_catalog.md5(coalesce(p.proacl::text, '') || p.prosrc)
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'oryn', 'oryn_realtime')
  union all
  select 'schema:' || nspname || ':' || coalesce(nspacl::text, '') from pg_catalog.pg_namespace
   where nspname in ('public', 'oryn', 'oryn_realtime')
  union all
  select 'policy:' || schemaname || '.' || tablename || '.' || policyname from pg_catalog.pg_policies
   where schemaname in ('public', 'oryn', 'oryn_realtime') or (schemaname = 'realtime' and tablename = 'messages')
  union all
  select 'defacl:' || coalesce(n.nspname, '-') || ':' || d.defaclobjtype::text || ':' || d.defaclacl::text
    from pg_catalog.pg_default_acl d left join pg_catalog.pg_namespace n on n.oid = d.defaclnamespace
   where n.nspname in ('public', 'oryn', 'oryn_realtime')
),
-- Partições de realtime.messages (e os índices delas): criadas pelo serviço Realtime, fora do nosso controle.
realtime_partitions as (
  select i.inhrelid as oid from pg_catalog.pg_inherits i where i.inhparent = 'realtime.messages'::regclass
  union all
  select x.indexrelid from pg_catalog.pg_index x join pg_catalog.pg_inherits i on i.inhrelid = x.indrelid
   where i.inhparent = 'realtime.messages'::regclass
),
platform as (
  select n.nspname || '.' || c.relname || ':' || c.relkind::text as o
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname not in ('public', 'oryn', 'oryn_realtime', 'supabase_migrations', 'pg_catalog', 'information_schema', 'pg_toast')
     and n.nspname not like 'pg_temp%' and n.nspname not like 'pg_toast_temp%'
     and c.oid not in (select oid from realtime_partitions)
)
select pg_catalog.json_build_object(
  'aviso', 'registro de estado; NÃO é backup',
  'registrado_em', pg_catalog.now(),
  'banco', pg_catalog.current_database(),
  'versao', pg_catalog.version(),
  'papel', current_user,
  'schemas_oryn', (select coalesce(pg_catalog.json_agg(nspname order by nspname), '[]') from pg_catalog.pg_namespace where nspname in ('oryn', 'oryn_realtime')),
  'public', pg_catalog.json_build_object(
     'funcoes', (select pg_catalog.count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'),
     'relacoes', (select pg_catalog.count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public')),
  'realtime_messages', (select pg_catalog.json_build_object('dono', pg_catalog.pg_get_userbyid(relowner), 'rls', relrowsecurity,
       'politicas', (select pg_catalog.count(*) from pg_catalog.pg_policies where schemaname = 'realtime' and tablename = 'messages'),
       'particoes', (select pg_catalog.count(*) from pg_catalog.pg_inherits where inhparent = 'realtime.messages'::regclass))
     from pg_catalog.pg_class where oid = 'realtime.messages'::regclass),
  'auth_users', (select pg_catalog.count(*) from auth.users),
  'cli_login_roles', (select coalesce(pg_catalog.json_agg(rolname order by rolname), '[]') from pg_catalog.pg_roles where rolname like 'cli\_login\_%'),
  'supabase_migrations', pg_catalog.to_regnamespace('supabase_migrations') is not null,
  'supabase_migrations_relacoes', (select coalesce(pg_catalog.json_agg(c.relname || ':' || c.relkind::text order by c.relname), '[]')
       from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = 'supabase_migrations'),
  'extensoes', (select pg_catalog.json_agg(extname || '@' || extversion order by extname) from pg_catalog.pg_extension),
  'oryn_scope_objetos', (select pg_catalog.count(*) from oryn_scope),
  'oryn_scope_fingerprint', (select pg_catalog.md5(coalesce(pg_catalog.string_agg(o, '|' order by o), '')) from oryn_scope),
  'platform_fingerprint', (select pg_catalog.md5(coalesce(pg_catalog.string_agg(o, '|' order by o), '')) from platform)
) as estado;

rollback;
