// A1 (auditoria do PR #3): a fila de operações SDP deve ser isolada por par/geração.
// No Chrome real, operações SDP em andamento ficam PENDENTES PARA SEMPRE após pc.close();
// os fakes aqui reproduzem isso com "portões" que nunca são liberados (ou são liberados tarde).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerCall, type CallCallbacks } from '../src/call.ts';
import { FakePeerConnection, SignalingHub, gate, harness, settle, type Gate, type Harness } from './helpers/fakes.ts';

interface Probe {
  logs: string[];
  errors: string[];
  session: { sessionId: string } | null;
  cb: CallCallbacks;
}

function probe(): Probe {
  const p: Probe = { logs: [], errors: [], session: null, cb: undefined as unknown as CallCallbacks };
  p.cb = {
    onPhase: (_phase, error) => error && p.errors.push(error),
    onSession: (info) => (p.session = info),
    onPeerStates: () => undefined,
    onLocalStream: () => undefined,
    onRemoteStream: () => undefined,
    onStats: () => undefined,
    onLog: (m) => p.logs.push(m),
  };
  return p;
}

/** Faz o N-ésimo RTCPeerConnection criado por este harness usar o portão indicado. */
function gateNthPeer(h: Harness, n: number, method: 'setRemoteDescription' | 'createOffer', g: Gate): void {
  const create = h.deps.createPeerConnection;
  let count = 0;
  h.deps.createPeerConnection = (cfg) => {
    const pc = create(cfg) as unknown as FakePeerConnection;
    if (++count === n) pc.gates[method] = g;
    return pc as unknown as RTCPeerConnection;
  };
}

const signalsOf = (h: Harness, kind: string) =>
  h.signalings
    .flatMap((s) => s.sent)
    .filter((m) => (m as { type: string; payload?: { kind: string } }).type === 'signal' && (m as { payload: { kind: string } }).payload.kind === kind) as {
    epoch: number;
  }[];

const SDP = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
let hub: SignalingHub;

beforeEach(() => {
  vi.useFakeTimers();
  hub = new SignalingHub();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('A1 — fila SDP isolada por par', () => {
  it('setRemoteDescription antigo pendente para sempre não bloqueia o novo par; rejeição tardia não afeta o novo par', async () => {
    const hostH = harness(hub);
    const guestH = harness(hub);
    const hostP = probe();
    const guestP = probe();
    const stuck = gate(); // nunca liberado até o fim do teste
    gateNthPeer(guestH, 1, 'setRemoteDescription', stuck);

    const host = new PeerCall(hostH.deps, hostP.cb);
    const guest = new PeerCall(guestH.deps, guestP.cb);
    await host.start({ kind: 'create' });
    await settle();
    await guest.start({ kind: 'join', sessionId: hostP.session!.sessionId });
    await settle();
    expect(guest.phase).toBe('negotiating'); // aplicando a offer do par 1: operação travada

    // O participante anterior sai durante a operação pendente.
    host.end();
    await settle();
    expect(guest.phase).toBe('waiting-peer');
    expect(guestH.pcs[0]!.signalingState).toBe('closed');

    // Um novo participante entra (vira host) e a nova negociação roda sem esperar a promessa antiga.
    const newH = harness(hub);
    const newcomer = new PeerCall(newH.deps, probe().cb);
    await newcomer.start({ kind: 'join', sessionId: guestP.session!.sessionId });
    await settle();
    expect(guest.currentEpoch).toBe(2);
    expect(guest.phase).toBe('connected');
    expect(newcomer.phase).toBe('connected');
    expect(guestH.pcs).toHaveLength(2);
    expect(guestH.pcs[1]!.calls.setRemoteDescription).toBe(1);
    expect(signalsOf(guestH, 'answer').map((a) => a.epoch)).toEqual([2]);

    // Liberação tardia: a operação antiga rejeita (conexão fechada) e NÃO pode derrubar o novo par.
    stuck.release();
    await settle();
    expect(guest.phase).toBe('connected');
    expect(guestP.errors).toEqual([]);
    expect(guestP.logs.join('\n')).not.toContain('Falha na negociação');
    expect(guestH.pcs[1]!.signalingState).toBe('stable');
    expect(signalsOf(guestH, 'answer').map((a) => a.epoch)).toEqual([2]);

    newcomer.end();
    guest.end();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('createOffer antigo pendente: o novo par oferta normalmente; resolução tardia não envia offer antiga', async () => {
    const hostH = harness(hub);
    const hostP = probe();
    const stuck = gate();
    gateNthPeer(hostH, 1, 'createOffer', stuck);
    const host = new PeerCall(hostH.deps, hostP.cb);
    await host.start({ kind: 'create' });
    await settle();

    const firstH = harness(hub);
    const first = new PeerCall(firstH.deps, probe().cb);
    await first.start({ kind: 'join', sessionId: hostP.session!.sessionId });
    await settle();
    expect(hostH.pcs[0]!.calls.createOffer).toBe(1);
    expect(signalsOf(hostH, 'offer')).toHaveLength(0); // createOffer travado

    first.end();
    await settle();
    expect(host.phase).toBe('waiting-peer');

    const secondH = harness(hub);
    const second = new PeerCall(secondH.deps, probe().cb);
    await second.start({ kind: 'join', sessionId: hostP.session!.sessionId });
    await settle();
    expect(host.phase).toBe('connected');
    expect(second.phase).toBe('connected');
    expect(signalsOf(hostH, 'offer').map((o) => o.epoch)).toEqual([2]);

    // Resolução tardia da operação antiga: descartada, sem offer extra e sem tocar no par novo.
    stuck.release();
    await settle();
    expect(signalsOf(hostH, 'offer').map((o) => o.epoch)).toEqual([2]);
    expect(hostH.pcs[0]!.localDescription).toBeNull();
    expect(host.phase).toBe('connected');
    expect(hostP.errors).toEqual([]);

    second.end();
    host.end();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('operações do mesmo par continuam serializadas (a segunda offer espera a primeira terminar)', async () => {
    const hostH = harness(hub);
    const guestH = harness(hub);
    const hostP = probe();
    const guestP = probe();
    const hold = gate();
    gateNthPeer(guestH, 1, 'setRemoteDescription', hold);
    const host = new PeerCall(hostH.deps, hostP.cb);
    const guest = new PeerCall(guestH.deps, guestP.cb);
    await host.start({ kind: 'create' });
    await settle();
    await guest.start({ kind: 'join', sessionId: hostP.session!.sessionId });
    await settle();

    // Uma offer duplicada do mesmo epoch chega enquanto a primeira ainda está sendo aplicada.
    guestH.signalings[0]!.inject({ type: 'signal', epoch: guest.currentEpoch, payload: { kind: 'offer', sdp: SDP } });
    await settle();
    expect(guestH.pcs[0]!.calls.setRemoteDescription).toBe(1); // não executou em paralelo
    expect(guestP.logs).not.toContain('Offer fora de ordem descartada.');

    hold.release();
    await settle();
    expect(guestP.logs).toContain('Offer fora de ordem descartada.'); // processada só depois, já fora de ordem
    expect(guestH.pcs[0]!.calls.setRemoteDescription).toBe(1);
    expect(guest.phase).toBe('connected');
    host.end();
    guest.end();
  });

  it('encerrar com operação SDP pendente para sempre não deixa timers, conexões nem microfone ativos', async () => {
    const hostH = harness(hub);
    const guestH = harness(hub);
    const hostP = probe();
    gateNthPeer(guestH, 1, 'setRemoteDescription', gate()); // nunca liberado
    const host = new PeerCall(hostH.deps, hostP.cb);
    const guest = new PeerCall(guestH.deps, probe().cb);
    await host.start({ kind: 'create' });
    await settle();
    await guest.start({ kind: 'join', sessionId: hostP.session!.sessionId });
    await settle();
    expect(guest.phase).toBe('negotiating');

    guest.end();
    host.end();
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    expect(guestH.pcs[0]!.signalingState).toBe('closed');
    expect(guestH.streams[0]!.track.readyState).toBe('ended');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
