// Chamada de voz multiponto: uma captura de microfone e uma conexão por participante remoto.
//
// Cada par é um PeerCall próprio, o mesmo motor do 1:1: fila SDP, candidatos ICE, timers, estatísticas e limpeza são isolados
// por par. A falha de um não alcança os outros. Aqui ficam só o que é da chamada inteira: o microfone, o mudo, a fase agregada
// e a ligação entre cada par e a sinalização.
//
// O microfone é pedido uma vez, antes de entrar na sala, e só é liberado quando a chamada termina. Cada áudio remoto é entregue
// separado, por sessão: é o que vai permitir volume individual e deafen.
//
// Limite conhecido: o servidor revoga a pertença, mas uma conexão P2P já estabelecida entre dois clientes MODIFICADOS não tem
// como ser interrompida com garantia só pelo banco. O cliente legítimo fecha a conexão ao perder o par.

import { AUDIO_CONSTRAINTS, PeerCall, type CallPhase, type CallStats, type IceInfo, type PeerStates, type SignalingLike } from './call.ts';
import { describeMediaError } from './errors.ts';
import type { IceServerConfig } from './ice.ts';
import type { IceMode } from './ice.ts';
import type { ClientMessage, Role, ServerMessage, SignalPayload, SignalingHandlers } from './protocol.ts';
import type { MeshEvents, MeshParticipant } from './mesh-signaling.ts';
import type { PeerLossReason } from './supabase-signaling.ts';

export type ParticipantState = 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'waiting';

export interface ParticipantView {
  session: string;
  displayName: string;
  state: ParticipantState;
}

/** O que a chamada precisa da sinalização (MeshSignaling em produção). */
export interface MeshRoom {
  connect(): Promise<void>;
  close(): void;
  sendTo(session: string, epoch: number, payload: SignalPayload): boolean;
  peerLost(session: string, epoch: number, reason: PeerLossReason): boolean;
  abandon(session: string): void;
}

export interface MeshCallDeps {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createPeerConnection(config: RTCConfiguration): RTCPeerConnection;
  createRoom(events: MeshEvents, onDisconnected: (code: number) => void): MeshRoom;
  iceServers: IceServerConfig[];
  audioCodecs?: () => RTCRtpCodec[] | null | undefined;
  iceMode?: IceMode;
  statsIntervalMs?: number;
  negotiationTimeoutMs?: number;
}

export interface MeshCallCallbacks {
  onPhase(phase: CallPhase, error?: string): void;
  onParticipants(list: ParticipantView[], standby: boolean): void;
  /** Áudio de um participante (null = encerrado). */
  onRemoteAudio(session: string, stream: MediaStream | null): void;
  onLocalStream(stream: MediaStream | null): void;
  /** Par mostrado no painel de status: o primeiro conectado. */
  onPeerStates(states: PeerStates | null): void;
  onStats(stats: CallStats | null): void;
  onLog(message: string): void;
  onIce?(info: IceInfo | null): void;
  /** Falha com um participante; a chamada com os demais continua. */
  onPeerProblem?(displayName: string, kind: 'reconnecting' | 'failed'): void;
  /** Evento do soundboard. A chamada só repassa: som não entra na voz. */
  onSound?(payload: unknown): void;
}

/** A sinalização de UM par, como o PeerCall a espera. */
class PairLink implements SignalingLike {
  handlers: SignalingHandlers | null = null;
  private held: ServerMessage[] | null = [];
  private readonly send_: (epoch: number, payload: SignalPayload) => boolean;
  private readonly unreachable: (epoch: number, reason: PeerLossReason) => boolean;
  private readonly iceServers: IceServerConfig[];

  constructor(send: (epoch: number, payload: SignalPayload) => boolean, unreachable: (epoch: number, reason: PeerLossReason) => boolean, iceServers: IceServerConfig[]) {
    this.send_ = send;
    this.unreachable = unreachable;
    this.iceServers = iceServers;
  }

  async connect(): Promise<void> {
    // A sessão da sala já existe: nada a fazer por par.
  }

  /** O PeerCall ficou pronto: entrega o que chegou antes. */
  open(first: ServerMessage): void {
    const held = this.held ?? [];
    this.held = null;
    this.handlers?.onMessage(first);
    for (const m of held) this.handlers?.onMessage(m);
  }

  deliver(message: ServerMessage): void {
    if (this.held) this.held.push(message);
    else this.handlers?.onMessage(message);
  }

  send(message: ClientMessage): boolean {
    switch (message.type) {
      case 'signal':
        return this.send_(message.epoch, message.payload);
      case 'ice-request':
        // Só STUN, sem credenciais: respondido aqui, depois do retorno, como no 1:1.
        queueMicrotask(() => this.deliver({ type: 'ice-config', mode: message.mode, iceServers: this.iceServers, expiresAt: null }));
        return true;
      default:
        return true; // `leave` é da chamada inteira, não do par
    }
  }

  close(): void {
    this.handlers = null;
    this.held = null;
  }

  peerUnreachable(epoch: number, reason: PeerLossReason): boolean {
    return this.unreachable(epoch, reason);
  }
}

interface Entry {
  peer: MeshParticipant;
  call: PeerCall;
  link: PairLink;
  state: ParticipantState;
  disposed: boolean;
  pc: PeerStates | null;
  stats: CallStats | null;
}

export class MeshCall {
  private phaseValue: CallPhase = 'idle';
  private disposed = false;
  private mutedValue = false;
  private stream: MediaStream | null = null;
  private room: MeshRoom | null = null;
  private opened = false;
  private standby = false;
  private readonly entries = new Map<string, Entry>();
  /** Todos os participantes vistos na sala, por sessão primária, mesmo sem conexão. */
  private others: MeshParticipant[] = [];
  /** Estado de quem não tem conexão agora: em recuperação ou com falha. */
  private readonly lost = new Map<string, ParticipantState>();
  private readonly deps: MeshCallDeps;
  private readonly cb: MeshCallCallbacks;

  constructor(deps: MeshCallDeps, callbacks: MeshCallCallbacks) {
    this.deps = deps;
    this.cb = callbacks;
  }

  get phase(): CallPhase {
    return this.phaseValue;
  }
  get muted(): boolean {
    return this.mutedValue;
  }

  /** Deve ser chamado a partir de um gesto do usuário. */
  async start(): Promise<void> {
    if (this.phaseValue !== 'idle') throw new Error('Chamada já iniciada.');
    this.setPhase('requesting-mic');
    let stream: MediaStream;
    try {
      stream = await this.deps.getUserMedia({ audio: AUDIO_CONSTRAINTS, video: false });
    } catch (error) {
      return this.fail(describeMediaError(error).message);
    }
    if (this.disposed) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const track = stream.getAudioTracks()[0];
    if (!track) {
      stream.getTracks().forEach((t) => t.stop());
      return this.fail('Nenhuma faixa de áudio foi obtida do microfone.');
    }
    this.stream = stream;
    track.addEventListener('ended', this.onTrackEnded);
    this.cb.onLocalStream(stream);
    this.cb.onLog(`Microfone capturado: "${track.label || 'sem rótulo'}".`);

    this.setPhase('connecting-signaling');
    const room = this.deps.createRoom(
      {
        onOpen: () => this.onOpen(),
        onPeerUp: (peer, epoch, role) => this.peerUp(peer, epoch, role),
        onPeerDown: (session, reason) => this.peerDown(session, reason),
        onSignal: (session, epoch, payload) => this.entries.get(session)?.link.deliver({ type: 'signal', epoch, payload }),
        onParticipants: (others, standby) => this.onParticipants(others, standby),
        onSound: (payload) => this.cb.onSound?.(payload),
      },
      // 4403: a sessão deixou de valer, o que inclui remoção e encerramento da sala. O código fica no registro, sem rótulo de erro.
      (code) => this.fail(`Conexão com a sinalização perdida (código ${code}).`, code === 4403 ? 'Desconexão' : 'Erro'),
    );
    this.room = room;
    try {
      await room.connect();
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : 'Falha ao conectar à sinalização.');
    }
    if (this.disposed) return;
    this.cb.onLog('Sinalização conectada.');
  }

  setMuted(muted: boolean): void {
    this.mutedValue = muted;
    // track.enabled = false envia silêncio a todos os pares, sem renegociar nem derrubar nenhuma conexão.
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    this.cb.onLog(muted ? 'Microfone mutado.' : 'Microfone reativado.');
  }

  /** Encerra a chamada, sai da sala e libera tudo. Idempotente. */
  end(): void {
    if (this.disposed) return;
    this.release();
    this.setPhase('ended');
    this.cb.onLog('Chamada encerrada; recursos liberados.');
  }

  // ---------- sala ----------

  private onOpen(): void {
    if (this.disposed) return;
    this.opened = true;
    this.refreshPhase();
  }

  private onParticipants(others: MeshParticipant[], standby: boolean): void {
    if (this.disposed) return;
    this.others = others;
    this.standby = standby;
    for (const session of [...this.lost.keys()]) {
      if (!others.some((o) => o.session === session)) this.lost.delete(session);
    }
    this.emitParticipants();
  }

  private peerUp(peer: MeshParticipant, epoch: number, role: Role): void {
    if (this.disposed || !this.stream) return;
    this.disposeEntry(peer.session);
    this.lost.delete(peer.session);
    const session = peer.session;
    const link = new PairLink(
      (e, payload) => this.room?.sendTo(session, e, payload) ?? false,
      (e, reason) => this.room?.peerLost(session, e, reason) ?? false,
      this.deps.iceServers,
    );
    const entry: Entry = { peer, link, state: 'connecting', disposed: false, pc: null, stats: null, call: undefined as unknown as PeerCall };
    const call = new PeerCall(
      {
        sharedMic: this.stream,
        getUserMedia: () => Promise.reject(new Error('microfone compartilhado')),
        createPeerConnection: (config) => this.deps.createPeerConnection(config),
        createSignaling: (handlers) => {
          link.handlers = handlers;
          return link;
        },
        ...(this.deps.audioCodecs ? { audioCodecs: this.deps.audioCodecs } : {}),
        ...(this.deps.iceMode ? { iceMode: this.deps.iceMode } : {}),
        ...(this.deps.statsIntervalMs !== undefined ? { statsIntervalMs: this.deps.statsIntervalMs } : {}),
        ...(this.deps.negotiationTimeoutMs !== undefined ? { negotiationTimeoutMs: this.deps.negotiationTimeoutMs } : {}),
      },
      {
        onPhase: (phase, error) => this.onPairPhase(entry, phase, error),
        onSession: () => undefined,
        onInvite: () => undefined,
        onPeerStates: (states) => {
          if (entry.disposed) return;
          entry.pc = states;
          this.emitDisplay();
        },
        onLocalStream: () => undefined,
        onRemoteStream: (stream) => {
          if (!entry.disposed) this.cb.onRemoteAudio(session, stream);
        },
        onStats: (stats) => {
          if (entry.disposed) return;
          entry.stats = stats;
          this.emitDisplay();
        },
        onLog: (message) => {
          if (!entry.disposed) this.cb.onLog(`[${peer.displayName}] ${message}`);
        },
        onIce: (info) => {
          if (!entry.disposed) this.cb.onIce?.(info);
        },
      },
    );
    entry.call = call;
    this.entries.set(session, entry);
    this.emitParticipants();
    this.refreshPhase();
    void call.start({ kind: 'room' }).then(() => {
      if (!entry.disposed) link.open({ type: 'session', sessionId: session, role, epoch, peerPresent: true });
    });
  }

  private peerDown(session: string, reason: 'left' | 'unreachable'): void {
    if (this.disposed) return;
    const entry = this.entries.get(session);
    this.disposeEntry(session);
    if (reason === 'unreachable') {
      this.lost.set(session, 'reconnecting');
      if (entry) this.cb.onPeerProblem?.(entry.peer.displayName, 'reconnecting');
    } else {
      this.lost.delete(session);
    }
    this.emitParticipants();
    this.refreshPhase();
  }

  private onPairPhase(entry: Entry, phase: CallPhase, error?: string): void {
    if (entry.disposed || this.disposed) return;
    if (phase === 'connected') {
      entry.state = 'connected';
      this.lost.delete(entry.peer.session);
    } else if (phase === 'failed') {
      // Só este par: o motor já liberou a conexão dele, e a chamada com os demais continua.
      const session = entry.peer.session;
      this.cb.onLog(`[${entry.peer.displayName}] Conexão encerrada: ${error ?? 'falha'}.`);
      this.disposeEntry(session);
      this.room?.abandon(session);
      this.lost.set(session, 'failed');
      this.cb.onPeerProblem?.(entry.peer.displayName, 'failed');
    }
    this.emitParticipants();
    this.refreshPhase();
  }

  private disposeEntry(session: string): void {
    const entry = this.entries.get(session);
    if (!entry) return;
    entry.disposed = true;
    this.entries.delete(session);
    entry.call.end();
    entry.link.close();
    this.cb.onRemoteAudio(session, null);
    this.emitDisplay();
  }

  // ---------- estado ----------

  private refreshPhase(): void {
    if (this.disposed || !this.opened) return;
    const states = [...this.entries.values()].map((e) => e.state);
    const next: CallPhase = states.includes('connected') ? 'connected' : states.length > 0 ? 'negotiating' : 'waiting-peer';
    if (next !== this.phaseValue) this.setPhase(next);
  }

  private emitParticipants(): void {
    const list: ParticipantView[] = this.others.map((o) => ({
      session: o.session,
      displayName: o.displayName,
      state: this.entries.get(o.session)?.state ?? this.lost.get(o.session) ?? 'waiting',
    }));
    // A descoberta pode adotar antes de a lista chegar: quem tem conexão sempre aparece.
    for (const e of this.entries.values()) {
      if (!list.some((p) => p.session === e.peer.session)) list.push({ session: e.peer.session, displayName: e.peer.displayName, state: e.state });
    }
    this.cb.onParticipants(list, this.standby);
  }

  private emitDisplay(): void {
    const entries = [...this.entries.values()];
    const shown = entries.find((e) => e.state === 'connected') ?? entries[0] ?? null;
    this.cb.onPeerStates(shown?.pc ?? null);
    this.cb.onStats(shown?.stats ?? null);
  }

  // ---------- encerramento ----------

  private readonly onTrackEnded = (): void => {
    this.fail('O microfone foi desconectado ou encerrado pelo sistema.');
  };

  private fail(message: string, label = 'Erro'): void {
    if (this.disposed) return;
    this.cb.onLog(`${label}: ${message}`);
    this.release();
    this.setPhase('failed', message);
  }

  private release(): void {
    this.disposed = true;
    for (const session of [...this.entries.keys()]) this.disposeEntry(session);
    this.lost.clear();
    this.others = [];
    this.cb.onParticipants([], false);
    this.room?.close();
    this.room = null;
    if (this.stream) {
      for (const t of this.stream.getTracks()) {
        t.removeEventListener('ended', this.onTrackEnded);
        t.stop();
      }
      this.stream = null;
      this.cb.onLocalStream(null);
    }
  }

  private setPhase(phase: CallPhase, error?: string): void {
    this.phaseValue = phase;
    this.cb.onPhase(phase, error);
  }
}
