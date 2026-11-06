// Verificação antes de entrar na chamada (NET-01): nada aqui abre o microfone. A página só pede o microfone quando
// `check` devolve `go`, e sempre depois de uma ação do usuário.
//
// É uma leitura para orientar a tela. Quem decide é o join_room, que continua podendo recusar (corrida entre abas ou
// aparelhos); nesse caso, a página chama `blockedByServer`. Sem resposta confiável, não libera: a entrada exige sala
// confirmada, e o erro nunca abre o microfone.
//
// Mensagens: só textos fixos. Nada do servidor é repassado à tela.

import { parseRosterEntry, type RosterEntry } from '../contracts.ts';
import { shortCode, type RpcResult } from './supabase-signaling.ts';

/** Mesmo limite do join_room. */
export const MAX_SESSIONS_PER_ACCOUNT = 2;
const POLL_MS = 5_000;
/** Depois disso, para de consultar e deixa a próxima verificação para um clique. */
const MAX_POLL_MS = 120_000;
const CHECK_TIMEOUT_MS = 4_000;

export type BlockReason = 'limit' | 'other-tab';

export type EntryState =
  | { status: 'idle' }
  | { status: 'checking'; roomId: string }
  | { status: 'blocked'; roomId: string; reason: BlockReason; polling: boolean }
  | { status: 'released'; roomId: string }
  | { status: 'error'; roomId: string; code: string };

export type EntryVerdict = 'go' | 'blocked' | 'failed' | 'cancelled';

export interface EntryGateDeps {
  /** Encerra as sessões órfãs deste navegador; nunca rejeita. */
  reclaim(): Promise<unknown>;
  /** Sessões desta sala mantidas por outra página deste navegador; nunca rejeita. */
  heldElsewhere(roomId: string): Promise<string[]>;
  roster(roomId: string): Promise<RpcResult<unknown[]>>;
  onChange(state: EntryState): void;
  pollMs?: number;
  maxPollMs?: number;
  timeoutMs?: number;
}

type Evaluation = { kind: 'free' } | { kind: 'blocked'; reason: BlockReason } | { kind: 'failed'; code: string };

const IDLE: EntryState = { status: 'idle' };

export class EntryGate {
  private s: EntryState = IDLE;
  /** Muda em nova verificação, cancelamento, logout e entrada: resposta antiga não mexe em nada. */
  private epoch = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly deps: EntryGateDeps;

  constructor(deps: EntryGateDeps) {
    this.deps = deps;
  }

  get state(): EntryState {
    return this.s;
  }

  get checking(): boolean {
    return this.s.status === 'checking';
  }

  private set(next: EntryState): void {
    this.s = next;
    this.deps.onChange(next);
  }

  private stopPolling(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Verifica uma vez e, se bloqueada, passa a acompanhar. Só `go` autoriza pedir o microfone. */
  async check(roomId: string): Promise<EntryVerdict> {
    this.stopPolling();
    const epoch = ++this.epoch;
    this.set({ status: 'checking', roomId });
    const result = await this.withTimeout(this.evaluate(roomId));
    if (epoch !== this.epoch) return 'cancelled';
    if (result.kind === 'free') {
      this.set(IDLE);
      return 'go';
    }
    if (result.kind === 'failed') {
      this.set({ status: 'error', roomId, code: result.code });
      return 'failed';
    }
    this.startPolling(roomId, result.reason, epoch);
    return 'blocked';
  }

  /** O join_room recusou depois de a verificação liberar. O microfone já foi liberado pela falha da chamada. */
  blockedByServer(roomId: string): void {
    this.stopPolling();
    this.startPolling(roomId, 'limit', ++this.epoch);
  }

  /** Cancelar, logout ou início da chamada. */
  reset(): void {
    this.stopPolling();
    this.epoch += 1;
    if (this.s.status !== 'idle') this.set(IDLE);
  }

  private startPolling(roomId: string, reason: BlockReason, epoch: number): void {
    this.set({ status: 'blocked', roomId, reason, polling: true });
    const deadline = Date.now() + (this.deps.maxPollMs ?? MAX_POLL_MS);
    const tick = (): void => {
      this.timer = setTimeout(() => void poll(), this.deps.pollMs ?? POLL_MS);
    };
    const poll = async (): Promise<void> => {
      const result = await this.withTimeout(this.evaluate(roomId));
      if (epoch !== this.epoch) return;
      // Liberar não entra na chamada: o microfone só abre com um novo clique.
      if (result.kind === 'free') return this.set({ status: 'released', roomId });
      if (result.kind === 'blocked' && (this.s.status !== 'blocked' || this.s.reason !== result.reason)) {
        this.set({ status: 'blocked', roomId, reason: result.reason, polling: true });
      }
      if (Date.now() >= deadline) {
        const lastReason = this.s.status === 'blocked' ? this.s.reason : reason;
        return this.set({ status: 'blocked', roomId, reason: lastReason, polling: false });
      }
      tick();
    };
    tick();
  }

  private async evaluate(roomId: string): Promise<Evaluation> {
    await this.deps.reclaim();
    const res = await this.deps.roster(roomId).catch(() => ({ data: null, error: 'erro' }));
    if (res.error || !Array.isArray(res.data)) return { kind: 'failed', code: shortCode(res.error) };
    const parsed = res.data.map(parseRosterEntry);
    if (parsed.some((e) => e === null)) return { kind: 'failed', code: 'erro' };
    const mine = (parsed as RosterEntry[]).filter((e) => e.is_self);
    // Só conta como outra aba se o servidor ainda vê a sessão: a trava de uma aba congelada, com sessão já vencida,
    // não pode impedir a entrada.
    const held = await this.deps.heldElsewhere(roomId);
    if (held.some((id) => mine.some((e) => e.session_id === id))) return { kind: 'blocked', reason: 'other-tab' };
    if (mine.length >= MAX_SESSIONS_PER_ACCOUNT) return { kind: 'blocked', reason: 'limit' };
    return { kind: 'free' };
  }

  private withTimeout(work: Promise<Evaluation>): Promise<Evaluation> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ kind: 'failed', code: 'erro' }), this.deps.timeoutMs ?? CHECK_TIMEOUT_MS);
      void work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        () => {
          clearTimeout(timer);
          resolve({ kind: 'failed', code: 'erro' });
        },
      );
    });
  }
}

// ---------- textos ----------

export const ENTRY_CHECKING = 'Verificando a sala…';
export const ENTRY_RELEASED = 'A vaga foi liberada. Clique em "Entrar agora": o microfone só é ativado nesse momento.';
export const ENTRY_NOT_CHECKED = 'Não foi possível verificar a sala agora. O microfone não foi ligado. Tente de novo.';
export const ENTRY_NOT_MEMBER = 'Esta conta não participa desta sala. O microfone não foi ligado.';
export const ENTRY_STILL_BLOCKED = 'Ainda bloqueada. Clique em "Verificar de novo" quando a outra sessão terminar.';

/** Sem Web Locks, este navegador não consegue recuperar a própria sessão, e só resta a expiração no servidor. */
export function blockedMessage(reason: BlockReason, recoverable: boolean): string {
  if (reason === 'other-tab') return 'Esta chamada já está aberta em outra aba deste navegador. Volte para ela ou feche-a para entrar aqui. O microfone não foi ligado.';
  const base = 'Esta conta já tem 2 sessões ativas nesta sala, em outra aba ou aparelho. O microfone não foi ligado.';
  return recoverable
    ? `${base} Se elas foram fechadas, a vaga é liberada em até 90 s.`
    : `${base} Este navegador não permite recuperar a sessão automaticamente: se elas foram fechadas, a vaga é liberada em até 90 s.`;
}

export function entryErrorMessage(code: string): string {
  return code === 'not-member' ? ENTRY_NOT_MEMBER : ENTRY_NOT_CHECKED;
}
