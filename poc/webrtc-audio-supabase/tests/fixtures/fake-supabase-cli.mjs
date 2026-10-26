// CLI FALSA do Supabase para testar integration/scripts/oryn-push-step.ps1 SEM rede e SEM projeto remoto.
// Registra num arquivo JSON (FAKE_CLI_LOG) os argumentos recebidos, se SUPABASE_DB_PASSWORD chegou (só o
// tamanho, nunca o valor) e as migrações presentes no --workdir. Comportamento por FAKE_CLI_MODE:
//   ok    → imprime, como "dry-run", as migrações do workdir que não estão em FAKE_APPLIED (lista separada por vírgula);
//   extra → idem, e cita também 20261023000300 (simula uma migração fora da etapa);
//   fail  → sai com código 1 (simula erro de autenticação).
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const workdir = args[args.indexOf('--workdir') + 1] ?? '';
const migrations = (() => {
  try {
    return readdirSync(join(workdir, 'supabase', 'migrations')).sort();
  } catch {
    return [];
  }
})();
const pw = process.env['SUPABASE_DB_PASSWORD'];
writeFileSync(process.env['FAKE_CLI_LOG'] ?? 'fake-cli.json', JSON.stringify({ args, workdir, migrations, passwordLength: pw === undefined ? null : pw.length }));

const mode = process.env['FAKE_CLI_MODE'] ?? 'ok';
if (mode === 'fail') {
  console.error('failed to connect to postgres: password authentication failed for user "postgres"');
  process.exit(1);
}
const applied = (process.env['FAKE_APPLIED'] ?? '').split(',').filter(Boolean);
const pending = migrations.filter((m) => !applied.some((a) => m.startsWith(a)));
console.log(args.includes('--dry-run') ? 'DRY RUN: migrations will *not* be pushed to the database.' : 'Applying migrations...');
console.log('Would push these migrations:');
for (const m of pending) console.log(` • ${m}`);
if (mode === 'extra') console.log(' • 20261023000300_oryn_realtime.sql');
