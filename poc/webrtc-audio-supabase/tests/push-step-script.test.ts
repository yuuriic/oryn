// integration/scripts/oryn-push-step.ps1 (02C.3A.1) com uma CLI FALSA (tests/fixtures/fake-supabase-cli.mjs):
// nenhum acesso à rede nem ao Supabase. Prova a montagem do workdir, os argumentos exatos, a senha só no
// ambiente durante a chamada e a limpeza em `finally`, inclusive em erro. Exige PowerShell 7 (`pwsh`),
// presente nos runners do GitHub e no ambiente de desenvolvimento.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const originalScript = fileURLToPath(new URL('../integration/scripts/oryn-push-step.ps1', import.meta.url));
let script: string;
const fake = fileURLToPath(new URL('./fixtures/fake-supabase-cli.mjs', import.meta.url));
const REF = 'abcdefghijklmnopqrst';
const TEST_PASSWORD = 'senha-ficticia-de-teste'; // fictícia; só existe neste teste
let work: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'oryn-push-test-'));
  // Fixture isolada: nunca chama Git, CLI real ou projeto remoto.
  const fixture = join(work, 'fixture');
  mkdirSync(join(fixture, 'integration', 'scripts'), { recursive: true });
  mkdirSync(join(fixture, 'supabase', 'migrations'), { recursive: true });
  script = join(fixture, 'integration', 'scripts', 'oryn-push-step.ps1');
  cpSync(originalScript, script);
  cpSync(new URL('../integration/scripts/profile-08-manifest.json', import.meta.url), join(fixture, 'integration', 'scripts', 'profile-08-manifest.json'));
  cpSync(new URL('../integration/sql/', import.meta.url), join(fixture, 'integration', 'sql'), { recursive: true });
  const source = fileURLToPath(new URL('../supabase/', import.meta.url));
  cpSync(join(source, 'config.toml'), join(fixture, 'supabase', 'config.toml'));
  for (const file of readdirSync(join(source, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    cpSync(join(source, 'migrations', file), join(fixture, 'supabase', 'migrations', file));
  }
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

interface CliCall {
  args: string[];
  workdir: string;
  migrations: string[];
  passwordLength: number | null;
}

interface Run {
  ok: boolean;
  out: string;
  envAfter: string;
  log: CliCall | null;
  /** Todas as chamadas à CLI, em ordem, fora `--version`. */
  calls: CliCall[];
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
  dirty?: boolean;
  profileState?: string;
  migrationMutation?: 'extra' | 'rename' | 'content';
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
    // Só o status Git da fixture é simulado, dentro deste pwsh descartável. O
    // executável real e suas travas não são alterados. Nenhum commit é necessário.
    `function global:git { $global:LASTEXITCODE = 0; ${opts.dirty ? "Write-Output ' M supabase/config.toml'" : ''} }`,
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
    FAKE_STATE: `${log}.state`,
    FAKE_CLI_VERSION: opts.version ?? 'ok',
  };
  delete env['SUPABASE_DB_PASSWORD'];
  env['FAKE_PROFILE_STATE'] = opts.profileState ?? 'ok';
  const migrationDir = join(work, 'fixture', 'supabase', 'migrations');
  const target = join(migrationDir, '20261109224924_oryn_account_display_name.sql');
  const original = readFileSync(target);
  const extra = join(migrationDir, '20261110000000_unexpected.sql');
  if (opts.migrationMutation === 'extra') writeFileSync(extra, 'select 1;');
  if (opts.migrationMutation === 'rename') { rmSync(target); writeFileSync(extra, original); }
  if (opts.migrationMutation === 'content') writeFileSync(target, Buffer.concat([original, Buffer.from('\n-- changed')]));
  let out: string;
  try {
    out = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', env });
  } finally {
    if (opts.migrationMutation) { writeFileSync(target, original); rmSync(extra, { force: true }); }
  }
  const versionLog = `${log}.version`;
  return {
    ok: /OK=True/.test(out),
    out,
    envAfter: /ENV_AFTER=(\w+)/.exec(out)?.[1] ?? '?',
    log: existsSync(log) ? JSON.parse(readFileSync(log, 'utf8')) : null,
    calls: existsSync(`${log}.calls`)
      ? readFileSync(`${log}.calls`, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as CliCall)
      : [],
    versionCalls: existsSync(versionLog)
      ? readFileSync(versionLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[])
      : [],
  };
}

describe('oryn-push-step.ps1 (CLI falsa, sem rede)', () => {
  describe('Etapa 8: lista fixa, pré/pós-voo e recusa de reaplicação', () => {
    const previous = '20261023000100,20261023000200,20261023000300,20261028000400,20261106000500,20261107000600,20261108000700';
    const options = { step: 8, applied: previous, apply: true, confirmation: 'APLICAR 20261109224924' };
    it('aplica somente o alvo depois de dois pré-voos; só anuncia sucesso após pós-voo', () => {
      const r = run(options);
      expect(r.ok, r.out).toBe(true);
      expect(r.calls.map((c) => c.args.includes('query') ? 'query' : c.args.includes('--dry-run') ? 'dry' : 'push'))
        .toEqual(['query', 'dry', 'query', 'push', 'dry', 'query']);
      expect(r.calls[0]!.migrations).toHaveLength(8);
      expect(r.calls[0]!.args).toContain('--linked');
      expect(r.calls.every((c) => c.passwordLength === TEST_PASSWORD.length)).toBe(true);
      expect(r.calls.every((c) => !c.args.includes('--yes') && !c.args.join(' ').includes(TEST_PASSWORD))).toBe(true);
      expect(r.out).toMatch(/postflight confirmado/);
      expect(r.out).toMatch(/^APLICADO: 20261109224924/m);
      expect(r.out).not.toContain(TEST_PASSWORD);
      expect(r.envAfter).toBe('False');
      expect(existsSync(r.calls[0]!.workdir)).toBe(false);
    });
    it('dry-run executa pré-voo, mas nenhuma escrita', () => {
      const r = run({ step: 8, applied: previous });
      expect(r.ok, r.out).toBe(true);
      expect(r.calls).toHaveLength(2);
      expect(r.calls[1]!.args).toContain('--dry-run');
    });
    it.each(['preflight', 'query-error'])('recusa estado divergente ou consulta indisponível: %s', (profileState) => {
      const r = run({ ...options, profileState });
      expect(r.ok).toBe(false);
      expect(r.calls).toHaveLength(1);
      expect(r.out).toMatch(/preflight recusado/);
      expect(r.envAfter).toBe('False');
    });
    it('não anuncia APLICADO se pós-voo divergir', () => {
      const r = run({ ...options, profileState: 'postflight' });
      expect(r.ok).toBe(false);
      expect(r.out).toMatch(/postflight recusado/);
      expect(r.out).not.toMatch(/^APLICADO/m);
      expect(r.envAfter).toBe('False');
    });
    it('recusa reaplicação antes do dry-run e do push', () => {
      const r = run({ ...options, applied: `${previous},20261109224924` });
      expect(r.ok).toBe(false);
      expect(r.calls).toHaveLength(1);
      expect(r.out).toMatch(/preflight recusado/);
    });
    it.each(['extra', 'rename', 'content'] as const)('recusa mudança de integridade antes de conectar: %s', (migrationMutation) => {
      const r = run({ ...options, migrationMutation });
      expect(r.ok).toBe(false);
      expect(r.out).toMatch(/migrações inesperadas|integridade divergente/);
      expect(r.calls).toEqual([]);
      expect(r.versionCalls).toEqual([]);
    });
    it('recusa versão desconhecida no plano, mesmo com o alvo presente', () => {
      const r = run({ ...options, mode: 'unexpected' });
      expect(r.ok).toBe(false);
      expect(r.out).toMatch(/20261110000000, fora desta etapa/);
      expect(r.calls).toHaveLength(2);
    });
    it('confirmação de outra etapa é recusada antes da consulta', () => {
      const r = run({ ...options, confirmation: 'APLICAR 20261108000700' });
      expect(r.ok).toBe(false);
      expect(r.calls).toEqual([]);
    });
  });
  it('árvore suja é recusada antes de versão, senha ou CLI', () => {
    const r = run({ step: 1, dirty: true });
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/mudanças não commitadas/);
    expect(r.calls).toEqual([]);
    expect(r.versionCalls).toEqual([]);
    expect(r.envAfter).toBe('False');
  });
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

  it('Etapa 5 com a 0100–0400 aplicadas: workdir com as 5 migrações e o dry-run só pode citar a 0500', () => {
    const r = run({ step: 5, applied: '20261023000100,20261023000200,20261023000300,20261028000400' });
    expect(r.ok, r.out).toBe(true);
    expect(r.log!.migrations).toHaveLength(5);
    expect(r.log!.migrations.at(-1)).toBe('20261106000500_oryn_room_messages.sql');
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

  describe('-Apply: o resultado vem do estado do banco, nunca só do código 0 da CLI', () => {
    const APPLY = { step: 1, apply: true, confirmation: 'APLICAR 20261023000100' };
    const BASE = (r: Run) => ['--workdir', r.calls[0]!.workdir, 'db', 'push', '--project-ref', REF, '--skip-vault'];
    const clean = (r: Run) => {
      expect(r.envAfter).toBe('False');
      expect(existsSync(r.calls[0]!.workdir)).toBe(false);
      expect(r.out).not.toContain(TEST_PASSWORD);
    };

    it('migração aplicada: dry-run, push SEM --dry-run e SEM --yes, conferência; só então APLICADO', () => {
      const r = run(APPLY);
      expect(r.ok, r.out).toBe(true);
      expect(r.calls.map((c) => c.args)).toEqual([[...BASE(r), '--dry-run'], BASE(r), [...BASE(r), '--dry-run']]);
      expect(r.calls.every((c) => c.passwordLength === TEST_PASSWORD.length)).toBe(true);
      expect(r.out).toMatch(/APLICADO: 20261023000100_oryn_schema\.sql/);
      expect(r.out).not.toMatch(/NADA APLICADO/);
      clean(r);
    });

    it('regressão: banco já em dia (segunda execução) → NADA APLICADO, sem push e sem o falso APLICADO', () => {
      const r = run({ ...APPLY, applied: '20261023000100' });
      expect(r.ok, r.out).toBe(true);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]!.args).toContain('--dry-run');
      expect(r.out).toMatch(/Remote database is up to date/);
      expect(r.out).toMatch(/NADA APLICADO: o banco já está em dia/);
      expect(r.out).not.toMatch(/^APLICADO/m);
      clean(r);
    });

    it('formato real da CLI capturada (JSON): reconhece migração pendente e banco em dia', () => {
      const applied = run({ ...APPLY, mode: 'json' });
      expect(applied.ok, applied.out).toBe(true);
      expect(applied.calls).toHaveLength(3);
      expect(applied.out).toMatch(/"upToDate":true/);
      expect(applied.out).toMatch(/^APLICADO: /m);
      const again = run({ ...APPLY, mode: 'json', applied: '20261023000100' });
      expect(again.ok, again.out).toBe(true);
      expect(again.calls).toHaveLength(1);
      expect(again.out).toMatch(/NADA APLICADO/);
      expect(again.out).not.toMatch(/^APLICADO/m);
      const dry = run({ step: 1, mode: 'json', applied: '20261023000100' });
      expect(dry.ok).toBe(false);
      expect(dry.out).toMatch(/não lista 20261023000100: interromper/);
    });

    it('etapa 7 com a 0100–0600 já aplicadas: aplica e confirma só a 0700', () => {
      const r = run({ step: 7, apply: true, confirmation: 'APLICAR 20261108000700', applied: '20261023000100,20261023000200,20261023000300,20261028000400,20261106000500,20261107000600' });
      expect(r.ok, r.out).toBe(true);
      expect(r.out).toMatch(/APLICADO: 20261108000700_oryn_soundboard\.sql/);
      expect(r.calls).toHaveLength(3);
      clean(r);
    });

    it('etapa 6 com a 0100–0500 já aplicadas: aplica e confirma só a 0600', () => {
      const r = run({ step: 6, apply: true, confirmation: 'APLICAR 20261107000600', applied: '20261023000100,20261023000200,20261023000300,20261028000400,20261106000500' });
      expect(r.ok, r.out).toBe(true);
      expect(r.out).toMatch(/APLICADO: 20261107000600_oryn_room_membership\.sql/);
      expect(r.calls).toHaveLength(3);
      clean(r);
    });

    it('etapa 5 com a 0100–0400 já aplicadas: aplica e confirma só a 0500', () => {
      const r = run({ step: 5, apply: true, confirmation: 'APLICAR 20261106000500', applied: '20261023000100,20261023000200,20261023000300,20261028000400' });
      expect(r.ok, r.out).toBe(true);
      expect(r.out).toMatch(/APLICADO: 20261106000500_oryn_room_messages\.sql/);
      expect(r.calls).toHaveLength(3);
      clean(r);
    });

    it('falha na conexão antes de aplicar: interrompe sem chamar o push', () => {
      const r = run({ ...APPLY, mode: 'fail' });
      expect(r.ok).toBe(false);
      expect(r.calls).toHaveLength(1);
      expect(r.out).toMatch(/a CLI saiu com código 1/);
      expect(r.out).not.toMatch(/APLICADO/);
      clean(r);
    });

    it('falha no push: sem APLICADO e com aviso de resultado não confirmado', () => {
      const r = run({ ...APPLY, mode: 'push-fail' });
      expect(r.ok).toBe(false);
      expect(r.calls).toHaveLength(2);
      expect(r.out).toMatch(/resultado não confirmado/);
      expect(r.out).not.toMatch(/APLICADO/);
      clean(r);
    });

    it('recusa no prompt da CLI (código 0, nada gravado): NÃO APLICADO', () => {
      const r = run({ ...APPLY, mode: 'decline' });
      expect(r.ok).toBe(false);
      expect(r.calls).toHaveLength(3);
      expect(r.out).toMatch(/NÃO APLICADO: 20261023000100_oryn_schema\.sql continua pendente/);
      expect(r.out).not.toMatch(/^APLICADO/m);
      clean(r);
    });

    it('conferência falha depois do push: sem APLICADO, porque o resultado não está provado', () => {
      const r = run({ ...APPLY, mode: 'recheck-fail' });
      expect(r.ok).toBe(false);
      expect(r.calls).toHaveLength(3);
      expect(r.out).toMatch(/conferência depois da aplicação falhou/);
      expect(r.out).not.toMatch(/APLICADO/);
      clean(r);
    });

    it('migração fora da etapa no dry-run inicial: interrompe sem chamar o push', () => {
      const r = run({ ...APPLY, mode: 'extra' });
      expect(r.ok).toBe(false);
      expect(r.calls).toHaveLength(1);
      expect(r.out).toMatch(/fora desta etapa: interromper/);
      clean(r);
    });

    it('saída desconhecida no dry-run inicial: interrompe sem chamar o push', () => {
      const r = run({ ...APPLY, mode: 'unknown' });
      expect(r.ok).toBe(false);
      expect(r.calls).toHaveLength(1);
      expect(r.out).toMatch(/nada foi aplicado; interromper/);
      clean(r);
    });
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
