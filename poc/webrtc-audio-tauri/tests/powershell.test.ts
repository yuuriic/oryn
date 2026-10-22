// Garante que valores passados ao PowerShell pelos scripts de teste são tratados como dado,
// inclusive caminhos com aspas simples, ponto e vírgula e subexpressões $(...).
// Executa o Windows PowerShell real; é ignorado fora do Windows.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPowerShell, toHandle } from '../scripts/powershell.mjs';

const onWindows = process.platform === 'win32';

// Nomes de arquivo válidos no Windows que quebrariam uma interpolação entre aspas simples.
const HOSTILE_NAMES = [
  "o'ryn.txt",
  "a'; New-Item -ItemType File -Name injected.txt; 'b.txt",
  "c$(New-Item -ItemType File -Name sub.txt)d.txt",
  "it''s ` two ' quotes.png",
];

describe.skipIf(!onWindows)('runPowerShell — caminhos hostis (Windows PowerShell)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oryn ps'test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(HOSTILE_NAMES)('Set-Content grava exatamente em "%s" sem executar nada', (name) => {
    const file = join(dir, name);
    runPowerShell('Set-Content -LiteralPath $env:ORYN_PS_FILE -Value ok -Encoding ASCII', { FILE: file }, { cwd: dir });

    expect(readFileSync(file, 'utf8').trim()).toBe('ok');
    // Só o arquivo pretendido existe: nenhum comando injetado criou injected.txt ou sub.txt.
    expect(readdirSync(dir)).toEqual([name]);
  });

  it('Bitmap.Save (mesmo padrão da captura do e2e) aceita caminho com aspas simples', () => {
    const file = join(dir, HOSTILE_NAMES[3]!);
    runPowerShell(
      'Add-Type -AssemblyName System.Drawing; $b=New-Object System.Drawing.Bitmap 1,1; $b.Save($env:ORYN_PS_FILE); $b.Dispose()',
      { FILE: file },
      { cwd: dir },
    );
    expect(existsSync(file)).toBe(true);
    expect(readdirSync(dir)).toEqual([HOSTILE_NAMES[3]]);
  });

  it('valores numéricos chegam como texto e são convertidos no script', () => {
    expect(runPowerShell('[long]$env:ORYN_PS_HWND + 1', { HWND: 41 })).toBe('42');
  });
});

describe('runPowerShell / toHandle — validação de entrada', () => {
  it('rejeita nomes de variável fora do padrão', () => {
    expect(() => runPowerShell('1', { 'X; whoami': 'a' })).toThrow(/inválido/);
    expect(() => runPowerShell('1', { lower: 'a' })).toThrow(/inválido/);
  });

  it('aceita apenas dígitos como handle/PID', () => {
    expect(toHandle(1180270)).toBe('1180270');
    expect(toHandle(' 42\n')).toBe('42');
    for (const bad of ['', '-1', '0x10', '1; Stop-Process', '1e3', null, undefined]) {
      expect(() => toHandle(bad)).toThrow(/inválido/);
    }
  });
});
