import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ServerMessage } from '../src/protocol.ts';
import { SignalingClient, signalingUrl, type SocketLike } from '../src/signaling-client.ts';
import { describePair, formatMetric, remoteInboundAudio } from '../src/stats.ts';

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  closedWith: number | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000): void {
    this.closedWith = code;
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

let socket: FakeSocket;
let handlers: { onMessage: Mock<(m: ServerMessage) => void>; onDisconnected: Mock<(code: number) => void>; onInvalid: Mock<() => void> };
let client: SignalingClient;

beforeEach(() => {
  vi.useFakeTimers();
  socket = new FakeSocket();
  handlers = { onMessage: vi.fn<(m: ServerMessage) => void>(), onDisconnected: vi.fn<(code: number) => void>(), onInvalid: vi.fn<() => void>() };
  client = new SignalingClient('wss://example/ws', handlers, () => socket);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('signalingUrl (movido de tls.test.ts, removido no 02B.2A)', () => {
  it('ws:// para página HTTP em loopback e wss:// para página HTTPS (túnel público futuro)', () => {
    expect(signalingUrl({ protocol: 'http:', host: 'localhost:5280' })).toBe('ws://localhost:5280/ws');
    expect(signalingUrl({ protocol: 'http:', host: '[::1]:5280' })).toBe('ws://[::1]:5280/ws');
    expect(signalingUrl({ protocol: 'https:', host: 'oryn-poc.example.com' })).toBe('wss://oryn-poc.example.com/ws');
  });
});

describe('SignalingClient', () => {
  it('conecta, envia JSON e entrega somente mensagens válidas do servidor', async () => {
    const connected = client.connect();
    socket.open();
    await connected;
    expect(client.send({ type: 'invite' })).toBe(true);
    expect(socket.sent).toEqual(['{"type":"invite"}']);

    socket.onmessage?.({ data: '{"type":"peer-joined","epoch":1}' });
    socket.onmessage?.({ data: '{"type":"peer-joined","epoch":1,"x":1}' });
    socket.onmessage?.({ data: new ArrayBuffer(4) });
    expect(handlers.onMessage).toHaveBeenCalledTimes(1);
    expect(handlers.onInvalid).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejeita se o socket fecha antes de abrir; send() devolve false sem conexão', async () => {
    const connected = client.connect();
    socket.serverClose(1006);
    await expect(connected).rejects.toThrow(/Não foi possível conectar/);
    expect(client.send({ type: 'leave' })).toBe(false);
    expect(handlers.onDisconnected).not.toHaveBeenCalled();
  });

  it('timeout de conexão rejeita, fecha o socket e não deixa timers', async () => {
    const connected = client.connect(500);
    const assertion = expect(connected).rejects.toThrow(/Tempo esgotado/);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    expect(socket.closedWith).not.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('close() durante a conexão cancela a promise e o timer', async () => {
    const connected = client.connect();
    client.close();
    await expect(connected).rejects.toThrow(/cancelada/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('queda do servidor avisa onDisconnected; close() pelo cliente não avisa', async () => {
    const connected = client.connect();
    socket.open();
    await connected;
    socket.serverClose(1001);
    expect(handlers.onDisconnected).toHaveBeenCalledWith(1001);

    const s2 = new FakeSocket();
    const c2 = new SignalingClient('ws://x/ws', handlers, () => s2);
    const p2 = c2.connect();
    s2.open();
    await p2;
    c2.close();
    expect(s2.closedWith).toBe(1000);
    expect(handlers.onDisconnected).toHaveBeenCalledTimes(1);
  });
});

describe('métricas da POC-02A', () => {
  it('remote-inbound-rtp converte unidades e devolve null quando ausente', () => {
    expect(remoteInboundAudio([])).toBeNull();
    const r = remoteInboundAudio([
      { id: 'x', type: 'remote-inbound-rtp', timestamp: 1, kind: 'audio', roundTripTime: 0.02, fractionLost: 0.05, packetsLost: 3, jitter: 0.003 },
    ]);
    expect(r?.roundTripTimeMs).toBeCloseTo(20);
    expect(r?.fractionLostPct).toBeCloseTo(5);
    expect(r?.packetsLost).toBe(3);
    expect(r?.jitterMs).toBeCloseTo(3);
    const partial = remoteInboundAudio([{ id: 'y', type: 'remote-inbound-rtp', timestamp: 1, kind: 'audio' }]);
    expect(partial).toEqual({ roundTripTimeMs: null, fractionLostPct: null, packetsLost: null, jitterMs: null });
  });

  it('formatMetric mostra "indisponível" (nunca 0) para ausentes; describePair sem endereços', () => {
    expect(formatMetric(null)).toBe('indisponível');
    expect(formatMetric(undefined)).toBe('indisponível');
    expect(formatMetric(Number.NaN)).toBe('indisponível');
    expect(formatMetric(0, 1, ' ms')).toBe('0.0 ms');
    expect(describePair(null)).toBe('indisponível');
    expect(describePair({ state: 'succeeded', rttMs: 3, localCandidateType: 'host', remoteCandidateType: 'srflx', protocol: 'udp' })).toBe(
      'host ↔ srflx · udp (succeeded)',
    );
  });
});
