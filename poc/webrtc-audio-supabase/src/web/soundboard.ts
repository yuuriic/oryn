// Soundboard da sala: catálogo, publicação pelo dono, disparo e reprodução local por evento. Sem DOM: a renderização fica em
// soundboard-view.ts. O servidor decide quem pode e quando. Aqui só se evita oferecer o que seria recusado.
//
// Prazo do evento: o servidor manda quando ele vence, e o relógio deste aparelho pode estar errado. Por isso a comparação é feita
// na hora do SERVIDOR, estimada por `sound_clock` (ida e volta medida). Ao chegar, o tempo restante vira um prazo no relógio
// monotônico, que não muda se o relógio do sistema for ajustado. Sem estimativa de hora, o evento é descartado: tocar um som
// antigo depois de reconectar é pior do que perder um som.
//
// Mensagens: só textos fixos por código curto. Nenhum token, chave de objeto ou conteúdo vai para o registro.

import { isRoomName, parseSoundAsset, parseSoundEvent, type SoundAsset, type SoundEvent } from '../contracts.ts';
import { checkSound, MAX_SOUND_BYTES, sha256Hex, type SoundReject } from '../../supabase/functions/_shared/sound-validate.ts';
import { soundKey, type SoundCache } from './sound-cache.ts';
import type { SoundBusLike } from './sound-bus.ts';
import { shortCode, type RpcResult } from './supabase-signaling.ts';

export const SOUND_COOLDOWN_MS = 2_000;
export const SOUND_POLL_MS = 15_000;
export const SOUND_RPC_TIMEOUT_MS = 8_000;
/** Maior janela aceita para a incerteza da estimativa de hora. Passar disso não amplia o prazo. */
const MAX_CLOCK_TOLERANCE_MS = 250;
/** Restante acima disto contradiz o prazo de 2 s: a estimativa envelheceu, e a hora é medida de novo antes de decidir. */
const MAX_PLAUSIBLE_REMAINING_MS = 2_600;
const SEEN_LIMIT = 512;
const PRELOAD_CONCURRENCY = 2;

const PUBLISH_ERRORS: Record<string, string> = {
  unauthorized: 'Só o dono da sala publica sons.',
  'sound-quota': 'A sala já tem 20 sons. Remova um antes de publicar outro.',
  'invalid-argument': 'Nome ou tamanho do som fora do limite.',
};
const REJECTS: Record<SoundReject | 'upload-expired' | 'upload-missing', string> = {
  empty: 'O arquivo está vazio.',
  'too-large': 'O arquivo passa de 2 MiB.',
  'invalid-format': 'Formato não aceito: envie um MP3 ou WAV válido.',
  truncated: 'O arquivo está cortado ou corrompido.',
  'too-long': 'O som passa de 10 segundos.',
  'upload-expired': 'O prazo de envio venceu. Tente de novo.',
  'upload-missing': 'O envio não chegou ao servidor. Tente de novo.',
};
const PUBLISH_FAILED = 'Não foi possível publicar o som (falha de rede ou do servidor). Tente de novo.';
const REMOVE_FAILED = 'Não foi possível remover o som (falha de rede ou do servidor). Tente de novo.';
const TRIGGER_ERRORS: Record<string, string> = {
  'rate-limited': 'Aguarde 2 segundos entre um som e outro.',
  'sound-unavailable': 'Este som não está mais disponível.',
  'session-invalid': 'A sessão desta chamada não vale mais.',
};
const TRIGGER_FAILED = 'Não foi possível tocar o som (falha de rede ou do servidor).';
const LOAD_FAILED = 'Não foi possível carregar os sons (falha de rede ou do servidor). Tentando de novo…';
export const SOUND_DENIED = 'Esta conta não participa mais desta sala.';
const AUDIO_BLOCKED = 'O navegador bloqueou o som. Clique em qualquer lugar da página para liberar.';
const SOUND_MISSED = 'Um som não chegou a tempo e foi descartado.';

export type SoundLocal = 'idle' | 'loading' | 'ready' | 'error';
export interface SoundItem extends SoundAsset {
  local: SoundLocal;
}

export interface SoundboardState {
  roomId: string | null;
  isOwner: boolean;
  status: 'closed' | 'loading' | 'ready' | 'error' | 'denied';
  sounds: SoundItem[];
  standby: boolean;
  cooling: boolean;
  volume: number;
  disabled: boolean;
  publishing: boolean;
  /** Som em remoção. */
  removing: string | null;
  message: { tone: 'info' | 'error'; text: string } | null;
}

export interface SoundPrefs {
  volume: number;
  disabled: boolean;
}

export interface SoundCounters {
  played: number;
  duplicate: number;
  expired: number;
  busy: number;
  blocked: number;
  failed: number;
}

export interface SoundboardDeps {
  rpc<T>(fn: string, args: Record<string, unknown>): Promise<RpcResult<T>>;
  upload(key: string, body: Blob): Promise<boolean>;
  download(key: string): Promise<ArrayBuffer | null>;
  invokeMedia(body: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }>;
  cache: SoundCache;
  bus: SoundBusLike;
  loadPrefs(): SoundPrefs;
  savePrefs(prefs: SoundPrefs): void;
  /** Sessão atual da chamada; null antes de entrar. */
  sessionId(): string | null;
  /** Relógio do sistema, em ms. Pode estar errado: nunca é comparado direto com hora do servidor. */
  wallNow(): number;
  /** Relógio monotônico, em ms. */
  monoNow(): number;
  isHidden(): boolean;
  confirm(message: string): boolean;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  onChange(state: SoundboardState): void;
}

interface ClockSample {
  offset: number;
  rtt: number;
}

/**
 * Estimativa da hora do servidor. Fica a amostra de menor ida e volta entre as recentes, que é a de menor incerteza. Amostras antigas
 * saem, para um ajuste do relógio do sistema não ficar preso à estimativa velha.
 */
export class ServerClock {
  private samples: ClockSample[] = [];
  private inflight: Promise<boolean> | null = null;
  private readonly fetchServerTime: () => Promise<string | null>;
  private readonly wallNow: () => number;

  constructor(fetchServerTime: () => Promise<string | null>, wallNow: () => number) {
    this.fetchServerTime = fetchServerTime;
    this.wallNow = wallNow;
  }

  get synced(): boolean {
    return this.samples.length > 0;
  }

  private best(): ClockSample | null {
    return this.samples.reduce<ClockSample | null>((a, b) => (a === null || b.rtt < a.rtt ? b : a), null);
  }

  /** Tempo que falta até `expiresAt` (hora do servidor), já com a tolerância pela incerteza. `null` sem estimativa. */
  remaining(expiresAt: string): number | null {
    const best = this.best();
    if (!best) return null;
    return Date.parse(expiresAt) - (this.wallNow() + best.offset) + Math.min(best.rtt / 2, MAX_CLOCK_TOLERANCE_MS);
  }

  sync(keep = 3): Promise<boolean> {
    if (this.inflight) return this.inflight;
    const t0 = this.wallNow();
    this.inflight = this.fetchServerTime()
      .then((text) => {
        const t1 = this.wallNow();
        const server = text === null ? Number.NaN : Date.parse(text);
        if (!Number.isFinite(server)) return false;
        this.samples = [...this.samples, { offset: server - (t0 + t1) / 2, rtt: Math.max(0, t1 - t0) }].slice(-keep);
        return true;
      })
      .catch(() => false)
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /** O relógio do sistema pode ter mudado: a próxima decisão usa só uma medida nova. */
  async resync(): Promise<boolean> {
    const previous = this.samples;
    this.samples = [];
    const ok = await this.sync();
    if (!ok) this.samples = previous;
    return ok;
  }
}

const CLOSED = { roomId: null, isOwner: false, status: 'closed', sounds: [], standby: false, cooling: false, publishing: false, removing: null, message: null } as const;

/** `null` = fora do contrato: é erro, não catálogo vazio. */
export function parseCatalog(data: unknown): SoundAsset[] | null {
  if (!Array.isArray(data)) return null;
  const parsed = data.map(parseSoundAsset);
  return parsed.every((a): a is SoundAsset => a !== null) ? parsed : null;
}

export class SoundboardController {
  private s: SoundboardState;
  private account: string | null = null;
  /** Muda ao entrar e sair: nada que estava em curso age depois. */
  private generation = 0;
  private pollTimer: unknown = null;
  private coolTimer: unknown = null;
  private readonly seen = new Set<string>();
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly inflight = new Map<string, Promise<AudioBuffer | null>>();
  readonly clock: ServerClock;
  readonly counters: SoundCounters = { played: 0, duplicate: 0, expired: 0, busy: 0, blocked: 0, failed: 0 };
  private readonly deps: SoundboardDeps;

  constructor(deps: SoundboardDeps) {
    this.deps = deps;
    const prefs = deps.loadPrefs();
    this.s = { ...CLOSED, sounds: [], volume: prefs.volume, disabled: prefs.disabled };
    deps.bus.setVolume(prefs.volume);
    this.clock = new ServerClock(async () => {
      const r = await this.call('sound_clock', {});
      return typeof r.data === 'string' ? r.data : null;
    }, deps.wallNow);
  }

  get state(): SoundboardState {
    return this.s;
  }

  private set(patch: Partial<SoundboardState>): void {
    this.s = { ...this.s, ...patch };
    this.deps.onChange(this.s);
  }

  private call<T = unknown>(fn: string, args: Record<string, unknown>): Promise<RpcResult<T>> {
    const failed: RpcResult<T> = { data: null, error: 'erro' };
    return new Promise((resolve) => {
      const timer = this.deps.setTimer(() => resolve(failed), SOUND_RPC_TIMEOUT_MS);
      const finish = (result: RpcResult<T>): void => {
        this.deps.clearTimer(timer);
        resolve(result);
      };
      this.deps.rpc<T>(fn, args).then(finish, () => finish(failed));
    });
  }

  // ---- ciclo de vida ----

  enter(roomId: string, account: string, isOwner: boolean): void {
    if (this.s.roomId === roomId && this.account === account) return;
    this.leave();
    this.account = account;
    this.set({ ...CLOSED, sounds: [], roomId, isOwner, status: 'loading', volume: this.s.volume, disabled: this.s.disabled });
    void this.clock.sync();
    if (isOwner) this.cleanup();
    void this.load();
  }

  leave(): void {
    this.generation += 1;
    if (this.pollTimer !== null) this.deps.clearTimer(this.pollTimer);
    if (this.coolTimer !== null) this.deps.clearTimer(this.coolTimer);
    this.pollTimer = null;
    this.coolTimer = null;
    this.seen.clear();
    this.buffers.clear();
    this.inflight.clear();
    this.deps.bus.stopAll();
    if (this.s.status !== 'closed') this.set({ ...CLOSED, sounds: [], volume: this.s.volume, disabled: this.s.disabled });
    this.account = null;
  }

  /** A lista de salas pode chegar depois da entrada na chamada. O servidor decide de qualquer forma: isto só mostra o que oferecer. */
  setOwner(roomId: string, isOwner: boolean): void {
    if (this.s.roomId !== roomId || this.s.isOwner === isOwner) return;
    this.set({ isOwner });
    if (isOwner) this.cleanup();
    void this.load();
  }

  setStandby(standby: boolean): void {
    if (standby !== this.s.standby) this.set({ standby });
  }

  unlock(): void {
    if (this.s.roomId === null) return;
    this.deps.bus.unlock();
    if (this.s.message?.text === AUDIO_BLOCKED) this.set({ message: null });
  }

  private itemKey(item: { asset_id: string; version: number; sha256: string | null }): string {
    return soundKey(this.account ?? '', this.s.roomId ?? '', item.asset_id, item.version, item.sha256 ?? '');
  }

  private schedule(): void {
    const gen = this.generation;
    this.pollTimer = this.deps.setTimer(() => {
      this.pollTimer = null;
      if (gen !== this.generation) return;
      if (this.deps.isHidden()) return this.schedule();
      void this.clock.sync();
      void this.load();
    }, SOUND_POLL_MS);
  }

  private async load(): Promise<void> {
    const gen = this.generation;
    const room = this.s.roomId;
    if (room === null) return;
    const result = await this.call<unknown>('list_sounds', { p_room_id: room });
    if (gen !== this.generation) return;
    if (result.error) {
      if (shortCode(result.error) === 'not-member') {
        this.deps.bus.stopAll();
        return this.set({ status: 'denied', sounds: [], message: { tone: 'error', text: SOUND_DENIED } });
      }
      if (this.s.status !== 'ready') this.set({ status: 'error', message: { tone: 'error', text: LOAD_FAILED } });
      return this.schedule();
    }
    const catalog = parseCatalog(result.data);
    if (catalog === null) {
      if (this.s.status !== 'ready') this.set({ status: 'error', message: { tone: 'error', text: LOAD_FAILED } });
      return this.schedule();
    }
    const previous = new Map(this.s.sounds.map((x) => [x.asset_id, x.local]));
    const sounds = catalog.map((a): SoundItem => ({ ...a, local: previous.get(a.asset_id) ?? 'idle' }));
    const wasError = this.s.status === 'error';
    this.set({ status: 'ready', sounds, ...(wasError ? { message: null } : {}) });
    const available = sounds.filter((x) => x.state === 'available');
    if (this.account) void this.deps.cache.retainAssets(this.account, room, new Set(available.map((x) => this.itemKey(x))));
    const keep = new Set(available.map((x) => this.itemKey(x)));
    for (const key of [...this.buffers.keys()]) if (!keep.has(key)) this.buffers.delete(key);
    this.schedule();
    if (!this.s.disabled) void this.preload(gen);
  }

  private setLocal(assetId: string, local: SoundLocal): void {
    const current = this.s.sounds.find((x) => x.asset_id === assetId);
    if (current && current.local !== local) this.set({ sounds: this.s.sounds.map((x) => (x.asset_id === assetId ? { ...x, local } : x)) });
  }

  /** Cache quente para o que está no catálogo. Dois de cada vez, para não disputar banda com a voz. */
  private async preload(gen: number): Promise<void> {
    const pending = this.s.sounds.filter((x) => x.state === 'available' && x.local !== 'ready');
    const worker = async (): Promise<void> => {
      for (let item = pending.shift(); item; item = pending.shift()) {
        if (gen !== this.generation) return;
        await this.ensure({ asset_id: item.asset_id, version: item.version, sha256: item.sha256 ?? '' }, gen);
      }
    };
    await Promise.all(Array.from({ length: PRELOAD_CONCURRENCY }, () => worker()));
  }

  /** Decodificado em memória, cache local ou download, nessa ordem. O hash do servidor é conferido antes de usar os bytes. */
  private ensure(item: { asset_id: string; version: number; sha256: string }, gen = this.generation): Promise<AudioBuffer | null> {
    const key = this.itemKey(item);
    const ready = this.buffers.get(key);
    if (ready) return Promise.resolve(ready);
    const running = this.inflight.get(key);
    if (running) return running;
    const task = this.fetchBuffer(item, key, gen).finally(() => {
      if (this.inflight.get(key) === task) this.inflight.delete(key);
    });
    this.inflight.set(key, task);
    return task;
  }

  private async fetchBuffer(item: { asset_id: string; version: number; sha256: string }, key: string, gen: number): Promise<AudioBuffer | null> {
    const room = this.s.roomId;
    const account = this.account;
    if (room === null || account === null) return null;
    this.setLocal(item.asset_id, 'loading');
    try {
      let bytes = await this.deps.cache.get(key);
      if (bytes && (await sha256Hex(new Uint8Array(bytes))) !== item.sha256) {
        await this.deps.cache.remove(key);
        bytes = null;
      }
      if (!bytes) {
        bytes = await this.deps.download(`${room}/${item.asset_id}/v${item.version}`);
        if (gen !== this.generation) return null;
        if (!bytes || (await sha256Hex(new Uint8Array(bytes))) !== item.sha256) throw new Error('sound-download');
        await this.deps.cache.put(account, room, key, bytes);
      }
      const buffer = await this.deps.bus.decode(bytes.slice(0));
      if (gen !== this.generation) return null;
      this.buffers.set(key, buffer);
      this.setLocal(item.asset_id, 'ready');
      return buffer;
    } catch {
      if (gen === this.generation) this.setLocal(item.asset_id, 'error');
      return null;
    }
  }

  // ---- eventos ----

  /** Evento vindo do tópico privado desta sessão. */
  onEvent(raw: unknown): void {
    const event = parseSoundEvent(raw);
    if (event && event.session_id !== this.deps.sessionId()) void this.playEvent(event);
  }

  private remember(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value as string);
    return true;
  }

  private async playEvent(event: SoundEvent): Promise<void> {
    if (this.s.status !== 'ready' && this.s.status !== 'loading') return;
    if (!this.remember(event.event_id)) {
      this.counters.duplicate += 1;
      return;
    }
    // A sessão em espera não toca: a mesma conta já ouve o som na sessão que está na chamada.
    if (this.s.disabled || this.s.standby) return;
    const gen = this.generation;
    if (!this.clock.synced) await this.clock.sync();
    if (gen !== this.generation) return;
    let remaining = this.clock.remaining(event.expires_at);
    if (remaining !== null && (remaining <= 0 || remaining > MAX_PLAUSIBLE_REMAINING_MS)) {
      // Pode ser atraso real ou relógio ajustado depois da última medida. Só uma medida nova decide.
      await this.clock.resync();
      if (gen !== this.generation) return;
      remaining = this.clock.remaining(event.expires_at);
    }
    if (remaining === null || remaining <= 0 || remaining > MAX_PLAUSIBLE_REMAINING_MS) {
      this.counters.expired += 1;
      return;
    }
    const deadline = this.deps.monoNow() + remaining;
    const buffer = await this.ensure({ asset_id: event.asset_id, version: event.version, sha256: event.sha256 }, gen);
    if (gen !== this.generation) return;
    if (!buffer) {
      this.counters.failed += 1;
      return this.set({ message: { tone: 'info', text: SOUND_MISSED } });
    }
    if (this.deps.monoNow() > deadline) {
      this.counters.expired += 1;
      return this.set({ message: { tone: 'info', text: SOUND_MISSED } });
    }
    if (this.s.disabled) return;
    const result = this.deps.bus.play(buffer);
    if (result === 'playing') this.counters.played += 1;
    else if (result === 'busy') this.counters.busy += 1;
    else {
      this.counters.blocked += 1;
      this.set({ message: { tone: 'info', text: AUDIO_BLOCKED } });
    }
  }

  // ---- ações ----

  async trigger(assetId: string): Promise<void> {
    const session = this.deps.sessionId();
    if (this.s.status !== 'ready' || this.s.cooling || this.s.standby || session === null) return;
    const gen = this.generation;
    this.deps.bus.unlock();
    this.set({ cooling: true, message: null });
    this.coolTimer = this.deps.setTimer(() => {
      this.coolTimer = null;
      if (gen === this.generation) this.set({ cooling: false });
    }, SOUND_COOLDOWN_MS);
    const result = await this.call<unknown>('trigger_sound', { p_session_id: session, p_asset_id: assetId });
    if (gen !== this.generation) return;
    if (result.error) {
      const code = shortCode(result.error);
      this.set({ message: { tone: 'error', text: TRIGGER_ERRORS[code] ?? TRIGGER_FAILED } });
      if (code === 'sound-unavailable') void this.load();
      return;
    }
    const row = Array.isArray(result.data) ? (result.data[0] as Record<string, unknown> | undefined) : undefined;
    // O emissor toca pelo resultado da própria chamada: o servidor não publica para a sessão que disparou.
    const event = row ? parseSoundEvent({ ...row, session_id: session, sender_ref: 'self' }) : null;
    if (event) void this.playEvent(event);
  }

  setVolume(volume: number): void {
    const v = Math.min(1, Math.max(0, volume));
    this.deps.bus.setVolume(v);
    this.deps.savePrefs({ volume: v, disabled: this.s.disabled });
    this.set({ volume: v });
  }

  setDisabled(disabled: boolean): void {
    this.deps.savePrefs({ volume: this.s.volume, disabled });
    if (disabled) this.deps.bus.stopAll();
    this.set({ disabled });
    if (!disabled && this.s.status === 'ready') void this.preload(this.generation);
  }

  private cleanup(): void {
    const room = this.s.roomId;
    if (room !== null) void this.deps.invokeMedia({ action: 'cleanup', room_id: room }).catch(() => undefined);
  }

  async publish(file: Blob, rawName: string): Promise<void> {
    const room = this.s.roomId;
    if (room === null || !this.s.isOwner || this.s.publishing) return;
    const gen = this.generation;
    const name = rawName.trim();
    if (!isRoomName(name)) return this.set({ message: { tone: 'error', text: 'Informe um nome de até 40 caracteres.' } });
    if (file.size > MAX_SOUND_BYTES) return this.set({ message: { tone: 'error', text: REJECTS['too-large'] } });
    this.set({ publishing: true, message: null });
    const done = (text: string, tone: 'info' | 'error'): void => {
      if (gen === this.generation) this.set({ publishing: false, message: { tone, text } });
    };
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const check = checkSound(bytes);
      if (!check.ok) return done(REJECTS[check.reason], 'error');
      const reserved = await this.call<unknown>('request_sound_upload', { p_room_id: room, p_name: name, p_size_bytes: bytes.length });
      if (gen !== this.generation) return;
      if (reserved.error) return done(PUBLISH_ERRORS[shortCode(reserved.error)] ?? PUBLISH_FAILED, 'error');
      const row = Array.isArray(reserved.data) ? (reserved.data[0] as { asset_id?: unknown; object_key?: unknown } | undefined) : undefined;
      if (typeof row?.asset_id !== 'string' || typeof row.object_key !== 'string') return done(PUBLISH_FAILED, 'error');
      const assetId = row.asset_id;
      const giveUp = async (text: string): Promise<void> => {
        await this.call('remove_sound', { p_asset_id: assetId });
        this.cleanup();
        done(text, 'error');
      };
      if (!(await this.deps.upload(row.object_key, new Blob([bytes as BlobPart], { type: check.mime })))) return await giveUp(PUBLISH_FAILED);
      const result = await this.deps.invokeMedia({ action: 'validate', asset_id: assetId });
      if (gen !== this.generation) return;
      if (result.status !== 200) {
        const error = String(result.body['error'] ?? '');
        const known = (REJECTS as Record<string, string>)[error];
        if (result.status === 422 || error === 'upload-expired') {
          done(known ?? PUBLISH_FAILED, 'error');
          return void this.load();
        }
        return await giveUp(known ?? PUBLISH_FAILED);
      }
      done(`"${name}" publicado.`, 'info');
      void this.load();
    } catch {
      done(PUBLISH_FAILED, 'error');
    }
  }

  async remove(assetId: string): Promise<void> {
    const item = this.s.sounds.find((x) => x.asset_id === assetId);
    if (!item || !this.s.isOwner || this.s.removing !== null) return;
    if (!this.deps.confirm(`Remover "${item.name}" para todos na sala?`)) return;
    const gen = this.generation;
    this.set({ removing: assetId, message: null });
    const result = await this.call('remove_sound', { p_asset_id: assetId });
    if (gen !== this.generation) return;
    if (result.error) return this.set({ removing: null, message: { tone: 'error', text: REMOVE_FAILED } });
    this.set({ removing: null, sounds: this.s.sounds.filter((x) => x.asset_id !== assetId) });
    this.cleanup();
    void this.load();
  }
}
