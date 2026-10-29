// Fakes determinísticos para testar PeerCall sem navegador:
// - FakePeerConnection: máquina de estados SDP simplificada; emite candidatos ANTES de a offer ser
//   enviada (exercita a fila de candidatos) e "conecta" quando há descrições e candidatos remotos.
// - Hub de sinalização em memória usando o SessionRegistry REAL e o protocolo serializado em JSON.
import { vi } from 'vitest';
import type { CallDeps, SignalingLike } from '../../src/call.ts';
import type { IceMode, IceServerConfig } from '../../src/ice.ts';
import { parseClientMessage, parseServerMessage, type ServerMessage } from '../../src/protocol.ts';
import type { SignalingHandlers } from '../../src/signaling-client.ts';
import { Admission } from '../../server/admission.ts';
import { SessionRegistry, type Participant } from '../../server/registry.ts';

/** Token administrativo fixo nos testes (43 caracteres base64url; no servidor real vem do pareamento). */
export const TEST_OPERATOR_KEY = 'O'.repeat(43);

// ---------- mídia ----------

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
  /** Simula o SO encerrando o dispositivo (ex.: headset desconectado). */
  endBySystem(): void {
    this.readyState = 'ended';
    for (const fn of this.listeners.get('ended') ?? []) fn();
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

// ---------- RTCPeerConnection ----------

export interface Gate {
  promise: Promise<void>;
  release(): void;
}

export function gate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

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
  /** Pontos de pausa opcionais para testes de corrida. */
  gates: Partial<Record<'setRemoteDescription' | 'createOffer', Gate>> = {};
  /** Contagem de chamadas por método (para provar serialização e ausência de reexecução). */
  readonly calls = { createOffer: 0, setRemoteDescription: 0 };
  statsEntries: unknown[] = [];

  addTrack(track: FakeTrack): void {
    this.senders.push({ track });
  }
  getTransceivers() {
    return [{ sender: this.senders[0], setCodecPreferences: this.setCodecPreferences }];
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    this.calls.createOffer += 1;
    // Como no Chrome real, uma operação em andamento NÃO se resolve só porque close() foi chamado.
    await this.gates.createOffer?.promise;
    return { type: 'offer', sdp: `v=0\r\no=- ${this.id} 1 IN IP4 0.0.0.0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n` };
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    if (this.signalingState !== 'have-remote-offer') throw new DOMException('sem offer', 'InvalidStateError');
    return { type: 'answer', sdp: `v=0\r\no=- ${this.id} 1 IN IP4 0.0.0.0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n` };
  }
  async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = desc;
    this.setSignaling(desc.type === 'offer' ? 'have-local-offer' : 'stable');
    // Candidatos são emitidos imediatamente (antes de quem chamou enviar a descrição).
    this.emitCandidates();
    this.maybeConnect();
  }
  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.calls.setRemoteDescription += 1;
    await this.gates.setRemoteDescription?.promise;
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
    return new Map(this.statsEntries.map((e, i) => [String(i), e]));
  }
  close(): void {
    this.setSignaling('closed');
    this.connectionState = 'closed';
  }
  /** Simula falha de ICE/DTLS. */
  failConnection(): void {
    this.connectionState = 'failed';
    this.onconnectionstatechange?.();
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

// ---------- sinalização em memória (registro real) ----------

export class SignalingHub {
  readonly registry: SessionRegistry;
  readonly admission: Admission;
  readonly operatorKey = TEST_OPERATOR_KEY;
  private counter = 0;
  private ids = 0;
  private tokens = 0;
  readonly sockets = new Set<FakeSignaling>();
  /**
   * Resposta ao pedido de configuração ICE (como o IceBroker do servidor): servidores entregues ou
   * um código de erro. Padrão: nenhum servidor (rede local), sem validade.
   */
  ice: { iceServers: IceServerConfig[]; expiresAt: number | null } | { error: 'turn-unavailable' | 'ice-limit' } | 'silent' = {
    iceServers: [],
    expiresAt: null,
  };
  readonly iceRequests: IceMode[] = [];

  constructor() {
    this.admission = new Admission({
      inviteTtlMs: 600_000,
      now: () => 0,
      randomToken: () => `I${String(++this.tokens).padStart(42, '0')}`,
    });
    this.registry = new SessionRegistry({
      maxSessions: 10,
      idleTimeoutMs: 600_000,
      maxAuthFailures: 3,
      admission: this.admission,
      verifyAdmin: (token) => token === TEST_OPERATOR_KEY,
      publicOrigin: null,
      now: () => 0,
      randomId: () => `SESSION${String(++this.ids).padStart(15, '0')}`,
    });
  }

  create(handlers: SignalingHandlers, options: { failConnect?: boolean } = {}): FakeSignaling {
    const s = new FakeSignaling(this, `p${++this.counter}`, handlers, options.failConnect ?? false);
    this.sockets.add(s);
    return s;
  }
}

export class FakeSignaling implements SignalingLike {
  readonly participant: Participant;
  readonly sent: unknown[] = [];
  open = false;
  private readonly hub: SignalingHub;
  private readonly handlers: SignalingHandlers;
  private readonly failConnect: boolean;

  constructor(hub: SignalingHub, id: string, handlers: SignalingHandlers, failConnect: boolean) {
    this.hub = hub;
    this.handlers = handlers;
    this.failConnect = failConnect;
    this.participant = {
      id,
      // Entrega assíncrona e serializada em JSON, como numa rede real.
      send: (m: ServerMessage) => {
        const raw = JSON.stringify(m);
        void Promise.resolve().then(() => {
          if (!this.open) return;
          const parsed = parseServerMessage(raw);
          if (parsed) this.handlers.onMessage(parsed);
          else this.handlers.onInvalid();
        });
      },
    };
  }

  async connect(): Promise<void> {
    await Promise.resolve();
    if (this.failConnect) throw new Error('Não foi possível conectar à sinalização.');
    this.open = true;
  }

  send(message: Parameters<SignalingLike['send']>[0]): boolean {
    if (!this.open) return false;
    this.sent.push(message);
    const parsed = parseClientMessage(JSON.stringify(message));
    if (!parsed.ok) throw new Error(`cliente enviou mensagem inválida: ${parsed.code}`);
    if (parsed.value.type === 'ice-request') {
      // Só participante admitido (como no servidor real).
      if (this.hub.registry.sessionOf(this.participant) === null) {
        this.participant.send({ type: 'error', code: 'unauthorized' });
        return true;
      }
      this.hub.iceRequests.push(parsed.value.mode);
      const ice = this.hub.ice;
      if (ice === 'silent') return true;
      this.participant.send(
        'error' in ice
          ? { type: 'error', code: ice.error }
          : { type: 'ice-config', mode: parsed.value.mode, iceServers: ice.iceServers, expiresAt: ice.expiresAt },
      );
      return true;
    }
    // Hub em memória = conexão do listener administrativo (operador neste PC).
    this.hub.registry.handle(this.participant, parsed.value, { admin: true });
    return true;
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.hub.registry.disconnect(this.participant);
    this.hub.sockets.delete(this);
  }

  /** Simula queda da conexão WebSocket. */
  drop(code = 1006): void {
    this.open = false;
    this.hub.registry.disconnect(this.participant);
    this.handlers.onDisconnected(code);
  }

  /** Injeta uma mensagem "do servidor" diretamente (testes de ordem/validação). */
  inject(message: ServerMessage): void {
    this.handlers.onMessage(message);
  }
}

// ---------- montagem de dependências ----------

export interface Harness {
  deps: CallDeps;
  streams: FakeStream[];
  pcs: FakePeerConnection[];
  signalings: FakeSignaling[];
  /** RTCConfiguration recebida em cada criação de RTCPeerConnection. */
  configs: RTCConfiguration[];
}

export function harness(hub: SignalingHub, options: { gum?: () => Promise<FakeStream>; failConnect?: boolean } = {}): Harness {
  const h: Harness = { deps: undefined as unknown as CallDeps, streams: [], pcs: [], signalings: [], configs: [] };
  h.deps = {
    getUserMedia: async () => {
      const s = options.gum ? await options.gum() : new FakeStream();
      h.streams.push(s);
      return s as unknown as MediaStream;
    },
    createPeerConnection: (config) => {
      h.configs.push(config);
      const pc = new FakePeerConnection();
      h.pcs.push(pc);
      return pc as unknown as RTCPeerConnection;
    },
    createSignaling: (handlers) => {
      const s = hub.create(handlers, { failConnect: options.failConnect ?? false });
      h.signalings.push(s);
      return s;
    },
    audioCodecs: () => [{ mimeType: 'audio/PCMU', clockRate: 8000 }, { mimeType: 'audio/opus', clockRate: 48000, channels: 2 }] as RTCRtpCodec[],
    statsIntervalMs: 1000,
    negotiationTimeoutMs: 20_000,
  };
  return h;
}

/** Esvazia a fila de microtarefas (entregas assíncronas e awaits encadeados). */
export async function settle(rounds = 200): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
