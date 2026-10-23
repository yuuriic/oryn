// Autenticação administrativa do operador (POC-02B.2C): pareamento por código de uso único.
// Lógica pura e síncrona (tempo e aleatoriedade injetáveis), testável de forma determinística.
//
// Fluxo:
// 1. O servidor gera um CÓDIGO DE PAREAMENTO curto (8 caracteres, 40 bits, Crockford base32), de uso
//    único, com validade curta e número limitado de tentativas. Só o código aparece no terminal.
// 2. A página administrativa (listener administrativo, loopback) troca o código por um TOKEN de
//    sessão administrativa (256 bits), mantido só em memória no navegador.
// 3. O token autoriza create/rejoin/invite no listener administrativo.
//
// Só hashes SHA-256 ficam em memória no servidor; comparações em tempo constante.
// O token nunca é impresso, registrado em log nem persistido.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Alfabeto Crockford base32 (sem I, L, O, U): legível e sem ambiguidades ao digitar. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 40 bits aleatórios → 8 caracteres Crockford. */
export function newPairingCode(): string {
  const bytes = randomBytes(5);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let i = 7; i >= 0; i--) out += CROCKFORD[Number((bits >> BigInt(i * 5)) & 31n)];
  return out;
}

/** Exibição em dois grupos: "ABCD-EFGH". */
export const formatPairingCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

/** Normaliza o que o operador digitou: maiúsculas, sem hífens/espaços; I/L → 1 e O → 0. */
export function normalizePairingCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

const sameHash = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);

export type PairResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; reason: 'invalid' | 'exhausted' };

export interface AdminAuthOptions {
  codeTtlMs: number;
  /** Tentativas erradas que queimam o código atual (exige gerar outro pelo terminal). */
  maxCodeAttempts: number;
  sessionTtlMs: number;
  now: () => number;
  newCode: () => string;
  newToken: () => string;
}

export class AdminAuth {
  private code: { hash: Buffer; expiresAt: number; attempts: number } | null = null;
  private session: { hash: Buffer; expiresAt: number } | null = null;
  private readonly options: AdminAuthOptions;

  constructor(options: AdminAuthOptions) {
    this.options = options;
  }

  /** true enquanto houver um código válido aguardando uso. */
  get pairingPending(): boolean {
    return this.code !== null && this.code.expiresAt > this.options.now();
  }

  /** Gera um novo código (invalida o anterior). O código em claro só sai daqui, para o terminal. */
  issuePairingCode(): { code: string; expiresAt: number } {
    const code = this.options.newCode();
    const expiresAt = this.options.now() + this.options.codeTtlMs;
    this.code = { hash: sha256(code), expiresAt, attempts: 0 };
    return { code, expiresAt };
  }

  /**
   * Troca o código por um token de sessão administrativa. Uso único: o código é descartado em caso
   * de sucesso. Um novo pareamento revoga o token anterior (uma sessão administrativa por vez).
   */
  pair(input: string): PairResult {
    const current = this.code;
    if (!current || current.expiresAt <= this.options.now()) {
      this.code = null;
      return { ok: false, reason: 'invalid' };
    }
    if (!sameHash(sha256(normalizePairingCode(input)), current.hash)) {
      current.attempts += 1;
      if (current.attempts >= this.options.maxCodeAttempts) {
        this.code = null;
        return { ok: false, reason: 'exhausted' };
      }
      return { ok: false, reason: 'invalid' };
    }
    this.code = null;
    const token = this.options.newToken();
    const expiresAt = this.options.now() + this.options.sessionTtlMs;
    this.session = { hash: sha256(token), expiresAt };
    return { ok: true, token, expiresAt };
  }

  /** Verifica o token administrativo (tempo constante; expira). */
  verify(token: string): boolean {
    const session = this.session;
    if (!session || session.expiresAt <= this.options.now()) return false;
    return sameHash(sha256(token), session.hash);
  }

  /** Revoga a sessão administrativa e o código pendente. */
  revokeAll(): void {
    this.code = null;
    this.session = null;
  }
}
