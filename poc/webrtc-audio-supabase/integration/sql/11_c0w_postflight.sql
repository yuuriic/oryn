-- POC-02C.6A — Z9: LEITURA DE DEPOIS da C0-W, SOMENTE LEITURA. Rodar no SQL editor (ou MCP execute_sql), como
-- postgres, logo depois da C0-W (runbook §12.2). Rodar TAMBÉM antes da C0-W: a leitura de antes tem de dar
-- partições = 0 (o item 1 sai FAIL nesse caso, e é o esperado ANTES; o resto tem de ser PASS).
-- Saída: item, expected, actual, status. Status:
--   PASS / FAIL  verificação objetiva;
--   INFO         fato registrado (partições criadas e seus limites), sem critério próprio.
-- Ordenado: FAIL, INFO, PASS. Transação READ ONLY e ROLLBACK no fim.
--
-- Alterações ESPERADAS da C0-W (operacionais do Realtime, fora do nosso controle):
--   - partições diárias realtime.messages_AAAA_MM_DD (e os índices delas), criadas na 1ª conexão WebSocket.
--     Ficam FORA dos dois fingerprints por construção (07_initial_state.sql exclui as partições e seus índices).
-- Alterações INDEVIDAS (qualquer uma = FAIL e investigação antes da C2):
--   - linha em realtime.messages (o harness não publica; a recusa de entrada não grava nada);
--   - usuário, identidade, sessão de Auth, sala, membro, sessão de sala, convite, concessão, signal_log;
--   - oryn_scope ou platform diferentes do baseline (estrutura nossa ou da plataforma mudou);
--   - migração nova, ou papel cli_login_*.
-- Baselines (02C.3H/02C.5D): oryn_scope 58 objetos, md5 1a5a563de28e1e1cf2a670e5731af5a7;
--                            platform md5 4ce6437364c259fec6b5ea9646ac1359.

begin;
set transaction read only;

with
-- Mesmas definições do 07_initial_state.sql (manter em sincronia).
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
),
-- Partições com os limites do RANGE (inserted_at, timestamp sem fuso; o Realtime grava em UTC).
parts as (
  select c.relname,
         pg_catalog.pg_get_expr(c.relpartbound, c.oid) as bound,
         pg_catalog.substring(pg_catalog.pg_get_expr(c.relpartbound, c.oid), $$FROM \('([^']+)'\)$$)::timestamp as lo,
         pg_catalog.substring(pg_catalog.pg_get_expr(c.relpartbound, c.oid), $$TO \('([^']+)'\)$$)::timestamp as hi
    from pg_catalog.pg_inherits i join pg_catalog.pg_class c on c.oid = i.inhrelid
   where i.inhparent = 'realtime.messages'::regclass
),
now_utc as (select (pg_catalog.now() at time zone 'utc') as t),
checks(item, expected, actual, ok) as (
  select '1 D0: partição de realtime.messages cobrindo AGORA (UTC) — premissa da C2', '>= 1',
         (select pg_catalog.count(*)::text from parts, now_utc where now_utc.t >= parts.lo and now_utc.t < parts.hi),
         (select pg_catalog.count(*) from parts, now_utc where now_utc.t >= parts.lo and now_utc.t < parts.hi) >= 1
  union all
  select '2 realtime.messages: linhas (o harness não publica)', '0',
         (select pg_catalog.count(*)::text from realtime.messages), (select pg_catalog.count(*) from realtime.messages) = 0
  union all
  select '3 realtime.messages: RLS ligado e 4 políticas oryn_*', 'true / 4',
         (select c.relrowsecurity::text from pg_catalog.pg_class c where c.oid = 'realtime.messages'::regclass) || ' / ' ||
         (select pg_catalog.count(*)::text from pg_catalog.pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname like 'oryn\_%'),
         (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'realtime.messages'::regclass)
           and (select pg_catalog.count(*) from pg_catalog.pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname like 'oryn\_%') = 4
  union all
  select '4 auth: users / identities / sessions / refresh_tokens', '0 / 0 / 0 / 0',
         (select pg_catalog.count(*) from auth.users)::text || ' / ' || (select pg_catalog.count(*) from auth.identities)::text || ' / ' ||
         (select pg_catalog.count(*) from auth.sessions)::text || ' / ' || (select pg_catalog.count(*) from auth.refresh_tokens)::text,
         (select pg_catalog.count(*) from auth.users) + (select pg_catalog.count(*) from auth.identities)
           + (select pg_catalog.count(*) from auth.sessions) + (select pg_catalog.count(*) from auth.refresh_tokens) = 0
  union all
  select '5 oryn: rooms / room_members / room_sessions', '0 / 0 / 0',
         (select pg_catalog.count(*) from oryn.rooms)::text || ' / ' || (select pg_catalog.count(*) from oryn.room_members)::text || ' / ' ||
         (select pg_catalog.count(*) from oryn.room_sessions)::text,
         (select pg_catalog.count(*) from oryn.rooms) + (select pg_catalog.count(*) from oryn.room_members) + (select pg_catalog.count(*) from oryn.room_sessions) = 0
  union all
  select '6 oryn: room_invites / creator_invites / creator_grants', '0 / 0 / 0',
         (select pg_catalog.count(*) from oryn.room_invites)::text || ' / ' || (select pg_catalog.count(*) from oryn.creator_invites)::text || ' / ' ||
         (select pg_catalog.count(*) from oryn.creator_grants)::text,
         (select pg_catalog.count(*) from oryn.room_invites) + (select pg_catalog.count(*) from oryn.creator_invites) + (select pg_catalog.count(*) from oryn.creator_grants) = 0
  union all
  select '7 oryn: signal_log / pair_counters', '0 / 0',
         (select pg_catalog.count(*) from oryn.signal_log)::text || ' / ' || (select pg_catalog.count(*) from oryn.pair_counters)::text,
         (select pg_catalog.count(*) from oryn.signal_log) + (select pg_catalog.count(*) from oryn.pair_counters) = 0
  union all
  select '8 oryn_scope: objetos / md5 (baseline pós-0300)', '58 / 1a5a563de28e1e1cf2a670e5731af5a7',
         (select pg_catalog.count(*)::text from oryn_scope) || ' / ' || (select pg_catalog.md5(coalesce(pg_catalog.string_agg(o, '|' order by o), '')) from oryn_scope),
         (select pg_catalog.count(*) from oryn_scope) = 58
           and (select pg_catalog.md5(coalesce(pg_catalog.string_agg(o, '|' order by o), '')) from oryn_scope) = '1a5a563de28e1e1cf2a670e5731af5a7'
  union all
  select '9 platform: md5 (sem partições e seus índices)', '4ce6437364c259fec6b5ea9646ac1359',
         (select pg_catalog.md5(coalesce(pg_catalog.string_agg(o, '|' order by o), '')) from platform),
         (select pg_catalog.md5(coalesce(pg_catalog.string_agg(o, '|' order by o), '')) from platform) = '4ce6437364c259fec6b5ea9646ac1359'
  union all
  select '10 migrações (supabase_migrations.schema_migrations)', '20261023000100,20261023000200,20261023000300',
         (select coalesce(pg_catalog.string_agg(version, ',' order by version), '') from supabase_migrations.schema_migrations),
         (select coalesce(pg_catalog.string_agg(version, ',' order by version), '') from supabase_migrations.schema_migrations)
           = '20261023000100,20261023000200,20261023000300'
  union all
  select '11 papéis cli_login_*', '(nenhum)',
         coalesce((select pg_catalog.string_agg(rolname, ',' order by rolname) from pg_catalog.pg_roles where rolname like 'cli\_login\_%'), '(nenhum)'),
         not exists (select 1 from pg_catalog.pg_roles where rolname like 'cli\_login\_%')
)
select * from (
select item, expected, actual, case when ok then 'PASS' else 'FAIL' end as status from checks
union all
select 'INFO partições criadas (esperado: só realtime.messages_AAAA_MM_DD)', '-',
       coalesce((select pg_catalog.string_agg(relname || ' ' || bound, '; ' order by lo) from parts), '(nenhuma)'), 'INFO'
union all
select 'INFO partições fora do padrão de nome messages_AAAA_MM_DD', '0',
       (select pg_catalog.count(*)::text from parts where relname !~ '^messages_\d{4}_\d{2}_\d{2}$'),
       case when exists (select 1 from parts where relname !~ '^messages_\d{4}_\d{2}_\d{2}$') then 'FAIL' else 'INFO' end
union all
select 'INFO agora (UTC)', '-', (select t::text from now_utc), 'INFO'
) r
order by r.status = 'PASS', r.status = 'INFO', pg_catalog.substring(r.item, '^\d+')::int nulls last, r.item;

rollback;
