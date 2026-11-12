// CLI FALSA do Supabase para testar integration/scripts/oryn-push-step.ps1 SEM rede e SEM projeto remoto.
// Registra num arquivo JSON (FAKE_CLI_LOG) os argumentos recebidos, se SUPABASE_DB_PASSWORD chegou (só o
// tamanho, nunca o valor) e as migrações presentes no --workdir. Comportamento por FAKE_CLI_MODE:
//   ok         → lista as migrações do workdir ainda não aplicadas, ou "up to date" sem nenhuma; sem --dry-run, grava-as em
//                FAKE_STATE, como um push real. Aplicadas = FAKE_APPLIED (lista separada por vírgula) + FAKE_STATE;
//   extra      → idem, e cita também 20261023000300 (simula uma migração fora da etapa);
//   fail       → sai com código 1 em qualquer chamada (simula erro de autenticação);
//   decline    → o push não grava nada e sai com código 0 (simula a recusa no prompt da CLI);
//   push-fail  → o dry-run funciona; o push sai com código 1;
//   recheck-fail → o push grava; o dry-run seguinte sai com código 1;
//   unknown    → o dry-run não cita o alvo nem informa banco em dia;
//   json       → como ok, no formato que a CLI 2.122.0 real usa com a saída capturada (lido dela em 2026-11-06).
// Cada chamada é acrescentada a `${FAKE_CLI_LOG}.calls`, para os testes conferirem a sequência.
// `--version` (02C.3B.1) registra só em `${FAKE_CLI_LOG}.version` e responde conforme FAKE_CLI_VERSION:
//   ok (padrão) → aviso de atualização no stderr (com OUTRAS versões) + `2.122.0` no stdout;
//   old → `2.115.0`; fail → código 1; garbage → texto sem versão; two → duas linhas de versão.
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  appendFileSync(`${process.env['FAKE_CLI_LOG'] ?? 'fake-cli.json'}.version`, JSON.stringify(args) + '\n');
  const v = process.env['FAKE_CLI_VERSION'] ?? 'ok';
  if (v === 'fail') {
    console.error('unexpected error: version lookup failed');
    process.exit(1);
  }
  if (v === 'garbage') console.log('Supabase CLI (dev build)');
  else if (v === 'two') console.log('2.122.0\n2.115.0');
  else {
    console.error('A new version of Supabase CLI is available: v2.130.0 (currently installed v2.115.0)');
    console.log(v === 'old' ? '2.115.0' : '2.122.0');
  }
  process.exit(0);
}
const workdir = args[args.indexOf('--workdir') + 1] ?? '';
const migrations = (() => {
  try {
    return readdirSync(join(workdir, 'supabase', 'migrations')).sort();
  } catch {
    return [];
  }
})();
const pw = process.env['SUPABASE_DB_PASSWORD'];
const entry = JSON.stringify({ args, workdir, migrations, passwordLength: pw === undefined ? null : pw.length });
writeFileSync(process.env['FAKE_CLI_LOG'] ?? 'fake-cli.json', entry);
appendFileSync(`${process.env['FAKE_CLI_LOG'] ?? 'fake-cli.json'}.calls`, `${entry}\n`);

const mode = process.env['FAKE_CLI_MODE'] ?? 'ok';
if (args.includes('query')) {
  const sqlFile = args[args.indexOf('--file') + 1] ?? '';
  // Etapa 8 (20/21, perfil), 9 (30/31, canais) ou 10 (40/41, capacidade): cada uma com o próprio marcador e a própria versão-alvo.
  const channels = /3[01]_channels_09_/.test(sqlFile);
  const capacity = /4[01]_capacity_10_/.test(sqlFile);
  const phase = /(20_profile_08|30_channels_09|40_capacity_10)_preflight\.sql$/.test(sqlFile) ? 'preflight' : 'postflight';
  const version = capacity ? '20261112001000' : channels ? '20261110000900' : '20261109224924';
  const marker = capacity ? 'oryn-capacity-10' : channels ? 'oryn-channels-09' : 'oryn-profile-08';
  const statePath = process.env['FAKE_STATE'];
  const alreadyApplied = (process.env['FAKE_APPLIED'] ?? '').includes(version) ||
    (statePath && existsSync(statePath) && readFileSync(statePath, 'utf8').includes(version));
  const state = process.env['FAKE_PROFILE_STATE'] ?? 'ok';
  const fail = state === phase || (phase === 'preflight' && alreadyApplied);
  console.log(JSON.stringify({ rows: [{ result: `${marker}-${phase}-${fail ? 'FAIL' : 'ok'}` }] }));
  process.exit(state === 'query-error' ? 1 : 0);
}
if (mode === 'fail') {
  console.error('failed to connect to postgres: password authentication failed for user "postgres"');
  process.exit(1);
}
const statePath = process.env['FAKE_STATE'];
const isDryRun = args.includes('--dry-run');
const persisted = statePath && existsSync(statePath) ? readFileSync(statePath, 'utf8').split('\n').filter(Boolean) : [];
const applied = [...(process.env['FAKE_APPLIED'] ?? '').split(',').filter(Boolean), ...persisted];
const pending = migrations.filter((m) => !applied.some((a) => m.startsWith(a)));

if (!isDryRun) {
  if (mode === 'push-fail') {
    console.error('failed to apply migration: statement error');
    process.exit(1);
  }
  console.log('Applying migrations...');
  if (mode !== 'decline' && statePath) appendFileSync(statePath, pending.map((m) => `${m}\n`).join(''));
  process.exit(0);
}
if (mode === 'recheck-fail' && persisted.length > 0) {
  console.error('failed to connect to postgres: connection reset');
  process.exit(1);
}
if (mode === 'unknown') {
  console.log('Connecting to remote database...');
  process.exit(0);
}
console.log('DRY RUN: migrations will *not* be pushed to the database.');
if (mode === 'json') {
  const upToDate = pending.length === 0;
  console.log(JSON.stringify({ upToDate, dryRun: true, migrations: pending, seeds: [], roles: [], ...(upToDate ? { message: 'Remote database is up to date.' } : {}) }));
  process.exit(0);
}
if (pending.length === 0) {
  console.log('Remote database is up to date.');
} else {
  console.log('Would push these migrations:');
  for (const m of pending) console.log(` • ${m}`);
}
if (mode === 'extra') console.log(' • 20261023000300_oryn_realtime.sql');
if (mode === 'unexpected') console.log(' • 20261110000000_unknown.sql');
