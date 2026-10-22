// Admissão de participantes (POC-02B.2B): autorização do operador e convites de uso único.
// Lógica pura e síncrona (tempo e aleatoriedade injetáveis), testável de forma determinística.
//
// - Chave do operador: só o hash SHA-256 fica em memória; comparação em tempo constante.
// - Convites: 256 bits aleatórios; só o hash é guardado; uso único; expiração curta; um convite
//   ativo por sessão (emitir um novo revoga o anterior); revogados quando a sessão termina.
// - Consumo atômico: verificação e remoção acontecem na mesma chamada síncrona. O Node processa
//   uma mensagem por vez, então duas entradas com o mesmo convite nunca são aceitas.
// - Nenhum segredo é registrado em log nem incluído em mensagens de erro.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const newToken = (): string => randomBytes(32).toString('base64url');

export const hashToken = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

export type OperatorCheck = 'ok' | 'unauthorized' | 'locked';

export interface AdmissionOptions {
  /** SHA-256 da chave do operador. null = criação de sessões desabilitada (fechado por padrão). */
  operatorKeyHash: Buffer | null;
  inviteTtlMs: number;
  /** Falhas locais de autenticação do operador dentro da janela que disparam o bloqueio. */
  maxOperatorFailures: number;
  failureWindowMs: number;
  lockoutMs: number;
  now: () => number;
  randomToken: () => string;
}

interface InviteRecord {
  sessionId: string;
  expiresAt: number;
}

export class Admission {
  private readonly invites = new Map<string, InviteRecord>(); // hash(hex) → convite
  private readonly bySession = new Map<string, string>(); // sessionId → hash(hex) do convite ativo
  private failures: number[] = [];
  private lockedUntil = 0;
  private readonly options: AdmissionOptions;

  constructor(options: AdmissionOptions) {
    this.options = options;
  }

  get activeInvites(): number {
    return this.invites.size;
  }

  /**
   * Verifica a chave do operador. Só conexões com Host local podem tentar; tentativas pelo
   * hostname público são recusadas sem contar para o bloqueio global (evita que um terceiro
   * remoto bloqueie o operador).
   */
  verifyOperator(key: string, local: boolean): OperatorCheck {
    const expected = this.options.operatorKeyHash;
    if (!local || expected === null) return 'unauthorized';
    const now = this.options.now();
    if (now < this.lockedUntil) return 'locked';
    const actual = hashToken(key);
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
      this.failures = [];
      return 'ok';
    }
    this.failures = this.failures.filter((t) => t > now - this.options.failureWindowMs);
    this.failures.push(now);
    if (this.failures.length >= this.options.maxOperatorFailures) {
      this.lockedUntil = now + this.options.lockoutMs;
      this.failures = [];
    }
    return 'unauthorized';
  }

  /** Emite um convite para a sessão, revogando o anterior. O token em claro só sai daqui. */
  issueInvite(sessionId: string): { token: string; expiresAt: number } {
    this.revokeSession(sessionId);
    const token = this.options.randomToken();
    const key = hashToken(token).toString('hex');
    const expiresAt = this.options.now() + this.options.inviteTtlMs;
    this.invites.set(key, { sessionId, expiresAt });
    this.bySession.set(sessionId, key);
    return { token, expiresAt };
  }

  /** Sessão do convite, se válido e não expirado, SEM consumi-lo. */
  peekInvite(token: string): string | null {
    const record = this.invites.get(hashToken(token).toString('hex'));
    if (!record || record.expiresAt <= this.options.now()) return null;
    return record.sessionId;
  }

  /** Consome o convite (uso único). Retorna a sessão ou null se inválido, expirado ou já usado. */
  consumeInvite(token: string): string | null {
    const key = hashToken(token).toString('hex');
    const record = this.invites.get(key);
    if (!record) return null;
    this.invites.delete(key);
    if (this.bySession.get(record.sessionId) === key) this.bySession.delete(record.sessionId);
    return record.expiresAt > this.options.now() ? record.sessionId : null;
  }

  /** Revoga o convite ativo da sessão (sessão encerrada ou novo convite emitido). */
  revokeSession(sessionId: string): void {
    const key = this.bySession.get(sessionId);
    if (key) this.invites.delete(key);
    this.bySession.delete(sessionId);
  }

  /** Remove convites expirados. */
  sweep(): void {
    const now = this.options.now();
    for (const [key, record] of this.invites) {
      if (record.expiresAt <= now) {
        this.invites.delete(key);
        if (this.bySession.get(record.sessionId) === key) this.bySession.delete(record.sessionId);
      }
    }
  }
}
