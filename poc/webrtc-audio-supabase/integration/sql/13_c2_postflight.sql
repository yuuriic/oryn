-- POC-02C.7P-A — LEITURA DE DEPOIS da C2 com contas preexistentes (caminho P), SOMENTE LEITURA. Rodar no SQL
-- editor (ou MCP execute_sql), como postgres, logo depois da C2, QUALQUER que seja o resultado.
--
-- ⚠ ANTES DE RODAR: troque os dois marcadores abaixo (em `params`) pelos horários do horario.txt da execução:
--   <<T0_UTC>> = inicio_utc   e   <<T1_UTC>> = fim_utc   (ex.: 2026-10-28T13:05:12.3456789Z; 7 casas são
--   arredondadas para microssegundos). Sem fim_utc (execução interrompida), usar o fim_utc_estimado gravado pelo
--   Invoke-C2Recovery (runbook §12.3). Sem a troca, a consulta FALHA de propósito (o marcador não é um horário).
-- A janela [T0, T1] separa o que ESTA execução criou do que já existia (contado à parte, como INFO).
-- J1 reprova janela invertida ou de 30 min ou mais (T0/T1 trocados ou copiados de outra execução).
-- Saída: item, expected, actual, status (PASS / FAIL / INFO). Ordenado: FAIL, INFO, PASS. READ ONLY e ROLLBACK.
--
-- Efeitos ESPERADOS de uma C2 password que passou (02C.7P):
--   - 0 contas novas; as 3 sessões de Auth do harness encerradas pelo signOut local (podem continuar como
--     linha; a contagem é de sessões ATIVAS);
--   - 1 sala it-02c4b-* ABERTA (não existe RPC de fechar sala), com 2 membros (owner + member);
--   - 1 convite de sala criado e usado (o #15, que criaria outro, é pulado no modo password);
--   - o convite de criador usado; nenhum convite de criador utilizável sobrando; concessão do dono;
--   - sessões de sala todas revogadas (left / expired);
--   - 1 signal_log e 1 pair_counters (#18 authorize_signal; as 5 repetições viram 1 msg_id);
--   - hello/bye em realtime.messages (realtime.send privado persiste; sai com a rotação das partições).
-- INDEVIDOS (FAIL): conta nova; sessão de Auth ativa; evento fora de hello/bye ou payload com chave fora de
-- {id, session_id, label}; mensagem fora de oryn:* na janela; estrutura, migrações ou cli_login_* alterados.

begin;
set transaction read only;

with
params as (
  select '<<T0_UTC>>'::timestamptz as t0, '<<T1_UTC>>'::timestamptz as t1
),
-- Mesmas definições do 07_initial_state.sql (manter em sincronia; também com 11 e 12).
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
-- Contas e identidades (mesmas definições do 12_c2_preflight.sql).
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
-- O que ESTA execução criou: tudo com carimbo dentro de [T0, T1].
run_rooms as (select r.* from oryn.rooms r, params p where r.created_at between p.t0 and p.t1),
run_sessions as (select s.* from oryn.room_sessions s, params p where s.created_at between p.t0 and p.t1),
run_room_invites as (select i.* from oryn.room_invites i, params p where i.created_at between p.t0 and p.t1),
run_signals as (select g.* from oryn.signal_log g, params p where g.created_at between p.t0 and p.t1),
run_msgs as (
  select m.* from realtime.messages m, params p
   where m.inserted_at between (p.t0 at time zone 'utc') and (p.t1 at time zone 'utc')
),
oryn_msgs as (
  select m.event, m.payload, m.private, m.topic from realtime.messages m where pg_catalog.lower(m.topic) like 'oryn:%'
),
checks(item, expected, actual, ok) as (
  select 'J1 janela [T0, T1]: T0 < T1 e duração < 30 min', 'true',
         (select (p.t0 < p.t1 and p.t1 - p.t0 < interval '30 minutes')::text || ' (' || (p.t1 - p.t0)::text || ')' from params p),
         (select p.t0 < p.t1 and p.t1 - p.t0 < interval '30 minutes' from params p)
  union all
  select 'A1 contas: auth.users (nenhuma conta nova)', '3',
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
  select 'A7 sessões de Auth ATIVAS (o signOut local encerrou as 3 do harness)', '0',
         (select pg_catalog.count(*)::text from active_sessions), (select pg_catalog.count(*) from active_sessions) = 0
  union all
  select 'A8 contas criadas na janela [T0, T1]', '0',
         (select pg_catalog.count(*)::text from accounts, params p where accounts.created_at between p.t0 and p.t1),
         not exists (select 1 from accounts, params p where accounts.created_at between p.t0 and p.t1)
  union all
  select 'R1 salas criadas na janela / com nome it-02c4b-*', '1 / 1',
         (select pg_catalog.count(*) from run_rooms)::text || ' / ' || (select pg_catalog.count(*) from run_rooms where name like 'it-02c4b-%')::text,
         (select pg_catalog.count(*) from run_rooms) = 1 and (select pg_catalog.count(*) from run_rooms where name like 'it-02c4b-%') = 1
  union all
  select 'R2 membros da sala da janela: owner / member / removidos', '1 / 1 / 0',
         (select pg_catalog.count(*) filter (where m.role = 'owner')::text || ' / ' || pg_catalog.count(*) filter (where m.role = 'member')::text || ' / ' ||
                 pg_catalog.count(*) filter (where m.removed_at is not null)::text from oryn.room_members m join run_rooms r on r.id = m.room_id),
         (select pg_catalog.count(*) filter (where m.role = 'owner') = 1 and pg_catalog.count(*) filter (where m.role = 'member') = 1
                 and pg_catalog.count(*) filter (where m.removed_at is not null) = 0 from oryn.room_members m join run_rooms r on r.id = m.room_id)
  union all
  select 'R3 convites de sala da janela: criados / usados / utilizáveis sobrando', '1 / 1 / 0',
         (select pg_catalog.count(*)::text || ' / ' || pg_catalog.count(*) filter (where used_at is not null)::text || ' / ' ||
                 pg_catalog.count(*) filter (where used_at is null and revoked_at is null and expires_at > pg_catalog.now())::text from run_room_invites),
         (select pg_catalog.count(*) = 1 and pg_catalog.count(*) filter (where used_at is not null) = 1
                 and pg_catalog.count(*) filter (where used_at is null and revoked_at is null and expires_at > pg_catalog.now()) = 0 from run_room_invites)
  union all
  select 'R4 convite de criador usado na janela / convites de criador utilizáveis sobrando', '1 / 0',
         (select pg_catalog.count(*) from oryn.creator_invites c, params p where c.used_at between p.t0 and p.t1)::text || ' / ' ||
         (select pg_catalog.count(*) from oryn.creator_invites where used_at is null and revoked_at is null and expires_at > pg_catalog.now())::text,
         (select pg_catalog.count(*) from oryn.creator_invites c, params p where c.used_at between p.t0 and p.t1) = 1
           and not exists (select 1 from oryn.creator_invites where used_at is null and revoked_at is null and expires_at > pg_catalog.now())
  union all
  select 'R5 o convite usado na janela foi resgatado pelo dono da sala da janela, que tem concessão', 'true',
         (select (exists (select 1 from oryn.creator_invites c, params p, run_rooms r where c.used_at between p.t0 and p.t1 and c.used_by = r.owner_id)
                 and exists (select 1 from oryn.creator_grants g join run_rooms r on r.owner_id = g.user_id))::text),
         exists (select 1 from oryn.creator_invites c, params p, run_rooms r where c.used_at between p.t0 and p.t1 and c.used_by = r.owner_id)
           and exists (select 1 from oryn.creator_grants g join run_rooms r on r.owner_id = g.user_id)
  union all
  select 'R6 sessões de sala da janela não revogadas (todas saem por leave_room ou vencem)', '0',
         (select pg_catalog.count(*)::text from run_sessions where revoked_at is null), not exists (select 1 from run_sessions where revoked_at is null)
  union all
  select 'R7 sessões de sala da janela fora da sala da janela', '0',
         (select pg_catalog.count(*)::text from run_sessions s where s.room_id not in (select id from run_rooms)),
         not exists (select 1 from run_sessions s where s.room_id not in (select id from run_rooms))
  union all
  select 'R8 signal_log da janela / pair_counters dessas sessões (#18: 5 repetições = 1 msg_id)', '1 / 1',
         (select pg_catalog.count(*) from run_signals)::text || ' / ' ||
         (select pg_catalog.count(*) from oryn.pair_counters c where c.from_session in (select id from run_sessions))::text,
         (select pg_catalog.count(*) from run_signals) = 1 and (select pg_catalog.count(*) from oryn.pair_counters c where c.from_session in (select id from run_sessions)) = 1
  union all
  select 'M1 realtime.messages da janela: hello / bye (realtime.send privado persiste)', '>= 1 / >= 1',
         (select pg_catalog.count(*) filter (where event = 'hello')::text || ' / ' || pg_catalog.count(*) filter (where event = 'bye')::text from run_msgs),
         (select pg_catalog.count(*) filter (where event = 'hello') >= 1 and pg_catalog.count(*) filter (where event = 'bye') >= 1 from run_msgs)
  union all
  select 'M2 realtime.messages da janela FORA de oryn:s:* (nenhum cliente grava)', '0',
         (select pg_catalog.count(*)::text from run_msgs where topic !~ '^oryn:s:[0-9a-f-]{36}$'),
         not exists (select 1 from run_msgs where topic !~ '^oryn:s:[0-9a-f-]{36}$')
  union all
  select 'M3 realtime.messages em oryn:*: evento fora de hello/bye / payload com chave fora de {id, session_id, label} / tópico não minúsculo / não privado', '0 / 0 / 0 / 0',
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
select 'INFO janela [T0, T1] (UTC)', '-', (select p.t0::text || ' .. ' || p.t1::text from params p), 'INFO'
union all
select 'INFO sala da janela: id / aberta (não há RPC de fechar sala)', '-',
       coalesce((select pg_catalog.string_agg(pg_catalog.left(id::text, 8) || ' / ' || (closed_at is null)::text, '; ') from run_rooms), '(nenhuma)'), 'INFO'
union all
select 'INFO sessões de sala da janela: total / motivos de revogação', '-',
       (select pg_catalog.count(*)::text from run_sessions) || ' / ' ||
       coalesce((select pg_catalog.string_agg(reason || '=' || n::text, ', ' order by reason)
                   from (select coalesce(revoke_reason, '(viva)') as reason, pg_catalog.count(*) as n from run_sessions group by 1) x), '-'), 'INFO'
union all
select 'INFO linhas de auth.sessions criadas na janela (encerradas podem continuar como linha)', '-',
       (select pg_catalog.count(*)::text from auth.sessions s, params p where s.created_at between p.t0 and p.t1), 'INFO'
union all
-- Dados ANTERIORES à janela: existiam antes desta execução (a C2 não os criou).
select 'INFO dados anteriores a T0: salas / sessões de sala / convites de sala / signal_log / realtime.messages em oryn:*', '-',
       (select pg_catalog.count(*) from oryn.rooms r, params p where r.created_at < p.t0)::text || ' / ' ||
       (select pg_catalog.count(*) from oryn.room_sessions s, params p where s.created_at < p.t0)::text || ' / ' ||
       (select pg_catalog.count(*) from oryn.room_invites i, params p where i.created_at < p.t0)::text || ' / ' ||
       (select pg_catalog.count(*) from oryn.signal_log g, params p where g.created_at < p.t0)::text || ' / ' ||
       (select pg_catalog.count(*) from realtime.messages m, params p where pg_catalog.lower(m.topic) like 'oryn:%' and m.inserted_at < (p.t0 at time zone 'utc'))::text, 'INFO'
union all
select 'INFO criados DEPOIS de T1 (outra atividade; não deveria haver)', '-',
       (select pg_catalog.count(*) from oryn.rooms r, params p where r.created_at > p.t1)::text || ' salas / ' ||
       (select pg_catalog.count(*) from oryn.room_sessions s, params p where s.created_at > p.t1)::text || ' sessões', 'INFO'
union all
select 'INFO agora (UTC)', '-', (pg_catalog.now() at time zone 'utc')::text, 'INFO'
) r
order by r.status = 'PASS', r.status = 'INFO', r.item;

rollback;
