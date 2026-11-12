// Artefatos operacionais da etapa 10 (capacidade 5, migração 1000), derivados SOMENTE do SQL versionado; não conecta a
// nenhum banco. node integration/scripts/capacity-10-artifacts.mjs [--check]
//
// A 1000 só redefine o corpo de oryn.enforce_room_capacity(). Pré-voo e pós-voo conferem histórico exato, corpo (md5),
// dono, ACL, search_path, o gatilho ligado e as permissões de quem aplica. A reversão (97) é a 1000 ao contrário: confere o
// pós-voo, restaura o corpo da 0600, tira a versão do histórico e confere que o banco voltou ao pré-voo.
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
  '20261110000900_oryn_channels.sql', '20261112001000_oryn_room_capacity_5.sql',
];
const quote = (s) => `'${s.replaceAll("'", "''")}'`;
const history = (count) => `ARRAY[${files.slice(0, count).map((f) => quote(f.slice(0, -4))).join(',')}]::text[]`;

/** A definição da função num arquivo: o comando inteiro e o corpo entre $$ (o que o Postgres guarda em prosrc). */
function capacityFn(file) {
  const m = /create\s+(?:or\s+replace\s+)?function\s+oryn\.enforce_room_capacity\(\)[\s\S]*?\bas\s+\$\$([\s\S]*?)\$\$;/i.exec(read(`supabase/migrations/${file}`));
  if (!m) throw new Error(`oryn.enforce_room_capacity ausente em ${file}`);
  return { sql: m[0], body: m[1] };
}
const before = capacityFn(files[5]);
const after = capacityFn(files[9]);
if (!/max_members > 4\b/.test(before.body) || !/max_members > 5\b/.test(after.body)) throw new Error('limites inesperados nas definições');

const permissions = `has_schema_privilege(current_user,'oryn','USAGE')
    AND has_schema_privilege(current_user,'oryn','CREATE')
    AND has_table_privilege(current_user,'supabase_migrations.schema_migrations','INSERT')
    AND has_table_privilege(current_user,'supabase_migrations.schema_migrations','DELETE')
    AND NOT EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='oryn' AND c.relkind='r' AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname=current_user))`;

// tgtype 7 = ROW (1) + BEFORE (2) + INSERT (4): o mesmo gatilho da 0600, sem UPDATE.
const check = (phase, count, body) => `-- Etapa 10 (capacidade 5, 1000): ${phase === 'preflight' ? 'pré-voo' : 'pós-voo'}. SELECT somente leitura, só de catálogo e histórico:
-- não chama RPCs nem lê dados de usuários. Gerado por capacity-10-artifacts.mjs. Qualquer FAIL impede prosseguir.
WITH checks AS (SELECT
  (SELECT array_agg(version || '_' || name ORDER BY version) FROM supabase_migrations.schema_migrations) = ${history(count)} AS history_ok,
  (SELECT count(*) = 1 AND bool_and(
    pg_get_userbyid(p.proowner) = current_user
    AND pg_get_function_identity_arguments(p.oid) = '' AND pg_get_function_result(p.oid) = 'trigger'
    AND md5(p.prosrc) = ${quote(hash(body, 'md5'))} AND p.provolatile = 'v' AND NOT p.prosecdef
    AND p.proconfig = ARRAY['search_path=""']::text[]
    AND NOT has_function_privilege('anon',p.oid,'EXECUTE')
    AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')
    AND NOT has_function_privilege('service_role',p.oid,'EXECUTE')
    AND NOT EXISTS (SELECT FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee <> p.proowner OR a.privilege_type <> 'EXECUTE' OR a.is_grantable)
  ) FROM pg_proc p WHERE p.oid = to_regprocedure('oryn.enforce_room_capacity()')) AS function_ok,
  (SELECT count(*) = 1 FROM pg_trigger t
    WHERE t.tgrelid = to_regclass('oryn.rooms') AND NOT t.tgisinternal AND t.tgname = 'oryn_room_capacity'
      AND t.tgfoid = to_regprocedure('oryn.enforce_room_capacity()') AND t.tgenabled = 'O' AND t.tgtype = 7)
    AND (SELECT count(*) = 1 FROM pg_trigger t WHERE t.tgrelid = to_regclass('oryn.rooms') AND NOT t.tgisinternal
      AND t.tgfoid = to_regprocedure('oryn.enforce_room_capacity()')) AS trigger_ok,
  (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
    WHERE c.conrelid = to_regclass('oryn.rooms') AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%max_members%')
    = 'CHECK (((max_members >= 2) AND (max_members <= 10)))' AS table_ok,
  ${permissions} AS permissions_ok
)
SELECT CASE WHEN history_ok AND function_ok AND trigger_ok AND table_ok AND permissions_ok
  THEN 'oryn-capacity-10-${phase}-ok' ELSE 'oryn-capacity-10-${phase}-FAIL' END AS result, checks.* FROM checks;
`;
const pre = check('preflight', 9, before.body);
const post = check('postflight', 10, after.body);
const inner = (q) => q.replace(/^--.*\n/gm, '').trim().replace(/;$/, '');
const rollback = `-- REVERSÃO SÓ DA MIGRAÇÃO 1000 (capacidade 5). Requer autorização própria. Transação única.
-- Ordem: publicar ANTES o cliente que oferece até 4 lugares; só então rodar este script.
-- Efeito: salas NOVAS voltam ao limite de 4 (corpo da 0600) e a versão 20261112001000 sai do histórico, para a etapa 10
-- poder ser reaplicada depois. Salas já criadas com 5 lugares continuam válidas e com os mesmos membros (o gatilho só
-- confere inserções). Sem DROP, CASCADE ou DML de dados de usuário.
-- Falha fechada: só começa com o pós-voo confirmado e só confirma se o banco voltar exatamente ao pré-voo.
-- Gerado por capacity-10-artifacts.mjs.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $rollback$
begin
  if not coalesce((select result = 'oryn-capacity-10-postflight-ok' from (
${inner(post)}
  ) checked),false) then
    raise exception 'capacity-10-rollback: estado divergente; nada revertido';
  end if;
end $rollback$;
${before.sql.replace(/^create(?: or replace)? function/i, 'create or replace function')}

delete from supabase_migrations.schema_migrations where version = '20261112001000';
do $verify$
begin
  if not coalesce((select result = 'oryn-capacity-10-preflight-ok' from (
${inner(pre)}
  ) checked),false) then
    raise exception 'capacity-10-rollback: verificação final falhou; nada revertido';
  end if;
end $verify$;
commit;
`;
const outputs = {
  'integration/sql/40_capacity_10_preflight.sql': pre,
  'integration/sql/41_capacity_10_postflight.sql': post,
  'integration/sql/97_rollback_capacity_10.sql': rollback,
};
outputs['integration/scripts/capacity-10-manifest.json'] = JSON.stringify({
  normalization: 'UTF-8; CRLF converted to LF',
  migrations: files.map((file) => ({ file, sha256: hash(read(`supabase/migrations/${file}`)) })),
  checks: Object.entries(outputs).map(([file, content]) => ({ file, sha256: hash(content) })),
}, null, 2) + '\n';
for (const [file, content] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) {
    if (read(file) !== content) throw new Error(`Artefato divergente: ${file}`);
  } else writeFileSync(fileURLToPath(new URL(file, root)), content);
}
console.log(process.argv.includes('--check') ? 'Artefatos 10 conferidos.' : 'Artefatos 10 gerados localmente.');
