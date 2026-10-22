import { describeMediaError, messageFor, type DescribedError } from './errors';
import { describeCandidate, describeDescription } from './redact';
import {
  bitrateKbps,
  concealmentPercent,
  inboundAudio,
  outboundAudio,
  packetLossPercent,
  selectedPair,
  toEntries,
  type CodecInfo,
  type InboundSnapshot,
  type OutboundSnapshot,
  type PairInfo,
} from './stats';
import type { MetricPoint } from './summary';

// Loopback local: dois RTCPeerConnection na mesma página simulam dois participantes.
// A (emissor) envia o microfone; B (receptor) reproduz o áudio recebido.
// A "sinalização" é a troca direta de objetos em memória — não há servidor.

export type PeerId = 'A' | 'B';

export type SessionPhase =
  | 'idle'
  | 'requesting_permission'
  | 'negotiating'
  | 'connected'
  | 'failed'
  | 'closed';

export interface PeerStates {
  connection: RTCPeerConnectionState;
  ice: RTCIceConnectionState;
  gathering: RTCIceGatheringState;
  signaling: RTCSignalingState;
}

export interface StatsSample {
  point: MetricPoint;
  outbound: OutboundSnapshot | null;
  inbound: InboundSnapshot | null;
  pair: PairInfo | null;
  codec: CodecInfo | null;
}

export interface SessionCallbacks {
  onPhase(phase: SessionPhase, error?: DescribedError): void;
  onPeerStates(peer: PeerId, states: PeerStates): void;
  onStats(sample: StatsSample): void;
  onLog(message: string): void;
}

export interface SessionOptions {
  /** Contêiner onde o elemento <audio> do áudio remoto é inserido. */
  audioContainer: HTMLElement;
  statsIntervalMs?: number;
  negotiationTimeoutMs?: number;
}

const LEVEL_SAMPLE_MS = 40;

const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

export class LoopbackSession {
  private phase: SessionPhase = 'idle';
  private disposed = false;

  private localStream: MediaStream | null = null;
  private pcA: RTCPeerConnection | null = null;
  private pcB: RTCPeerConnection | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private audioCtx: AudioContext | null = null;
  private localAnalyser: AnalyserNode | null = null;
  private remoteAnalyser: AnalyserNode | null = null;
  private levelBuffer: Float32Array<ArrayBuffer> | null = null;

  // Pico de RMS desde a última amostra de getStats, medido continuamente no track
  // (antes do playout). O audioLevel do inbound-rtp no Chrome é pós-volume/mute do
  // elemento <audio> e fica em 0 enquanto a saída está silenciada.
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private localPeak = 0;
  private remotePeak = 0;

  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private negotiationTimer: ReturnType<typeof setTimeout> | null = null;
  private statsInFlight = false;
  private startedAt = 0;
  private prevOutbound: OutboundSnapshot | null = null;
  private prevInbound: InboundSnapshot | null = null;

  // Candidatos que chegam antes da descrição remota do destino ficam enfileirados.
  private readonly pendingCandidates: Record<PeerId, RTCIceCandidateInit[]> = { A: [], B: [] };

  constructor(
    private readonly options: SessionOptions,
    private readonly cb: SessionCallbacks,
  ) {}

  get currentPhase(): SessionPhase {
    return this.phase;
  }

  /** Deve ser chamado a partir de um gesto do usuário (clique). */
  async start(): Promise<void> {
    if (this.phase !== 'idle') throw new Error('Sessão já iniciada.');

    if (!window.isSecureContext) return this.fail({ code: 'insecure-context', message: messageFor('insecure-context') });
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') {
      return this.fail({ code: 'unsupported', message: messageFor('unsupported') });
    }

    // AudioContext criado dentro do gesto do usuário para evitar bloqueio de autoplay.
    this.audioCtx = new AudioContext();

    this.setPhase('requesting_permission');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS, video: false });
    } catch (error) {
      if (this.disposed) return;
      return this.fail(describeMediaError(error));
    }
    if (this.disposed) {
      // Encerrado enquanto a permissão estava pendente: libera o que foi obtido.
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.localStream = stream;

    const track = stream.getAudioTracks()[0];
    if (!track) return this.fail({ code: 'no-device', message: messageFor('no-device') });
    this.cb.onLog(`Microfone capturado: "${track.label || 'sem rótulo'}"`);
    track.addEventListener('ended', this.onLocalTrackEnded);

    this.localAnalyser = this.createAnalyser(stream);

    this.setPhase('negotiating');
    this.startedAt = performance.now();
    this.negotiationTimer = setTimeout(() => {
      if (this.phase === 'negotiating') {
        this.fail({ code: 'unknown', message: 'Tempo de negociação esgotado (conexão não estabelecida).' });
      }
    }, this.options.negotiationTimeoutMs ?? 15_000);

    try {
      await this.negotiate(stream, track);
    } catch (error) {
      if (this.disposed) return;
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return this.fail({ code: 'unknown', message: `Falha na negociação WebRTC — ${message}` });
    }

    this.statsTimer = setInterval(() => void this.collectStats(), this.options.statsIntervalMs ?? 1000);
    this.levelTimer = setInterval(() => this.trackPeaks(), LEVEL_SAMPLE_MS);
  }

  private trackPeaks(): void {
    const { local, remote } = this.levels();
    this.localPeak = Math.max(this.localPeak, local);
    this.remotePeak = Math.max(this.remotePeak, remote);
  }

  private async negotiate(stream: MediaStream, track: MediaStreamTrack): Promise<void> {
    // Sem iceServers: no mesmo computador, candidatos host bastam. STUN/TURN ficam para P02.
    const config: RTCConfiguration = { iceServers: [] };
    const pcA = (this.pcA = new RTCPeerConnection(config));
    const pcB = (this.pcB = new RTCPeerConnection(config));

    this.wirePeer('A', pcA, pcB);
    this.wirePeer('B', pcB, pcA);

    pcB.ontrack = (event) => {
      const remote = event.streams[0] ?? new MediaStream([event.track]);
      this.cb.onLog(`B recebeu track remota (${event.track.kind}).`);
      this.attachRemote(remote);
    };

    pcA.addTrack(track, stream);

    const offer = await pcA.createOffer();
    await pcA.setLocalDescription(offer);
    this.cb.onLog(`A criou ${describeDescription(pcA.localDescription)}`);
    if (this.disposed) return;

    await pcB.setRemoteDescription(pcA.localDescription!);
    await this.flushCandidates('B');
    const answer = await pcB.createAnswer();
    await pcB.setLocalDescription(answer);
    this.cb.onLog(`B criou ${describeDescription(pcB.localDescription)}`);
    if (this.disposed) return;

    await pcA.setRemoteDescription(pcB.localDescription!);
    await this.flushCandidates('A');
  }

  private wirePeer(id: PeerId, pc: RTCPeerConnection, other: RTCPeerConnection): void {
    const target: PeerId = id === 'A' ? 'B' : 'A';
    const emit = () =>
      this.cb.onPeerStates(id, {
        connection: pc.connectionState,
        ice: pc.iceConnectionState,
        gathering: pc.iceGatheringState,
        signaling: pc.signalingState,
      });

    pc.onicecandidate = (event) => {
      this.cb.onLog(`${id} → ${target}: candidato ${describeCandidate(event.candidate)}`);
      if (!event.candidate) return;
      const init = event.candidate.toJSON();
      if (other.remoteDescription) {
        other.addIceCandidate(init).catch((err: unknown) => this.onCandidateError(target, err));
      } else {
        this.pendingCandidates[target].push(init);
      }
    };
    pc.onicecandidateerror = (event) => {
      // Apenas código numérico: o evento inclui endereço/URL que não deve ir para o log.
      this.cb.onLog(`${id}: erro na coleta de candidato (código ${event.errorCode}).`);
    };
    pc.onconnectionstatechange = () => {
      emit();
      this.onConnectionState(id, pc.connectionState);
    };
    pc.oniceconnectionstatechange = emit;
    pc.onicegatheringstatechange = emit;
    pc.onsignalingstatechange = emit;
    emit();
  }

  private async flushCandidates(target: PeerId): Promise<void> {
    const pc = target === 'A' ? this.pcA : this.pcB;
    const queue = this.pendingCandidates[target].splice(0);
    this.cb.onLog(`${target}: descrição remota aplicada; ${queue.length} candidato(s) da fila aplicados.`);
    for (const candidate of queue) {
      try {
        await pc?.addIceCandidate(candidate);
      } catch (err) {
        this.onCandidateError(target, err);
      }
    }
  }

  private onCandidateError(target: PeerId, err: unknown): void {
    const name = err instanceof Error ? err.name : 'Erro';
    this.cb.onLog(`${target}: addIceCandidate falhou (${name}).`);
  }

  private onConnectionState(id: PeerId, state: RTCPeerConnectionState): void {
    this.cb.onLog(`${id}: connectionState = ${state}`);
    if (this.disposed) return;
    const a = this.pcA?.connectionState;
    const b = this.pcB?.connectionState;
    if (state === 'failed') {
      this.fail({ code: 'unknown', message: `Conexão WebRTC falhou no participante ${id}.` });
    } else if (a === 'connected' && b === 'connected' && this.phase === 'negotiating') {
      this.clearNegotiationTimer();
      const ms = Math.round(performance.now() - this.startedAt);
      this.cb.onLog(`Ambos conectados em ${ms} ms após a permissão do microfone.`);
      this.setPhase('connected');
    } else if (state === 'disconnected' && this.phase === 'connected') {
      this.cb.onLog(`${id}: conexão temporariamente interrompida; aguardando recuperação do ICE.`);
    }
  }

  private attachRemote(stream: MediaStream): void {
    if (this.disposed) return;
    const el = document.createElement('audio');
    el.autoplay = true;
    el.muted = true; // começa silenciado para evitar microfonia; o usuário liga explicitamente
    el.dataset['testid'] = 'remote-audio';
    el.srcObject = stream;
    this.options.audioContainer.replaceChildren(el);
    this.audioEl = el;
    el.play().catch((err: unknown) => {
      const name = err instanceof Error ? err.name : 'Erro';
      this.cb.onLog(`Reprodução remota bloqueada (${name}). Use "Ouvir áudio recebido".`);
    });
    // O elemento <audio> precisa estar tocando (mesmo mudo) para o Chrome entregar
    // o áudio remoto ao Web Audio; o analisador mede o sinal efetivamente recebido.
    this.remoteAnalyser = this.createAnalyser(stream);
  }

  private createAnalyser(stream: MediaStream): AnalyserNode | null {
    if (!this.audioCtx) return null;
    const source = this.audioCtx.createMediaStreamSource(stream);
    const analyser = this.audioCtx.createAnalyser();
    analyser.fftSize = 2048; // ~43 ms a 48 kHz, cobre o intervalo de LEVEL_SAMPLE_MS
    source.connect(analyser); // não conectado ao destination: apenas medição, sem reprodução
    return analyser;
  }

  private rms(analyser: AnalyserNode | null): number {
    if (!analyser) return 0;
    if (!this.levelBuffer || this.levelBuffer.length !== analyser.fftSize) {
      this.levelBuffer = new Float32Array(analyser.fftSize);
    }
    analyser.getFloatTimeDomainData(this.levelBuffer);
    let sum = 0;
    for (const v of this.levelBuffer) sum += v * v;
    return Math.sqrt(sum / this.levelBuffer.length);
  }

  /** Níveis RMS (0–1) do microfone local e do áudio recebido por B. */
  levels(): { local: number; remote: number } {
    return { local: this.rms(this.localAnalyser), remote: this.rms(this.remoteAnalyser) };
  }

  /** Mute por track.enabled: o envio continua (silêncio), a conexão não é renegociada. */
  setMuted(muted: boolean): void {
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    this.cb.onLog(muted ? 'Microfone mutado (track.enabled = false).' : 'Microfone reativado.');
  }

  setListening(listening: boolean, volume: number): void {
    if (!this.audioEl) return;
    this.audioEl.volume = Math.min(1, Math.max(0, volume));
    this.audioEl.muted = !listening;
    if (listening) void this.audioCtx?.resume();
  }

  private async collectStats(): Promise<void> {
    if (this.statsInFlight || this.disposed || !this.pcA || !this.pcB) return;
    this.statsInFlight = true;
    try {
      const [reportA, reportB] = await Promise.all([this.pcA.getStats(), this.pcB.getStats()]);
      if (this.disposed) return;
      const entriesA = toEntries(reportA);
      const entriesB = toEntries(reportB);
      const outbound = outboundAudio(entriesA);
      const inbound = inboundAudio(entriesB);
      const pair = selectedPair(entriesB) ?? selectedPair(entriesA);

      const sendKbps =
        outbound && this.prevOutbound
          ? bitrateKbps(this.prevOutbound.bytesSent, this.prevOutbound.timestamp, outbound.bytesSent, outbound.timestamp)
          : null;
      const recvKbps =
        inbound && this.prevInbound
          ? bitrateKbps(this.prevInbound.bytesReceived, this.prevInbound.timestamp, inbound.bytesReceived, inbound.timestamp)
          : null;
      this.prevOutbound = outbound;
      this.prevInbound = inbound;

      this.cb.onStats({
        outbound,
        inbound,
        pair,
        codec: inbound?.codec ?? outbound?.codec ?? null,
        point: {
          elapsedS: (performance.now() - this.startedAt) / 1000,
          sendKbps,
          recvKbps,
          rttMs: pair?.rttMs ?? null,
          jitterMs: inbound?.jitterMs ?? null,
          lossPct: inbound ? packetLossPercent(inbound.packetsLost, inbound.packetsReceived) : null,
          concealPct: inbound ? concealmentPercent(inbound.concealedSamples, inbound.totalSamplesReceived) : null,
          audioLevel: inbound?.audioLevel ?? null,
          localRmsPeak: this.localPeak,
          remoteRmsPeak: this.remotePeak,
          packetsReceived: inbound?.packetsReceived ?? 0,
        },
      });
      this.localPeak = 0;
      this.remotePeak = 0;
    } catch (err) {
      const name = err instanceof Error ? err.name : 'Erro';
      this.cb.onLog(`getStats falhou (${name}).`);
    } finally {
      this.statsInFlight = false;
    }
  }

  private readonly onLocalTrackEnded = (): void => {
    if (this.disposed) return;
    this.fail({ code: 'device-busy', message: 'O microfone foi desconectado ou encerrado pelo sistema.' });
  };

  private fail(error: DescribedError): void {
    if (this.disposed) return;
    this.cb.onLog(`Erro: ${error.message}`);
    this.setPhase('failed', error);
    this.releaseResources();
  }

  private setPhase(phase: SessionPhase, error?: DescribedError): void {
    this.phase = phase;
    this.cb.onPhase(phase, error);
  }

  private clearNegotiationTimer(): void {
    if (this.negotiationTimer !== null) clearTimeout(this.negotiationTimer);
    this.negotiationTimer = null;
  }

  /** Encerra a sessão e libera todos os recursos. Idempotente. */
  close(): void {
    if (this.disposed) return;
    this.releaseResources();
    this.setPhase('closed');
    this.cb.onLog('Sessão encerrada; recursos liberados.');
  }

  private releaseResources(): void {
    this.disposed = true;

    if (this.statsTimer !== null) clearInterval(this.statsTimer);
    this.statsTimer = null;
    if (this.levelTimer !== null) clearInterval(this.levelTimer);
    this.levelTimer = null;
    this.clearNegotiationTimer();

    for (const pc of [this.pcA, this.pcB]) {
      if (!pc) continue;
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.onicecandidateerror = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      pc.onicegatheringstatechange = null;
      pc.onsignalingstatechange = null;
      pc.getSenders().forEach((s) => s.track?.stop());
      pc.close();
    }
    this.pcA = this.pcB = null;
    this.pendingCandidates.A.length = 0;
    this.pendingCandidates.B.length = 0;

    this.localStream?.getTracks().forEach((t) => {
      t.removeEventListener('ended', this.onLocalTrackEnded);
      t.stop();
    });
    this.localStream = null;

    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.srcObject = null;
      this.audioEl.remove();
    }
    this.audioEl = null;

    this.localAnalyser?.disconnect();
    this.remoteAnalyser?.disconnect();
    this.localAnalyser = this.remoteAnalyser = null;
    void this.audioCtx?.close().catch(() => undefined);
    this.audioCtx = null;

    this.prevInbound = this.prevOutbound = null;
  }
}
