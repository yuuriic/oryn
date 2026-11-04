-- MVP 01 — ENTRADAS DO oryn_scope, SOMENTE LEITURA. O 07_initial_state.sql dá só a contagem e o md5 do
-- oryn_scope; este script lista cada entrada, para comparar antes e depois de uma etapa entrada por entrada.
--
-- Uso na Etapa 4 (0400): rodar antes do dry-run e depois da aplicação; salvar as duas saídas em
-- integration/evidence/ (fora do Git). Critério depois da aplicação: as entradas de antes continuam
-- TODAS iguais e há exatamente 2 entradas novas, `fn:list_my_rooms()…` e `fn:close_room(uuid)…`. Qualquer
-- outra diferença = interromper. Depois do 91_rollback_0400.sql: igual à lista de antes.
-- A linha final (total e md5) usa a MESMA fórmula do 07, 11, 12 e 13: é o valor do S2 MEDIDO.
-- Sem dados de usuário: só nomes de objetos, ACL e md5 do código das funções.
-- A definição de oryn_scope é idêntica à do 07, 11, 12 e 13 (manter em sincronia; há teste).

begin;
set transaction read only;

with
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
-- Fim da definição compartilhada.
entries as (
  select pg_catalog.row_number() over (order by o) as n, o from oryn_scope
)
select n, o as entrada from entries
union all
select null, 'TOTAL ' || (select pg_catalog.count(*) from oryn_scope)::text || ' / md5 ' ||
             (select pg_catalog.md5(coalesce(pg_catalog.string_agg(o, '|' order by o), '')) from oryn_scope)
order by n nulls last;

rollback;
