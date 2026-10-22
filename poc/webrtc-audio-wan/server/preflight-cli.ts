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

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { argValue, portArg } from './cli.ts';
import { preflight, type PreflightMode } from './cloudflare-preflight.ts';

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

const here = dirname(fileURLToPath(import.meta.url));
let repoRoot: string;
try {
  repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: here, encoding: 'utf8' }).trim();
} catch {
  repoRoot = resolve(here, '..', '..', '..');
}

const read = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/** Versionado ou não ignorado pelo git (dentro do repositório). Fora do repositório = false. */
const isTrackedOrUnignored = (path: string): boolean => {
  const abs = resolve(path);
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', abs], { cwd: repoRoot, stdio: 'ignore' });
    return true; // versionado
  } catch {
    // não versionado: precisa estar ignorado
  }
  try {
    execFileSync('git', ['check-ignore', '-q', abs], { cwd: repoRoot, stdio: 'ignore' });
    return false; // ignorado
  } catch (error) {
    // status 1 = não ignorado; 128 = fora do repositório
    return (error as { status?: number }).status === 1;
  }
};

const configText = read(configPath) ?? usage('não foi possível ler o arquivo de --config.');
const envText = read(envPath) ?? usage('não foi possível ler o arquivo de --env-file.');
let env: Record<string, string>;
try {
  env = parseEnv(envText) as Record<string, string>;
} catch {
  usage('arquivo de ambiente inválido.');
  env = {};
}

const report = preflight({
  mode,
  configText,
  env,
  repoRoot,
  configPath: resolve(configPath),
  envPath: resolve(envPath),
  signalPort: portArg('signal-port', 5280),
  adminPort: portArg('admin-port', 5281),
  readFile: read,
  isTrackedOrUnignored,
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
