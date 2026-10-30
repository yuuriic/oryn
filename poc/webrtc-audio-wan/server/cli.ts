// Utilitários de linha de comando compartilhados pelos scripts do servidor.

export function argValue(name: string, argv: readonly string[] = process.argv): string | undefined {
  const prefix = `--${name}=`;
  return argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

export function hasFlag(name: string, argv: readonly string[] = process.argv): boolean {
  return argv.includes(`--${name}`);
}

export function portArg(name: string, fallback: number, argv: readonly string[] = process.argv): number {
  const raw = argValue(name, argv);
  if (raw === undefined) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Porta inválida em --${name}: ${raw}`);
  return port;
}
