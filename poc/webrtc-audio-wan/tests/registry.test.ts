// Registro de sessões com admissão (02B.2B): operador, convites de uso único, limites, reentrada e logs.
import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerMessage } from '../src/protocol.ts';
import { Admission, hashToken } from '../server/admission.ts';
import { TokenBucket } from '../server/rate-limit.ts';
import { SessionRegistry, shortId, type ConnectionContext, type Participant } from '../server/registry.ts';

const SDP = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const KEY = 'K'.repeat(43);
const LOCAL: ConnectionContext = { local: true };
const PUBLIC: ConnectionContext = { local: false };

class FakeParticipant implements Participant {
  readonly inbox: ServerMessage[] = [];
  closedWith: number | null = null;
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
  send(message: ServerMessage): void {
    this.inbox.push(message);
  }
  close(code: number): void {
    this.closedWith = code;
  }
  last(): ServerMessage | undefined {
    return this.inbox.at(-1);
  }
  lastOf<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    return this.inbox.filter((m) => m.type === type).at(-1) as Extract<ServerMessage, { type: T }> | undefined;
  }
}

let clock = 0;
let ids = 0;
let tokens = 0;
let logs: string[] = [];
let registry: SessionRegistry;

beforeEach(() => {
  clock = 1_000;
  ids = 0;
  tokens = 0;
  logs = [];
  const admission = new Admission({
    operatorKeyHash: hashToken(KEY),
    inviteTtlMs: 60_000,
    maxOperatorFailures: 5,
    failureWindowMs: 60_000,
    lockoutMs: 60_000,
    now: () => clock,
    randomToken: () => `I${String(++tokens).padStart(42, '0')}`,
  });
  registry = new SessionRegistry({
    maxSessions: 3,
    idleTimeoutMs: 60_000,
    maxAuthFailures: 3,
    admission,
    publicOrigin: 'https://oryn-poc.example.com',
    now: () => clock,
    randomId: () => `S${String(++ids).padStart(21, '0')}`,
    log: (e) => logs.push(e),
  });
});

function createSession(id = 'h') {
  const host = new FakeParticipant(id);
  registry.handle(host, { type: 'create', operatorKey: KEY }, LOCAL);
  const session = host.lastOf('session')!;
  const invite = host.lastOf('invite')!;
  return { host, sessionId: session.sessionId, invite: invite.token };
}

function pair() {
  const { host, sessionId, invite } = createSession();
  const guest = new FakeParticipant('g');
  registry.handle(guest, { type: 'join', invite }, PUBLIC);
  return { host, guest, sessionId, invite };
}

describe('criação restrita ao operador (testes 1 e "criação sem autorização")', () => {
  it('operador local com a chave cria a sessão como host e recebe um convite com a origem pública', () => {
    const { host } = createSession();
    expect(host.inbox[0]).toEqual({ type: 'session', sessionId: 'S000000000000000000001', role: 'host', epoch: 0, peerPresent: false });
    expect(host.inbox[1]).toMatchObject({ type: 'invite', token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), publicOrigin: 'https://oryn-poc.example.com' });
    expect(registry.sessionCount).toBe(1);
  });

  it('chave errada → unauthorized; chave certa pelo hostname público → unauthorized (loopback/Host não bastam sozinhos)', () => {
    const wrong = new FakeParticipant('w');
    registry.handle(wrong, { type: 'create', operatorKey: 'X'.repeat(43) }, LOCAL);
    expect(wrong.last()).toEqual({ type: 'error', code: 'unauthorized' });
    const remote = new FakeParticipant('r');
    registry.handle(remote, { type: 'create', operatorKey: KEY }, PUBLIC);
    expect(remote.last()).toEqual({ type: 'error', code: 'unauthorized' });
    expect(registry.sessionCount).toBe(0);
  });

  it('3 falhas de autorização na mesma conexão encerram a conexão (1008)', () => {
    const p = new FakeParticipant('p');
    for (let i = 0; i < 2; i++) registry.handle(p, { type: 'create', operatorKey: 'X'.repeat(43) }, LOCAL);
    expect(p.closedWith).toBeNull();
    registry.handle(p, { type: 'join', invite: 'Y'.repeat(43) }, PUBLIC);
    expect(p.closedWith).toBe(1008);
  });

  it('limite de sessões → server-busy', () => {
    for (let i = 0; i < 3; i++) createSession(`h${i}`);
    const extra = new FakeParticipant('extra');
    registry.handle(extra, { type: 'create', operatorKey: KEY }, LOCAL);
    expect(extra.last()).toEqual({ type: 'error', code: 'server-busy' });
  });

  it('participante já em sessão não cria outra', () => {
    const { host } = createSession();
    registry.handle(host, { type: 'create', operatorKey: KEY }, LOCAL);
    expect(host.last()).toEqual({ type: 'error', code: 'already-in-session' });
  });
});

describe('convites de uso único', () => {
  it('convite válido coloca o convidado na vaga de guest; o host fica sabendo (epoch 1)', () => {
    const { host, guest, sessionId } = pair();
    expect(guest.last()).toEqual({ type: 'session', sessionId, role: 'guest', epoch: 1, peerPresent: true });
    expect(host.last()).toEqual({ type: 'peer-joined', epoch: 1 });
  });

  it('convite reutilizado, inválido ou expirado → invite-invalid', () => {
    const { invite } = pair();
    const reuse = new FakeParticipant('reuse');
    registry.handle(reuse, { type: 'join', invite }, PUBLIC);
    expect(reuse.last()).toEqual({ type: 'error', code: 'invite-invalid' });

    const random = new FakeParticipant('random');
    registry.handle(random, { type: 'join', invite: 'Z'.repeat(43) }, PUBLIC);
    expect(random.last()).toEqual({ type: 'error', code: 'invite-invalid' });

    const { invite: late } = createSession('h2');
    clock += 60_000;
    const slow = new FakeParticipant('slow');
    registry.handle(slow, { type: 'join', invite: late }, PUBLIC);
    expect(slow.last()).toEqual({ type: 'error', code: 'invite-invalid' });
  });

  it('convite revogado quando a sessão termina (operador sai antes de o convidado entrar)', () => {
    const { host, invite } = createSession();
    registry.handle(host, { type: 'leave' }, LOCAL);
    expect(registry.sessionCount).toBe(0);
    const g = new FakeParticipant('g');
    registry.handle(g, { type: 'join', invite }, PUBLIC);
    expect(g.last()).toEqual({ type: 'error', code: 'invite-invalid' });
  });

  it('novo convite revoga o anterior', () => {
    const { host, invite: first } = createSession();
    registry.handle(host, { type: 'invite' }, LOCAL);
    const second = host.lastOf('invite')!.token;
    expect(second).not.toBe(first);
    const a = new FakeParticipant('a');
    registry.handle(a, { type: 'join', invite: first }, PUBLIC);
    expect(a.last()).toEqual({ type: 'error', code: 'invite-invalid' });
    const b = new FakeParticipant('b');
    registry.handle(b, { type: 'join', invite: second }, PUBLIC);
    expect(b.lastOf('session')?.role).toBe('guest');
  });

  it('consumo concorrente do mesmo convite: só um entra', async () => {
    const { invite } = createSession();
    const contenders = Array.from({ length: 10 }, (_, i) => new FakeParticipant(`c${i}`));
    await Promise.all(contenders.map((c) => Promise.resolve().then(() => registry.handle(c, { type: 'join', invite }, PUBLIC))));
    expect(contenders.filter((c) => c.lastOf('session')?.role === 'guest')).toHaveLength(1);
    expect(contenders.filter((c) => c.last()?.type === 'error')).toHaveLength(9);
  });

  it('só o operador da sessão emite convites; convidado ou estranho → unauthorized', () => {
    const { guest } = pair();
    registry.handle(guest, { type: 'invite' }, PUBLIC);
    expect(guest.last()).toEqual({ type: 'error', code: 'unauthorized' });
    const outsider = new FakeParticipant('o');
    registry.handle(outsider, { type: 'invite' }, LOCAL);
    expect(outsider.last()).toEqual({ type: 'error', code: 'unauthorized' });
  });
});

describe('limite de participantes (teste 2)', () => {
  it('com a vaga de convidado ocupada, o operador não obtém convite (session-full) e o convite usado não serve', () => {
    const { host, invite } = pair();
    registry.handle(host, { type: 'invite' }, LOCAL);
    expect(host.last()).toEqual({ type: 'error', code: 'session-full' });
    const third = new FakeParticipant('t');
    registry.handle(third, { type: 'join', invite }, PUBLIC);
    expect(third.last()).toEqual({ type: 'error', code: 'invite-invalid' });
    expect(registry.sessionOf(third)).toBeNull();
  });
});

describe('reentrada legítima', () => {
  it('convidado sai e volta com um novo convite emitido pelo operador (epoch avança)', () => {
    const { host, guest, sessionId } = pair();
    registry.disconnect(guest);
    expect(host.last()).toEqual({ type: 'peer-left', epoch: 1 });
    registry.handle(host, { type: 'invite' }, LOCAL);
    const back = new FakeParticipant('g2');
    registry.handle(back, { type: 'join', invite: host.lastOf('invite')!.token }, PUBLIC);
    expect(back.last()).toEqual({ type: 'session', sessionId, role: 'guest', epoch: 2, peerPresent: true });
  });

  it('operador sai e volta com a chave (rejoin) para a vaga de host', () => {
    const { host, guest, sessionId } = pair();
    registry.disconnect(host);
    expect(guest.last()).toEqual({ type: 'peer-left', epoch: 1 });
    const op = new FakeParticipant('op2');
    registry.handle(op, { type: 'rejoin', sessionId, operatorKey: KEY }, LOCAL);
    expect(op.last()).toEqual({ type: 'session', sessionId, role: 'host', epoch: 2, peerPresent: true });
    expect(guest.last()).toEqual({ type: 'peer-joined', epoch: 2 });
  });

  it('rejoin recusado: chave errada, pelo hostname público, vaga ocupada ou sessão inexistente', () => {
    const { sessionId } = pair();
    const cases: [ConnectionContext, string, string, ServerMessage][] = [
      [LOCAL, 'X'.repeat(43), sessionId, { type: 'error', code: 'unauthorized' }],
      [PUBLIC, KEY, sessionId, { type: 'error', code: 'unauthorized' }],
      [LOCAL, KEY, sessionId, { type: 'error', code: 'session-full' }],
      [LOCAL, KEY, 'N'.repeat(22), { type: 'error', code: 'not-found' }],
    ];
    cases.forEach(([ctx, key, sid, expected], i) => {
      const p = new FakeParticipant(`r${i}`);
      registry.handle(p, { type: 'rejoin', sessionId: sid, operatorKey: key }, ctx);
      expect(p.last()).toEqual(expected);
    });
  });

  it('convites só preenchem a vaga de convidado: com o operador fora, um convite nunca ocupa a vaga de host', () => {
    const { host, sessionId } = createSession();
    registry.handle(host, { type: 'invite' }, LOCAL); // convite válido pendente
    const pending = host.lastOf('invite')!.token;
    const g = new FakeParticipant('g');
    registry.handle(g, { type: 'join', invite: pending }, PUBLIC);
    registry.disconnect(host); // vaga de host livre, vaga de convidado ocupada
    expect(registry.inspect(sessionId)).toEqual({ host: false, guest: true, epoch: 1 });
    const intruder = new FakeParticipant('i');
    registry.handle(intruder, { type: 'join', invite: pending }, PUBLIC);
    expect(intruder.last()).toEqual({ type: 'error', code: 'invite-invalid' });
    expect(registry.inspect(sessionId)).toEqual({ host: false, guest: true, epoch: 1 });
  });
});

describe('encaminhamento de sinais', () => {
  it('encaminha offer do host e answer/candidate do guest, sem alterar o conteúdo', () => {
    const { host, guest } = pair();
    registry.handle(host, { type: 'signal', epoch: 1, payload: { kind: 'offer', sdp: SDP } }, LOCAL);
    expect(guest.last()).toEqual({ type: 'signal', epoch: 1, payload: { kind: 'offer', sdp: SDP } });
    registry.handle(guest, { type: 'signal', epoch: 1, payload: { kind: 'answer', sdp: SDP } }, PUBLIC);
    expect(host.last()).toEqual({ type: 'signal', epoch: 1, payload: { kind: 'answer', sdp: SDP } });
  });

  it('ordem de papéis, epoch antigo, sem par e fora de sessão', () => {
    const { host, guest } = pair();
    registry.handle(guest, { type: 'signal', epoch: 1, payload: { kind: 'offer', sdp: SDP } }, PUBLIC);
    expect(guest.last()).toEqual({ type: 'error', code: 'unexpected-signal' });
    registry.handle(host, { type: 'signal', epoch: 0, payload: { kind: 'offer', sdp: SDP } }, LOCAL);
    expect(host.last()).toEqual({ type: 'error', code: 'stale-epoch' });
    const { host: lonely } = createSession('l');
    registry.handle(lonely, { type: 'signal', epoch: 0, payload: { kind: 'offer', sdp: SDP } }, LOCAL);
    expect(lonely.last()).toEqual({ type: 'error', code: 'no-peer' });
    const outsider = new FakeParticipant('o');
    registry.handle(outsider, { type: 'signal', epoch: 0, payload: { kind: 'offer', sdp: SDP } }, PUBLIC);
    expect(outsider.last()).toEqual({ type: 'error', code: 'not-in-session' });
  });
});

describe('desconexão, expiração e limpeza', () => {
  it('saída do último participante remove a sessão e revoga convites', () => {
    const { host, guest, sessionId } = pair();
    registry.disconnect(guest);
    registry.handle(host, { type: 'invite' }, LOCAL);
    const pending = host.lastOf('invite')!.token;
    registry.disconnect(host);
    expect(registry.inspect(sessionId)).toBeNull();
    const late = new FakeParticipant('late');
    registry.handle(late, { type: 'join', invite: pending }, PUBLIC);
    expect(late.last()).toEqual({ type: 'error', code: 'invite-invalid' });
  });

  it('sessão com um participante expira por inatividade; sessão com par não expira', () => {
    const { host: lone } = createSession('lone');
    const { host } = pair();
    clock += 60_001;
    registry.sweep();
    expect(lone.last()).toEqual({ type: 'session-closed', reason: 'expired' });
    expect(registry.sessionOf(lone)).toBeNull();
    expect(registry.sessionOf(host)).not.toBeNull();
  });

  it('closeAll avisa todos e esvazia o registro', () => {
    const { host, guest } = pair();
    registry.closeAll();
    expect(host.last()).toEqual({ type: 'session-closed', reason: 'server-shutdown' });
    expect(guest.last()).toEqual({ type: 'session-closed', reason: 'server-shutdown' });
    expect(registry.sessionCount).toBe(0);
  });
});

describe('logs', () => {
  it('não contêm SDP, chave do operador, convites nem o ID completo da sessão', () => {
    const { host, sessionId, invite } = pair();
    registry.handle(host, { type: 'signal', epoch: 1, payload: { kind: 'offer', sdp: SDP } }, LOCAL);
    registry.handle(new FakeParticipant('x'), { type: 'create', operatorKey: 'X'.repeat(43) }, LOCAL);
    const all = logs.join('\n');
    for (const secret of ['v=0', KEY, 'X'.repeat(43), invite, sessionId]) expect(all).not.toContain(secret);
    expect(all).toContain(shortId(sessionId));
    expect(all).toContain('falha de autorização (unauthorized)');
  });
});

describe('TokenBucket', () => {
  it('permite a rajada configurada, bloqueia e repõe com o tempo', () => {
    let now = 0;
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 2, now: () => now });
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, true, false]);
    now += 500;
    expect([bucket.take(), bucket.take()]).toEqual([true, false]);
  });
});
