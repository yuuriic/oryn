// Artefatos operacionais derivados SOMENTE do SQL aprovado; não conecta a nenhum banco.
// node integration/scripts/profile-08-artifacts.mjs [--check]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8').replaceAll('\r\n', '\n');
const hash = (text, algorithm = 'sha256') => createHash(algorithm).update(text).digest('hex');
const files = [
  '20261023000100_oryn_schema.sql', '20261023000200_oryn_functions.sql',
  '20261023000300_oryn_realtime.sql', '20261028000400_oryn_room_management.sql',
  '20261106000500_oryn_room_messages.sql', '20261107000600_oryn_room_membership.sql',
  '20261108000700_oryn_soundboard.sql', '20261109224924_oryn_account_display_name.sql',
];
const contracts = {
  join_room: ['uuid', 'p_room_id uuid', 'TABLE(session_id uuid, topic text)'],
  get_roster: ['uuid', 'p_room_id uuid', 'TABLE(session_id uuid, display_name text, is_self boolean, joined_at timestamp with time zone)'],
  list_room_members: ['uuid', 'p_room_id uuid', 'TABLE(member_ref text, display_name text, role text, is_self boolean, in_call boolean, joined_at timestamp with time zone)'],
  get_voice_participants: ['uuid', 'p_room_id uuid', 'TABLE(session_id uuid, participant_ref text, display_name text, is_self boolean, joined_at timestamp with time zone)'],
  send_room_message: ['uuid,uuid,text', 'p_room_id uuid, p_client_nonce uuid, p_body text', 'TABLE(seq bigint, display_name text, is_mine boolean, client_nonce uuid, body text, created_at timestamp with time zone)'],
  list_room_messages: ['uuid,bigint,bigint,integer', 'p_room_id uuid, p_before_seq bigint, p_after_seq bigint, p_limit integer', 'TABLE(seq bigint, display_name text, is_mine boolean, client_nonce uuid, body text, created_at timestamp with time zone)'],
};
const extract = (sql) => [...sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(public|oryn)\.(\w+)\s*\([\s\S]*?\bas\s+\$\$([\s\S]*?)\$\$;/gi)]
  .map((m) => ({ schema: m[1], name: m[2], body: m[3], sql: m[0] }));
const previous = new Map();
for (const file of files.slice(0, 7)) for (const fn of extract(read(`supabase/migrations/${file}`))) {
  if (fn.schema === 'public' && contracts[fn.name]) previous.set(fn.name, fn);
}
const next = extract(read(`supabase/migrations/${files[7]}`));
if (previous.size !== 6 || next.length !== 9) throw new Error('Conjunto de funções inesperado: revisar artefatos manualmente.');
const quote = (s) => `'${s.replaceAll("'", "''")}'`;
const history = (count) => `ARRAY[${files.slice(0, count).map((f) => quote(f.slice(0, -4))).join(',')}]::text[]`;
const functionRows = (fns) => fns.map((f) => {
  const [args, identity, result] = f.schema === 'public' ? contracts[f.name] : {
    normalize_account_name: ['text', 'p_name text', 'text'],
    account_display_name: ['uuid,text', 'p_user uuid, p_legacy text', 'text'],
    validate_account_name: ['', '', 'trigger'],
  }[f.name];
  const definer = f.schema === 'public' || f.name === 'validate_account_name';
  const volatility = /\bimmutable\b/i.test(f.sql) ? 'i' : /\bstable\b/i.test(f.sql) ? 's' : 'v';
  const fullArgs = f.name === 'list_room_messages'
    ? 'p_room_id uuid, p_before_seq bigint DEFAULT NULL::bigint, p_after_seq bigint DEFAULT NULL::bigint, p_limit integer DEFAULT 50' : identity;
  return `(${[`${f.schema}.${f.name}(${args})`, identity, fullArgs, result, hash(f.body, 'md5'), volatility].map(quote).join(',')},${definer},${f.schema === 'public'})`;
}).join(',\n');
const inertValidator = { schema: 'oryn', name: 'validate_account_name', body: '\nbegin\n  return new;\nend ',
  sql: "create or replace function oryn.validate_account_name() returns trigger language plpgsql security definer set search_path = '' as $$\nbegin\n  return new;\nend $$;" };
function checkQuery(after, recovered = false) {
  const funcs = recovered ? [...previous.values(), ...next.filter((f) => f.schema === 'oryn' && f.name !== 'validate_account_name'), inertValidator]
    : after ? next : [...previous.values()];
  const marker = recovered ? 'recovered' : after ? 'postflight' : 'preflight';
  return `-- PR #23: SELECT somente leitura; não chama RPCs nem consulta dados pessoais.
-- Gerado por profile-08-artifacts.mjs. Qualquer FAIL impede prosseguir.
WITH expected(signature,identity_args,full_args,result_type,body_md5,volatility,definer,client_execute) AS (VALUES
${functionRows(funcs)}
), checks AS (SELECT
  (SELECT array_agg(version || '_' || name ORDER BY version) FROM supabase_migrations.schema_migrations) = ${history(after || recovered ? 8 : 7)} AS history_ok,
  (SELECT count(*) = ${funcs.length} AND bool_and(
    p.oid IS NOT NULL AND pg_get_userbyid(p.proowner) = current_user
    AND pg_get_function_identity_arguments(p.oid) = e.identity_args
    AND pg_get_function_arguments(p.oid) = e.full_args
    AND pg_get_function_result(p.oid) = e.result_type
    AND md5(p.prosrc) = e.body_md5 AND p.provolatile::text = e.volatility
    AND p.prosecdef = e.definer AND p.proconfig = ARRAY['search_path=""']::text[]
    AND has_function_privilege('authenticated',p.oid,'EXECUTE') = e.client_execute
    AND NOT has_function_privilege('anon',p.oid,'EXECUTE')
    AND NOT has_function_privilege('service_role',p.oid,'EXECUTE')
    AND NOT EXISTS (SELECT FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee NOT IN (p.proowner, CASE WHEN e.client_execute THEN 'authenticated'::regrole::oid ELSE p.proowner END)
         OR a.privilege_type <> 'EXECUTE' OR a.is_grantable)
  ) FROM expected e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature)) AS functions_ok,
  (SELECT count(*) = ${after || recovered ? 3 : 0} FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='oryn' AND p.proname IN ('normalize_account_name','account_display_name','validate_account_name')) AS helpers_ok,
  (SELECT count(*) = 6 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN (${Object.keys(contracts).map(quote).join(',')})) AS rpc_overloads_ok,
  ${after || recovered ? `(SELECT count(*) = 1 AND bool_and(t.tgtype=23 AND t.tgenabled='O'
      AND t.tgfoid=to_regprocedure('oryn.validate_account_name()') AND t.tgnargs=0 AND t.tgqual IS NULL
      AND NOT t.tgisinternal AND t.tgconstraint=0
      AND t.tgattr::text=(SELECT attnum::text FROM pg_attribute WHERE attrelid='auth.users'::regclass AND attname='raw_user_meta_data'))
    FROM pg_trigger t WHERE t.tgrelid='auth.users'::regclass AND t.tgname='oryn_validate_account_name')` : `NOT EXISTS (SELECT FROM pg_trigger WHERE tgrelid='auth.users'::regclass AND tgname='oryn_validate_account_name')`} AS trigger_ok,
  has_table_privilege(current_user,'auth.users','TRIGGER')
    AND has_column_privilege(current_user,'auth.users','id','SELECT')
    AND has_column_privilege(current_user,'auth.users','raw_user_meta_data','SELECT')
    AND has_schema_privilege(current_user,'oryn','USAGE')
    AND has_schema_privilege(current_user,'oryn','CREATE')
    AND has_schema_privilege(current_user,'public','USAGE')
    AND has_schema_privilege(current_user,'public','CREATE')
    AND has_schema_privilege(current_user,'auth','USAGE')
    AND has_table_privilege(current_user,'supabase_migrations.schema_migrations','INSERT') AS permissions_ok
)
SELECT CASE WHEN history_ok AND functions_ok AND helpers_ok AND rpc_overloads_ok AND trigger_ok AND permissions_ok
  THEN 'oryn-profile-08-${marker}-ok' ELSE 'oryn-profile-08-${marker}-FAIL' END AS result, checks.* FROM checks;
`;
}
const pre = checkQuery(false), post = checkQuery(true), recovered = checkQuery(false, true);
const recovery = `-- RECUPERAÇÃO PR #23: requer autorização própria e cliente Gold restaurado.
-- Recuperação funcional: mantém os helpers privados e o gatilho, com validador inerte.
-- Não depende de ser dono de auth.users (DROP TRIGGER exigiria esse privilégio).
-- Transação única, sem CASCADE, DML de dados de usuário ou alteração do histórico.
-- Mantém a versão 20261109224924 registrada: nova aplicação fica bloqueada.
-- Gerado a partir das seis definições anteriores aprovadas; não é um rollback geral.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $recovery$
begin
  if not coalesce((select result = 'oryn-profile-08-postflight-ok' from (
${post.replace(/^--.*\n/gm, '').trim().replace(/;$/, '')}
  ) checked),false) then
    raise exception 'profile-08-recovery: estado divergente; nada revertido';
  end if;
end $recovery$;
${[...previous.values()].map((f) => f.sql.replace(/^create(?: or replace)? function/i, 'create or replace function')).join('\n\n')}
${inertValidator.sql}
do $verify$
begin
  if not coalesce((select result = 'oryn-profile-08-recovered-ok' from (
${recovered.replace(/^--.*\n/gm, '').trim().replace(/;$/, '')}
  ) checked),false) then
    raise exception 'profile-08-recovery: verificação final falhou; nada revertido';
  end if;
end $verify$;
commit;
`;
const outputs = {
  'integration/sql/20_profile_08_preflight.sql': pre,
  'integration/sql/21_profile_08_postflight.sql': post,
  'integration/sql/22_profile_08_recovered.sql': recovered,
  'integration/sql/95_recover_profile_08.sql': recovery,
};
outputs['integration/scripts/profile-08-manifest.json'] = JSON.stringify({
  referenceCommit: 'b210aec', normalization: 'UTF-8; CRLF converted to LF',
  migrations: files.map((file) => ({ file, sha256: hash(read(`supabase/migrations/${file}`)) })),
  checks: Object.entries(outputs).map(([file, content]) => ({ file, sha256: hash(content) })),
}, null, 2) + '\n';
for (const [file, content] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) {
    if (read(file) !== content) throw new Error(`Artefato divergente: ${file}`);
  } else writeFileSync(fileURLToPath(new URL(file, root)), content);
}
console.log(process.argv.includes('--check') ? 'Artefatos 08 conferidos.' : 'Artefatos 08 gerados localmente.');
