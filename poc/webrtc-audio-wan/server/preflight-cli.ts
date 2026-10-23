// Pré-validação offline da integração Cloudflare (POC-02B.3B). NÃO inicia o cloudflared, NÃO acessa a
// rede e NÃO imprime segredos.
//
// Uso:
//   node server/preflight-cli.ts --config=<config.yml> --env-file=<arquivo .env> [--mode=activation|template]
//                                [--signal-port=5280] [--admin-port=5281]
//
// Os valores vêm de ARQUIVOS (config.yml e arquivo de ambiente), nunca de argumentos com conteúdo:
// nada sensível passa pela linha de comando ou pelo histórico do shell.
// Código de saída: 0 = pronto; 1 = violação; 2 = uso incorreto.

import { resolve } from 'node:path';
import { argValue, portArg } from './cli.ts';
import { preflight, type PreflightMode } from './cloudflare-preflight.ts';
import { isTrackedOrUnignored, parseEnvText, readText, repoRoot } from './preflight-io.ts';

const usage = (message: string): never => {
  console.error(`Uso incorreto: ${message}`);
  process.exit(2);
};

const allowed = ['--config=', '--env-file=', '--mode=', '--signal-port=', '--admin-port='];
for (const arg of process.argv.slice(2).filter((a) => a !== '--')) {
  if (!allowed.some((p) => arg.startsWith(p))) usage(`argumento não reconhecido (${arg.split('=')[0]}). Valores sensíveis nunca vão na linha de comando.`);
}
const configPath = argValue('config') ?? usage('--config é obrigatório.');
const envPath = argValue('env-file') ?? usage('--env-file é obrigatório.');
const mode = (argValue('mode') ?? 'activation') as PreflightMode;
if (mode !== 'activation' && mode !== 'template') usage('--mode deve ser activation ou template.');

const root = repoRoot();
const configText = readText(configPath) ?? usage('não foi possível ler o arquivo de --config.');
const envText = readText(envPath) ?? usage('não foi possível ler o arquivo de --env-file.');
const env = parseEnvText(envText) ?? usage('arquivo de ambiente inválido.');

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

console.log(`\nOryn POC-02B — pré-validação Cloudflare (offline, modo ${mode})`);
for (const [k, v] of Object.entries(report.summary)) console.log(`  ${k.padEnd(14)} ${v}`);
if (report.ok) {
  console.log('\nRESULTADO: OK — nenhuma violação encontrada.');
  if (mode === 'activation') console.log('Isto não ativa nada. Siga o checklist manual em cloudflare/README.md antes de iniciar o túnel.');
  process.exit(0);
}
console.log(`\nRESULTADO: ${report.errors.length} violação(ões) — NÃO ativar.`);
for (const e of report.errors) console.log(`  [${e.id}] ${e.message}`);
process.exit(1);
