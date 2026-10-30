// Fakes determinísticos do cliente web (02C, integração), sem navegador e sem rede:
// - mídia e RTCPeerConnection: copiados de poc/webrtc-audio-wan/tests/helpers/fakes.ts (POC-02B, 6daeb99);
// - FakeSupabase: backend em memória com as REGRAS das RPCs da 0200 usadas pelo cliente (membro, limite de
//   2 sessões, hello/bye para as outras sessões, roster, batimento, saída) e a Edge Function `signal` pelo
//   NÚCLEO REAL (handleSignal + parseSignalRequest), com authorize em memória (sessão própria, destino vivo
//   na mesma sala, idempotência por client_msg_id, seq por par, limite de 40 em 10 s).
// O comportamento do banco real está provado pelos testes SQL e pela C2; aqui interessa o cliente.
import { vi } from 'vitest';
import { RpcError, handleSignal, type AuthorizeResult, type SignalDeps } from '../../supabase/functions/_shared/signal-core.ts';
import type { SignalEnvelope, SignalRequest } from '../../supabase/functions/_shared/signal-contract.ts';
import type { TransportResponse } from '../../src/signal-sender.ts';
import type { ChannelHandlers, RoomBackend, RpcResult } from '../../src/web/supabase-signaling.ts';

// ---------- mídia (cópia da 02B) ----------

export class FakeTrack {
  kind = 'audio';
  label = 'fake-mic';
  enabled = true;
  readyState: MediaStreamTrackState = 'live';
  private listeners = new Map<string, Set<() => void>>();
  stop(): void {
    this.readyState = 'ended';
  }
  addEventListener(type: string, fn: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  listenerCount(): number {
    return [...this.listeners.values()].reduce((n, s) => n + s.size, 0);
  }
}

export class FakeStream {
  readonly track = new FakeTrack();
  getAudioTracks(): FakeTrack[] {
    return [this.track];
  }
  getTracks(): FakeTrack[] {
    return [this.track];
  }
}

// ---------- RTCPeerConnection (cópia da 02B, sem os pontos de pausa) ----------

let pcCounter = 0;

export class FakePeerConnection {
  readonly id = ++pcCounter;
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  iceGatheringState: RTCIceGatheringState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((ev: { candidate: unknown }) => void) | null = null;
  ontrack: ((ev: { streams: unknown[]; track: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onicegatheringstatechange: (() => void) | null = null;
  onsignalingstatechange: (() => void) | null = null;
  readonly addedCandidates: RTCIceCandidateInit[] = [];
  readonly senders: { track: FakeTrack }[] = [];
  readonly setCodecPreferences = vi.fn();
  readonly config: RTCConfiguration;

  constructor(config: RTCConfiguration) {
    this.config = config;
  }
  addTrack(track: FakeTrack): void {
    this.senders.push({ track });
  }
  getTransceivers() {
    return [{ sender: this.senders[0], setCodecPreferences: this.setCodecPreferences }];
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: `v=0\r\no=- ${this.id} 1 IN IP4 0.0.0.0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n` };
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    if (this.signalingState !== 'have-remote-offer') throw new DOMException('sem offer', 'InvalidStateError');
    return { type: 'answer', sdp: `v=0\r\no=- ${this.id} 1 IN IP4 0.0.0.0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n` };
  }
  async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = desc;
    this.setSignaling(desc.type === 'offer' ? 'have-local-offer' : 'stable');
    this.emitCandidates();
    this.maybeConnect();
  }
  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    if (this.signalingState === 'closed') throw new DOMException('fechada', 'InvalidStateError');
    this.remoteDescription = desc;
    this.setSignaling(desc.type === 'offer' ? 'have-remote-offer' : 'stable');
    this.ontrack?.({ streams: [{ id: `remote-${this.id}` }], track: {} });
    this.maybeConnect();
  }
  async addIceCandidate(init: RTCIceCandidateInit): Promise<void> {
    if (!this.remoteDescription) throw new DOMException('sem descrição remota', 'InvalidStateError');
    this.addedCandidates.push(init);
    this.maybeConnect();
  }
  async getStats(): Promise<Map<string, unknown>> {
    return new Map();
  }
  close(): void {
    this.setSignaling('closed');
    this.connectionState = 'closed';
  }
  private setSignaling(state: RTCSignalingState): void {
    this.signalingState = state;
    this.onsignalingstatechange?.();
  }
  private emitCandidates(): void {
    const mk = (n: number) => ({
      candidate: `candidate:${n} 1 udp 2122260223 192.0.2.${this.id} 5000${n} typ host`,
      sdpMid: '0',
      sdpMLineIndex: 0,
      usernameFragment: 'ufrag',
      type: 'host',
      protocol: 'udp',
    });
    this.onicecandidate?.({ candidate: mk(1) });
    this.onicecandidate?.({ candidate: mk(2) });
    this.onicecandidate?.({ candidate: null });
  }
  private maybeConnect(): void {
    if (this.connectionState === 'closed' || this.connectionState === 'connected') return;
    if (this.localDescription && this.remoteDescription && this.signalingState === 'stable' && this.addedCandidates.length > 0) {
      this.iceConnectionState = 'connected';
      this.connectionState = 'connected';
      this.oniceconnectionstatechange?.();
      this.onconnectionstatechange?.();
    }
  }
}

/** Esvazia a fila de microtarefas (entregas assíncronas e awaits encadeados). */
export async function settle(rounds = 400): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

// ---------- backend Supabase em memória ----------

export const ROOM = '0c2a0000-0000-4000-8000-000000000001';
export const USERS = {
  owner: '0a000000-0000-4000-8000-00000000000a',
  member: '0b000000-0000-4000-8000-00000000000b',
  stranger: '0c000000-0000-4000-8000-00000000000c',
} as const;

interface Session {
  id: string;
  user: string;
  room: string;
  revoked: boolean;
  lastSeen: number;
  createdAt: number;
}

interface Logged {
  msg_id: string;
  seq: number;
  room: string;
  epoch: number;
  bytes: number;
  kind: string;
  to: string;
  state: AuthorizeResult['state'];
  createdAt: number;
}

export type InvokeFault = { status: number; body: Record<string, unknown> } | 'network';

export class FakeSupabase {
  readonly members = new Map<string, string>([
    [USERS.owner, 'it-owner'],
    [USERS.member, 'it-member'],
  ]);
  readonly sessions = new Map<string, Session>();
  readonly topics = new Map<string, Set<ChannelHandlers>>();
  readonly log = new Map<string, Logged>();
  readonly pairSeq = new Map<string, number>();
  readonly calls: { user: string; fn: string; args: Record<string, unknown> }[] = [];
  readonly invokes: SignalRequest[] = [];
  readonly published: SignalEnvelope[] = [];
  /** Session ids das próximas entradas (para controlar quem é o iniciador). Senão, crescentes. */
  nextSessionIds: string[] = [];
  /** Falhas injetadas nas próximas chamadas da função (em ordem). */
  invokeFaults: InvokeFault[] = [];
  /** Falhas injetadas por RPC (próxima chamada). */
  rpcFaults = new Map<string, string>();
  /** Entrega cada envelope publicado DUAS vezes (pelo menos uma vez). */
  duplicateDeliveries = false;
  /** Recusa a entrada no canal privado. */
  refuseChannels = false;
  /** Não entrega mais nada aos canais (eventos "perdidos"). */
  silent = false;
  private counter = 0;
  private readonly clock: () => number;

  constructor(clock: () => number = () => Date.now()) {
    this.clock = clock;
  }

  private uuid(): string {
    return `5e550000-0000-4000-8000-${String(++this.counter).padStart(12, '0')}`;
  }
  private fresh(s: Session): boolean {
    return !s.revoked && this.clock() - s.lastSeen < 90_000;
  }
  private live(room: string): Session[] {
    return [...this.sessions.values()].filter((s) => s.room === room && this.fresh(s)).sort((a, b) => a.createdAt - b.createdAt);
  }
  private deliver(topic: string, event: string, payload: unknown): void {
    if (this.silent) return;
    const subs = [...(this.topics.get(topic) ?? [])];
    const raw = JSON.stringify(payload); // serializado, como pela rede
    void Promise.resolve().then(() => {
      for (const h of subs) h.onBroadcast(event, JSON.parse(raw));
    });
  }
  /** publish_control: só para as OUTRAS sessões vivas da sala; o realtime.send injeta `id`. */
  private control(room: string, except: string, event: 'hello' | 'bye', payload: Record<string, unknown>): void {
    for (const s of this.live(room)) if (s.id !== except) this.deliver(`oryn:s:${s.id}`, event, { ...payload, id: this.uuid() });
  }

  /** Cliente de UM usuário (o "JWT" dele). */
  backend(user: string): RoomBackend {
    return {
      rpc: async <T>(fn: string, args: Record<string, unknown>): Promise<RpcResult<T>> => {
        await Promise.resolve();
        this.calls.push({ user, fn, args });
        const fault = this.rpcFaults.get(fn);
        if (fault) {
          this.rpcFaults.delete(fn);
          return { data: null, error: fault };
        }
        try {
          return { data: this.rpc(user, fn, args) as T, error: null };
        } catch (e) {
          return { data: null, error: e instanceof Error ? e.message : 'erro' };
        }
      },
      invokeSignal: (request) => this.invoke(user, request),
      openChannel: async (topic, handlers) => {
        await Promise.resolve();
        const sid = topic.slice('oryn:s:'.length);
        const s = this.sessions.get(sid);
        // can_receive_topic: só o dono da sessão ativa.
        if (this.refuseChannels || !s || s.user !== user || !this.fresh(s)) throw new Error('channel-refused');
        if (!this.topics.has(topic)) this.topics.set(topic, new Set());
        this.topics.get(topic)!.add(handlers);
        return { close: async () => void this.topics.get(topic)?.delete(handlers) };
      },
    };
  }

  private rpc(user: string, fn: string, a: Record<string, unknown>): unknown {
    switch (fn) {
      case 'join_room': {
        const room = String(a['p_room_id']);
        if (room !== ROOM || !this.members.has(user)) throw new Error('not-member');
        if (this.live(room).filter((s) => s.user === user).length >= 2) throw new Error('limit-reached');
        const id = this.nextSessionIds.shift() ?? this.uuid();
        this.sessions.set(id, { id, user, room, revoked: false, lastSeen: this.clock(), createdAt: this.clock() + this.counter / 1000 });
        this.control(room, id, 'hello', { session_id: id, label: this.members.get(user) });
        return [{ session_id: id, topic: `oryn:s:${id}` }];
      }
      case 'get_roster': {
        const room = String(a['p_room_id']);
        if (!this.members.has(user)) throw new Error('not-member');
        return this.live(room).map((s) => ({ session_id: s.id, display_name: this.members.get(s.user)!, is_self: s.user === user, joined_at: new Date(s.createdAt).toISOString() }));
      }
      case 'touch_session': {
        const s = this.sessions.get(String(a['p_session_id']));
        if (!s || s.user !== user || !this.fresh(s)) throw new Error('session-invalid');
        s.lastSeen = this.clock();
        return null;
      }
      case 'leave_room': {
        const s = this.sessions.get(String(a['p_session_id']));
        if (!s || s.user !== user || s.revoked) throw new Error('session-invalid');
        s.revoked = true;
        this.control(s.room, s.id, 'bye', { session_id: s.id });
        return null;
      }
      case 'ack_signals': {
        const ids = a['p_msg_ids'] as string[];
        let n = 0;
        for (const l of this.log.values()) if (ids.includes(l.msg_id) && l.state === 'published') (l.state = 'acknowledged'), n++;
        return n;
      }
      default:
        throw new Error('not-found');
    }
  }

  private async invoke(user: string, request: SignalRequest): Promise<TransportResponse> {
    await Promise.resolve();
    this.invokes.push(request);
    const fault = this.invokeFaults.shift();
    if (fault === 'network') throw new Error('signal-unreachable');
    if (fault) return fault;
    const deps: SignalDeps = {
      verifyUser: async () => user,
      authorize: async (_jwt, req, bytes) => this.authorize(user, req, bytes),
      setState: async (msgId, state) => {
        for (const l of this.log.values()) if (l.msg_id === msgId) l.state = state;
      },
      publish: async (topic, envelope) => {
        this.published.push(envelope);
        this.deliver(topic, 'signal', envelope);
        if (this.duplicateDeliveries) this.deliver(topic, 'signal', envelope);
      },
      log: () => undefined,
    };
    return handleSignal({ authorization: 'Bearer aaa.bbb.ccc', body: JSON.stringify(request) }, deps);
  }

  /** Regras do authorize_signal (0200) que o cliente pode exercitar. */
  private authorize(user: string, r: SignalRequest, bytes: number): AuthorizeResult {
    const from = this.sessions.get(r.session_id);
    if (!from || from.user !== user || !this.fresh(from)) throw new RpcError('session-invalid');
    const to = this.sessions.get(r.to_session_id);
    if (!to || to.room !== from.room || !this.fresh(to)) throw new RpcError('recipient-invalid');
    const key = `${r.session_id}|${r.client_msg_id}`;
    const existing = this.log.get(key);
    if (existing) {
      if (existing.kind !== r.kind || existing.to !== r.to_session_id || existing.epoch !== r.pair_epoch || existing.bytes !== bytes) throw new RpcError('idempotency-conflict');
      return { msg_id: existing.msg_id, seq: existing.seq, from_user: user, room_id: from.room, state: existing.state, duplicate: true, accepted_at: new Date(existing.createdAt).toISOString() };
    }
    const recent = [...this.log.entries()].filter(([k, l]) => k.startsWith(`${r.session_id}|`) && this.clock() - l.createdAt < 10_000).length;
    if (recent >= 40) throw new RpcError('rate-limited');
    const pair = `${r.session_id}>${r.to_session_id}`;
    const seq = (this.pairSeq.get(pair) ?? 0) + 1;
    this.pairSeq.set(pair, seq);
    const logged: Logged = { msg_id: this.uuid(), seq, room: from.room, epoch: r.pair_epoch, bytes, kind: r.kind, to: r.to_session_id, state: 'accepted', createdAt: this.clock() };
    this.log.set(key, logged);
    return { msg_id: logged.msg_id, seq, from_user: user, room_id: from.room, state: 'accepted', duplicate: false, accepted_at: new Date(logged.createdAt).toISOString() };
  }

  /** Simula aba fechada sem saída: a sessão para de bater e vence. */
  expire(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) s.lastSeen = -Infinity;
  }
  liveSessions(user?: string): string[] {
    return this.live(ROOM).filter((s) => !user || s.user === user).map((s) => s.id);
  }
  subscribers(): number {
    return [...this.topics.values()].reduce((n, s) => n + s.size, 0);
  }
}
