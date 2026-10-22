import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerMessage } from '../src/protocol.ts';
import { TokenBucket } from '../server/rate-limit.ts';
import { SessionRegistry, shortId, type Participant } from '../server/registry.ts';

const SDP = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';

class FakeParticipant implements Participant {
  readonly inbox: ServerMessage[] = [];
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
  send(message: ServerMessage): void {
    this.inbox.push(message);
  }
  last(): ServerMessage | undefined {
    return this.inbox.at(-1);
  }
}

let clock = 0;
let ids = 0;
let logs: string[] = [];
let registry: SessionRegistry;

const nextId = () => `S${String(++ids).padStart(21, '0')}`;

beforeEach(() => {
  clock = 1_000;
  ids = 0;
  logs = [];
  registry = new SessionRegistry({
    maxSessions: 3,
    idleTimeoutMs: 60_000,
    now: () => clock,
    randomId: nextId,
    log: (e) => logs.push(e),
  });
});

function pair() {
  const host = new FakeParticipant('h');
  const guest = new FakeParticipant('g');
  registry.handle(host, { type: 'create' });
  const created = host.last() as Extract<ServerMessage, { type: 'session' }>;
  registry.handle(guest, { type: 'join', sessionId: created.sessionId });
  return { host, guest, sessionId: created.sessionId };
}

describe('criação e entrada (teste 1)', () => {
  it('cria sessão com o criador como host, sem par', () => {
    const host = new FakeParticipant('h');
    registry.handle(host, { type: 'create' });
    expect(host.last()).toEqual({ type: 'session', sessionId: 'S000000000000000000001', role: 'host', epoch: 0, peerPresent: false });
    expect(registry.sessionCount).toBe(1);
  });

  it('o segundo participante entra como guest e ambos ficam sabendo (epoch 1)', () => {
    const { host, guest, sessionId } = pair();
    expect(guest.last()).toEqual({ type: 'session', sessionId, role: 'guest', epoch: 1, peerPresent: true });
    expect(host.last()).toEqual({ type: 'peer-joined', epoch: 1 });
    expect(registry.inspect(sessionId)).toEqual({ host: true, guest: true, epoch: 1 });
  });

  it('sessão inexistente → not-found; participante já em sessão → already-in-session', () => {
    const p = new FakeParticipant('p');
    registry.handle(p, { type: 'join', sessionId: 'X'.repeat(22) });
    expect(p.last()).toEqual({ type: 'error', code: 'not-found' });
    registry.handle(p, { type: 'create' });
    registry.handle(p, { type: 'create' });
    expect(p.last()).toEqual({ type: 'error', code: 'already-in-session' });
  });

  it('limite global de sessões → server-busy', () => {
    for (let i = 0; i < 3; i++) registry.handle(new FakeParticipant(`p${i}`), { type: 'create' });
    const extra = new FakeParticipant('extra');
    registry.handle(extra, { type: 'create' });
    expect(extra.last()).toEqual({ type: 'error', code: 'server-busy' });
  });
});

describe('limite de dois participantes (teste 2)', () => {
  it('terceiro participante recebe session-full e a sessão não muda', () => {
    const { host, guest, sessionId } = pair();
    const third = new FakeParticipant('t');
    const before = [host.inbox.length, guest.inbox.length];
    registry.handle(third, { type: 'join', sessionId });
    expect(third.last()).toEqual({ type: 'error', code: 'session-full' });
    expect([host.inbox.length, guest.inbox.length]).toEqual(before);
    expect(registry.sessionOf(third)).toBeNull();
  });
});

describe('encaminhamento de sinais (teste 3)', () => {
  it('encaminha offer do host e answer/candidate do guest, sem alterar o conteúdo', () => {
    const { host, guest } = pair();
    registry.handle(host, { type: 'signal', epoch: 1, payload: { kind: 'offer', sdp: SDP } });
    expect(guest.last()).toEqual({ type: 'signal', epoch: 1, payload: { kind: 'offer', sdp: SDP } });
    registry.handle(guest, { type: 'signal', epoch: 1, payload: { kind: 'answer', sdp: SDP } });
    expect(host.last()).toEqual({ type: 'signal', epoch: 1, payload: { kind: 'answer', sdp: SDP } });
    const cand = { kind: 'candidate' as const, candidate: { candidate: 'candidate:1 1 udp 1 x 1 typ host', sdpMid: '0', sdpMLineIndex: 0 } };
    registry.handle(guest, { type: 'signal', epoch: 1, payload: cand });
    expect(host.last()).toEqual({ type: 'signal', epoch: 1, payload: cand });
  });

  it('ordem de papéis: offer do guest e answer do host → unexpected-signal', () => {
    const { host, guest } = pair();
    registry.handle(guest, { type: 'signal', epoch: 1, payload: { kind: 'offer', sdp: SDP } });
    expect(guest.last()).toEqual({ type: 'error', code: 'unexpected-signal' });
    registry.handle(host, { type: 'signal', epoch: 1, payload: { kind: 'answer', sdp: SDP } });
    expect(host.last()).toEqual({ type: 'error', code: 'unexpected-signal' });
  });

  it('epoch antigo → stale-epoch; sem par → no-peer; fora de sessão → not-in-session', () => {
    const { host } = pair();
    registry.handle(host, { type: 'signal', epoch: 0, payload: { kind: 'offer', sdp: SDP } });
    expect(host.last()).toEqual({ type: 'error', code: 'stale-epoch' });

    const lonely = new FakeParticipant('l');
    registry.handle(lonely, { type: 'create' });
    registry.handle(lonely, { type: 'signal', epoch: 0, payload: { kind: 'offer', sdp: SDP } });
    expect(lonely.last()).toEqual({ type: 'error', code: 'no-peer' });

    const outsider = new FakeParticipant('o');
    registry.handle(outsider, { type: 'signal', epoch: 0, payload: { kind: 'offer', sdp: SDP } });
    expect(outsider.last()).toEqual({ type: 'error', code: 'not-in-session' });
  });

  it('logs não contêm SDP nem o identificador completo da sessão', () => {
    const { host, sessionId } = pair();
    registry.handle(host, { type: 'signal', epoch: 1, payload: { kind: 'offer', sdp: SDP } });
    const all = logs.join('\n');
    expect(all).not.toContain('v=0');
    expect(all).not.toContain(sessionId);
    expect(all).toContain(shortId(sessionId));
  });
});

describe('desconexão e limpeza (teste 4)', () => {
  it('saída do guest notifica o host; saída do último remove a sessão', () => {
    const { host, guest, sessionId } = pair();
    registry.disconnect(guest);
    expect(host.last()).toEqual({ type: 'peer-left', epoch: 1 });
    expect(registry.inspect(sessionId)).toEqual({ host: true, guest: false, epoch: 1 });
    registry.handle(host, { type: 'leave' });
    expect(registry.inspect(sessionId)).toBeNull();
    expect(registry.sessionCount).toBe(0);
    expect(registry.sessionOf(host)).toBeNull();
  });

  it('se o host sai, quem entra depois vira host (para criar a offer) e o epoch avança', () => {
    const { host, guest, sessionId } = pair();
    registry.disconnect(host);
    expect(guest.last()).toEqual({ type: 'peer-left', epoch: 1 });
    const newcomer = new FakeParticipant('n');
    registry.handle(newcomer, { type: 'join', sessionId });
    expect(newcomer.last()).toEqual({ type: 'session', sessionId, role: 'host', epoch: 2, peerPresent: true });
    expect(guest.last()).toEqual({ type: 'peer-joined', epoch: 2 });
  });

  it('sessão com um participante expira por inatividade; sessão com par não expira', () => {
    const lone = new FakeParticipant('l');
    registry.handle(lone, { type: 'create' });
    const { host } = pair();
    clock += 60_001;
    registry.sweep();
    expect(lone.last()).toEqual({ type: 'session-closed', reason: 'expired' });
    expect(registry.sessionOf(lone)).toBeNull();
    expect(registry.sessionOf(host)).not.toBeNull();
    expect(registry.sessionCount).toBe(1);
  });

  it('closeAll avisa todos e esvazia o registro', () => {
    const { host, guest } = pair();
    registry.closeAll();
    expect(host.last()).toEqual({ type: 'session-closed', reason: 'server-shutdown' });
    expect(guest.last()).toEqual({ type: 'session-closed', reason: 'server-shutdown' });
    expect(registry.sessionCount).toBe(0);
  });

  it('desconectar quem não está em sessão é inofensivo', () => {
    expect(() => registry.disconnect(new FakeParticipant('x'))).not.toThrow();
  });
});

describe('TokenBucket', () => {
  it('permite a rajada configurada, bloqueia e repõe com o tempo', () => {
    let now = 0;
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 2, now: () => now });
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, true, false]);
    now += 500; // +1 token
    expect([bucket.take(), bucket.take()]).toEqual([true, false]);
    now += 10_000; // não passa da capacidade
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, true, false]);
  });
});
