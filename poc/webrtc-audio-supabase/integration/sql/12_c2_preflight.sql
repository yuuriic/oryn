-- POC-02C.7P-A — LEITURA DE ANTES da C2 com contas preexistentes (caminho P), SOMENTE LEITURA. Rodar no SQL
-- editor (ou MCP execute_sql), como postgres, no MESMO DIA (UTC) da C2 e ANTES de emitir o convite de criador.
-- Também é a verificação do provisionamento (G3): rodar logo depois de criar as 3 contas no painel.
-- Saída: item, expected, actual, status. Status:
--   PASS / FAIL  verificação objetiva;
--   INFO         fato registrado (dados anteriores à execução; contas sem dado pessoal), sem critério próprio.
-- Ordenado: FAIL, INFO, PASS. Transação READ ONLY e ROLLBACK no fim.
--
-- Contas de teste: o projeto da POC só pode ter as 3 contas criadas pelo operador (dono, membro, estranho).
-- Por isso o critério é sobre TODO o auth.users: qualquer conta a mais (inclusive cadastro de terceiros pelo
-- cadastro por e-mail aberto) é FAIL. Nenhum e-mail, senha ou JWT é impresso: só contagens, booleanos, os 8
-- primeiros caracteres do id e uma impressão do e-mail (md5, 8 hex) para comparar entre leituras.
-- Sessão de Auth "ativa": linha em auth.sessions não vencida (not_after) com refresh token não revogado. Linhas
-- encerradas podem continuar na tabela: a contagem não pressupõe que o logout apague nada.
-- Baselines (MVP 01, pós-0400; medidos no projeto em 2026-10-28 22:48 UTC pelo 08_scope_entries.sql):
--   oryn_scope 60 objetos, md5 787129706368d4c3ed93a8d5a07429af; platform md5 4ce6437364c259fec6b5ea9646ac1359;
--   migrações 0100–0400. Antes da 0400 (02C.3H/02C.5D): oryn_scope 58 / 1a5a563de28e1e1cf2a670e5731af5a7.

begin;
set transaction read only;

with
-- Mesmas definições do 07_initial_state.sql (manter em sincronia; também com 11 e 13).
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
parts as (
  select c.relname,
         pg_catalog.substring(pg_catalog.pg_get_expr(c.relpartbound, c.oid), $$FROM \('([^']+)'\)$$)::timestamp as lo,
         pg_catalog.substring(pg_catalog.pg_get_expr(c.relpartbound, c.oid), $$TO \('([^']+)'\)$$)::timestamp as hi
    from pg_catalog.pg_inherits i join pg_catalog.pg_class c on c.oid = i.inhrelid
   where i.inhparent = 'realtime.messages'::regclass
),
now_utc as (select (pg_catalog.now() at time zone 'utc') as t),
-- Contas e identidades (mesmas definições do 13_c2_postflight.sql).
accounts as (
  select u.id, u.email, u.created_at, u.last_sign_in_at,
         coalesce(u.is_anonymous, false) as is_anonymous,
         u.email_confirmed_at is not null as confirmed,
         u.deleted_at is null and (u.banned_until is null or u.banned_until <= pg_catalog.now()) and not coalesce(u.is_sso_user, false) as usable,
         (select pg_catalog.count(*) from auth.identities i where i.user_id = u.id) as identities,
         (select pg_catalog.count(*) from auth.identities i where i.user_id = u.id and i.provider = 'email') as email_identities
    from auth.users u
),
active_sessions as (
  select s.id, s.user_id from auth.sessions s
   where (s.not_after is null or s.not_after > pg_catalog.now())
     and exists (select 1 from auth.refresh_tokens r where r.session_id = s.id and not coalesce(r.revoked, false))
),
oryn_msgs as (
  select m.event, m.payload, m.private, m.topic from realtime.messages m where pg_catalog.lower(m.topic) like 'oryn:%'
),
checks(item, expected, actual, ok) as (
  select 'A1 contas: auth.users (o projeto da POC só tem as 3 contas de teste)', '3',
         (select pg_catalog.count(*)::text from accounts), (select pg_catalog.count(*) from accounts) = 3
  union all
  select 'A2 contas não anônimas / anônimas', '3 / 0',
         (select pg_catalog.count(*) filter (where not is_anonymous)::text || ' / ' || pg_catalog.count(*) filter (where is_anonymous)::text from accounts),
         (select pg_catalog.count(*) filter (where not is_anonymous) = 3 and pg_catalog.count(*) filter (where is_anonymous) = 0 from accounts)
  union all
  select 'A3 e-mails confirmados', '3',
         (select pg_catalog.count(*) filter (where confirmed)::text from accounts), (select pg_catalog.count(*) filter (where confirmed) = 3 from accounts)
  union all
  select 'A4 e-mails presentes e distintos (sem diferenciar maiúsculas)', '3',
         (select pg_catalog.count(distinct pg_catalog.lower(email))::text from accounts where email is not null and email <> ''),
         (select pg_catalog.count(distinct pg_catalog.lower(email)) = 3 from accounts where email is not null and email <> '')
  union all
  select 'A5 contas utilizáveis (sem banimento ativo, não apagadas, não SSO)', '3',
         (select pg_catalog.count(*) filter (where usable)::text from accounts), (select pg_catalog.count(*) filter (where usable) = 3 from accounts)
  union all
  select 'A6 identidades: total / provedor email / contas com exatamente 1 (email)', '3 / 3 / 3',
         (select pg_catalog.count(*) from auth.identities)::text || ' / ' ||
         (select pg_catalog.count(*) from auth.identities where provider = 'email')::text || ' / ' ||
         (select pg_catalog.count(*) from accounts where identities = 1 and email_identities = 1)::text,
         (select pg_catalog.count(*) from auth.identities) = 3 and (select pg_catalog.count(*) from auth.identities where provider = 'email') = 3
           and (select pg_catalog.count(*) from accounts where identities = 1 and email_identities = 1) = 3
  union all
  select 'A7 sessões de Auth ATIVAS (antes da execução, nenhuma conta logada)', '0',
         (select pg_catalog.count(*)::text from active_sessions), (select pg_catalog.count(*) from active_sessions) = 0
  union all
  select 'D1 D0: partição de realtime.messages cobrindo AGORA (UTC)', '>= 1',
         (select pg_catalog.count(*)::text from parts, now_utc where now_utc.t >= parts.lo and now_utc.t < parts.hi),
         (select pg_catalog.count(*) from parts, now_utc where now_utc.t >= parts.lo and now_utc.t < parts.hi) >= 1
  union all
  select 'D2 salas ABERTAS (com uma, create_room recusa: limit-reached)', '0',
         (select pg_catalog.count(*)::text from oryn.rooms where closed_at is null), not exists (select 1 from oryn.rooms where closed_at is null)
  union all
  select 'D3 convites de criador UTILIZÁVEIS (não usados, não revogados, no prazo) antes da emissão', '0',
         (select pg_catalog.count(*)::text from oryn.creator_invites where used_at is null and revoked_at is null and expires_at > pg_catalog.now()),
         not exists (select 1 from oryn.creator_invites where used_at is null and revoked_at is null and expires_at > pg_catalog.now())
  union all
  select 'D4 sessões de sala VIVAS (não revogadas, batimento < 90 s)', '0',
         (select pg_catalog.count(*)::text from oryn.room_sessions where revoked_at is null and last_seen_at > pg_catalog.now() - interval '90 seconds'),
         not exists (select 1 from oryn.room_sessions where revoked_at is null and last_seen_at > pg_catalog.now() - interval '90 seconds')
  union all
  select 'D5 realtime.messages em oryn:*: evento fora de hello/bye / payload com chave fora de {id, session_id, label} / tópico não minúsculo / não privado', '0 / 0 / 0 / 0',
         (select pg_catalog.count(*) from oryn_msgs where event is distinct from 'hello' and event is distinct from 'bye')::text || ' / ' ||
         (select pg_catalog.count(*) from oryn_msgs where exists (select 1 from pg_catalog.jsonb_object_keys(case when pg_catalog.jsonb_typeof(payload) = 'object' then payload else '{}'::jsonb end) k where k not in ('id', 'session_id', 'label')) or pg_catalog.jsonb_typeof(payload) is distinct from 'object')::text || ' / ' ||
         (select pg_catalog.count(*) from oryn_msgs where topic <> pg_catalog.lower(topic))::text || ' / ' ||
         (select pg_catalog.count(*) from oryn_msgs where private is distinct from true)::text,
         not exists (select 1 from oryn_msgs where event is distinct from 'hello' and event is distinct from 'bye')
           and not exists (select 1 from oryn_msgs where exists (select 1 from pg_catalog.jsonb_object_keys(case when pg_catalog.jsonb_typeof(payload) = 'object' then payload else '{}'::jsonb end) k where k not in ('id', 'session_id', 'label')) or pg_catalog.jsonb_typeof(payload) is distinct from 'object')
           and not exists (select 1 from oryn_msgs where topic <> pg_catalog.lower(topic))
           and not exists (select 1 from oryn_msgs where private is distinct from true)
  union all
  select 'S1 realtime.messages: RLS ligado e 4 políticas oryn_*', 'true / 4',
         (select c.relrowsecurity::text from pg_catalog.pg_class c where c.oid = 'realtime.messages'::regclass) || ' / ' ||
         (select pg_catalog.count(*)::text from pg_catalog.pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname like 'oryn\_%'),
         (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'realtime.messages'::regclass)
           and (select pg_catalog.count(*) from pg_catalog.pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname like 'oryn\_%') = 4
  union all
  select 'S2 oryn_scope: objetos / md5 (baseline pós-0400)', '60 / 787129706368d4c3ed93a8d5a07429af',
         (select pg_catalog.count(*)::text from oryn_scope) || ' / ' || (select pg_catalog.md5(coalesce(pg_catalog.string_agg(o, '|' order by o), '')) from oryn_scope),
         (select pg_catalog.count(*) from oryn_scope) = 60
           and (select pg_catalog.md5(coalesce(pg_catalog.string_agg(o, '|' order by o), '')) from oryn_scope) = '787129706368d4c3ed93a8d5a07429af'
  union all
  select 'S3 platform: md5 (sem partições e seus índices)', '4ce6437364c259fec6b5ea9646ac1359',
         (select pg_catalog.md5(coalesce(pg_catalog.string_agg(o, '|' order by o), '')) from platform),
         (select pg_catalog.md5(coalesce(pg_catalog.string_agg(o, '|' order by o), '')) from platform) = '4ce6437364c259fec6b5ea9646ac1359'
  union all
  select 'S4 migrações (supabase_migrations.schema_migrations)', '20261023000100,20261023000200,20261023000300,20261028000400',
         (select coalesce(pg_catalog.string_agg(version, ',' order by version), '') from supabase_migrations.schema_migrations),
         (select coalesce(pg_catalog.string_agg(version, ',' order by version), '') from supabase_migrations.schema_migrations)
           = '20261023000100,20261023000200,20261023000300,20261028000400'
  union all
  select 'S5 papéis cli_login_*', '(nenhum)',
         coalesce((select pg_catalog.string_agg(rolname, ',' order by rolname) from pg_catalog.pg_roles where rolname like 'cli\_login\_%'), '(nenhum)'),
         not exists (select 1 from pg_catalog.pg_roles where rolname like 'cli\_login\_%')
)
select * from (
select item, expected, actual, case when ok then 'PASS' else 'FAIL' end as status from checks
union all
-- Contas sem dado pessoal: 8 primeiros caracteres do id, impressão do e-mail (md5, 8 hex) e datas.
select 'INFO conta ' || pg_catalog.row_number() over (order by created_at, id), '-',
       'id=' || pg_catalog.left(id::text, 8) || ' email#=' || pg_catalog.left(pg_catalog.md5(pg_catalog.lower(coalesce(email, ''))), 8) ||
       ' criada=' || pg_catalog.to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI"Z"') ||
       ' ultimo_login=' || coalesce(pg_catalog.to_char(last_sign_in_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI"Z"'), '-'), 'INFO'
  from accounts
union all
-- Dados ANTERIORES à execução (base para separar o que a C2 criar): contagens totais.
select 'INFO dados anteriores: salas (abertas) / membros / convites de sala / convites de criador (usados) / concessões', '-',
       (select pg_catalog.count(*) from oryn.rooms)::text || ' (' || (select pg_catalog.count(*) from oryn.rooms where closed_at is null)::text || ') / ' ||
       (select pg_catalog.count(*) from oryn.room_members)::text || ' / ' || (select pg_catalog.count(*) from oryn.room_invites)::text || ' / ' ||
       (select pg_catalog.count(*) from oryn.creator_invites)::text || ' (' || (select pg_catalog.count(*) from oryn.creator_invites where used_at is not null)::text || ') / ' ||
       (select pg_catalog.count(*) from oryn.creator_grants)::text, 'INFO'
union all
select 'INFO dados anteriores: sessões de sala (não revogadas) / signal_log / pair_counters / realtime.messages em oryn:*', '-',
       (select pg_catalog.count(*) from oryn.room_sessions)::text || ' (' || (select pg_catalog.count(*) from oryn.room_sessions where revoked_at is null)::text || ') / ' ||
       (select pg_catalog.count(*) from oryn.signal_log)::text || ' / ' || (select pg_catalog.count(*) from oryn.pair_counters)::text || ' / ' ||
       (select pg_catalog.count(*) from oryn_msgs)::text, 'INFO'
union all
select 'INFO dados anteriores: linhas em auth.sessions / refresh tokens não revogados', '-',
       (select pg_catalog.count(*) from auth.sessions)::text || ' / ' || (select pg_catalog.count(*) from auth.refresh_tokens where not coalesce(revoked, false))::text, 'INFO'
union all
-- Recuperação (runbook §12.4): QUAL conta tem sessão de Auth ativa (id curto = quantidade). Sem e-mail.
select 'INFO sessões de Auth ativas por conta (id curto=quantidade)', '-',
       coalesce((select pg_catalog.string_agg(pg_catalog.left(a.id::text, 8) || '=' || s.n::text, ', ' order by a.created_at, a.id)
                   from accounts a join (select user_id, pg_catalog.count(*) as n from active_sessions group by user_id) s on s.user_id = a.id), '(nenhuma)'), 'INFO'
union all
select 'INFO partições fora do padrão de nome messages_AAAA_MM_DD', '0',
       (select pg_catalog.count(*)::text from parts where relname !~ '^messages_\d{4}_\d{2}_\d{2}$'),
       case when exists (select 1 from parts where relname !~ '^messages_\d{4}_\d{2}_\d{2}$') then 'FAIL' else 'INFO' end
union all
select 'INFO agora (UTC)', '-', (select t::text from now_utc), 'INFO'
) r
order by r.status = 'PASS', r.status = 'INFO', r.item;

rollback;
