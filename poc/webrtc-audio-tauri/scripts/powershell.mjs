// Execução segura de PowerShell para os scripts de teste.
//
// Valores variáveis (caminhos, handles, PIDs) NUNCA são concatenados ao texto do script:
// são passados como variáveis de ambiente ORYN_PS_<NOME> e lidos no script como
// $env:ORYN_PS_<NOME>. O PowerShell trata o conteúdo dessas variáveis apenas como dado,
// então aspas simples, ponto e vírgula ou $(...) em um caminho não executam nada.
// Compatível com Windows PowerShell 5.1 (powershell.exe).

import { execFileSync } from 'node:child_process';

const NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * Executa `script` no Windows PowerShell e devolve a saída sem espaços nas pontas.
 * @param {string} script Texto fixo do script; referencie valores como $env:ORYN_PS_<NOME>.
 * @param {Record<string, string | number>} [vars] Valores expostos como ORYN_PS_<NOME>.
 * @param {{ cwd?: string }} [options]
 */
export function runPowerShell(script, vars = {}, options = {}) {
  const env = { ...process.env };
  for (const [name, value] of Object.entries(vars)) {
    if (!NAME.test(name)) throw new Error(`Nome de variável inválido: ${name}`);
    env[`ORYN_PS_${name}`] = String(value);
  }
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    env,
    cwd: options.cwd,
  }).trim();
}

/** Valida um handle de janela ou PID: somente dígitos decimais. */
export function toHandle(value) {
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw new Error(`Handle/PID inválido: ${JSON.stringify(value)}`);
  return text;
}
