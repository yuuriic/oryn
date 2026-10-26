-- POC-02C.3A.1 — EFEITOS COLATERAIS DA CLI, SOMENTE LEITURA. Rodar no SQL editor (ou MCP) ANTES e DEPOIS
-- de cada `supabase db push` (com ou sem --dry-run). Uma linha por item, com o valor atual.
--
-- Esperado:
--   antes e depois do --dry-run (sem nada aplicado): cli_login_roles = {}; supabase_migrations = false;
--     history = {}  → prova que o dry-run NÃO gravou nada e não criou o papel temporário;
--   depois da Etapa N aplicada: cli_login_roles = {}; supabase_migrations = true; history = as N versões.
-- Qualquer cli_login_* = INTERROMPER (a CLI rodou sem a senha explícita; o papel é gerido pela plataforma e só
-- sai pela Management API — ver DEPLOY-CHECKLIST-02C.md, seção 1).

begin;
set transaction read only;

select 'cli_login_roles' as item,
       coalesce((select pg_catalog.array_agg(rolname::text order by rolname)
                   from pg_catalog.pg_roles where rolname like 'cli\_login\_%'), '{}')::text as actual
union all
select 'supabase_migrations (schema existe)',
       (pg_catalog.to_regnamespace('supabase_migrations') is not null)::text
union all
-- A tabela pode não existir: a consulta dinâmica só roda quando ela existe (CASE é avaliado em ordem).
select 'history (versões em supabase_migrations.schema_migrations)',
       case when pg_catalog.to_regclass('supabase_migrations.schema_migrations') is null then '{}'
            else (select coalesce(pg_catalog.array_agg(x::text order by x::text), '{}')
                    from pg_catalog.unnest(pg_catalog.xpath('//version/text()',
                           pg_catalog.query_to_xml('select version from supabase_migrations.schema_migrations', false, false, ''))) x)::text
       end;

rollback;
