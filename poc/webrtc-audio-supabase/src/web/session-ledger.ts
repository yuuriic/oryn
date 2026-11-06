// Sessões de chamada abertas neste navegador (NET-01). Permite recuperar uma sessão cuja página acabou sem conseguir
// avisar o servidor, como na recarga ou no encerramento da aba no Safari do iPhone.
//
// Isto é coordenação local, não prova de encerramento. Cada página viva mantém uma trava Web Locks com o id da sessão,
// mas a especificação não define o que acontece com a trava em bfcache ou documento congelado. Por isso, a trava livre
// sozinha não basta: é preciso também uma destas evidências (ver `canRetire`):
// - a própria página registrou a saída, no pagehide ou numa saída não confirmada;
// - esta é a mesma aba, recarregada (a página anterior foi substituída). Uma aba duplicada copia o armazenamento da
//   aba, então o identificador só é mantido em recarga (ver `resolveTabId`);
// - a sessão está sem batimento local há mais de um intervalo de batimento e margem.
// Trava ocupada, inclusive de página congelada, sempre preserva a sessão.
//
// O servidor continua decidindo: encerrar é chamar leave_room, que recusa sessão de outra conta e é idempotente. Outro
// aparelho, outro perfil e janela privada têm outro armazenamento, então nunca entram aqui e dependem da expiração de
// 90 s no servidor.
//
// No armazenamento ficam só ids e carimbos, por origem, conta e sessão: nada de JWT, token ou credencial. Cada sessão
// tem a própria chave, então abas diferentes não sobrescrevem as entradas umas das outras.
//
// Sem Web Locks ou sem armazenamento, nada é registrado nem encerrado: vale o comportamento anterior.

import { isUuid } from '../../supabase/functions/_shared/signal-contract.ts';
import { shortCode, type RpcResult, type SessionTracker } from './supabase-signaling.ts';

const KEY_PREFIX = 'oryn.callSession.v1';
const LOCK_PREFIX = 'oryn.callSession.v1';
const TAB_KEY = 'oryn.tabId';
/** Um batimento (30 s) e margem. Bem abaixo dos 90 s do servidor; protege página suspensa por pouco tempo. */
export const RETIRE_GRACE_MS = 40_000;

export interface ListableStore {
  keys(): string[];
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LockManagerLike {
  request<T>(name: string, options: { ifAvailable: true }, callback: (lock: unknown) => Promise<T> | T): Promise<T>;
}

export interface SessionLedgerDeps {
  /** null: armazenamento indisponível. */
  store: ListableStore | null;
  /** null: navegador sem Web Locks. */
  locks: LockManagerLike | null;
  origin: string;
  /** Identifica a aba; sobrevive à recarga. null: indisponível (sem essa evidência, vale o tempo de carência). */
  tabId(): string | null;
  now(): number;
  leave(sessionId: string): Promise<RpcResult<unknown>>;
  graceMs?: number;
}

interface Entry {
  room: string;
  tab: string | null;
  beat: number;
  closing: boolean;
}

function parseEntry(raw: string | null): Entry | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!isUuid(v['room']) || typeof v['beat'] !== 'number' || !Number.isFinite(v['beat'])) return null;
    return { room: v['room'], tab: typeof v['tab'] === 'string' ? v['tab'] : null, beat: v['beat'], closing: v['closing'] === true };
  } catch {
    return null;
  }
}

export class SessionLedger {
  private readonly deps: SessionLedgerDeps;
  private readonly grace: number;
  /** Sessões desta página. O valor solta a trava; null enquanto a trava não foi concedida. */
  private readonly holds = new Map<string, (() => void) | null>();
  private readonly reclaiming = new Map<string, Promise<ReclaimResult>>();
  /** Reserva de entrada desta página, mantida da verificação até a sessão ser registrada. */
  private entry: { name: string; release: () => void } | null = null;

  constructor(deps: SessionLedgerDeps) {
    this.deps = deps;
    this.grace = deps.graceMs ?? RETIRE_GRACE_MS;
  }

  /** Falso: sem recuperação automática nem aviso de outra aba; sobra a expiração no servidor. */
  get supported(): boolean {
    return this.deps.store !== null && this.deps.locks !== null;
  }

  private prefix(userId: string): string {
    return `${KEY_PREFIX}:${this.deps.origin}:${userId}:`;
  }

  private lockName(userId: string, sessionId: string): string {
    return `${LOCK_PREFIX}:${userId}:${sessionId}`;
  }

  private read(userId: string, sessionId: string): Entry | null {
    try {
      return parseEntry(this.deps.store?.getItem(this.prefix(userId) + sessionId) ?? null);
    } catch {
      return null;
    }
  }

  private write(userId: string, sessionId: string, entry: Entry): void {
    try {
      this.deps.store?.setItem(this.prefix(userId) + sessionId, JSON.stringify(entry));
    } catch {
      // armazenamento cheio ou negado: a sessão fica para a expiração no servidor
    }
  }

  private remove(userId: string, sessionId: string): void {
    try {
      this.deps.store?.removeItem(this.prefix(userId) + sessionId);
    } catch {
      // nada a limpar
    }
  }

  private release(sessionId: string): void {
    const release = this.holds.get(sessionId);
    this.holds.delete(sessionId);
    release?.();
  }

  /** Sessões registradas desta conta. Entradas ilegíveis são descartadas: não valem como evidência de nada. */
  private entries(userId: string): { sessionId: string; entry: Entry }[] {
    const prefix = this.prefix(userId);
    let keys: string[];
    try {
      keys = this.deps.store?.keys() ?? [];
    } catch {
      return [];
    }
    const found: { sessionId: string; entry: Entry }[] = [];
    for (const key of keys) {
      if (!key.startsWith(prefix)) continue;
      const sessionId = key.slice(prefix.length);
      const entry = isUuid(sessionId) ? this.read(userId, sessionId) : null;
      if (entry) found.push({ sessionId, entry });
      else this.removeKey(key);
    }
    return found;
  }

  private removeKey(key: string): void {
    try {
      this.deps.store?.removeItem(key);
    } catch {
      // nada a limpar
    }
  }

  private entryLock(userId: string, roomId: string): string {
    return `${LOCK_PREFIX}:entry:${userId}:${roomId}`;
  }

  /**
   * Reserva a entrada nesta sala para esta página: duas abas não passam juntas pela verificação e pelo pedido de
   * microfone. Falso: outra página deste navegador está entrando. Sem Web Locks, ou se a API falhar, não bloqueia:
   * o limite continua no join_room.
   */
  reserveEntry(userId: string, roomId: string): Promise<boolean> {
    const { locks } = this.deps;
    if (!this.supported || !locks) return Promise.resolve(true);
    const name = this.entryLock(userId, roomId);
    if (this.entry?.name === name) return Promise.resolve(true);
    this.releaseEntry();
    return new Promise((resolve) => {
      locks
        .request(name, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(false);
            return undefined;
          }
          return new Promise<void>((release) => {
            this.entry = { name, release };
            resolve(true);
          });
        })
        .catch(() => resolve(true));
    });
  }

  /** Idempotente. O fim da página solta a reserva sozinho. */
  releaseEntry(): void {
    const entry = this.entry;
    this.entry = null;
    entry?.release();
  }

  /** Outra página deste navegador está entrando nesta sala. Nunca rejeita. */
  async entryHeldElsewhere(userId: string, roomId: string): Promise<boolean> {
    const { locks } = this.deps;
    const name = this.entryLock(userId, roomId);
    if (!this.supported || !locks || this.entry?.name === name) return false;
    return locks.request(name, { ifAvailable: true }, (lock) => lock === null).catch(() => false);
  }

  /** Registro de uma sessão desta página, entregue à sinalização. */
  tracker(userId: string, roomId: string): SessionTracker {
    return {
      opened: (sessionId) => this.opened(userId, roomId, sessionId),
      beat: (sessionId) => {
        const entry = this.read(userId, sessionId);
        if (entry && this.holds.has(sessionId)) this.write(userId, sessionId, { ...entry, beat: this.deps.now(), closing: false });
      },
      closing: (sessionId) => {
        const entry = this.read(userId, sessionId);
        if (entry) this.write(userId, sessionId, { ...entry, closing: true });
        this.release(sessionId);
      },
      left: (sessionId) => {
        this.remove(userId, sessionId);
        this.release(sessionId);
      },
    };
  }

  private opened(userId: string, roomId: string, sessionId: string): void {
    const { locks } = this.deps;
    if (!this.supported || !locks) return;
    this.holds.set(sessionId, null);
    void locks
      .request(this.lockName(userId, sessionId), { ifAvailable: true }, (lock) => {
        // Saiu antes de a trava ser concedida: não há o que registrar.
        if (!lock || !this.holds.has(sessionId)) return undefined;
        // Trava primeiro, registro depois: quem lê a entrada de uma página viva sempre encontra a trava ocupada.
        this.write(userId, sessionId, { room: roomId, tab: this.safeTabId(), beat: this.deps.now(), closing: false });
        this.releaseEntry(); // a sessão já está visível às outras abas
        return new Promise<void>((resolve) => {
          if (this.holds.has(sessionId)) this.holds.set(sessionId, resolve);
          else resolve();
        });
      })
      .catch(() => undefined);
  }

  private safeTabId(): string | null {
    try {
      return this.deps.tabId();
    } catch {
      return null;
    }
  }

  private canRetire(entry: Entry): boolean {
    if (entry.closing) return true;
    const tab = this.safeTabId();
    if (tab !== null && entry.tab === tab) return true;
    return this.deps.now() - entry.beat >= this.grace;
  }

  /**
   * Encerra as sessões órfãs desta conta neste navegador. Nunca rejeita. Uma chamada por conta por vez nesta página;
   * entre abas, quem não obtém a trava pula a sessão, e leave_room é idempotente.
   */
  reclaim(userId: string): Promise<ReclaimResult> {
    const running = this.reclaiming.get(userId);
    if (running) return running;
    const run = this.reclaimNow(userId).finally(() => this.reclaiming.delete(userId));
    this.reclaiming.set(userId, run);
    return run;
  }

  private async reclaimNow(userId: string): Promise<ReclaimResult> {
    const { locks } = this.deps;
    const result: ReclaimResult = { retired: 0, pending: 0 };
    if (!this.supported || !locks) return result;
    for (const { sessionId } of this.entries(userId)) {
      if (this.holds.has(sessionId)) continue;
      const outcome = await locks
        .request(this.lockName(userId, sessionId), { ifAvailable: true }, async (lock) => {
          if (!lock) return 'held' as const;
          // Lida de novo sob a trava: outra aba pode ter terminado esta limpeza.
          const entry = this.read(userId, sessionId);
          if (!entry) return 'gone' as const;
          if (!this.canRetire(entry)) return 'wait' as const;
          const res = await this.deps.leave(sessionId).catch(() => ({ data: null, error: 'erro' }));
          // session-invalid: a sessão não existe para esta conta. Falha de rede ou de JWT: tenta de novo depois.
          if (res.error && shortCode(res.error) !== 'session-invalid') return 'wait' as const;
          this.remove(userId, sessionId);
          return 'retired' as const;
        })
        .catch(() => 'wait' as const);
      if (outcome === 'retired') result.retired += 1;
      if (outcome === 'wait') result.pending += 1;
    }
    return result;
  }

  /** Sessões desta sala e conta mantidas por OUTRA página viva ou congelada deste navegador. Nunca rejeita. */
  async heldElsewhere(userId: string, roomId: string): Promise<string[]> {
    const { locks } = this.deps;
    if (!this.supported || !locks) return [];
    const held: string[] = [];
    for (const { sessionId, entry } of this.entries(userId)) {
      if (entry.room !== roomId || this.holds.has(sessionId)) continue;
      const free = await locks.request(this.lockName(userId, sessionId), { ifAvailable: true }, (lock) => lock !== null).catch(() => true);
      if (!free) held.push(sessionId);
    }
    return held;
  }
}

export interface ReclaimResult {
  retired: number;
  /** Órfãs que ainda não podem ser encerradas (carência) ou cuja saída falhou. */
  pending: number;
}

// ---------- navegador ----------

/**
 * O identificador só sobrevive à recarga. O armazenamento da aba é copiado na duplicação e em window.open, e a cópia não
 * pode valer como "a mesma aba": sem isso, ela poderia encerrar a sessão de uma original viva que perdesse a trava.
 */
export function resolveTabId(known: string | null, navigationType: string | undefined, create: () => string): string {
  return known && isUuid(known) && navigationType === 'reload' ? known : create();
}

export function browserStore(storage: Storage | null): ListableStore | null {
  if (!storage) return null;
  return {
    keys: () => Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((k): k is string => k !== null),
    getItem: (key) => storage.getItem(key),
    setItem: (key, value) => storage.setItem(key, value),
    removeItem: (key) => storage.removeItem(key),
  };
}

/** Só com uma medida real: em janelas restritas, o simples acesso ao armazenamento pode lançar. */
export function createBrowserLedger(leave: SessionLedgerDeps['leave']): SessionLedger {
  let store: ListableStore | null = null;
  try {
    store = browserStore(window.localStorage);
  } catch {
    store = null;
  }
  const locks = (navigator as unknown as { locks?: LockManagerLike }).locks ?? null;
  let current: string | null = null;
  const tabId = (): string | null => {
    if (current) return current;
    const tabs = window.sessionStorage;
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    current = resolveTabId(tabs.getItem(TAB_KEY), navigation?.type, () => crypto.randomUUID());
    tabs.setItem(TAB_KEY, current);
    return current;
  };
  // Já na carga: uma cópia que recarregasse antes do primeiro uso herdaria o identificador da original.
  try {
    tabId();
  } catch {
    current = null; // armazenamento da aba indisponível: sem essa evidência, vale a carência
  }
  return new SessionLedger({ store, locks, origin: window.location.origin, tabId, now: Date.now, leave });
}
