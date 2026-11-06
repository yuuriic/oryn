// Sessões abandonadas e entrada bloqueada (NET-01): registro local, verificação antes do microfone, sinalização e, no
// fim, os dois contra o SQL real. O ciclo de vida real do Safari do iPhone só se valida em aparelho: aqui, "página morta",
// "congelada" e "bfcache" são simulados pelo gerenciador de travas falso.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EntryGate, MAX_SESSIONS_PER_ACCOUNT, blockedMessage, entryErrorMessage, type EntryGateDeps } from '../src/web/entry-gate.ts';
import { RETIRE_GRACE_MS, SessionLedger, browserStore, type ListableStore, type LockManagerLike, type SessionLedgerDeps } from '../src/web/session-ledger.ts';
import { JOIN_LIMIT_MESSAGE, type RpcResult, type SessionTracker } from '../src/web/supabase-signaling.ts';
import { createRoom, joinWithInvite, makeCreator, openSession } from './helpers/fixtures.ts';
import { TestDb } from './helpers/db.ts';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const ROOM = '33333333-3333-4333-8333-333333333333';
const ROOM2 = '44444444-4444-4444-8444-444444444444';
const S1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const S2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORIGIN = 'https://oryn.example';
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const code = (text: string) => text.replace(/\/\/.*$/gm, '');
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

class MemoryStore implements ListableStore {
  readonly data = new Map<string, string>();
  keys = () => [...this.data.keys()];
  getItem = (k: string) => this.data.get(k) ?? null;
  setItem = (k: string, v: string) => void this.data.set(k, v);
  removeItem = (k: string) => void this.data.delete(k);
}

/** Travas de um navegador. Cada "página" tem o próprio cliente; `kill` solta o que ela segura, como o fim do documento. */
class FakeBrowserLocks {
  readonly held = new Map<string, { page: string; release: () => void }>();
  client(page: string): LockManagerLike {
    return {
      request: async <T,>(name: string, _o: { ifAvailable: true }, callback: (lock: unknown) => Promise<T> | T): Promise<T> => {
        if (this.held.has(name)) return callback(null);
        let release = (): void => undefined;
        const released = new Promise<void>((r) => (release = r));
        this.held.set(name, { page, release });
        try {
          return await Promise.race([Promise.resolve(callback({ name })), released.then(() => undefined as T)]);
        } finally {
          if (this.held.get(name)?.page === page) this.held.delete(name);
        }
      },
    };
  }
  kill(page: string): void {
    for (const [name, h] of [...this.held]) {
      if (h.page === page) {
        this.held.delete(name);
        h.release();
      }
    }
  }
  /** Mantém a trava como se fosse de um documento vivo ou congelado que este teste não controla. */
  holdFor(name: string): void {
    this.held.set(name, { page: 'congelada', release: () => undefined });
  }
}

interface Browser {
  store: MemoryStore;
  locks: FakeBrowserLocks;
  clock: { now: number };
  leave: ReturnType<typeof vi.fn>;
}

function browser(leave?: (sid: string) => Promise<RpcResult<unknown>>): Browser {
  return {
    store: new MemoryStore(),
    locks: new FakeBrowserLocks(),
    clock: { now: 1_000_000 },
    leave: vi.fn(leave ?? (async () => ({ data: null, error: null }))),
  };
}

function page(b: Browser, name: string, tab: string | null = name, over: Partial<SessionLedgerDeps> = {}): SessionLedger {
  return new SessionLedger({
    store: b.store,
    locks: b.locks.client(name),
    origin: ORIGIN,
    tabId: () => tab,
    now: () => b.clock.now,
    leave: b.leave as unknown as SessionLedgerDeps['leave'],
    ...over,
  });
}

async function open(l: SessionLedger, sid: string, user = USER, room = ROOM): Promise<SessionTracker> {
  const t = l.tracker(user, room);
  t.opened(sid);
  await flush();
  return t;
}

describe('registro local: o que fica guardado', () => {
  it('só ids e carimbos, por origem, conta e sessão; sem JWT, token ou credencial', async () => {
    const b = browser();
    await open(page(b, 'a'), S1);
    const [[key, value]] = [...b.store.data] as [[string, string]];
    expect(key).toContain(ORIGIN);
    expect(key).toContain(USER);
    expect(key.endsWith(S1)).toBe(true);
    expect(Object.keys(JSON.parse(value) as object).sort()).toEqual(['beat', 'closing', 'room', 'tab']);
    expect(value).not.toMatch(/eyJ|token|password|refresh|access|apikey/i);
    expect(code(read('src/web/session-ledger.ts'))).not.toMatch(/access_token|refresh_token|password|getSession/);
  });

  it('a trava vem antes do registro: quem lê a entrada de uma página viva sempre encontra a trava ocupada', () => {
    const src = code(read('src/web/session-ledger.ts'));
    const grant = src.indexOf('if (!lock || !this.holds.has(sessionId)) return undefined;');
    expect(grant).toBeGreaterThan(-1);
    expect(src.indexOf('this.write(userId, sessionId, { room: roomId', grant)).toBeGreaterThan(grant);
  });

  it('origem diferente e conta diferente não enxergam a entrada', async () => {
    const b = browser();
    await open(page(b, 'a'), S1);
    b.locks.kill('a');
    b.clock.now += RETIRE_GRACE_MS + 1;
    expect((await page(b, 'b', 'b', { origin: 'https://outra.example' }).reclaim(USER)).retired).toBe(0);
    expect((await page(b, 'b').reclaim(OTHER_USER)).retired).toBe(0);
    expect(b.leave).not.toHaveBeenCalled();
    expect((await page(b, 'b').reclaim(USER)).retired).toBe(1);
  });

  it('entrada corrompida ou fora do contrato é descartada, sem virar saída', async () => {
    const b = browser();
    const prefix = `oryn.callSession.v1:${ORIGIN}:${USER}:`;
    b.store.setItem(`${prefix}${S1}`, '{nao-json');
    b.store.setItem(`${prefix}${S2}`, JSON.stringify({ room: 'x', beat: 'y' }));
    b.store.setItem(`${prefix}nao-e-uuid`, JSON.stringify({ room: ROOM, beat: 1 }));
    await page(b, 'a').reclaim(USER);
    expect(b.leave).not.toHaveBeenCalled();
    expect(b.store.data.size).toBe(0);
  });

  it('saída confirmada limpa o registro; repetir não causa efeito', async () => {
    const b = browser();
    const t = await open(page(b, 'a'), S1);
    t.left(S1);
    t.left(S1);
    await flush();
    expect(b.store.data.size).toBe(0);
    expect(b.locks.held.size).toBe(0);
  });
});

describe('recuperação: só com trava livre e mais uma evidência', () => {
  it('mesma aba recarregada: encerra na hora, sem aguardar a carência', async () => {
    const b = browser();
    await open(page(b, 'antes', 'aba-1'), S1);
    b.locks.kill('antes');
    expect(await page(b, 'depois', 'aba-1').reclaim(USER)).toEqual({ retired: 1, pending: 0 });
    expect(b.leave).toHaveBeenCalledWith(S1);
    expect(b.store.data.size).toBe(0);
  });

  it('a própria página registrou a saída: outra aba encerra na hora', async () => {
    const b = browser();
    const t = await open(page(b, 'a', 'aba-1'), S1);
    t.closing(S1);
    await flush();
    expect(b.locks.held.size).toBe(0);
    expect((await page(b, 'b', 'aba-2').reclaim(USER)).retired).toBe(1);
  });

  it('trava livre sem outra evidência (aba nova, batimento recente): espera a carência, depois encerra', async () => {
    const b = browser();
    await open(page(b, 'a', 'aba-1'), S1);
    b.locks.kill('a');
    const nova = page(b, 'b', 'aba-2');
    expect(await nova.reclaim(USER)).toEqual({ retired: 0, pending: 1 });
    expect(b.leave).not.toHaveBeenCalled();
    b.clock.now += RETIRE_GRACE_MS - 1;
    expect((await nova.reclaim(USER)).pending).toBe(1);
    b.clock.now += 1;
    expect(await nova.reclaim(USER)).toEqual({ retired: 1, pending: 0 });
  });

  it('o batimento adia a carência: sessão com vida recente não é tratada como órfã', async () => {
    const b = browser();
    const t = await open(page(b, 'a', 'aba-1'), S1);
    b.clock.now += RETIRE_GRACE_MS - 5;
    t.beat(S1);
    b.locks.kill('a');
    b.clock.now += 10;
    expect((await page(b, 'b', 'aba-2').reclaim(USER)).pending).toBe(1);
    expect(b.leave).not.toHaveBeenCalled();
  });

  it('sem identificador de aba, vale só a carência', async () => {
    const b = browser();
    await open(page(b, 'a', null), S1);
    b.locks.kill('a');
    expect((await page(b, 'b', null).reclaim(USER)).pending).toBe(1);
  });

  it('falha de rede ou de JWT mantém o registro; a próxima tentativa encerra', async () => {
    const answers: RpcResult<unknown>[] = [{ data: null, error: 'erro' }, { data: null, error: 'JWT expired' }, { data: null, error: null }];
    const b = browser(async () => answers.shift()!);
    await open(page(b, 'antes', 'aba-1'), S1);
    b.locks.kill('antes');
    const depois = page(b, 'depois', 'aba-1');
    expect((await depois.reclaim(USER)).pending).toBe(1);
    expect((await depois.reclaim(USER)).pending).toBe(1);
    expect(b.store.data.size).toBe(1);
    expect((await depois.reclaim(USER)).retired).toBe(1);
    expect(b.store.data.size).toBe(0);
  });

  it('rejeição da RPC não escapa', async () => {
    const b = browser(async () => Promise.reject(new Error('rede')));
    await open(page(b, 'antes', 'aba-1'), S1);
    b.locks.kill('antes');
    await expect(page(b, 'depois', 'aba-1').reclaim(USER)).resolves.toEqual({ retired: 0, pending: 1 });
  });

  it('session-invalid: a sessão não existe para esta conta; limpa sem repetir', async () => {
    const b = browser(async () => ({ data: null, error: 'session-invalid' }));
    await open(page(b, 'antes', 'aba-1'), S1);
    b.locks.kill('antes');
    expect((await page(b, 'depois', 'aba-1').reclaim(USER)).retired).toBe(1);
    expect(b.store.data.size).toBe(0);
  });
});

describe('quem nunca é encerrado', () => {
  it('outra aba viva: a trava ocupada preserva a sessão, por mais antigo que seja o batimento', async () => {
    const b = browser();
    await open(page(b, 'a', 'aba-1'), S1);
    b.clock.now += RETIRE_GRACE_MS * 100;
    expect(await page(b, 'b', 'aba-2').reclaim(USER)).toEqual({ retired: 0, pending: 0 });
    expect(b.leave).not.toHaveBeenCalled();
    expect(b.store.data.size).toBe(1);
  });

  it('aba duplicada (mesmo identificador de aba): a original viva mantém a trava e é preservada', async () => {
    const b = browser();
    await open(page(b, 'original', 'aba-copiada'), S1);
    expect((await page(b, 'duplicada', 'aba-copiada').reclaim(USER)).retired).toBe(0);
    expect(b.leave).not.toHaveBeenCalled();
  });

  it('a própria sessão desta página nunca é alvo', async () => {
    const b = browser();
    const l = page(b, 'a', 'aba-1');
    await open(l, S1);
    b.clock.now += RETIRE_GRACE_MS * 2;
    await l.reclaim(USER);
    expect(b.leave).not.toHaveBeenCalled();
  });

  it('outro perfil ou aparelho: outro armazenamento, nada a encerrar', async () => {
    const perfil1 = browser();
    const perfil2 = browser();
    await open(page(perfil1, 'a', 'aba-1'), S1);
    perfil1.locks.kill('a');
    perfil1.clock.now += RETIRE_GRACE_MS * 2;
    expect((await page(perfil2, 'b', 'aba-2').reclaim(USER)).retired).toBe(0);
    expect(perfil2.leave).not.toHaveBeenCalled();
  });

  it('congelada, com a trava mantida: preservada; ao liberar a trava, volta a ser avaliada', async () => {
    const b = browser();
    await open(page(b, 'congelada', 'aba-1'), S1);
    b.clock.now += RETIRE_GRACE_MS * 10;
    expect((await page(b, 'b', 'aba-2').reclaim(USER)).retired).toBe(0);
    b.locks.kill('congelada');
    expect((await page(b, 'b', 'aba-2').reclaim(USER)).retired).toBe(1);
  });

  it('congelada, com trava perdida em silêncio: batimento recente ainda protege', async () => {
    const b = browser();
    await open(page(b, 'suspensa', 'aba-1'), S1);
    b.locks.kill('suspensa'); // a especificação não define trava em documento congelado
    b.clock.now += RETIRE_GRACE_MS - 1;
    expect((await page(b, 'b', 'aba-2').reclaim(USER)).retired).toBe(0);
    expect(b.leave).not.toHaveBeenCalled();
  });

  it('volta do bfcache: o batimento da sessão retomada renova a evidência e desfaz "saindo"', async () => {
    const b = browser();
    const l = page(b, 'a', 'aba-1');
    const t = await open(l, S1);
    const raw = (): Record<string, unknown> => JSON.parse([...b.store.data.values()][0]!) as Record<string, unknown>;
    const before = raw()['beat'];
    b.clock.now += 1000;
    t.beat(S1);
    expect(raw()['beat']).not.toBe(before);
    expect(raw()['closing']).toBe(false);
  });
});

describe('condições de corrida', () => {
  it('saída antes de a trava ser concedida: nada é registrado', async () => {
    const b = browser();
    const t = page(b, 'a', 'aba-1').tracker(USER, ROOM);
    t.opened(S1);
    t.left(S1);
    await flush();
    expect(b.store.data.size).toBe(0);
    expect(b.locks.held.size).toBe(0);
  });

  it('duas abas limpando ao mesmo tempo: uma única saída', async () => {
    let finish: (v: RpcResult<unknown>) => void = () => undefined;
    const b = browser(() => new Promise((r) => (finish = r)));
    await open(page(b, 'antes', 'x'), S1);
    b.locks.kill('antes');
    b.clock.now += RETIRE_GRACE_MS;
    const a = page(b, 'a', 'aba-a').reclaim(USER);
    await flush();
    const other = page(b, 'b', 'aba-b').reclaim(USER);
    await flush();
    finish({ data: null, error: null });
    expect((await a).retired + (await other).retired).toBe(1);
    expect(b.leave).toHaveBeenCalledTimes(1);
  });

  it('limpezas seguidas na mesma página compartilham a mesma execução', async () => {
    const b = browser();
    await open(page(b, 'antes', 'aba-1'), S1);
    b.locks.kill('antes');
    const l = page(b, 'depois', 'aba-1');
    await Promise.all([l.reclaim(USER), l.reclaim(USER), l.reclaim(USER)]);
    expect(b.leave).toHaveBeenCalledTimes(1);
  });

  it('outra aba terminou a limpeza antes: a entrada lida sob a trava já não existe', async () => {
    const b = browser();
    await open(page(b, 'antes', 'aba-1'), S1);
    b.locks.kill('antes');
    const key = [...b.store.data.keys()][0]!;
    const original = b.locks.client('c').request.bind(b.locks.client('c'));
    const locks: LockManagerLike = {
      request: (name, o, cb) => {
        b.store.removeItem(key); // a outra aba concluiu entre a listagem e a trava
        return original(name, o, cb);
      },
    };
    await page(b, 'c', 'aba-1', { locks }).reclaim(USER);
    expect(b.leave).not.toHaveBeenCalled();
  });

  it('armazenamento que falha não derruba a chamada nem rejeita', async () => {
    const broken: ListableStore = {
      keys: () => {
        throw new Error('negado');
      },
      getItem: () => {
        throw new Error('negado');
      },
      setItem: () => {
        throw new Error('cheio');
      },
      removeItem: () => {
        throw new Error('negado');
      },
    };
    const b = browser();
    const l = page(b, 'a', 'aba-1', { store: broken });
    const t = l.tracker(USER, ROOM);
    expect(() => {
      t.opened(S1);
      t.beat(S1);
      t.closing(S1);
      t.left(S1);
    }).not.toThrow();
    await expect(l.reclaim(USER)).resolves.toEqual({ retired: 0, pending: 0 });
    await expect(l.heldElsewhere(USER, ROOM)).resolves.toEqual([]);
  });

  it('gerenciador de travas que rejeita: nada é encerrado', async () => {
    const b = browser();
    await open(page(b, 'antes', 'aba-1'), S1);
    b.locks.kill('antes');
    const locks: LockManagerLike = { request: () => Promise.reject(new Error('SecurityError')) };
    const l = page(b, 'c', 'aba-1', { locks });
    expect((await l.reclaim(USER)).retired).toBe(0);
    expect(b.leave).not.toHaveBeenCalled();
  });
});

describe('sem Web Locks ou sem armazenamento: fallback seguro', () => {
  it.each([
    ['sem Web Locks', { locks: null }],
    ['sem armazenamento', { store: null }],
  ])('%s: não registra, não encerra e não aponta outra aba', async (_nome, over) => {
    const b = browser();
    const l = page(b, 'a', 'aba-1', over);
    expect(l.supported).toBe(false);
    const t = l.tracker(USER, ROOM);
    t.opened(S1);
    t.beat(S1);
    t.closing(S1);
    t.left(S1);
    await flush();
    expect(b.store.data.size).toBe(0);
    expect(await l.reclaim(USER)).toEqual({ retired: 0, pending: 0 });
    expect(await l.heldElsewhere(USER, ROOM)).toEqual([]);
    expect(b.leave).not.toHaveBeenCalled();
  });

  it('a mensagem diz que este navegador depende da expiração', () => {
    expect(blockedMessage('limit', false)).toMatch(/não permite recuperar a sessão automaticamente/);
    expect(blockedMessage('limit', true)).not.toMatch(/não permite/);
    for (const text of [blockedMessage('limit', true), blockedMessage('limit', false), blockedMessage('other-tab', true)]) {
      expect(text).toMatch(/O microfone não foi ligado/);
    }
  });

  it('browserStore lista as chaves do armazenamento real', () => {
    const data = new Map([['a', '1']]);
    const storage = {
      get length() {
        return data.size;
      },
      key: (i: number) => [...data.keys()][i] ?? null,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
    } as Storage;
    expect(browserStore(storage)?.keys()).toEqual(['a']);
    expect(browserStore(null)).toBeNull();
  });
});

describe('outra aba: heldElsewhere', () => {
  it('aponta só sessão desta sala, mantida por outra página', async () => {
    const b = browser();
    await open(page(b, 'a', 'aba-1'), S1, USER, ROOM);
    await open(page(b, 'b', 'aba-2'), S2, USER, ROOM2);
    const c = page(b, 'c', 'aba-3');
    expect(await c.heldElsewhere(USER, ROOM)).toEqual([S1]);
    expect(await c.heldElsewhere(USER, ROOM2)).toEqual([S2]);
    expect(await c.heldElsewhere(OTHER_USER, ROOM)).toEqual([]);
    b.locks.kill('a');
    expect(await c.heldElsewhere(USER, ROOM)).toEqual([]);
  });

  it('a própria sessão não conta como outra aba', async () => {
    const b = browser();
    const a = page(b, 'a', 'aba-1');
    await open(a, S1);
    expect(await a.heldElsewhere(USER, ROOM)).toEqual([]);
  });
});

describe('verificação antes do microfone', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const entry = (id: string, self: boolean) => ({ session_id: id, display_name: 'N', is_self: self, joined_at: '2026-11-05T00:00:00Z' });

  function setup(over: Partial<EntryGateDeps> = {}) {
    const states: string[] = [];
    let rosterAnswer: RpcResult<unknown[]> = { data: [], error: null };
    let held: string[] = [];
    const reclaim = vi.fn(async () => undefined);
    const roster = vi.fn(async (_r: string) => rosterAnswer);
    const g = new EntryGate({
      reclaim,
      heldElsewhere: async () => held,
      roster,
      onChange: (s) => states.push(s.status),
      pollMs: 5000,
      maxPollMs: 20000,
      timeoutMs: 1000,
      ...over,
    });
    return {
      g,
      states,
      reclaim,
      roster,
      setRoster: (v: RpcResult<unknown[]>) => {
        rosterAnswer = v;
      },
      setHeld: (v: string[]) => {
        held = v;
      },
    };
  }

  it('com vaga: libera, depois de tentar recuperar as órfãs', async () => {
    const t = setup();
    t.setRoster({ data: [entry(S1, true), entry(S2, false)], error: null });
    await expect(t.g.check(ROOM)).resolves.toBe('go');
    expect(t.reclaim.mock.invocationCallOrder[0]).toBeLessThan(t.roster.mock.invocationCallOrder[0]!);
    expect(t.g.state).toEqual({ status: 'idle' });
  });

  it('limite: 2 sessões da própria conta bloqueiam; sessões de outra conta não contam', async () => {
    expect(MAX_SESSIONS_PER_ACCOUNT).toBe(2);
    const t = setup();
    t.setRoster({ data: [entry(S1, false), entry(S2, false)], error: null });
    await expect(t.g.check(ROOM)).resolves.toBe('go');
    t.setRoster({ data: [entry(S1, true), entry(S2, true)], error: null });
    await expect(t.g.check(ROOM)).resolves.toBe('blocked');
    expect(t.g.state).toEqual({ status: 'blocked', roomId: ROOM, reason: 'limit', polling: true });
    t.g.reset();
  });

  it('outra aba viva, confirmada pelo servidor: bloqueia antes do limite', async () => {
    const t = setup();
    t.setHeld([S1]);
    t.setRoster({ data: [entry(S1, true)], error: null });
    await expect(t.g.check(ROOM)).resolves.toBe('blocked');
    expect(t.g.state).toMatchObject({ reason: 'other-tab' });
    t.g.reset();
  });

  it('trava de aba congelada com sessão já vencida no servidor não impede a entrada', async () => {
    const t = setup();
    t.setHeld([S1]);
    t.setRoster({ data: [], error: null });
    await expect(t.g.check(ROOM)).resolves.toBe('go');
  });

  it('liberar não entra: vira "released" e exige novo clique', async () => {
    const t = setup();
    t.setRoster({ data: [entry(S1, true), entry(S2, true)], error: null });
    await t.g.check(ROOM);
    t.setRoster({ data: [entry(S1, true)], error: null });
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.g.state).toEqual({ status: 'released', roomId: ROOM });
    const calls = t.roster.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(t.roster.mock.calls.length).toBe(calls); // parou de consultar
  });

  it('para de consultar no prazo; depois, só com um clique', async () => {
    const t = setup();
    t.setRoster({ data: [entry(S1, true), entry(S2, true)], error: null });
    await t.g.check(ROOM);
    await vi.advanceTimersByTimeAsync(25000);
    expect(t.g.state).toMatchObject({ status: 'blocked', polling: false });
    const calls = t.roster.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(t.roster.mock.calls.length).toBe(calls);
  });

  it('falha temporária durante a espera mantém o bloqueio, sem liberar', async () => {
    const t = setup();
    t.setRoster({ data: [entry(S1, true), entry(S2, true)], error: null });
    await t.g.check(ROOM);
    t.setRoster({ data: null, error: 'erro' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.g.state).toMatchObject({ status: 'blocked' });
    t.g.reset();
  });

  it('o motivo acompanha o estado: a aba fechou, mas ainda há 2 sessões no servidor', async () => {
    const t = setup();
    t.setHeld([S1]);
    t.setRoster({ data: [entry(S1, true), entry(S2, true)], error: null });
    await t.g.check(ROOM);
    expect(t.g.state).toMatchObject({ reason: 'other-tab' });
    t.setHeld([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.g.state).toMatchObject({ status: 'blocked', reason: 'limit' });
    t.g.reset();
  });

  it.each([
    ['falha de rede', () => Promise.reject(new Error('rede'))],
    ['erro do servidor', async () => ({ data: null, error: 'detalhe interno' })],
    ['resposta fora do contrato', async () => ({ data: [{ x: 1 }], error: null })],
    ['resposta sem lista', async () => ({ data: null, error: null })],
  ])('%s: não libera o microfone', async (_nome, roster) => {
    const t = setup({ roster: roster as EntryGateDeps['roster'] });
    await expect(t.g.check(ROOM)).resolves.toBe('failed');
    expect(t.g.state).toMatchObject({ status: 'error', roomId: ROOM });
  });

  it('sem resposta dentro do prazo: não libera', async () => {
    const t = setup({ roster: () => new Promise(() => undefined) });
    const verdict = t.g.check(ROOM);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(verdict).resolves.toBe('failed');
  });

  it('não membro: mensagem própria; nunca repete texto do servidor', async () => {
    const t = setup();
    t.setRoster({ data: null, error: 'not-member' });
    await t.g.check(ROOM);
    expect(t.g.state).toEqual({ status: 'error', roomId: ROOM, code: 'not-member' });
    expect(entryErrorMessage('not-member')).toMatch(/não participa/);
    expect(entryErrorMessage('qualquer')).toMatch(/Não foi possível verificar/);
    expect(entryErrorMessage('qualquer')).toMatch(/O microfone não foi ligado/);
  });

  it('cancelar ou sair da conta durante a verificação: a resposta é descartada', async () => {
    let answer: (v: RpcResult<unknown[]>) => void = () => undefined;
    const t = setup({ roster: () => new Promise((r) => (answer = r)) });
    const verdict = t.g.check(ROOM);
    await flush();
    t.g.reset();
    answer({ data: [], error: null });
    await expect(verdict).resolves.toBe('cancelled');
    expect(t.g.state).toEqual({ status: 'idle' });
  });

  it('cancelar durante o bloqueio para as consultas', async () => {
    const t = setup();
    t.setRoster({ data: [entry(S1, true), entry(S2, true)], error: null });
    await t.g.check(ROOM);
    t.g.reset();
    const calls = t.roster.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(t.roster.mock.calls.length).toBe(calls);
    expect(t.g.state).toEqual({ status: 'idle' });
  });

  it('o servidor recusou depois de liberar: vira bloqueio e acompanha', async () => {
    const t = setup();
    t.setRoster({ data: [entry(S1, true), entry(S2, true)], error: null });
    t.g.blockedByServer(ROOM);
    expect(t.g.state).toMatchObject({ status: 'blocked', reason: 'limit', polling: true });
    t.setRoster({ data: [], error: null });
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.g.state).toEqual({ status: 'released', roomId: ROOM });
  });

  it('nova verificação substitui a anterior', async () => {
    const t = setup();
    t.setRoster({ data: [entry(S1, true), entry(S2, true)], error: null });
    await t.g.check(ROOM);
    t.setRoster({ data: [], error: null });
    await expect(t.g.check(ROOM2)).resolves.toBe('go');
    await vi.advanceTimersByTimeAsync(60000);
    expect(t.g.state).toEqual({ status: 'idle' });
  });
});

describe('estático: a página', () => {
  const main = code(read('src/web/main.ts'));
  const gate = code(read('src/web/entry-gate.ts'));
  const ledger = code(read('src/web/session-ledger.ts'));

  it('só cria a chamada, e portanto o microfone, depois do veredito `go`', () => {
    const start = /function startCall\(roomInput: string\): void \{([\s\S]*?)\n\}/.exec(main)?.[1] ?? '';
    expect(start).toMatch(/entryGate\.check\(roomId\)\.then\(\(verdict\) => \{\s*if \(verdict === 'go'[^\n]*beginCall\(roomId, userId\)/);
    expect(start).not.toMatch(/new PeerCall|getUserMedia/);
    expect(main.match(/beginCall\(/g)).toHaveLength(2); // a definição e a única chamada
    expect(main.match(/new PeerCall/g)).toHaveLength(1);
    expect(main.indexOf('function beginCall')).toBeLessThan(main.indexOf('new PeerCall'));
  });

  it('a liberação não inicia nada: "Entrar agora" passa pelo clique e verifica de novo', () => {
    expect(main).toMatch(/entryGoBtn\.addEventListener\('click'[\s\S]{0,90}startCall\(roomId\)/);
    expect(gate).not.toMatch(/startCall|beginCall|getUserMedia|PeerCall/);
  });

  it('a recusa do join_room continua decidindo, e vira o estado de bloqueio', () => {
    expect(main).toMatch(/error === JOIN_LIMIT_MESSAGE && callRoomId\) \{[\s\S]{0,180}entryGate\.blockedByServer\(callRoomId\)/);
    expect(JOIN_LIMIT_MESSAGE).toMatch(/2 sessões/);
  });

  it('nada de eventos de visibilidade encerrando a chamada; o pagehide continua como melhor esforço', () => {
    expect(main).not.toMatch(/visibilitychange|beforeunload/);
    expect(main).toMatch(/addEventListener\('pagehide'/);
    expect(main).toMatch(/addEventListener\('pageshow'[\s\S]{0,200}event\.persisted/);
  });

  it('órfã ainda na carência é revista depois, também a partir da verificação de entrada', () => {
    expect(main).toMatch(/reclaim: \(\) => \(selfUserId \? sweepOrphans\(selfUserId\)/);
    expect(main).toMatch(/if \(pending > 0 && selfUserId === userId\) sweepTimer = setTimeout\(\(\) => void sweepOrphans\(userId\)/);
    expect(main).toMatch(/if \(sweepTimer !== null\) clearTimeout\(sweepTimer\);\s*sweepTimer = null;\s*entryGate\.reset\(\)/);
  });

  it('o registro não toma sessão: só leave_room, com a trava obtida, e sem steal', () => {
    expect(ledger).not.toMatch(/steal|force/);
    expect(main).toMatch(/createBrowserLedger\(\(sessionId\) => backend\.rpc\('leave_room', \{ p_session_id: sessionId \}\)\)/);
  });
});

describe('contra o SQL real', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await TestDb.create();
  });
  afterEach(() => db.close());

  const rpcAs = (actor: { uid: string }) => async <T,>(fn: string, args: Record<string, unknown>): Promise<RpcResult<T>> => {
    try {
      // Como o PostgREST entrega: JSON, com datas em texto.
      return { data: JSON.parse(JSON.stringify(await db.rpc(actor, `public.${fn}`, args))) as T, error: null };
    } catch (e) {
      return { data: null, error: (e as Error).message };
    }
  };

  const ledgerFor = (b: Browser, name: string, tab: string, actor: { uid: string }) =>
    page(b, name, tab, { leave: (sid) => rpcAs(actor)('leave_room', { p_session_id: sid }) });

  const gateFor = (l: SessionLedger, actor: { uid: string }) =>
    new EntryGate({
      reclaim: () => l.reclaim(actor.uid),
      heldElsewhere: (roomId) => l.heldElsewhere(actor.uid, roomId),
      roster: (roomId) => rpcAs(actor)<unknown[]>('get_roster', { p_room_id: roomId }),
      onChange: () => undefined,
      pollMs: 60_000,
    });

  const reason = async (sid: string) => (await db.admin<{ r: string | null }>('select revoke_reason r from oryn.room_sessions where id = $1', [sid]))[0]?.r;

  it('regressão do iPhone: duas páginas somem sem leave_room; a mesma aba volta e entra sem esperar 90 s', async () => {
    const owner = await makeCreator(db);
    const room = await createRoom(db, owner, 2);
    const member = await joinWithInvite(db, room, owner);
    const b = browser();
    const s1 = await openSession(db, member, room);
    const s2 = await openSession(db, member, room);
    await open(ledgerFor(b, 'p1', 'aba-1', member), s1, member.uid, room);
    await open(ledgerFor(b, 'p2', 'aba-2', member), s2, member.uid, room);
    expect(await db.rpcError(member, 'public.join_room', { p_room_id: room })).toBe('limit-reached');

    b.locks.kill('p1');
    b.locks.kill('p2');
    const volta = ledgerFor(b, 'p3', 'aba-1', member);
    await expect(gateFor(volta, member).check(room)).resolves.toBe('go'); // aba-1 recuperada; aba-2 ainda na carência
    expect(await reason(s1)).toBe('left');
    expect(await reason(s2)).toBeNull();
    expect(await openSession(db, member, room)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('duas páginas vivas: nenhuma é encerrada; a entrada fica bloqueada, e o join_room também recusa', async () => {
    const owner = await makeCreator(db);
    const room = await createRoom(db, owner, 2);
    const member = await joinWithInvite(db, room, owner);
    const b = browser();
    const s1 = await openSession(db, member, room);
    const s2 = await openSession(db, member, room);
    await open(ledgerFor(b, 'p1', 'aba-1', member), s1, member.uid, room);
    await open(ledgerFor(b, 'p2', 'aba-2', member), s2, member.uid, room);
    const g = gateFor(ledgerFor(b, 'p3', 'aba-3', member), member);
    await expect(g.check(room)).resolves.toBe('blocked');
    g.reset();
    expect(await reason(s1)).toBeNull();
    expect(await reason(s2)).toBeNull();
    expect(await db.rpcError(member, 'public.join_room', { p_room_id: room })).toBe('limit-reached');
  });

  it('o servidor é a autoridade: sessão de OUTRA conta forjada no registro não é encerrada', async () => {
    const owner = await makeCreator(db);
    const room = await createRoom(db, owner, 2);
    const member = await joinWithInvite(db, room, owner);
    const vitima = await openSession(db, owner, room);
    const b = browser();
    // Alguém grava no armazenamento do próprio navegador o id de uma sessão alheia.
    b.store.setItem(`oryn.callSession.v1:${ORIGIN}:${member.uid}:${vitima}`, JSON.stringify({ room, tab: 'aba-1', beat: 0, closing: true }));
    const l = ledgerFor(b, 'p', 'aba-1', member);
    await l.reclaim(member.uid);
    expect(await reason(vitima)).toBeNull();
    expect((await db.rpc<{ session_id: string }>(owner, 'public.get_roster', { p_room_id: room })).map((e) => e.session_id)).toContain(vitima);
    expect(b.store.data.size).toBe(0); // a entrada forjada foi descartada
  });

  it('encerrar é idempotente: duas execuções não mudam o motivo nem falham', async () => {
    const owner = await makeCreator(db);
    const room = await createRoom(db, owner, 2);
    const member = await joinWithInvite(db, room, owner);
    const sid = await openSession(db, member, room);
    expect(await db.rpcError(member, 'public.leave_room', { p_session_id: sid })).toBeNull();
    expect(await db.rpcError(member, 'public.leave_room', { p_session_id: sid })).toBeNull();
    expect(await reason(sid)).toBe('left');
  });

  it('sem registro local (outro aparelho, sem Web Locks): depende da expiração de 90 s no servidor', async () => {
    const owner = await makeCreator(db);
    const room = await createRoom(db, owner, 2);
    const member = await joinWithInvite(db, room, owner);
    await openSession(db, member, room);
    await openSession(db, member, room);
    const g = gateFor(ledgerFor(browser(), 'p', 'aba', member), member);
    await expect(g.check(room)).resolves.toBe('blocked');
    g.reset();
    await db.admin(`update oryn.room_sessions set last_seen_at = now() - interval '91 seconds' where user_id = $1`, [member.uid]);
    await expect(g.check(room)).resolves.toBe('go');
    expect(await openSession(db, member, room)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
