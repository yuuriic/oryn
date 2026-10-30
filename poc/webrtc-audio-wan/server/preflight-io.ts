// E/S compartilhada pelas ferramentas offline (pré-validação e prontidão): leitura de arquivos, estado no
// git e busca de segredos REAIS em arquivos versionados. Valores sensíveis nunca vão em argumentos de
// processo: os padrões do `git grep` são passados pela entrada padrão.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));

export function repoRoot(): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: here, encoding: 'utf8' }).trim();
  } catch {
    return resolve(here, '..', '..', '..');
  }
}

export function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function parseEnvText(text: string): Record<string, string> | null {
  try {
    return parseEnv(text) as Record<string, string>;
  } catch {
    return null;
  }
}

/** Versionado ou não ignorado pelo git (dentro do repositório). Fora do repositório = false. */
export function isTrackedOrUnignored(root: string, path: string): boolean {
  const abs = resolve(path);
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', abs], { cwd: root, stdio: 'ignore' });
    return true; // versionado
  } catch {
    // não versionado: precisa estar ignorado
  }
  try {
    execFileSync('git', ['check-ignore', '-q', abs], { cwd: root, stdio: 'ignore' });
    return false; // ignorado
  } catch (error) {
    // status 1 = não ignorado; 128 = fora do repositório
    return (error as { status?: number }).status === 1;
  }
}

/** true se algum arquivo versionado contém o valor literal (padrão pela entrada padrão, nunca em argumento). */
export function trackedContains(root: string, value: string): boolean {
  if (value.length < 8 || /[\r\n]/.test(value)) return false;
  const r = spawnSync('git', ['grep', '-q', '-F', '-f', '-'], { cwd: root, input: `${value}\n`, encoding: 'utf8' });
  return r.status === 0;
}

/** true se algum arquivo versionado contém algo com formato de JWT. */
export function trackedHasJwt(root: string): boolean {
  const r = spawnSync('git', ['grep', '-q', '-E', '-f', '-'], { cwd: root, input: 'eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\n', encoding: 'utf8' });
  return r.status === 0;
}
