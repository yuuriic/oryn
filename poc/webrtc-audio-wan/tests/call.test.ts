// PeerCall: negociação simulada entre dois participantes (teste 5), ciclo de vida de recursos e
// timers (teste 6), mute/unmute (teste 7) e tratamento de erros (teste 8).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerCall, type CallCallbacks, type CallPhase, type CallStats } from '../src/call.ts';
import { FakeStream, SignalingHub, gate, harness, settle, type Harness } from './helpers/fakes.ts';

interface Probe {
  phases: CallPhase[];
  errors: string[];
  logs: string[];
  stats: (CallStats | null)[];
  remote: unknown[];
  session: { sessionId: string; role: string; epoch: number } | null;
  invite: string | null;
  cb: CallCallbacks;
}

function probe(): Probe {
  const p: Probe = { phases: [], errors: [], logs: [], stats: [], remote: [], session: null, invite: null, cb: undefined as unknown as CallCallbacks };
  p.cb = {
    onPhase: (phase, error) => {
      p.phases.push(phase);
      if (error) p.errors.push(error);
    },
    onSession: (info) => (p.session = info),
    onInvite: (invite) => (p.invite = invite.token),
    onPeerStates: () => undefined,
    onLocalStream: () => undefined,
    onRemoteStream: (s) => p.remote.push(s),
    onStats: (s) => p.stats.push(s),
    onLog: (m) => p.logs.push(m),
  };
  return p;
}

let hub: SignalingHub;

beforeEach(() => {
  vi.useFakeTimers();
  hub = new SignalingHub();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function connectedPair() {
  const hostH = harness(hub);
  const guestH = harness(hub);
  const hostP = probe();
  const guestP = probe();
  const host = new PeerCall(hostH.deps, hostP.cb);
  const guest = new PeerCall(guestH.deps, guestP.cb);
  await host.start({ kind: 'create', operatorKey: hub.operatorKey });
  await settle();
  expect(host.phase).toBe('waiting-peer');
  await guest.start({ kind: 'join', invite: hostP.invite! });
  await settle();
  return { host, guest, hostH, guestH, hostP, guestP };
}

const allTimers = () => vi.getTimerCount();

describe('negociação simulada (teste 5)', () => {
  it('host oferta, guest responde, candidatos chegam antes da offer e são enfileirados; ambos conectam', async () => {
    const { host, guest, hostH, guestH, hostP, guestP } = await connectedPair();
    expect(host.phase).toBe('connected');
    expect(guest.phase).toBe('connected');
    expect(host.currentRole).toBe('host');
    expect(guest.currentRole).toBe('guest');
    expect(host.currentEpoch).toBe(1);
    expect(guest.currentEpoch).toBe(1);

    const kinds = (h: Harness) => h.signalings[0]!.sent.flatMap((m) => ((m as { type: string }).type === 'signal' ? [(m as { payload: { kind: string } }).payload.kind] : []));
    expect(kinds(hostH).filter((k) => k === 'offer')).toHaveLength(1);
    expect(kinds(hostH)).not.toContain('answer');
    expect(kinds(guestH).filter((k) => k === 'answer')).toHaveLength(1);
    expect(kinds(guestH)).not.toContain('offer');
    // Os candidatos do host foram enviados ANTES da offer; o guest os enfileirou e aplicou depois.
    expect(kinds(hostH).indexOf('candidate')).toBeLessThan(kinds(hostH).indexOf('offer'));
    expect(guestH.pcs[0]!.addedCandidates).toHaveLength(2);
    expect(hostH.pcs[0]!.addedCandidates).toHaveLength(2);
    expect([...hostP.logs, ...guestP.logs].join('\n')).not.toContain('addIceCandidate falhou');
    // Áudio remoto entregue aos dois lados.
    expect(hostP.remote.at(-1)).not.toBeNull();
    expect(guestP.remote.at(-1)).not.toBeNull();
  });

  it('prefere Opus nos dois lados (setCodecPreferences com Opus primeiro)', async () => {
    const { hostH, guestH } = await connectedPair();
    for (const pc of [hostH.pcs[0]!, guestH.pcs[0]!]) {
      const lastCall = pc.setCodecPreferences.mock.calls.at(-1)![0] as { mimeType: string }[];
      expect(lastCall[0]!.mimeType).toBe('audio/opus');
    }
  });

  it('descarta sinais de epoch antigo e sinais fora de ordem', async () => {
    const { guest, host, hostH, guestH, hostP, guestP } = await connectedPair();
    const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
    guestH.signalings[0]!.inject({ type: 'signal', epoch: 0, payload: { kind: 'offer', sdp } });
    guestH.signalings[0]!.inject({ type: 'signal', epoch: 1, payload: { kind: 'answer', sdp } });
    guestH.signalings[0]!.inject({ type: 'signal', epoch: 1, payload: { kind: 'offer', sdp } });
    hostH.signalings[0]!.inject({ type: 'signal', epoch: 1, payload: { kind: 'answer', sdp } });
    await settle();
    expect(guestP.logs).toContain('Sinal "offer" de negociação anterior descartado.');
    expect(guestP.logs).toContain('Answer fora de ordem descartada.');
    expect(guestP.logs).toContain('Offer fora de ordem descartada.');
    expect(hostP.logs).toContain('Answer fora de ordem descartada.');
    expect(host.phase).toBe('connected');
    expect(guest.phase).toBe('connected');
  });

  it('se o participante sai e outro entra, o par é refeito com novo epoch e nova conexão', async () => {
    const { host, guest, guestH, guestP } = await connectedPair();
    host.end();
    await settle();
    expect(guest.phase).toBe('waiting-peer');
    expect(guestH.pcs[0]!.signalingState).toBe('closed');
    expect(guestP.remote.at(-1)).toBeNull();

    const newH = harness(hub);
    const newcomer = new PeerCall(newH.deps, probe().cb);
    // Só o operador ocupa a vaga de host: ele volta à própria sessão (rejoin).
    await newcomer.start({ kind: 'rejoin', sessionId: guestP.session!.sessionId, operatorKey: hub.operatorKey });
    await settle();
    expect(newcomer.currentRole).toBe('host'); // o operador retomou a vaga de host
    expect(guest.currentEpoch).toBe(2);
    expect(guestH.pcs).toHaveLength(2);
    expect(guest.phase).toBe('connected');
    expect(newcomer.phase).toBe('connected');
    newcomer.end();
    guest.end();
  });
});

describe('ciclo de vida de recursos e timers (teste 6)', () => {
  it('conectado: só os intervalos de stats; encerrar libera tracks, peers, sinalização e timers', async () => {
    const { host, guest, hostH, guestH } = await connectedPair();
    expect(allTimers()).toBe(2); // um intervalo de stats por participante (timeout de negociação limpo)

    host.end();
    await settle();
    expect(hostH.streams[0]!.track.readyState).toBe('ended');
    expect(hostH.streams[0]!.track.listenerCount()).toBe(0);
    expect(hostH.pcs[0]!.signalingState).toBe('closed');
    expect(hostH.signalings[0]!.open).toBe(false);
    // O guest perdeu o par: fecha a conexão e para as métricas, mas mantém microfone e sessão.
    expect(guestH.pcs[0]!.signalingState).toBe('closed');
    expect(guestH.streams[0]!.track.readyState).toBe('live');
    expect(allTimers()).toBe(0);

    guest.end();
    expect(guestH.streams[0]!.track.readyState).toBe('ended');
    expect(hub.registry.sessionCount).toBe(0);
    expect(allTimers()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(allTimers()).toBe(0);
  });

  it('end() é idempotente e emite "ended" uma única vez', async () => {
    const { host, hostP } = await connectedPair();
    host.end();
    host.end();
    expect(hostP.phases.filter((p) => p === 'ended')).toHaveLength(1);
  });

  it('encerrar enquanto a permissão do microfone está pendente libera o microfone depois', async () => {
    const g = gate();
    const stream = new FakeStream();
    const h = harness(hub, { gum: async () => (await g.promise, stream) });
    const call = new PeerCall(h.deps, probe().cb);
    const started = call.start({ kind: 'create', operatorKey: hub.operatorKey });
    await settle();
    call.end();
    g.release();
    await started;
    await settle();
    expect(stream.track.readyState).toBe('ended');
    expect(h.signalings).toHaveLength(0);
    expect(allTimers()).toBe(0);
  });

  it('encerrar durante a negociação não deixa timers nem conexões abertas', async () => {
    const hostH = harness(hub);
    const guestH = harness(hub);
    const hostP = probe();
    const host = new PeerCall(hostH.deps, hostP.cb);
    const guest = new PeerCall(guestH.deps, probe().cb);
    await host.start({ kind: 'create', operatorKey: hub.operatorKey });
    await settle();
    // Segura a aplicação da offer no guest.
    const hold = gate();
    const origCreate = guestH.deps.createPeerConnection;
    guestH.deps.createPeerConnection = (cfg) => {
      const pc = origCreate(cfg) as unknown as { gates: Record<string, unknown> };
      pc.gates['setRemoteDescription'] = hold;
      return pc as unknown as RTCPeerConnection;
    };
    await guest.start({ kind: 'join', invite: hostP.invite! });
    await settle();
    expect(guest.phase).toBe('negotiating');
    guest.end();
    hold.release();
    await settle();
    host.end();
    expect(guestH.pcs[0]!.signalingState).toBe('closed');
    expect(guestH.signalings[0]!.sent.some((m) => (m as { payload?: { kind: string } }).payload?.kind === 'answer')).toBe(false);
    expect(allTimers()).toBe(0);
  });

  it('timeout de negociação encerra a tentativa e limpa tudo', async () => {
    const hostH = harness(hub);
    const hostP = probe();
    const host = new PeerCall(hostH.deps, hostP.cb);
    await host.start({ kind: 'create', operatorKey: hub.operatorKey });
    await settle();
    // Um guest "mudo": entra na sessão mas nunca responde.
    const silent = hub.create({ onMessage: () => undefined, onDisconnected: () => undefined, onInvalid: () => undefined });
    await silent.connect();
    silent.send({ type: 'join', invite: hostP.invite! });
    await settle();
    expect(host.phase).toBe('negotiating');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(host.phase).toBe('failed');
    expect(hostP.errors.at(-1)).toMatch(/Tempo de negociação esgotado/);
    expect(allTimers()).toBe(0);
    silent.close();
  });
});

describe('mute/unmute (teste 7)', () => {
  it('muta e reativa sem renegociar nem derrubar a conexão; lados independentes', async () => {
    const { host, guest, hostH, guestH } = await connectedPair();
    const hostTrack = hostH.streams[0]!.track;
    const guestTrack = guestH.streams[0]!.track;
    const signalsBefore = hostH.signalings[0]!.sent.length;

    host.setMuted(true);
    expect(host.muted).toBe(true);
    expect(hostTrack.enabled).toBe(false);
    expect(guestTrack.enabled).toBe(true);
    expect(host.phase).toBe('connected');
    expect(hostH.pcs[0]!.connectionState).toBe('connected');

    guest.setMuted(true);
    expect(guestTrack.enabled).toBe(false);
    host.setMuted(false);
    expect(hostTrack.enabled).toBe(true);
    expect(guestTrack.enabled).toBe(false);
    expect(hostH.signalings[0]!.sent.length).toBe(signalsBefore); // nenhuma renegociação
    expect(hostH.pcs).toHaveLength(1);
  });
});

describe('tratamento de erros (teste 8)', () => {
  it('permissão negada: falha com mensagem e nenhuma sinalização é aberta', async () => {
    const h = harness(hub, { gum: () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })) });
    const p = probe();
    const call = new PeerCall(h.deps, p.cb);
    await call.start({ kind: 'create', operatorKey: hub.operatorKey });
    expect(call.phase).toBe('failed');
    expect(p.errors[0]).toMatch(/Permissão de microfone negada/);
    expect(h.signalings).toHaveLength(0);
  });

  it('convite inexistente ou já usado: falha e libera o microfone', async () => {
    const h = harness(hub);
    const p = probe();
    const call = new PeerCall(h.deps, p.cb);
    await call.start({ kind: 'join', invite: 'X'.repeat(43) });
    await settle();
    expect(call.phase).toBe('failed');
    expect(p.errors[0]).toMatch(/Convite inválido/);
    expect(h.streams[0]!.track.readyState).toBe('ended');

    const { hostP } = await connectedPair();
    const thirdH = harness(hub);
    const thirdP = probe();
    const third = new PeerCall(thirdH.deps, thirdP.cb);
    // O convite já foi consumido pelo convidado: uso único.
    await third.start({ kind: 'join', invite: hostP.invite! });
    await settle();
    expect(third.phase).toBe('failed');
    expect(thirdP.errors[0]).toMatch(/Convite inválido/);
  });

  it('falha ao conectar na sinalização: falha e libera o microfone', async () => {
    const h = harness(hub, { failConnect: true });
    const p = probe();
    const call = new PeerCall(h.deps, p.cb);
    await call.start({ kind: 'create', operatorKey: hub.operatorKey });
    expect(call.phase).toBe('failed');
    expect(h.streams[0]!.track.readyState).toBe('ended');
  });

  it('queda da sinalização durante a chamada: falha e limpa; o outro lado volta a aguardar', async () => {
    const { host, guest, hostH, guestP } = await connectedPair();
    hostH.signalings[0]!.drop();
    await settle();
    expect(host.phase).toBe('failed');
    expect(hostH.pcs[0]!.signalingState).toBe('closed');
    expect(hostH.streams[0]!.track.readyState).toBe('ended');
    expect(guest.phase).toBe('waiting-peer');
    expect(guestP.logs).toContain('O outro participante saiu; aguardando novo participante.');
    guest.end();
    expect(allTimers()).toBe(0);
  });

  it('falha de ICE/DTLS e microfone desconectado encerram com mensagem clara', async () => {
    const a = await connectedPair();
    a.hostH.pcs[0]!.failConnection();
    expect(a.host.phase).toBe('failed');
    expect(a.hostP.errors.at(-1)).toMatch(/conexão WebRTC falhou/);
    a.guest.end();

    const b = await connectedPair();
    b.guestH.streams[0]!.track.endBySystem();
    expect(b.guest.phase).toBe('failed');
    expect(b.guestP.errors.at(-1)).toMatch(/microfone foi desconectado/);
    b.host.end();
    expect(allTimers()).toBe(0);
  });
});

describe('métricas', () => {
  it('métricas ausentes chegam como null (não zero); RTT prefere RTCP e recorre ao par ICE', async () => {
    const { hostH, hostP } = await connectedPair();
    const pc = hostH.pcs[0]!;
    pc.statsEntries = [
      { id: 'c', type: 'codec', timestamp: 1, mimeType: 'audio/opus', clockRate: 48000, channels: 2, payloadType: 111 },
      { id: 'o', type: 'outbound-rtp', timestamp: 1000, kind: 'audio', codecId: 'c', bytesSent: 4000, packetsSent: 50 },
      { id: 't', type: 'transport', timestamp: 1000, selectedCandidatePairId: 'p' },
      { id: 'p', type: 'candidate-pair', timestamp: 1000, state: 'succeeded', nominated: true, currentRoundTripTime: 0.004, localCandidateId: 'l', remoteCandidateId: 'r' },
      { id: 'l', type: 'local-candidate', timestamp: 1, candidateType: 'host', protocol: 'udp', address: '192.0.2.1' },
      { id: 'r', type: 'remote-candidate', timestamp: 1, candidateType: 'host', protocol: 'udp', address: '192.0.2.2' },
    ];
    await vi.advanceTimersByTimeAsync(1000);
    const first = hostP.stats.at(-1)!;
    expect(first.codec?.mimeType).toBe('audio/opus');
    expect(first.packetsSent).toBe(50);
    expect(first.packetsReceived).toBeNull(); // sem inbound-rtp: indisponível, não zero
    expect(first.jitterMs).toBeNull();
    expect(first.remoteLossPct).toBeNull();
    expect(first.rttMs).toBeCloseTo(4);
    expect(first.rttSource).toBe('ice');
    expect(JSON.stringify(first)).not.toContain('192.0.2');

    pc.statsEntries.push({ id: 'ri', type: 'remote-inbound-rtp', timestamp: 2000, kind: 'audio', roundTripTime: 0.012, fractionLost: 0.01, packetsLost: 1, jitter: 0.002 });
    (pc.statsEntries[1] as { timestamp: number; bytesSent: number }).timestamp = 2000;
    (pc.statsEntries[1] as { bytesSent: number }).bytesSent = 8000;
    await vi.advanceTimersByTimeAsync(1000);
    const second = hostP.stats.at(-1)!;
    expect(second.rttMs).toBeCloseTo(12);
    expect(second.rttSource).toBe('rtcp');
    expect(second.remoteLossPct).toBeCloseTo(1);
    expect(second.sendKbps).toBeCloseTo(32);
  });
});
