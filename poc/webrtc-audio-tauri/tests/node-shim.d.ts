// Tipos mínimos das APIs do Node usadas em tests/powershell.test.ts.
// Evita adicionar @types/node só para um teste; o código da aplicação roda no WebView2, não no Node.
declare module 'node:fs' {
  export function existsSync(path: string): boolean;
  export function mkdtempSync(prefix: string): string;
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
}

declare const process: { readonly platform: string };
