// Chamada de áudio bidirecional entre dois dispositivos reais, com sinalização via WebSocket.
//
// Regras de negociação:
// - Cada cliente tem UMA RTCPeerConnection por par formado (epoch). O host sempre cria a offer.
// - Operações SDP são serializadas em fila; sinais de epoch antigo ou fora de ordem são descartados.
// - Candidatos ICE que chegam antes da descrição remota ficam em fila (limitada).
// - Sem iceServers: validação inicial apenas em LAN (sem STUN/TURN).
// - Nenhum SDP, candidato completo ou credencial ICE é registrado no log.

import { preferOpus } from './codecs.ts';
import { describeMediaError } from './errors.ts';
import { ERROR_MESSAGES, type ClientMessage, type ErrorCode, type Role, type ServerMessage, type SignalPayload } from './protocol.ts';
import { describeCandidate } from './redact.ts';
import type { SignalingHandlers } from './signaling-client.ts';
import {
  bitrateKbps,
  inboundAudio,
  outboundAudio,
  packetLossPercent,
  remoteInboundAudio,
  selectedPair,
  toEntries,
  type CodecInfo,
  type PairInfo,
} from './stats.ts';

export type CallPhase =
  | 'idle'
  | 'requesting-mic'
  | 'connecting-signaling'
  | 'waiting-peer'
  | 'negotiating'
  | 'connected'
  | 'ended'
  | 'failed';

export type StartMode = { kind: 'create' } | { kind: 'join'; sessionId: string };

export interface PeerStates {
  connection: RTCPeerConnectionState;
  ice: RTCIceConnectionState;
  gathering: RTCIceGatheringState;
  signaling: RTCSignalingState;
}

export interface CallStats {
  codec: CodecInfo | null;
  sendKbps: number | null;
  recvKbps: number | null;
  packetsSent: number | null;
  packetsReceived: number | null;
  /** Perda do que recebemos (inbound-rtp). */
  packetsLost: number | null;
  lossPct: number | null;
  jitterMs: number | null;
  /** Perda do que enviamos, segundo o RTCP do outro lado (remote-inbound-rtp). */
  remoteLossPct: number | null;
  rttMs: number | null;
  rttSource: 'rtcp' | 'ice' | null;
  pair: PairInfo | null;
}

export interface SignalingLike {
  connect(): Promise<void>;
  send(message: ClientMessage): boolean;
  close(): void;
}

export interface CallDeps {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createPeerConnection(config: RTCConfiguration): RTCPeerConnection;
  createSignaling(handlers: SignalingHandlers): SignalingLike;
  /** RTCRtpReceiver.getCapabilities('audio')?.codecs — ausente em ambientes sem WebRTC. */
  audioCodecs?: () => RTCRtpCodec[] | null | undefined;
  statsIntervalMs?: number;
  negotiationTimeoutMs?: number;
}

export interface CallCallbacks {
  onPhase(phase: CallPhase, error?: string): void;
  onSession(info: { sessionId: string; role: Role; epoch: number }): void;
  onPeerStates(states: PeerStates | null): void;
  onLocalStream(stream: MediaStream | null): void;
  onRemoteStream(stream: MediaStream | null): void;
  onStats(stats: CallStats | null): void;
  onLog(message: string): void;
}

export const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

const MAX_PENDING_CANDIDATES = 64;
/** Erros do servidor que encerram a tentativa (antes de existir sessão ativa). */
const FATAL_ERRORS: readonly ErrorCode[] = ['not-found', 'session-full', 'server-busy', 'already-in-session', 'rate-limited'];

export class PeerCall {
  private phaseValue: CallPhase = 'idle';
  private disposed = false;
  private mutedValue = false;

  private localStream: MediaStream | null = null;
  private signaling: SignalingLike | null = null;
  private pc: RTCPeerConnection | null = null;
  private pending: RTCIceCandidateInit[] = [];
  /**
   * Fila de operações SDP do par ATUAL. Cada par (geração) tem a sua: operações de um par
   * desfeito podem ficar pendentes para sempre após pc.close() (comportamento observado no
   * Chrome) e não podem bloquear a negociação do par seguinte.
   */
  private queue: Promise<void> = Promise.resolve();
  /** Incrementada sempre que o par atual é desfeito; invalida operações e erros antigos. */
  private generation = 0;

  private sessionId: string | null = null;
  private role: Role | null = null;
  private epoch = -1;

  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private negotiationTimer: ReturnType<typeof setTimeout> | null = null;
  private prevOut: { bytes: number; ts: number } | null = null;
  private prevIn: { bytes: number; ts: number } | null = null;

  private readonly deps: CallDeps;
  private readonly cb: CallCallbacks;

  constructor(deps: CallDeps, callbacks: CallCallbacks) {
    this.deps = deps;
    this.cb = callbacks;
  }

  get phase(): CallPhase {
    return this.phaseValue;
  }
  get muted(): boolean {
    return this.mutedValue;
  }
  get currentRole(): Role | null {
    return this.role;
  }
  get currentEpoch(): number {
    return this.epoch;
  }

  /** Deve ser chamado a partir de um gesto do usuário. */
  async start(mode: StartMode): Promise<void> {
    if (this.phaseValue !== 'idle') throw new Error('Chamada já iniciada.');

    // 1. Microfone primeiro: a permissão é pedida no gesto do usuário.
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
    this.localStream = stream;
    track.addEventListener('ended', this.onTrackEnded);
    this.cb.onLocalStream(stream);
    this.cb.onLog(`Microfone capturado: "${track.label || 'sem rótulo'}".`);

    // 2. Sinalização.
    this.setPhase('connecting-signaling');
    const signaling = this.deps.createSignaling({
      onMessage: (m) => this.onServerMessage(m),
      onDisconnected: (code) => this.fail(`Conexão com a sinalização perdida (código ${code}).`),
      onInvalid: () => this.cb.onLog('Mensagem inválida do servidor descartada.'),
    });
    this.signaling = signaling;
    try {
      await signaling.connect();
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : 'Falha ao conectar à sinalização.');
    }
    if (this.disposed) return;
    this.cb.onLog('Sinalização conectada.');
    signaling.send(mode.kind === 'create' ? { type: 'create' } : { type: 'join', sessionId: mode.sessionId });
  }

  setMuted(muted: boolean): void {
    this.mutedValue = muted;
    // track.enabled = false envia silêncio sem renegociar e sem derrubar a conexão.
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    this.cb.onLog(muted ? 'Microfone mutado.' : 'Microfone reativado.');
  }

  /** Encerra a chamada, sai da sessão e libera todos os recursos. Idempotente. */
  end(): void {
    if (this.disposed) return;
    this.signaling?.send({ type: 'leave' });
    this.release();
    this.setPhase('ended');
    this.cb.onLog('Chamada encerrada; recursos liberados.');
  }

  // ---------- mensagens do servidor ----------

  private onServerMessage(message: ServerMessage): void {
    if (this.disposed) return;
    switch (message.type) {
      case 'session':
        this.sessionId = message.sessionId;
        this.role = message.role;
        this.epoch = message.epoch;
        this.cb.onSession({ sessionId: message.sessionId, role: message.role, epoch: message.epoch });
        this.cb.onLog(`Na sessão como ${message.role === 'host' ? 'anfitrião' : 'convidado'}.`);
        if (message.peerPresent) this.beginPair(message.epoch);
        else this.setPhase('waiting-peer');
        return;
      case 'peer-joined':
        this.cb.onLog('Outro participante entrou.');
        this.beginPair(message.epoch);
        return;
      case 'peer-left':
        if (message.epoch !== this.epoch) return;
        this.cb.onLog('O outro participante saiu; aguardando novo participante.');
        this.teardownPeer();
        this.setPhase('waiting-peer');
        return;
      case 'signal':
        this.enqueue(() => this.onSignal(message.epoch, message.payload));
        return;
      case 'session-closed':
        this.fail(message.reason === 'expired' ? 'A sessão expirou por inatividade.' : 'O servidor foi encerrado.');
        return;
      case 'error':
        if (FATAL_ERRORS.includes(message.code) && (this.sessionId === null || message.code === 'rate-limited')) {
          this.fail(ERROR_MESSAGES[message.code]);
        } else {
          this.cb.onLog(`Servidor: ${ERROR_MESSAGES[message.code]}`);
        }
        return;
    }
  }

  // ---------- par WebRTC ----------

  private beginPair(epoch: number): void {
    this.teardownPeer();
    this.epoch = epoch;
    const stream = this.localStream;
    const track = stream?.getAudioTracks()[0];
    if (!stream || !track) return this.fail('Microfone indisponível.');

    const pc = this.deps.createPeerConnection({ iceServers: [] });
    this.pc = pc;
    this.wirePeer(pc);
    pc.addTrack(track, stream);
    this.applyCodecPreferences(pc);

    this.setPhase('negotiating');
    this.negotiationTimer = setTimeout(() => {
      if (this.pc === pc && this.phaseValue === 'negotiating') {
        this.fail('Tempo de negociação esgotado: a conexão WebRTC não foi estabelecida.');
      }
    }, this.deps.negotiationTimeoutMs ?? 20_000);
    this.statsTimer = setInterval(() => void this.collectStats(pc, epoch), this.deps.statsIntervalMs ?? 1000);

    if (this.role === 'host') this.enqueue(() => this.makeOffer(pc));
  }

  private wirePeer(pc: RTCPeerConnection): void {
    const emit = () =>
      this.pc === pc &&
      this.cb.onPeerStates({
        connection: pc.connectionState,
        ice: pc.iceConnectionState,
        gathering: pc.iceGatheringState,
        signaling: pc.signalingState,
      });
    pc.onicecandidate = (event) => {
      if (this.pc !== pc) return;
      this.cb.onLog(`Candidato local: ${describeCandidate(event.candidate)}.`);
      const c = event.candidate;
      this.sendSignal({
        kind: 'candidate',
        candidate: c
          ? { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex, usernameFragment: c.usernameFragment }
          : null,
      });
    };
    pc.ontrack = (event) => {
      if (this.pc !== pc) return;
      this.cb.onLog('Áudio remoto recebido.');
      this.cb.onRemoteStream(event.streams[0] ?? new MediaStream([event.track]));
    };
    pc.onconnectionstatechange = () => {
      emit();
      if (this.pc !== pc) return;
      const state = pc.connectionState;
      this.cb.onLog(`connectionState = ${state}`);
      if (state === 'connected') {
        this.clearNegotiationTimer();
        this.setPhase('connected');
      } else if (state === 'failed') {
        this.fail('A conexão WebRTC falhou (sem rota entre os dispositivos na LAN?).');
      }
    };
    pc.oniceconnectionstatechange = emit;
    pc.onicegatheringstatechange = emit;
    pc.onsignalingstatechange = emit;
    emit();
  }

  private applyCodecPreferences(pc: RTCPeerConnection): void {
    const codecs = this.deps.audioCodecs?.();
    if (!codecs || codecs.length === 0) return;
    for (const transceiver of pc.getTransceivers()) {
      try {
        transceiver.setCodecPreferences?.(preferOpus(codecs));
      } catch {
        this.cb.onLog('setCodecPreferences indisponível; usando a ordem padrão do navegador.');
      }
    }
  }

  private async makeOffer(pc: RTCPeerConnection): Promise<void> {
    const epoch = this.epoch;
    const offer = await pc.createOffer();
    if (this.stale(pc, epoch)) return;
    await pc.setLocalDescription(offer);
    if (this.stale(pc, epoch)) return;
    this.sendSignal({ kind: 'offer', sdp: pc.localDescription?.sdp ?? '' });
    this.cb.onLog('Offer enviada.');
  }

  private async onSignal(epoch: number, payload: SignalPayload): Promise<void> {
    const pc = this.pc;
    if (this.disposed) return;
    if (epoch !== this.epoch || !pc) {
      this.cb.onLog(`Sinal "${payload.kind}" de negociação anterior descartado.`);
      return;
    }
    switch (payload.kind) {
      case 'offer': {
        if (this.role !== 'guest' || pc.signalingState !== 'stable' || pc.remoteDescription) {
          this.cb.onLog('Offer fora de ordem descartada.');
          return;
        }
        await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
        if (this.stale(pc, epoch)) return;
        this.applyCodecPreferences(pc);
        await this.flushCandidates(pc, epoch);
        const answer = await pc.createAnswer();
        if (this.stale(pc, epoch)) return;
        await pc.setLocalDescription(answer);
        if (this.stale(pc, epoch)) return;
        this.sendSignal({ kind: 'answer', sdp: pc.localDescription?.sdp ?? '' });
        this.cb.onLog('Offer recebida; answer enviada.');
        return;
      }
      case 'answer': {
        if (this.role !== 'host' || pc.signalingState !== 'have-local-offer') {
          this.cb.onLog('Answer fora de ordem descartada.');
          return;
        }
        await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
        if (this.stale(pc, epoch)) return;
        await this.flushCandidates(pc, epoch);
        this.cb.onLog('Answer recebida.');
        return;
      }
      case 'candidate': {
        if (payload.candidate === null) return; // fim da coleta remota
        const init: RTCIceCandidateInit = {
          candidate: payload.candidate.candidate,
          sdpMid: payload.candidate.sdpMid,
          sdpMLineIndex: payload.candidate.sdpMLineIndex,
          ...(payload.candidate.usernameFragment ? { usernameFragment: payload.candidate.usernameFragment } : {}),
        };
        if (!pc.remoteDescription) {
          if (this.pending.length >= MAX_PENDING_CANDIDATES) {
            this.cb.onLog('Fila de candidatos cheia; candidato descartado.');
            return;
          }
          this.pending.push(init);
          return;
        }
        await this.addCandidate(pc, init);
        return;
      }
    }
  }

  private async flushCandidates(pc: RTCPeerConnection, epoch: number): Promise<void> {
    const queued = this.pending.splice(0);
    for (const c of queued) {
      if (this.stale(pc, epoch)) return;
      await this.addCandidate(pc, c);
    }
  }

  private async addCandidate(pc: RTCPeerConnection, init: RTCIceCandidateInit): Promise<void> {
    try {
      await pc.addIceCandidate(init);
    } catch (error) {
      this.cb.onLog(`addIceCandidate falhou (${error instanceof Error ? error.name : 'erro'}).`);
    }
  }

  /**
   * Serializa operações SDP do par atual; um erro em uma operação não bloqueia as seguintes.
   * Operações e erros de uma geração anterior (par já desfeito) são descartados.
   */
  private enqueue(op: () => Promise<void>): void {
    const generation = this.generation;
    this.queue = this.queue
      .then(() => (this.disposed || generation !== this.generation ? undefined : op()))
      .catch((error: unknown) => {
        if (this.disposed || generation !== this.generation) return;
        const name = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        this.fail(`Falha na negociação WebRTC — ${name}`);
      });
  }

  private sendSignal(payload: SignalPayload): void {
    this.signaling?.send({ type: 'signal', epoch: this.epoch, payload });
  }

  /** true quando a sessão foi encerrada ou o par (conexão ou epoch) mudou durante uma operação assíncrona. */
  private stale(pc: RTCPeerConnection, epoch: number): boolean {
    return this.disposed || this.pc !== pc || this.epoch !== epoch;
  }

  // ---------- métricas ----------

  private async collectStats(pc: RTCPeerConnection, epoch: number): Promise<void> {
    if (this.stale(pc, epoch)) return;
    let entries;
    try {
      entries = toEntries(await pc.getStats());
    } catch {
      return;
    }
    if (this.stale(pc, epoch)) return;
    const out = outboundAudio(entries);
    const inn = inboundAudio(entries);
    const remote = remoteInboundAudio(entries);
    const pair = selectedPair(entries);

    const sendKbps = out && this.prevOut ? bitrateKbps(this.prevOut.bytes, this.prevOut.ts, out.bytesSent, out.timestamp) : null;
    const recvKbps = inn && this.prevIn ? bitrateKbps(this.prevIn.bytes, this.prevIn.ts, inn.bytesReceived, inn.timestamp) : null;
    this.prevOut = out ? { bytes: out.bytesSent, ts: out.timestamp } : null;
    this.prevIn = inn ? { bytes: inn.bytesReceived, ts: inn.timestamp } : null;

    const rtcpRtt = remote?.roundTripTimeMs ?? null;
    this.cb.onStats({
      codec: out?.codec ?? inn?.codec ?? null,
      sendKbps,
      recvKbps,
      packetsSent: out?.packetsSent ?? null,
      packetsReceived: inn?.packetsReceived ?? null,
      packetsLost: inn?.packetsLost ?? null,
      lossPct: inn ? packetLossPercent(inn.packetsLost, inn.packetsReceived) : null,
      jitterMs: inn?.jitterMs ?? null,
      remoteLossPct: remote?.fractionLostPct ?? null,
      rttMs: rtcpRtt ?? pair?.rttMs ?? null,
      rttSource: rtcpRtt !== null ? 'rtcp' : pair?.rttMs != null ? 'ice' : null,
      pair,
    });
  }

  // ---------- encerramento ----------

  private readonly onTrackEnded = (): void => {
    this.fail('O microfone foi desconectado ou encerrado pelo sistema.');
  };

  private fail(message: string): void {
    if (this.disposed) return;
    this.cb.onLog(`Erro: ${message}`);
    this.signaling?.send({ type: 'leave' });
    this.release();
    this.setPhase('failed', message);
  }

  private clearNegotiationTimer(): void {
    if (this.negotiationTimer !== null) clearTimeout(this.negotiationTimer);
    this.negotiationTimer = null;
  }

  /** Fecha a RTCPeerConnection atual e para seus timers; mantém microfone e sinalização. */
  private teardownPeer(): void {
    // Nova geração com fila própria: operações pendentes do par anterior não bloqueiam o próximo.
    this.generation += 1;
    this.queue = Promise.resolve();
    if (this.statsTimer !== null) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.clearNegotiationTimer();
    const pc = this.pc;
    this.pc = null;
    this.pending = [];
    this.prevIn = this.prevOut = null;
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      pc.onicegatheringstatechange = null;
      pc.onsignalingstatechange = null;
      pc.close();
      this.cb.onRemoteStream(null);
      this.cb.onPeerStates(null);
      this.cb.onStats(null);
    }
  }

  private release(): void {
    this.disposed = true;
    this.teardownPeer();
    this.signaling?.close();
    this.signaling = null;
    if (this.localStream) {
      for (const t of this.localStream.getTracks()) {
        t.removeEventListener('ended', this.onTrackEnded);
        t.stop();
      }
      this.localStream = null;
      this.cb.onLocalStream(null);
    }
  }

  private setPhase(phase: CallPhase, error?: string): void {
    this.phaseValue = phase;
    this.cb.onPhase(phase, error);
  }
}
