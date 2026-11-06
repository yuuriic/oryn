// Soundboard no cliente, sem navegador: catálogo, eventos, prazo com relógio errado, cache, limites e limpeza. O áudio é um barramento
// falso: prova as decisões, não o som. A saída real é medida no roteiro de navegador.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcResult } from '../src/web/supabase-signaling.ts';
import { sha256Hex } from '../supabase/functions/_shared/sound-validate.ts';
import { MAX_SIMULTANEOUS_SOUNDS, SoundBus, type PlayResult, type SoundBusLike } from '../src/web/sound-bus.ts';
import { SOUND_CACHE_MAX_BYTES, SoundCache, soundKey, type SoundCacheMeta, type SoundStore } from '../src/web/sound-cache.ts';
import { SOUND_DENIED, SOUND_POLL_MS, ServerClock, SoundboardController, parseCatalog, type SoundPrefs, type SoundboardDeps, type SoundboardState } from '../src/web/soundboard.ts';
import { renderSoundboard, soundDetail, soundboardStatus } from '../src/web/soundboard-view.ts';
import { SOUND_PREFS_DEFAULT, loadSoundPrefs, saveSoundPrefs } from '../src/web/sound-prefs.ts';
import { parseSoundEvent } from '../src/contracts.ts';
import { mp3, wav } from './helpers/sound-files.ts';

const ROOM = '10000000-0000-4000-8000-000000000001';
const ACCOUNT = '20000000-0000-4000-8000-000000000002';
const SESSION = '30000000-0000-4000-8000-000000000003';
const OTHER_SESSION = '30000000-0000-4000-8000-000000000004';
const ASSET = '40000000-0000-4000-8000-000000000005';
const ASSET_B = '40000000-0000-4000-8000-000000000006';
const uuid = (n: number) => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

class MemoryStore implements SoundStore {
  metas = new Map<string, SoundCacheMeta>();
  bytes = new Map<string, ArrayBuffer>();
  fail = false;
  async list() {
    if (this.fail) throw new Error('idb');
    return [...this.metas.values()];
  }
  async read(key: string) {
    if (this.fail) throw new Error('idb');
    return this.bytes.get(key) ?? null;
  }
  async write(meta: SoundCacheMeta, bytes: ArrayBuffer) {
    if (this.fail) throw new Error('idb');
    this.metas.set(meta.key, meta);
    this.bytes.set(meta.key, bytes);
  }
  async touch(key: string, lastUsed: number) {
    const m = this.metas.get(key);
    if (m) this.metas.set(key, { ...m, lastUsed });
  }
  async remove(keys: string[]) {
    for (const k of keys) {
      this.metas.delete(k);
      this.bytes.delete(k);
    }
  }
}

class FakeBus implements SoundBusLike {
  played: AudioBuffer[] = [];
  volume = -1;
  unlocked = 0;
  stopped = 0;
  result: PlayResult = 'playing';
  decodeFail = false;
  active = 0;
  unlock() {
    this.unlocked += 1;
  }
  async decode(bytes: ArrayBuffer) {
    if (this.decodeFail) throw new Error('decode');
    return { byteLength: bytes.byteLength } as unknown as AudioBuffer;
  }
  play(buffer: AudioBuffer) {
    if (this.result === 'playing') this.played.push(buffer);
    return this.result;
  }
  setVolume(v: number) {
    this.volume = v;
  }
  stopAll() {
    this.stopped += 1;
  }
}

interface Options {
  clockSkewMs?: number;
  prefs?: SoundPrefs;
  session?: string | null;
  store?: MemoryStore;
}

const fileA = wav(500);
const fileB = wav(800);
let hashA: string;
let hashB: string;

beforeEach(async () => {
  hashA = await sha256Hex(fileA);
  hashB = await sha256Hex(fileB);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-11-06T20:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

const assetRow = (id: string, name: string, sha: string) => ({
  asset_id: id, name, version: 1, sha256: sha, mime: 'audio/wav', size_bytes: 1000, duration_ms: 500, state: 'available', created_at: '2026-11-06T19:00:00Z',
});

/** SHA-256 em curso: roda fora da thread, então a espera dos testes acompanha cada um, sem depender da carga da máquina. */
let digests = 0;
const realDigest = crypto.subtle.digest.bind(crypto.subtle);
vi.spyOn(crypto.subtle, 'digest').mockImplementation((...args: Parameters<SubtleCrypto['digest']>) => {
  digests += 1;
  return realDigest(...args).finally(() => {
    digests -= 1;
  });
});

/** Termina a fila de promessas, inclusive o SHA-256 real, sem avançar a hora simulada. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    while (digests > 0) await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function harness(o: Options = {}) {
  const bus = new FakeBus();
  const store = o.store ?? new MemoryStore();
  const cache = new SoundCache(store, () => Date.now());
  const rpcs: [string, Record<string, unknown>][] = [];
  const h = {
    catalog: [assetRow(ASSET, 'Risada', hashA), assetRow(ASSET_B, 'Buzina', hashB)] as unknown[],
    catalogError: null as string | null,
    downloads: [] as string[],
    downloadFail: false,
    downloadDelayMs: 0,
    clockFail: false,
    /** Quanto o relógio deste aparelho está à frente do servidor. */
    skew: o.clockSkewMs ?? 0,
    triggerError: null as string | null,
    uploads: [] as string[],
    uploadOk: true,
    media: [] as Record<string, string>[],
    mediaResult: { status: 200, body: {} } as { status: number; body: Record<string, unknown> },
    confirm: true,
    session: o.session === undefined ? SESSION : o.session,
    saved: [] as SoundPrefs[],
    hidden: false,
  };
  const serverNow = () => Date.now() - h.skew;
  const rpc = async <T,>(fn: string, args: Record<string, unknown>): Promise<RpcResult<T>> => {
    rpcs.push([fn, args]);
    const ok = (data: unknown) => ({ data: data as T, error: null });
    if (fn === 'sound_clock') return h.clockFail ? { data: null, error: 'erro' } : ok(new Date(serverNow()).toISOString());
    if (fn === 'list_sounds') return h.catalogError ? { data: null, error: h.catalogError } : ok(h.catalog);
    if (fn === 'trigger_sound') {
      if (h.triggerError) return { data: null, error: h.triggerError };
      const issued = serverNow();
      return ok([{ event_id: uuid(900 + rpcs.length), asset_id: args['p_asset_id'], version: 1, sha256: args['p_asset_id'] === ASSET ? hashA : hashB, issued_at: new Date(issued).toISOString(), expires_at: new Date(issued + 2000).toISOString() }]);
    }
    if (fn === 'request_sound_upload') return ok([{ asset_id: uuid(1), object_key: `${ROOM}/${uuid(1)}/v1`, upload_expires_at: '2026-11-06T21:00:00Z' }]);
    return ok(null);
  };
  const deps: SoundboardDeps = {
    rpc,
    upload: async (key) => {
      h.uploads.push(key);
      return h.uploadOk;
    },
    download: async (key) => {
      h.downloads.push(key);
      if (h.downloadDelayMs) await new Promise((r) => setTimeout(r, h.downloadDelayMs));
      if (h.downloadFail) return null;
      return (key.includes(ASSET_B) ? fileB : fileA).slice().buffer as ArrayBuffer;
    },
    invokeMedia: async (body) => {
      h.media.push(body);
      return h.mediaResult;
    },
    cache,
    bus,
    loadPrefs: () => o.prefs ?? { volume: 0.5, disabled: false },
    savePrefs: (p) => h.saved.push(p),
    sessionId: () => h.session,
    wallNow: () => Date.now(),
    monoNow: () => Date.now(),
    isHidden: () => h.hidden,
    confirm: () => h.confirm,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    onChange: () => undefined,
  };
  const sb = new SoundboardController(deps);
  /** Evento como o servidor o emitiu há `ageMs`, na hora do servidor. */
  const event = (n: number, ageMs = 0, asset = ASSET, sha = hashA) => {
    const issued = serverNow() - ageMs;
    return { id: uuid(n + 500), event_id: uuid(n), session_id: OTHER_SESSION, sender_ref: 'ref', asset_id: asset, version: 1, sha256: sha, issued_at: new Date(issued).toISOString(), expires_at: new Date(issued + 2000).toISOString() };
  };
  const ready = async (owner = false) => {
    sb.enter(ROOM, ACCOUNT, owner);
    await settle();
  };
  const calls = (fn: string) => rpcs.filter(([f]) => f === fn);
  return { h, bus, store, rpcs, calls, sb, event, ready };
}

describe('contrato do evento', () => {
  const valid = { event_id: uuid(1), session_id: uuid(2), sender_ref: 'r', asset_id: uuid(3), version: 1, sha256: 'a'.repeat(64), issued_at: '2026-11-06T20:00:00.123456+00:00', expires_at: '2026-11-06T20:00:02.123456+00:00' };
  it('aceita o evento e o `id` do realtime.send, que fica de fora', () => {
    expect(parseSoundEvent(valid)).toEqual(valid);
    expect(parseSoundEvent({ ...valid, id: uuid(4) })).toEqual(valid);
  });
  it.each([
    ['chave a mais', { ...valid, url: 'https://x' }],
    ['event_id inválido', { ...valid, event_id: 'x' }],
    ['hash inválido', { ...valid, sha256: 'x' }],
    ['versão inválida', { ...valid, version: 0 }],
    ['prazo diferente de 2 s', { ...valid, expires_at: '2026-11-06T20:10:00+00:00' }],
    ['data inválida', { ...valid, issued_at: 'ontem' }],
    ['id inválido', { ...valid, id: 'x' }],
  ])('recusa %s', (_, v) => {
    expect(parseSoundEvent(v)).toBeNull();
  });
  it('catálogo fora do contrato é erro, não lista vazia', () => {
    expect(parseCatalog('x')).toBeNull();
    expect(parseCatalog([{ asset_id: 'x' }])).toBeNull();
    expect(parseCatalog([{ ...assetRow(ASSET, 'a', 'a'.repeat(64)), sha256: null }])).toBeNull();
    expect(parseCatalog([])).toEqual([]);
  });
});

describe('catálogo e cache frio/quente', () => {
  it('entra, lista e deixa o cache quente sem ninguém disparar', async () => {
    const t = harness();
    await t.ready();
    expect(t.sb.state.status).toBe('ready');
    expect(t.sb.state.sounds.map((s) => s.name)).toEqual(['Risada', 'Buzina']);
    expect(t.sb.state.sounds.every((s) => s.local === 'ready')).toBe(true);
    expect(t.h.downloads.sort()).toEqual([`${ROOM}/${ASSET_B}/v1`, `${ROOM}/${ASSET}/v1`].sort());
    expect(t.store.metas.size).toBe(2);
  });

  it('cache quente: entrar de novo não baixa nada', async () => {
    const store = new MemoryStore();
    const first = harness({ store });
    await first.ready();
    first.sb.leave();
    const second = harness({ store });
    await second.ready();
    expect(second.h.downloads).toEqual([]);
    expect(second.sb.state.sounds.every((s) => s.local === 'ready')).toBe(true);
  });

  it('cache adulterado: descarta e baixa de novo', async () => {
    const store = new MemoryStore();
    const first = harness({ store });
    await first.ready();
    first.sb.leave();
    const key = soundKey(ACCOUNT, ROOM, ASSET, 1, hashA);
    store.bytes.set(key, new TextEncoder().encode('outro conteúdo').buffer as ArrayBuffer);
    const second = harness({ store });
    await second.ready();
    expect(second.h.downloads).toEqual([`${ROOM}/${ASSET}/v1`]);
    expect(await sha256Hex(new Uint8Array(store.bytes.get(key)!))).toBe(hashA);
  });

  it('download com hash errado não vai para o cache nem toca', async () => {
    const t = harness();
    t.h.catalog = [assetRow(ASSET, 'Risada', 'f'.repeat(64))];
    await t.ready();
    expect(t.sb.state.sounds[0]!.local).toBe('error');
    expect(t.store.metas.size).toBe(0);
    t.sb.onEvent(t.event(1, 0, ASSET, 'f'.repeat(64)));
    await settle();
    expect(t.bus.played).toHaveLength(0);
    expect(t.sb.counters.failed).toBe(1);
  });

  it('sem armazenamento, tudo segue: baixa e toca', async () => {
    const store = new MemoryStore();
    store.fail = true;
    const t = harness({ store });
    await t.ready();
    t.sb.onEvent(t.event(1));
    await settle();
    expect(t.bus.played).toHaveLength(1);
  });

  it('o catálogo muda sozinho; som removido sai do cache', async () => {
    const t = harness();
    await t.ready();
    t.h.catalog = [assetRow(ASSET, 'Risada', hashA)];
    await vi.advanceTimersByTimeAsync(SOUND_POLL_MS);
    await settle();
    expect(t.sb.state.sounds.map((s) => s.name)).toEqual(['Risada']);
    expect([...t.store.metas.keys()]).toEqual([soundKey(ACCOUNT, ROOM, ASSET, 1, hashA)]);
  });

  it('com a página oculta, não consulta', async () => {
    const t = harness();
    await t.ready();
    t.h.hidden = true;
    const before = t.calls('list_sounds').length;
    await vi.advanceTimersByTimeAsync(SOUND_POLL_MS * 3);
    await settle();
    expect(t.calls('list_sounds')).toHaveLength(before);
  });

  it('removido da sala: painel negado, sem áudio', async () => {
    const t = harness();
    await t.ready();
    t.h.catalogError = 'not-member';
    await vi.advanceTimersByTimeAsync(SOUND_POLL_MS);
    await settle();
    expect(t.sb.state.status).toBe('denied');
    expect(t.sb.state.message?.text).toBe(SOUND_DENIED);
    expect(t.sb.state.sounds).toEqual([]);
    expect(t.bus.stopped).toBeGreaterThan(0);
    t.sb.onEvent(t.event(1));
    await settle();
    expect(t.bus.played).toHaveLength(0);
  });

  it('falha de rede na primeira carga: aviso, e tenta de novo', async () => {
    const t = harness();
    t.h.catalogError = 'erro';
    await t.ready();
    expect(t.sb.state.status).toBe('error');
    t.h.catalogError = null;
    await vi.advanceTimersByTimeAsync(SOUND_POLL_MS);
    await settle();
    expect(t.sb.state.status).toBe('ready');
    expect(t.sb.state.message).toBeNull();
  });
});

describe('reprodução por evento', () => {
  it('toca uma vez; o mesmo event_id repetido não toca de novo', async () => {
    const t = harness();
    await t.ready();
    const e = t.event(1);
    t.sb.onEvent(e);
    t.sb.onEvent(e);
    await settle();
    t.sb.onEvent(e);
    await settle();
    expect(t.bus.played).toHaveLength(1);
    expect(t.sb.counters).toMatchObject({ played: 1, duplicate: 2 });
  });

  it('evento fora do contrato é ignorado', async () => {
    const t = harness();
    await t.ready();
    t.sb.onEvent({ ...t.event(1), audio: 'AAAA' });
    t.sb.onEvent('x');
    await settle();
    expect(t.bus.played).toHaveLength(0);
  });

  it('evento da própria sessão é ignorado: o emissor já tocou pela resposta', async () => {
    const t = harness();
    await t.ready();
    t.sb.onEvent({ ...t.event(1), session_id: SESSION });
    await settle();
    expect(t.bus.played).toHaveLength(0);
  });

  it('sessão em espera não toca: a mesma conta já ouve na sessão da chamada', async () => {
    const t = harness();
    await t.ready();
    t.sb.setStandby(true);
    t.sb.onEvent(t.event(1));
    await settle();
    expect(t.bus.played).toHaveLength(0);
    t.sb.setStandby(false);
    t.sb.onEvent(t.event(2));
    await settle();
    expect(t.bus.played).toHaveLength(1);
  });

  it('limite de simultaneidade: o barramento recusa, e o som é contado como descartado', async () => {
    const t = harness();
    await t.ready();
    t.bus.result = 'busy';
    t.sb.onEvent(t.event(1));
    await settle();
    expect(t.sb.counters.busy).toBe(1);
  });

  it('áudio bloqueado pelo navegador: avisa, e um clique libera', async () => {
    const t = harness();
    await t.ready();
    t.bus.result = 'blocked';
    t.sb.onEvent(t.event(1));
    await settle();
    expect(t.sb.state.message?.text).toMatch(/bloqueou/);
    t.sb.unlock();
    expect(t.bus.unlocked).toBeGreaterThan(0);
    expect(t.sb.state.message).toBeNull();
  });

  it('cache frio: baixa e toca, se ainda estiver no prazo', async () => {
    const t = harness();
    t.h.catalog = [];
    await t.ready();
    t.h.downloadDelayMs = 300;
    t.sb.onEvent(t.event(1));
    await settle();
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect(t.h.downloads).toEqual([`${ROOM}/${ASSET}/v1`]);
    expect(t.bus.played).toHaveLength(1);
  });

  it('cache frio: download lento demais não toca atrasado, mas aquece o cache', async () => {
    const t = harness();
    t.h.catalog = [];
    await t.ready();
    t.h.downloadDelayMs = 2_500;
    t.sb.onEvent(t.event(1));
    await settle();
    await vi.advanceTimersByTimeAsync(2_500);
    await settle();
    expect(t.bus.played).toHaveLength(0);
    expect(t.sb.counters.expired).toBe(1);
    expect(t.sb.state.message?.text).toMatch(/não chegou a tempo/);
    expect(t.store.metas.size).toBe(1);
  });

  it('falha ao decodificar não derruba nada', async () => {
    const t = harness();
    t.h.catalog = [];
    await t.ready();
    t.bus.decodeFail = true;
    t.sb.onEvent(t.event(1));
    await settle();
    expect(t.bus.played).toHaveLength(0);
    expect(t.sb.counters.failed).toBe(1);
  });
});

describe('prazo e relógios', () => {
  it.each([
    ['certo', 0],
    ['1 h adiantado', 3_600_000],
    ['1 h atrasado', -3_600_000],
    ['30 s adiantado', 30_000],
    ['1,5 s atrasado', -1_500],
  ])('relógio %s: evento novo toca', async (_, skew) => {
    const t = harness({ clockSkewMs: skew });
    await t.ready();
    t.sb.onEvent(t.event(1));
    await settle();
    expect(t.bus.played).toHaveLength(1);
    expect(t.sb.counters.expired).toBe(0);
  });

  it.each([
    ['certo', 0],
    ['1 h adiantado', 3_600_000],
    ['1 h atrasado', -3_600_000],
  ])('relógio %s: evento de 3 s atrás não toca', async (_, skew) => {
    const t = harness({ clockSkewMs: skew });
    await t.ready();
    t.sb.onEvent(t.event(1, 3_000));
    await settle();
    expect(t.bus.played).toHaveLength(0);
    expect(t.sb.counters.expired).toBe(1);
  });

  it('evento antigo recebido depois de reconectar não toca', async () => {
    const t = harness();
    await t.ready();
    t.sb.onEvent(t.event(1, 60_000));
    await settle();
    expect(t.bus.played).toHaveLength(0);
  });

  it('evento com 1,5 s de idade ainda toca', async () => {
    const t = harness();
    await t.ready();
    t.sb.onEvent(t.event(1, 1_500));
    await settle();
    expect(t.bus.played).toHaveLength(1);
  });

  it('relógio do sistema ajustado depois da medida: mede de novo e toca o que é válido', async () => {
    const t = harness();
    await t.ready();
    vi.setSystemTime(Date.now() + 3_600_000);
    t.h.skew = 3_600_000; // o servidor não mudou
    t.sb.onEvent(t.event(1));
    await settle();
    expect(t.bus.played).toHaveLength(1);
  });

  it('sem conseguir medir a hora, descarta: não toca às cegas', async () => {
    const t = harness();
    t.h.clockFail = true;
    await t.ready();
    t.sb.onEvent(t.event(1));
    await settle();
    expect(t.bus.played).toHaveLength(0);
    expect(t.sb.counters.expired).toBe(1);
  });

  it('ServerClock: fica a amostra de menor ida e volta, e a tolerância é limitada', async () => {
    let wall = 1_000_000;
    let reply = 0;
    const clock = new ServerClock(async () => {
      wall += reply; // ida e volta simulada
      return new Date(wall - reply / 2 + 5_000).toISOString();
    }, () => wall);
    reply = 2_000;
    await clock.sync();
    reply = 40;
    await clock.sync();
    reply = 900;
    await clock.sync();
    const left = clock.remaining(new Date(wall + 5_000 + 1_000).toISOString())!;
    expect(left).toBeGreaterThanOrEqual(1_000);
    expect(left).toBeLessThanOrEqual(1_030);
  });

  it('ServerClock: amostra inválida não altera a estimativa', async () => {
    const clock = new ServerClock(async () => 'não é data', () => 0);
    expect(await clock.sync()).toBe(false);
    expect(clock.synced).toBe(false);
    expect(clock.remaining('2026-01-01T00:00:00Z')).toBeNull();
  });
});

describe('disparo', () => {
  it('emissor toca uma vez, pela resposta do servidor; o cooldown vale 2 s na tela', async () => {
    const t = harness();
    await t.ready();
    await t.sb.trigger(ASSET);
    await settle();
    expect(t.bus.played).toHaveLength(1);
    expect(t.calls('trigger_sound')[0]![1]).toEqual({ p_session_id: SESSION, p_asset_id: ASSET });
    expect(t.sb.state.cooling).toBe(true);
    await t.sb.trigger(ASSET);
    expect(t.calls('trigger_sound')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.sb.state.cooling).toBe(false);
  });

  it.each([
    ['rate-limited', /Aguarde/],
    ['sound-unavailable', /não está mais disponível/],
    ['session-invalid', /não vale mais/],
    ['erro qualquer', /falha de rede/],
  ])('recusa %s: mensagem fixa, sem tocar', async (code, text) => {
    const t = harness();
    await t.ready();
    t.h.triggerError = code;
    await t.sb.trigger(ASSET);
    await settle();
    expect(t.sb.state.message?.text).toMatch(text);
    expect(t.bus.played).toHaveLength(0);
  });

  it('sem sessão ou em espera não chama o servidor', async () => {
    const t = harness({ session: null });
    await t.ready();
    await t.sb.trigger(ASSET);
    t.h.session = SESSION;
    t.sb.setStandby(true);
    await t.sb.trigger(ASSET);
    expect(t.calls('trigger_sound')).toEqual([]);
  });

  it('desativado localmente: dispara para os outros, sem tocar aqui', async () => {
    const t = harness({ prefs: { volume: 0.5, disabled: true } });
    await t.ready();
    await t.sb.trigger(ASSET);
    await settle();
    expect(t.calls('trigger_sound')).toHaveLength(1);
    expect(t.bus.played).toHaveLength(0);
  });
});

describe('volume e desativação', () => {
  it('volume próprio, aplicado ao barramento e guardado', async () => {
    const t = harness({ prefs: { volume: 0.25, disabled: false } });
    expect(t.bus.volume).toBe(0.25);
    await t.ready();
    t.sb.setVolume(0.8);
    expect(t.bus.volume).toBe(0.8);
    expect(t.h.saved.at(-1)).toEqual({ volume: 0.8, disabled: false });
    t.sb.setVolume(3);
    expect(t.bus.volume).toBe(1);
  });

  it('desativar para o que está tocando, não baixa nem toca; reativar volta a tocar', async () => {
    const t = harness({ prefs: { volume: 0.5, disabled: true } });
    await t.ready();
    expect(t.h.downloads).toEqual([]);
    t.sb.onEvent(t.event(1));
    await settle();
    expect(t.bus.played).toHaveLength(0);
    t.sb.setDisabled(false);
    await settle();
    expect(t.h.downloads.length).toBe(2);
    t.sb.onEvent(t.event(2));
    await settle();
    expect(t.bus.played).toHaveLength(1);
    const stops = t.bus.stopped;
    t.sb.setDisabled(true);
    expect(t.bus.stopped).toBe(stops + 1);
    expect(t.h.saved.at(-1)).toEqual({ volume: 0.5, disabled: true });
  });
});

describe('fim da chamada', () => {
  it('sair para os sons, esquece os eventos e ignora o que chegar depois', async () => {
    const t = harness();
    await t.ready();
    t.sb.leave();
    expect(t.bus.stopped).toBeGreaterThan(0);
    expect(t.sb.state.status).toBe('closed');
    t.sb.onEvent(t.event(1));
    await settle();
    expect(t.bus.played).toHaveLength(0);
  });

  it('um download em curso ao sair não toca nem marca nada', async () => {
    const t = harness();
    t.h.catalog = [];
    await t.ready();
    t.h.downloadDelayMs = 200;
    t.sb.onEvent(t.event(1));
    await settle();
    t.sb.leave();
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(t.bus.played).toHaveLength(0);
  });
});

describe('publicação e remoção', () => {
  const file = (bytes: Uint8Array) => new Blob([bytes as BlobPart]);

  it('fluxo completo: reserva, envia, valida; faz limpeza ao entrar', async () => {
    const t = harness();
    await t.ready(true);
    expect(t.h.media).toContainEqual({ action: 'cleanup', room_id: ROOM });
    t.h.media.length = 0;
    const done = t.sb.publish(file(mp3(1000)), '  Risada  ');
    await settle();
    await done;
    expect(t.calls('request_sound_upload')[0]![1]).toMatchObject({ p_room_id: ROOM, p_name: 'Risada' });
    expect(t.h.uploads).toEqual([`${ROOM}/${uuid(1)}/v1`]);
    expect(t.h.media).toEqual([{ action: 'validate', asset_id: uuid(1) }]);
    expect(t.sb.state.message).toEqual({ tone: 'info', text: '"Risada" publicado.' });
    expect(t.sb.state.publishing).toBe(false);
  });

  it.each([
    ['HTML', new TextEncoder().encode('<html>'), /Formato não aceito/],
    ['longo demais', wav(10_500), /10 segundos/],
    ['cortado', wav(1000).subarray(0, 500), /cortado/],
  ])('%s: recusado antes de reservar ou enviar', async (_, bytes, text) => {
    const t = harness();
    await t.ready(true);
    const done = t.sb.publish(file(bytes), 'Som');
    await settle();
    await done;
    expect(t.sb.state.message?.text).toMatch(text);
    expect(t.calls('request_sound_upload')).toEqual([]);
    expect(t.h.uploads).toEqual([]);
  });

  it('acima de 2 MiB: recusado sem ler o arquivo', async () => {
    const t = harness();
    await t.ready(true);
    const big = { size: 3 * 1024 * 1024, arrayBuffer: () => { throw new Error('leu'); } } as unknown as Blob;
    await t.sb.publish(big, 'Som');
    expect(t.sb.state.message?.text).toMatch(/2 MiB/);
  });

  it('nome inválido e conta sem poder', async () => {
    const t = harness();
    await t.ready(false);
    await t.sb.publish(file(mp3(1000)), 'Som');
    expect(t.calls('request_sound_upload')).toEqual([]);
    const o = harness();
    await o.ready(true);
    await o.sb.publish(file(mp3(1000)), 'x'.repeat(41));
    expect(o.sb.state.message?.text).toMatch(/40 caracteres/);
  });

  it('o servidor recusa o conteúdo: mostra o motivo', async () => {
    const t = harness();
    await t.ready(true);
    t.h.mediaResult = { status: 422, body: { error: 'too-long' } };
    const done = t.sb.publish(file(mp3(1000)), 'Som');
    await settle();
    await done;
    expect(t.sb.state.message?.text).toMatch(/10 segundos/);
  });

  it('falha no envio: desfaz a reserva e limpa', async () => {
    const t = harness();
    await t.ready(true);
    t.h.uploadOk = false;
    t.h.media.length = 0;
    const done = t.sb.publish(file(mp3(1000)), 'Som');
    await settle();
    await done;
    expect(t.calls('remove_sound')[0]![1]).toEqual({ p_asset_id: uuid(1) });
    expect(t.h.media).toEqual([{ action: 'cleanup', room_id: ROOM }]);
    expect(t.sb.state.publishing).toBe(false);
    expect(t.sb.state.message?.tone).toBe('error');
  });

  it('remoção pede confirmação, some da lista e dispara a limpeza', async () => {
    const t = harness();
    await t.ready(true);
    t.h.confirm = false;
    await t.sb.remove(ASSET);
    expect(t.calls('remove_sound')).toEqual([]);
    t.h.confirm = true;
    t.h.media.length = 0;
    t.h.catalog = [assetRow(ASSET_B, 'Buzina', hashB)];
    await t.sb.remove(ASSET);
    await settle();
    expect(t.sb.state.sounds.map((s) => s.asset_id)).toEqual([ASSET_B]);
    expect(t.h.media).toEqual([{ action: 'cleanup', room_id: ROOM }]);
  });

  it('papel descoberto depois da entrada: o dono passa a ver o formulário e a limpeza roda', async () => {
    const t = harness();
    await t.ready(false);
    expect(t.sb.state.isOwner).toBe(false);
    t.sb.setOwner('outra-sala', true);
    expect(t.sb.state.isOwner).toBe(false);
    t.sb.setOwner(ROOM, true);
    await settle();
    expect(t.sb.state.isOwner).toBe(true);
    expect(t.h.media).toContainEqual({ action: 'cleanup', room_id: ROOM });
  });

  it('membro não remove', async () => {
    const t = harness();
    await t.ready(false);
    await t.sb.remove(ASSET);
    expect(t.calls('remove_sound')).toEqual([]);
  });
});

describe('SoundCache', () => {
  const meta = (cache: SoundCache, account: string, room: string, name: string, size: number) =>
    cache.put(account, room, soundKey(account, room, name, 1, 'h'), new ArrayBuffer(size));

  it('LRU: passa do teto e sai o menos usado, não o recém-lido', async () => {
    let now = 1;
    const store = new MemoryStore();
    const cache = new SoundCache(store, () => now++, 100);
    await meta(cache, 'a', 'r', 'x', 40);
    await meta(cache, 'a', 'r', 'y', 40);
    await cache.get(soundKey('a', 'r', 'x', 1, 'h'));
    await meta(cache, 'a', 'r', 'z', 40);
    expect([...store.metas.keys()].sort()).toEqual([soundKey('a', 'r', 'x', 1, 'h'), soundKey('a', 'r', 'z', 1, 'h')].sort());
    expect([...store.metas.values()].reduce((s, m) => s + m.size, 0)).toBeLessThanOrEqual(100);
  });

  it('teto padrão de 100 MiB; arquivo maior que o teto não entra', async () => {
    expect(SOUND_CACHE_MAX_BYTES).toBe(100 * 1024 * 1024);
    const store = new MemoryStore();
    await meta(new SoundCache(store, () => 1, 10), 'a', 'r', 'x', 11);
    expect(store.metas.size).toBe(0);
  });

  it('chave isola conta, sala, som, versão e hash', () => {
    const keys = [soundKey('a', 'r', 's', 1, 'h'), soundKey('b', 'r', 's', 1, 'h'), soundKey('a', 'q', 's', 1, 'h'), soundKey('a', 'r', 't', 1, 'h'), soundKey('a', 'r', 's', 2, 'h'), soundKey('a', 'r', 's', 1, 'i')];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('limpezas por conta, sala e catálogo não tocam nos demais', async () => {
    const store = new MemoryStore();
    const cache = new SoundCache(store, () => 1);
    await meta(cache, 'a', 'r1', 'x', 1);
    await meta(cache, 'a', 'r1', 'y', 1);
    await meta(cache, 'a', 'r2', 'x', 1);
    await meta(cache, 'b', 'r1', 'x', 1);
    await cache.retainAssets('a', 'r1', new Set([soundKey('a', 'r1', 'x', 1, 'h')]));
    expect(store.metas.has(soundKey('a', 'r1', 'y', 1, 'h'))).toBe(false);
    await cache.purgeRoom('a', 'r1');
    expect([...store.metas.values()].map((m) => `${m.account}/${m.room}`).sort()).toEqual(['a/r2', 'b/r1']);
    await cache.retainRooms('a', new Set());
    expect([...store.metas.values()].map((m) => m.account)).toEqual(['b']);
    await cache.purgeAccount('b');
    expect(store.metas.size).toBe(0);
  });

  it('só bytes e metadados técnicos: nenhum campo de credencial', async () => {
    const store = new MemoryStore();
    await meta(new SoundCache(store, () => 1), 'a', 'r', 'x', 1);
    expect(Object.keys([...store.metas.values()][0]!).sort()).toEqual(['account', 'key', 'lastUsed', 'room', 'size']);
  });

  it('falha do armazenamento não sobe', async () => {
    const store = new MemoryStore();
    store.fail = true;
    const cache = new SoundCache(store, () => 1);
    await expect(cache.get('x')).resolves.toBeNull();
    await expect(meta(cache, 'a', 'r', 'x', 1)).resolves.toBeUndefined();
    await expect(new SoundCache(null, () => 1).get('x')).resolves.toBeNull();
  });
});

describe('preferências de som', () => {
  const stored = new Map<string, string>();
  beforeEach(() => {
    stored.clear();
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v) } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('grava só volume e desativação, numa única chave, mesmo se receber mais campos', () => {
    saveSoundPrefs({ volume: 0.4, disabled: true, access_token: 'segredo', refresh_token: 'segredo' } as SoundPrefs);
    expect([...stored.keys()]).toEqual(['oryn.sound.v1']);
    expect(JSON.parse(stored.get('oryn.sound.v1')!)).toEqual({ volume: 0.4, disabled: true });
    expect(loadSoundPrefs()).toEqual({ volume: 0.4, disabled: true });
  });

  it('ao ler, campo a mais não passa; valor estranho vira padrão', () => {
    stored.set('oryn.sound.v1', JSON.stringify({ volume: 0.2, disabled: false, access_token: 'segredo' }));
    expect(loadSoundPrefs()).toEqual({ volume: 0.2, disabled: false });
    for (const bad of ['não é json', 'null', '{"volume":5,"disabled":false}', '{"volume":0.5}']) {
      stored.set('oryn.sound.v1', bad);
      expect(loadSoundPrefs()).toEqual(SOUND_PREFS_DEFAULT);
    }
  });
});

describe('SoundBus', () => {
  function fakeContext() {
    const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
    const sources: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; onended: null | (() => void); connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; buffer: unknown }[] = [];
    const gain = { ...node(), gain: { value: 0 } };
    const limiter = { ...node(), threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 } };
    const ctx = {
      state: 'running',
      destination: {},
      currentTime: 0,
      createGain: () => gain,
      createDynamicsCompressor: () => limiter,
      createBufferSource: () => {
        const s = { ...node(), start: vi.fn(), stop: vi.fn(), onended: null, buffer: null };
        sources.push(s);
        return s;
      },
      decodeAudioData: vi.fn(async () => ({})),
      resume: vi.fn(async () => undefined),
    };
    return { ctx, gain, limiter, sources };
  }
  const bus = (c: ReturnType<typeof fakeContext>) => new SoundBus(() => c.ctx as never);

  it('caminho: som → volume → limitador → saída; nada liga ao microfone', () => {
    const c = fakeContext();
    const b = bus(c);
    expect(b.play({} as AudioBuffer)).toBe('playing');
    expect(c.sources[0]!.connect).toHaveBeenCalledWith(c.gain);
    expect(c.gain.connect).toHaveBeenCalledWith(c.limiter);
    expect(c.limiter.connect).toHaveBeenCalledWith(c.ctx.destination);
    expect(c.limiter.threshold.value).toBeLessThan(0);
    expect(c.limiter.ratio.value).toBeGreaterThanOrEqual(12);
  });

  it(`no máximo ${MAX_SIMULTANEOUS_SOUNDS} ao mesmo tempo; ao terminar um, libera`, () => {
    const c = fakeContext();
    const b = bus(c);
    expect(b.play({} as AudioBuffer)).toBe('playing');
    expect(b.play({} as AudioBuffer)).toBe('playing');
    expect(b.play({} as AudioBuffer)).toBe('busy');
    expect(b.active).toBe(2);
    c.sources[0]!.onended?.();
    expect(b.active).toBe(1);
    expect(b.play({} as AudioBuffer)).toBe('playing');
  });

  it('volume limitado a 0–1 e aplicado no ganho', () => {
    const c = fakeContext();
    const b = bus(c);
    b.setVolume(0.3);
    b.unlock();
    expect(c.gain.gain.value).toBe(0.3);
    b.setVolume(2);
    expect(c.gain.gain.value).toBe(1);
    b.setVolume(-1);
    expect(c.gain.gain.value).toBe(0);
  });

  it('contexto suspenso: tenta liberar e responde bloqueado', () => {
    const c = fakeContext();
    c.ctx.state = 'suspended';
    const b = bus(c);
    expect(b.play({} as AudioBuffer)).toBe('blocked');
    expect(c.ctx.resume).toHaveBeenCalled();
    expect(c.sources).toHaveLength(0);
  });

  it('parar todos zera os ativos, mesmo se um já terminou', () => {
    const c = fakeContext();
    const b = bus(c);
    b.play({} as AudioBuffer);
    b.play({} as AudioBuffer);
    c.sources[0]!.stop.mockImplementation(() => {
      throw new Error('já terminou');
    });
    b.stopAll();
    expect(b.active).toBe(0);
    expect(c.sources[1]!.stop).toHaveBeenCalled();
  });
});

describe('tela', () => {
  class FakeNode {
    tag: string;
    children: FakeNode[] = [];
    textContent = '';
    className = '';
    disabled = false;
    type = '';
    dataset: Record<string, string> = {};
    attrs: Record<string, string> = {};
    listeners: Record<string, () => void> = {};
    constructor(tag: string) {
      this.tag = tag;
    }
    append(...c: FakeNode[]) {
      this.children.push(...c);
    }
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    }
    addEventListener(e: string, f: () => void) {
      this.listeners[e] = f;
    }
  }
  const doc = { createElement: (t: string) => new FakeNode(t) } as never;
  const base: SoundboardState = { roomId: ROOM, isOwner: false, status: 'ready', sounds: [], standby: false, cooling: false, volume: 1, disabled: false, publishing: false, removing: null, message: null };
  const sound = { ...assetRow(ASSET, '<b>Risada</b>', 'a'.repeat(64)), state: 'available' as const, local: 'ready' as const };

  it('nome só como texto; dono tem remover, membro não; cooldown bloqueia', () => {
    const calls: string[] = [];
    const opts = { onTrigger: (id: string) => calls.push(`t:${id}`), onRemove: (id: string) => calls.push(`r:${id}`) };
    const member = renderSoundboard(doc, { ...base, sounds: [sound] }, opts) as unknown as FakeNode;
    const row = member.children[0]!;
    expect(row.children).toHaveLength(2);
    expect(row.children[0]!.textContent).toBe('<b>Risada</b>');
    row.children[0]!.listeners['click']!();
    expect(calls).toEqual([`t:${ASSET}`]);
    const owner = renderSoundboard(doc, { ...base, isOwner: true, cooling: true, sounds: [sound] }, opts) as unknown as FakeNode;
    expect(owner.children[0]!.children).toHaveLength(3);
    expect(owner.children[0]!.children[0]!.disabled).toBe(true);
    owner.children[0]!.children[2]!.listeners['click']!();
    expect(calls).toContain(`r:${ASSET}`);
  });

  it('estados e textos', () => {
    expect(soundDetail({ ...sound, duration_ms: 1500 })).toBe('1,5 s');
    expect(soundDetail({ ...sound, duration_ms: 1500, local: 'loading' })).toMatch(/carregando/);
    expect(soundDetail({ ...sound, local: 'error' })).toMatch(/falha/);
    expect(soundDetail({ ...sound, state: 'quarantine', duration_ms: null })).toBe('em validação');
    expect(soundboardStatus({ ...base, status: 'loading' })).toMatch(/Carregando/);
    expect(soundboardStatus({ ...base, isOwner: true })).toMatch(/Publique/);
    expect(soundboardStatus(base)).toMatch(/ainda não tem/);
    expect(soundboardStatus({ ...base, standby: true })).toMatch(/espera/);
    expect(soundboardStatus({ ...base, sounds: [sound] })).toBeNull();
  });
});
