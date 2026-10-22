// Regressão: nenhuma rotina periódica pode ser criada depois que a sessão foi encerrada,
// inclusive quando o encerramento acontece no meio da negociação SDP.
// Usa fakes determinísticos de WebRTC/Web Audio e timers falsos do Vitest (sem navegador).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoopbackSession, type SessionPhase } from '../src/session';

// ---------- Portões: permitem pausar uma etapa da negociação e liberá-la depois ----------

interface Gate {
  promise: Promise<void>;
  release: () => void;
}
let gates = new Map<string, Gate>();

function hold(point: string): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  const gate = { promise, release };
  gates.set(point, gate);
  return gate;
}

const pass = (point: string): Promise<void> => gates.get(point)?.promise ?? Promise.resolve();

// ---------- Fakes ----------

class FakeTrack {
  kind = 'audio';
  label = 'fake';
  enabled = true;
  muted = false;
  readyState: MediaStreamTrackState = 'live';
  stop(): void {
    this.readyState = 'ended';
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  getSettings(): MediaTrackSettings {
    return { sampleRate: 48000, channelCount: 1 };
  }
}

class FakeStream {
  constructor(readonly track: FakeTrack) {}
  getAudioTracks(): FakeTrack[] {
    return [this.track];
  }
  getTracks(): FakeTrack[] {
    return [this.track];
  }
}

const SDP = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  readonly id: 'A' | 'B';
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  iceGatheringState: RTCIceGatheringState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  ontrack = null;
  onicecandidate = null;
  onicecandidateerror = null;
  onconnectionstatechange = null;
  oniceconnectionstatechange = null;
  onicegatheringstatechange = null;
  onsignalingstatechange = null;
  private readonly senders: { track: FakeTrack }[] = [];

  constructor() {
    this.id = FakePeerConnection.instances.length === 0 ? 'A' : 'B';
    FakePeerConnection.instances.push(this);
  }
  addTrack(track: FakeTrack): void {
    this.senders.push({ track });
  }
  getSenders(): { track: FakeTrack }[] {
    return this.senders;
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    await pass(`${this.id}.createOffer`);
    return { type: 'offer', sdp: SDP };
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    await pass(`${this.id}.createAnswer`);
    return { type: 'answer', sdp: SDP };
  }
  // Os fakes resolvem mesmo depois de close(): é o pior caso para o ciclo de vida da sessão.
  async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    await pass(`${this.id}.setLocalDescription`);
    this.localDescription = desc;
  }
  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    await pass(`${this.id}.setRemoteDescription`);
    this.remoteDescription = desc;
  }
  async addIceCandidate(): Promise<void> {}
  async getStats(): Promise<Map<string, unknown>> {
    return new Map();
  }
  close(): void {
    this.connectionState = 'closed';
    this.signalingState = 'closed';
  }
}

class FakeAudioContext {
  state: AudioContextState = 'running';
  sampleRate = 48000;
  onstatechange: (() => void) | null = null;
  createMediaStreamSource() {
    return { connect: () => undefined };
  }
  createAnalyser() {
    return { fftSize: 2048, connect: () => undefined, disconnect: () => undefined, getFloatTimeDomainData: () => undefined };
  }
  async close(): Promise<void> {
    this.state = 'closed';
  }
  async resume(): Promise<void> {}
}

// ---------- Ambiente ----------

let track: FakeTrack;
let phases: SessionPhase[];

/** Esvazia a fila de microtarefas sem avançar timers. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

function newSession(): LoopbackSession {
  return new LoopbackSession(
    { audioContainer: {} as HTMLElement },
    {
      onPhase: (phase) => phases.push(phase),
      onPeerStates: () => undefined,
      onStats: () => undefined,
      onLog: () => undefined,
    },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  gates = new Map();
  phases = [];
  track = new FakeTrack();
  FakePeerConnection.instances = [];
  vi.stubGlobal('window', { isSecureContext: true });
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: async () => new FakeStream(track),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      enumerateDevices: async () => [],
    },
  });
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  vi.stubGlobal('AudioContext', FakeAudioContext);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function expectFullyReleased(): void {
  expect(vi.getTimerCount()).toBe(0);
  expect(track.readyState).toBe('ended');
  expect(FakePeerConnection.instances).toHaveLength(2);
  expect(FakePeerConnection.instances.every((pc) => pc.signalingState === 'closed')).toBe(true);
}

describe('LoopbackSession — ciclo de vida dos timers', () => {
  it('controle: negociação completa cria as rotinas periódicas e close() remove todas', async () => {
    const session = newSession();
    await session.start();
    // stats (1 s) + níveis (40 ms) + timeout de negociação (ainda pendente: o fake nunca conecta)
    expect(vi.getTimerCount()).toBe(3);

    session.close();
    expectFullyReleased();
    expect(phases.at(-1)).toBe('closed');
  });

  // Cada ponto cobre um caminho distinto de retorno de negotiate() após o encerramento:
  // retornos antecipados (A/B.setLocalDescription), etapa final sem checagem
  // (A.setRemoteDescription) e retorno após createOffer.
  it.each(['A.createOffer', 'A.setLocalDescription', 'B.setLocalDescription', 'A.setRemoteDescription'])(
    'close() enquanto %s está pendente não deixa timers ativos',
    async (point) => {
      const gate = hold(point);
      const session = newSession();
      const started = session.start();
      await flushMicrotasks();
      expect(session.currentPhase).toBe('negotiating');

      session.close();
      gate.release();
      await started;
      await flushMicrotasks();

      expectFullyReleased();
      expect(phases.at(-1)).toBe('closed');
      // Nada dispara depois: avançar o relógio não recria rotinas nem muda a fase.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(vi.getTimerCount()).toBe(0);
      expect(phases.at(-1)).toBe('closed');
    },
  );

  it('falha durante a negociação (timeout) também não deixa timers ativos', async () => {
    const gate = hold('B.setLocalDescription');
    const session = newSession();
    const started = session.start();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(15_000); // dispara o timeout de negociação → fail()
    expect(session.currentPhase).toBe('failed');
    gate.release();
    await started;
    await flushMicrotasks();

    expectFullyReleased();
  });
});
