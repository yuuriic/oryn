// Artefatos operacionais da etapa 9 (canais, 0900), derivados SOMENTE do SQL versionado; não conecta a nenhum banco.
// node integration/scripts/channels-09-artifacts.mjs [--check]
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
  '20261110000900_oryn_channels.sql',
];
const msgTable = 'TABLE(seq bigint, display_name text, is_mine boolean, client_nonce uuid, body text, created_at timestamp with time zone)';
const voiceTable = 'TABLE(session_id uuid, participant_ref text, display_name text, is_self boolean, joined_at timestamp with time zone)';
// [assinatura de tipos, argumentos de identidade, argumentos completos (com DEFAULT), resultado]
const contracts = {
  'public.join_room': ['uuid', 'p_room_id uuid', null, 'TABLE(session_id uuid, topic text)'],
  'public.get_roster': ['uuid', 'p_room_id uuid', null, 'TABLE(session_id uuid, display_name text, is_self boolean, joined_at timestamp with time zone)'],
  'public.get_voice_participants': ['uuid', 'p_room_id uuid', null, voiceTable],
  'public.leave_room': ['uuid', 'p_session_id uuid', null, 'void'],
  'public.authorize_signal': ['uuid,uuid,uuid,text,integer,integer',
    'p_session_id uuid, p_to_session_id uuid, p_client_msg_id uuid, p_kind text, p_pair_epoch integer, p_payload_bytes integer', null,
    'TABLE(msg_id uuid, seq bigint, from_user uuid, room_id uuid, state text, duplicate boolean, accepted_at timestamp with time zone)'],
  'public.send_room_message': ['uuid,uuid,text', 'p_room_id uuid, p_client_nonce uuid, p_body text', null, msgTable],
  'public.list_room_messages': ['uuid,bigint,bigint,integer', 'p_room_id uuid, p_before_seq bigint, p_after_seq bigint, p_limit integer',
    'p_room_id uuid, p_before_seq bigint DEFAULT NULL::bigint, p_after_seq bigint DEFAULT NULL::bigint, p_limit integer DEFAULT 50', msgTable],
  'public.list_channels': ['uuid', 'p_room_id uuid', null,
    'TABLE(channel_id uuid, kind text, name text, "position" integer, is_default boolean, archived_at timestamp with time zone, created_at timestamp with time zone)'],
  'public.create_channel': ['uuid,text,text', 'p_room_id uuid, p_name text, p_kind text', null, 'uuid'],
  'public.archive_channel': ['uuid', 'p_channel_id uuid', null, 'timestamp with time zone'],
  'public.send_channel_message': ['uuid,uuid,text', 'p_channel_id uuid, p_client_nonce uuid, p_body text', null, msgTable],
  'public.list_channel_messages': ['uuid,bigint,bigint,integer', 'p_channel_id uuid, p_before_seq bigint, p_after_seq bigint, p_limit integer',
    'p_channel_id uuid, p_before_seq bigint DEFAULT NULL::bigint, p_after_seq bigint DEFAULT NULL::bigint, p_limit integer DEFAULT 50', msgTable],
  'public.join_voice_channel': ['uuid', 'p_channel_id uuid', null, 'TABLE(session_id uuid, topic text)'],
  'public.get_channel_participants': ['uuid', 'p_channel_id uuid', null, voiceTable],
  'oryn.default_channel': ['uuid,text', 'p_room uuid, p_kind text', null, 'uuid'],
  'oryn.create_default_channels': ['', '', null, 'trigger'],
  'oryn.fill_message_channel': ['', '', null, 'trigger'],
  'oryn.fill_session_channel': ['', '', null, 'trigger'],
  'oryn.publish_channel_control': ['uuid,uuid,text,jsonb', 'p_channel uuid, p_except uuid, p_event text, p_payload jsonb', null, 'void'],
  'oryn.open_voice_session': ['uuid,uuid,uuid', 'p_room uuid, p_channel uuid, p_uid uuid', null, 'TABLE(session_id uuid, topic text)'],
  'oryn.post_message': ['uuid,uuid,uuid,uuid,text', 'p_room uuid, p_channel uuid, p_uid uuid, p_client_nonce uuid, p_body text', null, msgTable],
  'oryn.channel_messages': ['uuid,uuid,uuid,bigint,bigint,integer',
    'p_room uuid, p_channel uuid, p_uid uuid, p_before_seq bigint, p_after_seq bigint, p_limit integer', null, msgTable],
};
const replaced = ['public.join_room', 'public.get_roster', 'public.get_voice_participants', 'public.leave_room',
  'public.authorize_signal', 'public.send_room_message', 'public.list_room_messages'];
const added = ['public.list_channels', 'public.create_channel', 'public.archive_channel', 'public.send_channel_message',
  'public.list_channel_messages', 'public.join_voice_channel', 'public.get_channel_participants'];
const internal = Object.keys(contracts).filter((k) => k.startsWith('oryn.'));

const extract = (sql) => [...sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(public|oryn)\.(\w+)\s*\(([\s\S]*?)\bas\s+\$\$([\s\S]*?)\$\$;/gi)]
  .map((m) => ({ key: `${m[1]}.${m[2]}`, header: m[3], body: m[4], sql: m[0] }));
// Última definição anterior à 0900 de cada RPC redefinida (a 0800 redefine 5; leave_room e authorize_signal são da 0200).
const previous = new Map();
for (const file of files.slice(0, 8)) for (const fn of extract(read(`supabase/migrations/${file}`))) if (replaced.includes(fn.key)) previous.set(fn.key, fn);
const next = new Map(extract(read(`supabase/migrations/${files[8]}`)).map((fn) => [fn.key, fn]));
if (previous.size !== 7 || next.size !== 22 || ![...replaced, ...added, ...internal].every((k) => next.has(k))) {
  throw new Error('Conjunto de funções inesperado: revisar artefatos manualmente.');
}
const quote = (s) => `'${s.replaceAll("'", "''")}'`;
const history = (count) => `ARRAY[${files.slice(0, count).map((f) => quote(f.slice(0, -4))).join(',')}]::text[]`;
const row = (key, fn, clientExecute) => {
  const [args, identity, full, result] = contracts[key];
  const volatility = /\bimmutable\b/i.test(fn.header) ? 'i' : /\bstable\b/i.test(fn.header) ? 's' : 'v';
  const definer = /\bsecurity\s+definer\b/i.test(fn.header);
  return `(${[`${key}(${args})`, identity, full ?? identity, result, hash(fn.body, 'md5'), volatility].map(quote).join(',')},${definer},${clientExecute})`;
};
const functionCheck = (rows) => `(SELECT count(*) = ${rows.length} AND bool_and(
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
  ) FROM expected e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature))`;
const permissions = `has_schema_privilege(current_user,'oryn','USAGE')
    AND has_schema_privilege(current_user,'oryn','CREATE')
    AND has_schema_privilege(current_user,'public','USAGE')
    AND has_schema_privilege(current_user,'public','CREATE')
    AND has_table_privilege(current_user,'supabase_migrations.schema_migrations','INSERT')
    AND NOT EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='oryn' AND c.relkind='r' AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname=current_user))`;
// Estrutura da 0900. Tudo por to_regclass/catálogo: o texto roda também onde a 0900 não existe (dá false).
const structure = `(SELECT to_regclass('oryn.channels') IS NOT NULL
    AND (SELECT c.relrowsecurity AND NOT c.relforcerowsecurity FROM pg_class c WHERE c.oid=to_regclass('oryn.channels'))
    AND NOT EXISTS (SELECT FROM pg_policies WHERE schemaname='oryn')
    AND NOT EXISTS (SELECT FROM pg_class c, aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      WHERE c.oid=to_regclass('oryn.channels') AND a.grantee <> c.relowner)
    AND (SELECT count(*) = 2 FROM pg_attribute a WHERE a.attname='channel_id' AND a.attnotnull AND NOT a.attisdropped
      AND a.attrelid IN (to_regclass('oryn.room_messages'), to_regclass('oryn.room_sessions')))
    AND (SELECT count(*) = 2 FROM pg_constraint k WHERE k.contype='f' AND k.confrelid=to_regclass('oryn.channels')
      AND k.conname IN ('room_messages_channel_fk','room_sessions_channel_fk') AND array_length(k.conkey,1)=2 AND k.confdeltype='c')
    AND EXISTS (SELECT FROM pg_constraint k WHERE k.conrelid=to_regclass('oryn.channels') AND k.contype='u' AND array_length(k.conkey,1)=2)
    AND (SELECT count(*) = 3 FROM pg_class i WHERE i.relkind='i' AND i.relname IN ('channels_one_default_idx','channels_active_name_idx','channels_room_order_idx')
      AND i.relnamespace='oryn'::regnamespace)
    AND (SELECT count(*) = 3 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgenabled='O'
      AND (t.tgname, t.tgrelid, t.tgfoid) IN (('oryn_room_default_channels', to_regclass('oryn.rooms'), to_regprocedure('oryn.create_default_channels()')),
        ('oryn_message_channel', to_regclass('oryn.room_messages'), to_regprocedure('oryn.fill_message_channel()')),
        ('oryn_session_channel', to_regclass('oryn.room_sessions'), to_regprocedure('oryn.fill_session_channel()'))))
    AND EXISTS (SELECT FROM pg_constraint k WHERE k.conrelid=to_regclass('oryn.room_sessions') AND k.conname='room_sessions_revoke_reason_check'
      AND pg_get_constraintdef(k.oid) LIKE '%channel-archived%'))`;
// Dados: só agregados (nenhum conteúdo ou identificador sai do banco).
const data = `(SELECT NOT EXISTS (SELECT FROM oryn.rooms r WHERE (SELECT count(*) FROM oryn.channels c WHERE c.room_id=r.id AND c.is_default AND c.kind='text') <> 1
      OR (SELECT count(*) FROM oryn.channels c WHERE c.room_id=r.id AND c.is_default AND c.kind='voice') <> 1)
    AND NOT EXISTS (SELECT FROM oryn.room_messages m JOIN oryn.channels c ON c.id=m.channel_id WHERE c.kind <> 'text' OR c.room_id <> m.room_id)
    AND NOT EXISTS (SELECT FROM oryn.room_sessions s JOIN oryn.channels c ON c.id=s.channel_id WHERE c.kind <> 'voice' OR c.room_id <> s.room_id))`;

function checkQuery(state) {
  const fns = state === 'preflight' ? replaced.map((k) => row(k, previous.get(k), true))
    : state === 'postflight' ? [...replaced, ...added, ...internal].map((k) => row(k, next.get(k), k.startsWith('public.')))
    : [...replaced.map((k) => row(k, previous.get(k), true)), ...added.map((k) => row(k, next.get(k), false)), ...internal.map((k) => row(k, next.get(k), false))];
  const after = state !== 'preflight';
  const absent = `(to_regclass('oryn.channels') IS NULL
    AND NOT EXISTS (SELECT FROM pg_attribute a WHERE a.attname='channel_id' AND NOT a.attisdropped
      AND a.attrelid IN (to_regclass('oryn.room_messages'), to_regclass('oryn.room_sessions')))
    AND NOT EXISTS (SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE (n.nspname, p.proname) IN (${[...added, ...internal].map((k) => `(${k.split('.').map(quote).join(',')})`).join(', ')})))`;
  return `-- Etapa 9 (canais, 0900): SELECT somente leitura; não chama RPCs nem lê conteúdo de usuários (só agregados).
-- Gerado por channels-09-artifacts.mjs. Qualquer FAIL impede prosseguir.
WITH expected(signature,identity_args,full_args,result_type,body_md5,volatility,definer,client_execute) AS (VALUES
${fns.join(',\n')}
), checks AS (SELECT
  (SELECT array_agg(version || '_' || name ORDER BY version) FROM supabase_migrations.schema_migrations) = ${history(after ? 9 : 8)} AS history_ok,
  ${functionCheck(fns)} AS functions_ok,
  ${after ? structure : absent} AS structure_ok,
  ${after ? data : 'true'} AS data_ok,
  ${permissions} AS permissions_ok
)
SELECT CASE WHEN history_ok AND functions_ok AND structure_ok AND data_ok AND permissions_ok
  THEN 'oryn-channels-09-${state}-ok' ELSE 'oryn-channels-09-${state}-FAIL' END AS result, checks.* FROM checks;
`;
}
const pre = checkQuery('preflight'), post = checkQuery('postflight'), recovered = checkQuery('recovered');
const inner = (q) => q.replace(/^--.*\n/gm, '').trim().replace(/;$/, '');
const recovery = `-- RECUPERAÇÃO ETAPA 9 (canais): requer autorização própria e cliente publicado sem canais.
-- Recuperação funcional: devolve os 7 corpos anteriores e tira o EXECUTE das 7 RPCs novas. Mantém tabela, colunas,
-- índices e gatilhos: os gatilhos levam toda gravação dos corpos antigos ao canal padrão.
-- Transação única, sem DROP, CASCADE, DML de dados de usuário ou alteração do histórico.
-- Mantém a versão 20261110000900 registrada: nova aplicação fica bloqueada. Não é um rollback geral.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $recovery$
begin
  if not coalesce((select result = 'oryn-channels-09-postflight-ok' from (
${inner(post)}
  ) checked),false) then
    raise exception 'channels-09-recovery: estado divergente; nada revertido';
  end if;
end $recovery$;
${replaced.map((k) => previous.get(k).sql.replace(/^create(?: or replace)? function/i, 'create or replace function')).join('\n\n')}

revoke execute on function ${added.map((k) => `${k}(${contracts[k][0]})`).join(', ')} from authenticated;
do $verify$
begin
  if not coalesce((select result = 'oryn-channels-09-recovered-ok' from (
${inner(recovered)}
  ) checked),false) then
    raise exception 'channels-09-recovery: verificação final falhou; nada revertido';
  end if;
end $verify$;
commit;
`;
const outputs = {
  'integration/sql/30_channels_09_preflight.sql': pre,
  'integration/sql/31_channels_09_postflight.sql': post,
  'integration/sql/32_channels_09_recovered.sql': recovered,
  'integration/sql/96_recover_channels_09.sql': recovery,
};
outputs['integration/scripts/channels-09-manifest.json'] = JSON.stringify({
  normalization: 'UTF-8; CRLF converted to LF',
  migrations: files.map((file) => ({ file, sha256: hash(read(`supabase/migrations/${file}`)) })),
  checks: Object.entries(outputs).map(([file, content]) => ({ file, sha256: hash(content) })),
}, null, 2) + '\n';
for (const [file, content] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) {
    if (read(file) !== content) throw new Error(`Artefato divergente: ${file}`);
  } else writeFileSync(fileURLToPath(new URL(file, root)), content);
}
console.log(process.argv.includes('--check') ? 'Artefatos 09 conferidos.' : 'Artefatos 09 gerados localmente.');
