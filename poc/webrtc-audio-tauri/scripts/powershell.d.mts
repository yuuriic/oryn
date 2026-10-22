// Tipos de scripts/powershell.mjs para o typecheck dos testes.
export function runPowerShell(
  script: string,
  vars?: Record<string, string | number>,
  options?: { cwd?: string },
): string;
export function toHandle(value: unknown): string;
