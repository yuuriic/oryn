// integration/scripts/oryn-push-step.ps1 (02C.3A.1) com uma CLI FALSA (tests/fixtures/fake-supabase-cli.mjs):
// nenhum acesso à rede nem ao Supabase. Prova a montagem do workdir, os argumentos exatos, a senha só no
// ambiente durante a chamada e a limpeza em `finally`, inclusive em erro. Exige PowerShell 7 (`pwsh`),
// presente nos runners do GitHub e no ambiente de desenvolvimento.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../integration/scripts/oryn-push-step.ps1', import.meta.url));
const fake = fileURLToPath(new URL('./fixtures/fake-supabase-cli.mjs', import.meta.url));
const REF = 'abcdefghijklmnopqrst';
const TEST_PASSWORD = 'senha-ficticia-de-teste'; // fictícia; só existe neste teste
let work: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'oryn-push-test-'));
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

interface Run {
  ok: boolean;
  out: string;
  envAfter: string;
  log: { args: string[]; workdir: string; migrations: string[]; passwordLength: number | null } | null;
  /** Argumentos de cada chamada `--version` (02C.3B.1). */
  versionCalls: string[][];
}

/** Roda o script num pwsh novo e informa, no MESMO processo, se SUPABASE_DB_PASSWORD sobrou. */
function run(opts: {
  step: number;
  apply?: boolean;
  confirmation?: string;
  mode?: string;
  applied?: string;
  ref?: string;
  preset?: boolean;
  version?: string;
  missingCli?: boolean;
}): Run {
  const log = join(work, `cli-${Math.random().toString(36).slice(2)}.json`);
  const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
  const params = [
    `-Step ${opts.step}`,
    opts.apply ? '-Apply' : '',
    opts.confirmation !== undefined ? `-Confirmation ${q(opts.confirmation)}` : '',
    opts.missingCli ? `-SupabaseCli ${q('supabase-inexistente-oryn-teste')}` : `-SupabaseCli ${q(process.execPath)} -SupabaseCliPrefix @(${q(fake)})`,
    `-ProjectRef ${q(opts.ref ?? REF)}`,
    `-Password (ConvertTo-SecureString ${q(TEST_PASSWORD)} -AsPlainText -Force)`,
  ].join(' ');
  const command = [
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$ErrorActionPreference = 'Stop'",
    opts.preset ? "$env:SUPABASE_DB_PASSWORD = 'segredo-preexistente'" : '',
    `$ok = $true; try { & ${q(script)} ${params} } catch { $ok = $false; Write-Host ('ERRO: ' + $_.Exception.Message) }`,
    "Write-Host ('OK=' + $ok)",
    "Write-Host ('ENV_AFTER=' + [string](Test-Path Env:SUPABASE_DB_PASSWORD))",
  ].join('; ');
  // Ambiente SEM SUPABASE_DB_PASSWORD (variável vazia ainda "existe" no Windows e o script recusaria).
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FAKE_CLI_LOG: log,
    FAKE_CLI_MODE: opts.mode ?? 'ok',
    FAKE_APPLIED: opts.applied ?? '',
    FAKE_CLI_VERSION: opts.version ?? 'ok',
  };
  delete env['SUPABASE_DB_PASSWORD'];
  const out = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', env });
  const versionLog = `${log}.version`;
  return {
    ok: /OK=True/.test(out),
    out,
    envAfter: /ENV_AFTER=(\w+)/.exec(out)?.[1] ?? '?',
    log: existsSync(log) ? JSON.parse(readFileSync(log, 'utf8')) : null,
    versionCalls: existsSync(versionLog)
      ? readFileSync(versionLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[])
      : [],
  };
}

describe('oryn-push-step.ps1 (CLI falsa, sem rede)', () => {
  it('dry-run da Etapa 1: workdir só com a 0100, argumentos exatos, senha só durante a chamada, limpeza total', () => {
    const r = run({ step: 1 });
    expect(r.ok, r.out).toBe(true);
    expect(r.out).toMatch(/DRY-RUN OK: só 20261023000100_oryn_schema\.sql/);
    expect(r.log!.migrations).toEqual(['20261023000100_oryn_schema.sql']);
    expect(r.log!.args).toEqual(['--workdir', r.log!.workdir, 'db', 'push', '--project-ref', REF, '--skip-vault', '--dry-run']);
    expect(r.log!.args.join(' ')).not.toContain(TEST_PASSWORD); // nunca na linha de comando
    expect(r.log!.passwordLength).toBe(TEST_PASSWORD.length); // chegou pelo ambiente
    expect(r.out).not.toContain(TEST_PASSWORD);
    expect(r.envAfter).toBe('False');
    expect(existsSync(r.log!.workdir)).toBe(false); // workdir temporário apagado
    // 02C.3B.1: versão conferida uma vez, só com `--version` (sem ref, sem workdir), apesar do aviso de atualização.
    expect(r.versionCalls).toEqual([['--version']]);
    expect(r.out).toMatch(/Supabase CLI 2\.122\.0 confirmada/);
  });

  it('Etapa 2 depois da 0100 aplicada: workdir com 0100+0200 e o dry-run só pode citar a 0200', () => {
    const r = run({ step: 2, applied: '20261023000100' });
    expect(r.ok, r.out).toBe(true);
    expect(r.log!.migrations).toEqual(['20261023000100_oryn_schema.sql', '20261023000200_oryn_functions.sql']);
  });

  it('erro da CLI (ex.: autenticação): o script falha e a senha e o workdir são removidos mesmo assim', () => {
    const r = run({ step: 1, mode: 'fail' });
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/a CLI saiu com código 1/);
    expect(r.out).toMatch(/password authentication failed/);
    expect(r.envAfter).toBe('False');
    expect(existsSync(r.log!.workdir)).toBe(false);
  });

  it('dry-run citando migração fora da etapa → interrompe', () => {
    const r = run({ step: 1, mode: 'extra' });
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/fora desta etapa: interromper/);
    expect(r.envAfter).toBe('False');
  });

  it('dry-run que NÃO cita o alvo (ex.: já aplicado) → interrompe', () => {
    const r = run({ step: 1, applied: '20261023000100' });
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/não lista 20261023000100: interromper/);
  });

  it('SUPABASE_DB_PASSWORD já definida → recusa antes de chamar a CLI e NÃO apaga o segredo alheio', () => {
    const r = run({ step: 1, preset: true });
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/já está definida/);
    expect(r.log).toBeNull();
    expect(r.envAfter).toBe('True');
  });

  it('-Apply sem a confirmação exata → nada é chamado', () => {
    for (const confirmation of ['aplicar 20261023000100', 'APLICAR 20261023000200', 'APLICAR']) {
      const r = run({ step: 1, apply: true, confirmation });
      expect(r.ok, confirmation).toBe(false);
      expect(r.out).toMatch(/confirmação não confere/);
      expect(r.log, confirmation).toBeNull();
      expect(r.envAfter).toBe('False');
    }
  });

  it('-Apply com a confirmação exata → chama a CLI SEM --dry-run e SEM --yes', () => {
    const r = run({ step: 1, apply: true, confirmation: 'APLICAR 20261023000100' });
    expect(r.ok, r.out).toBe(true);
    expect(r.log!.args).toEqual(['--workdir', r.log!.workdir, 'db', 'push', '--project-ref', REF, '--skip-vault']);
    expect(r.envAfter).toBe('False');
  });

  describe('versão da CLI (02C.3B.1): recusa ANTES de credenciais, workdir e db push', () => {
    const refused = (r: Run, message: RegExp) => {
      expect(r.ok, r.out).toBe(false);
      expect(r.out).toMatch(message);
      expect(r.out).toMatch(/Nada foi executado/);
      expect(r.log).toBeNull(); // db push nunca chamado
      expect(r.out).not.toMatch(/workdir temporário/); // nem o workdir foi montado
      expect(r.envAfter).toBe('False');
    };

    it('CLI ausente', () => {
      const r = run({ step: 1, missingCli: true });
      refused(r, /Supabase CLI não encontrada \('supabase-inexistente-oryn-teste'\): instale a 2\.122\.0/);
      expect(r.versionCalls).toEqual([]);
    });

    it('versão incompatível (2.115.0), inclusive no -Apply com a confirmação certa', () => {
      refused(run({ step: 1, version: 'old' }), /Supabase CLI 2\.115\.0 encontrada; o procedimento exige exatamente 2\.122\.0/);
      refused(run({ step: 1, apply: true, confirmation: 'APLICAR 20261023000100', version: 'old' }), /exige exatamente 2\.122\.0/);
    });

    it('falha ao identificar a versão: código ≠ 0, saída sem versão, saída ambígua', () => {
      refused(run({ step: 1, version: 'fail' }), /não foi possível identificar a versão da Supabase CLI \(código 1\)/);
      refused(run({ step: 1, version: 'garbage' }), /não foi possível identificar a versão da Supabase CLI \(saída: 'Supabase CLI \(dev build\)'\)/);
      refused(run({ step: 1, version: 'two' }), /não foi possível identificar a versão/);
    });
  });

  it('ref fora do formato → recusa sem chamar a CLI', () => {
    const r = run({ step: 1, ref: 'https://evil.example' });
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/ref do projeto fora do formato/);
    expect(r.log).toBeNull();
  });
});
