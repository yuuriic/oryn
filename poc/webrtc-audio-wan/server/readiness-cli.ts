// Relatório consolidado de prontidão WAN (POC-02B.5): `pnpm readiness -- --config=<config.yml> --env-file=<arquivo>`
//   [--mode=activation|template] [--skip-diagnostics] [--json=<saída.json>]
//
// Junta pré-validação offline + diagnóstico local simulado + busca de segredos reais versionados + itens
// que só o operador/ambiente real confirmam. Resultado: PASS / FAIL / NOT_VERIFIED por requisito.
// NÃO inicia túnel, NÃO acessa a rede, NÃO pede credenciais e NÃO autoriza a ativação.
// Saída: 0 = nenhum FAIL (pode haver NOT_VERIFIED); 1 = algum FAIL; 2 = uso incorreto.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { argValue, hasFlag, portArg } from './cli.ts';
import { preflight, type PreflightMode } from './cloudflare-preflight.ts';
import { runDiagnostics } from './diagnostics.ts';
import { isTrackedOrUnignored, parseEnvText, readText, repoRoot, trackedContains, trackedHasJwt } from './preflight-io.ts';
import { buildReadiness, summarize } from './readiness.ts';

const usage = (message: string): never => {
  console.error(`Uso incorreto: ${message}`);
  process.exit(2);
};
const allowed = ['--config=', '--env-file=', '--mode=', '--signal-port=', '--admin-port=', '--json=', '--skip-diagnostics'];
for (const arg of process.argv.slice(2).filter((a) => a !== '--')) {
  if (!allowed.some((p) => arg === p || arg.startsWith(p))) usage(`argumento não reconhecido (${arg.split('=')[0]}). Valores sensíveis nunca vão na linha de comando.`);
}
const configPath = argValue('config') ?? usage('--config é obrigatório.');
const envPath = argValue('env-file') ?? usage('--env-file é obrigatório.');
const mode = (argValue('mode') ?? 'activation') as PreflightMode;
if (mode !== 'activation' && mode !== 'template') usage('--mode deve ser activation ou template.');

const root = repoRoot();
const configText = readText(configPath) ?? usage('não foi possível ler o arquivo de --config.');
const env = parseEnvText(readText(envPath) ?? usage('não foi possível ler o arquivo de --env-file.')) ?? usage('arquivo de ambiente inválido.');

const report = preflight({
  mode,
  configText,
  env,
  repoRoot: root,
  configPath: resolve(configPath),
  envPath: resolve(envPath),
  signalPort: portArg('signal-port', 5280),
  adminPort: portArg('admin-port', 5281),
  readFile: readText,
  isTrackedOrUnignored: (path) => isTrackedOrUnignored(root, path),
});

// Segredos REAIS que não podem aparecer em arquivos versionados (busca sem expor o valor).
const versionedSecrets: string[] = [];
const turnToken = env['ORYN_TURN_API_TOKEN']?.trim();
if (turnToken && trackedContains(root, turnToken)) versionedSecrets.push('token da API TURN');
let tunnelSecret: string | null = null;
try {
  const credsPath = (parse(configText) as Record<string, unknown> | null)?.['credentials-file'];
  const creds = typeof credsPath === 'string' ? readText(credsPath) : null;
  const secret = creds ? (JSON.parse(creds) as Record<string, unknown>)['TunnelSecret'] : null;
  tunnelSecret = typeof secret === 'string' ? secret : null;
} catch {
  tunnelSecret = null;
}
if (tunnelSecret && trackedContains(root, tunnelSecret)) versionedSecrets.push('segredo do túnel');
if (trackedHasJwt(root)) versionedSecrets.push('JWT');

const diagnostics = hasFlag('skip-diagnostics') ? null : await runDiagnostics();
const items = buildReadiness({ mode, preflight: report, env, diagnostics, versionedSecrets });
const totals = summarize(items);

console.log(`\nOryn POC-02B — prontidão para testes WAN (offline, modo ${mode})`);
for (const [k, v] of Object.entries(report.summary)) console.log(`  ${k.padEnd(14)} ${v}`);
console.log('');
for (const i of items) console.log(`  ${i.status.padEnd(12)} ${i.id.padEnd(14)} ${i.requisito} — ${i.detalhe}`);
console.log(`\nTOTAL: ${totals.pass} PASS · ${totals.fail} FAIL · ${totals.notVerified} NOT VERIFIED`);
console.log(
  totals.fail > 0
    ? 'RESULTADO: há FAIL — NÃO ativar. Corrija e rode de novo.'
    : 'RESULTADO: nenhum FAIL. Os itens NOT VERIFIED dependem do ambiente real/operador. Este relatório NÃO autoriza a ativação (02B.6 exige aprovação explícita).',
);

const jsonOut = argValue('json');
if (jsonOut) {
  writeFileSync(jsonOut, `${JSON.stringify({ geradoEm: new Date().toISOString(), modo: mode, resumo: report.summary, totais: totals, itens: items }, null, 2)}\n`);
  console.log(`Relatório JSON: ${jsonOut}`);
}
process.exit(totals.fail > 0 ? 1 : 0);
