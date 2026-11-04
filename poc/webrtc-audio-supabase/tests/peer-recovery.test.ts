// Recuperação depois de falha de ICE, queda abrupta do par e `bye` perdido. Antes, a falha de ICE era fatal em
// cerca de 17-18 s (antes do batimento de 30 s) e um par fantasma bloqueava a reconexão por até 90 s.
// Usa só o que já existe no contrato: restart-request (`ice-failed` pede, `renegotiate` responde), roster e batimento.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerCall, type CallDeps, type CallPhase } from '../src/web/call.ts';
import type { ServerMessage } from '../src/web/protocol.ts';
import { PEER_UNREACHABLE, disconnectPhase } from '../src/web/rooms.ts';
import { DISCONNECT, SupabaseSignaling, pairEpoch, type SupabaseSignalingOptions } from '../src/web/supabase-signaling.ts';
import { FakePeerConnection, FakeStream, FakeSupabase, ROOM, USERS, settle } from './helpers/web-fakes.ts';

const STUN = [{ urls: ['stun:stun.l.google.com:19302'] }];
const LOW = '00000000-0000-4000-8000-0000000000a1';
const MID = '00000000-0000-4000-8000-0000000000b2';
const HIGH = '00000000-0000-4000-8000-0000000000c3';

let server: FakeSupabase;
const open: SupabaseSignaling[] = [];
const calls: PeerCall[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  server = new FakeSupabase();
});
afterEach(() => {
  for (const c of calls.splice(0)) c.end();
  for (const s of open.splice(0)) s.close();
  vi.clearAllTimers();
  vi.useRealTimers();
});

interface Client {
  s: SupabaseSignaling;
  messages: ServerMessage[];
  disconnects: number[];
  logs: string[];
  unreachable: number;
}

async function joined(user: string, over: Partial<SupabaseSignalingOptions> = {}): Promise<Client> {
  const c: Client = { s: undefined as unknown as SupabaseSignaling, messages: [], disconnects: [], logs: [], unreachable: 0 };
  c.s = new SupabaseSignaling({
    backend: server.backend(user),
    roomId: ROOM,
    selfUserId: user,
    handlers: { onMessage: (m) => c.messages.push(m), onDisconnected: (code) => c.disconnects.push(code), onInvalid: () => undefined },
    iceServers: STUN,
    log: (m) => c.logs.push(m),
    onPeerUnreachable: () => (c.unreachable += 1),
    ...over,
  });
  open.push(c.s);
  await c.s.connect();
  await settle();
  return c;
}

/** Sessão que entrou e parou de responder (aba que caiu): existe no banco, sem cliente nenhum por trás. */
async function ghost(user: string): Promise<string> {
  const res = await server.backend(user).rpc<{ session_id: string }[]>('join_room', { p_room_id: ROOM });
  await settle();
  return res.data![0]!.session_id;
}

const ofType = <T extends ServerMessage['type']>(c: Client, type: T) =>
  c.messages.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
const restarts = () => server.invokes.filter((r) => r.kind === 'restart-request').map((r) => (r.payload as { reason: string }).reason);

describe('SupabaseSignaling: par inalcançável', () => {
  it('par que caiu: vira suspeito, sem erro; o roster não o adota de novo enquanto ele não der sinal de vida', async () => {
    const a = await joined(USERS.owner);
    const g = await ghost(USERS.member);
    expect(a.s.currentPeer).toBe(g);
    const epoch = pairEpoch(a.s.session!, g);
    const adoptions = ofType(a, 'peer-joined').length;

    expect(a.s.peerUnreachable(epoch, 'ice-failed')).toBe(true);
    await settle();

    expect(ofType(a, 'peer-left')).toEqual([{ type: 'peer-left', epoch }]);
    expect(a.s.currentPeer).toBeNull();
    expect(a.unreachable).toBe(1);
    expect(restarts()).toEqual(['ice-failed']); // prova de vida pedida ao par
    await vi.advanceTimersByTimeAsync(30_000); // a sessão dele ainda consta como viva no roster
    expect(a.s.currentPeer).toBeNull();
    expect(ofType(a, 'peer-joined')).toHaveLength(adoptions);
    expect(a.disconnects).toEqual([]);
  });

  it('a sessão fantasma vence (90 s): é esquecida, sem erro e sem nova tentativa', async () => {
    const a = await joined(USERS.owner);
    const g = await ghost(USERS.member);
    a.s.peerUnreachable(pairEpoch(a.s.session!, g), 'ice-failed');
    await settle();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(a.logs).toContain('Par saiu (sessão vencida).');
    expect(a.s.currentPeer).toBeNull();
    expect(a.disconnects).toEqual([]);
    expect(restarts()).toEqual(['ice-failed']); // sem loop
  });

  it('reconexão não fica bloqueada: a nova sessão do par assume no lugar da fantasma', async () => {
    const a = await joined(USERS.owner);
    const g = await ghost(USERS.member);
    a.s.peerUnreachable(pairEpoch(a.s.session!, g), 'ice-failed');
    await settle();
    const b = await joined(USERS.member);
    expect(a.s.currentPeer).toBe(b.s.session);
    expect(ofType(a, 'peer-joined').at(-1)).toEqual(expect.objectContaining({ epoch: pairEpoch(a.s.session!, b.s.session!) }));
  });

  it('a nova sessão chegou antes da falha: assume assim que o par antigo é dado como inalcançável', async () => {
    const a = await joined(USERS.owner);
    const g = await ghost(USERS.member);
    const b = await joined(USERS.member);
    expect(a.logs).toContain('Terceira sessão na sala ignorada (1:1).');
    expect(a.s.currentPeer).toBe(g);
    a.s.peerUnreachable(pairEpoch(a.s.session!, g), 'ice-failed');
    await settle();
    expect(a.s.currentPeer).toBe(b.s.session);
  });

  it('offer ignorada enquanto havia fantasma: quem responde pede a offer de novo ao assumir', async () => {
    server.nextSessionIds = [MID, HIGH, LOW]; // dono no meio; a nova sessão do membro é a iniciadora
    const a = await joined(USERS.owner);
    const g = await ghost(USERS.member);
    const b = await joined(USERS.member);
    const epochAB = pairEpoch(a.s.session!, b.s.session!);
    b.s.send({ type: 'signal', epoch: epochAB, payload: { kind: 'offer', sdp: 'v=0\r\n' } });
    await settle();
    expect(a.logs).toContain('Sinal de terceira sessão ignorado (1:1).');
    const before = ofType(b, 'peer-joined').length;

    a.s.peerUnreachable(pairEpoch(a.s.session!, g), 'ice-failed');
    await settle();

    expect(a.s.currentPeer).toBe(b.s.session);
    expect(ofType(b, 'peer-joined')).toHaveLength(before + 1); // a iniciadora refaz a offer
  });

  it('par vivo, interrupção de um lado: pedido e resposta, os dois refazem o par uma vez, sem loop', async () => {
    const a = await joined(USERS.owner);
    const b = await joined(USERS.member);
    const epoch = pairEpoch(a.s.session!, b.s.session!);
    const bBefore = ofType(b, 'peer-joined').length;
    const aBefore = ofType(a, 'peer-joined').length;

    a.s.peerUnreachable(epoch, 'ice-failed');
    await settle();

    expect(restarts()).toEqual(['ice-failed', 'renegotiate']);
    expect(a.s.currentPeer).toBe(b.s.session);
    expect(b.s.currentPeer).toBe(a.s.session);
    expect(ofType(b, 'peer-left')).toEqual([{ type: 'peer-left', epoch }]);
    expect(ofType(a, 'peer-joined')).toHaveLength(aBefore + 1);
    expect(ofType(b, 'peer-joined')).toHaveLength(bBefore + 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(restarts()).toEqual(['ice-failed', 'renegotiate']);
    expect(server.liveSessions()).toHaveLength(2); // nenhuma sessão nova
  });

  it('os dois lados falham juntos: cada um adota o outro uma vez e ninguém responde a resposta', async () => {
    const a = await joined(USERS.owner);
    const b = await joined(USERS.member);
    const epoch = pairEpoch(a.s.session!, b.s.session!);
    const aBefore = ofType(a, 'peer-joined').length;
    const bBefore = ofType(b, 'peer-joined').length;
    a.s.peerUnreachable(epoch, 'ice-failed');
    b.s.peerUnreachable(epoch, 'ice-failed');
    await settle();
    expect(restarts()).toEqual(['ice-failed', 'ice-failed']);
    expect(ofType(a, 'peer-joined')).toHaveLength(aBefore + 1);
    expect(ofType(b, 'peer-joined')).toHaveLength(bBefore + 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(restarts()).toHaveLength(2);
  });

  it('orçamento: no máximo 2 recuperações por par; a 3ª devolve false; depois de 60 s, o orçamento volta', async () => {
    const a = await joined(USERS.owner);
    const b = await joined(USERS.member);
    const epoch = pairEpoch(a.s.session!, b.s.session!);
    expect(a.s.peerUnreachable(epoch, 'ice-failed')).toBe(true);
    await settle();
    expect(a.s.peerUnreachable(epoch, 'ice-failed')).toBe(true);
    await settle();
    const sent = restarts().length;
    expect(a.s.peerUnreachable(epoch, 'ice-failed')).toBe(false);
    await settle();
    expect(restarts()).toHaveLength(sent); // nada sai quando a recuperação é recusada
    await vi.advanceTimersByTimeAsync(61_000);
    expect(a.s.peerUnreachable(epoch, 'ice-failed')).toBe(true);
  });

  it('pedido de quem já esgotou o orçamento é ignorado: não há como forçar renegociação sem fim', async () => {
    const a = await joined(USERS.owner);
    const b = await joined(USERS.member);
    const epoch = pairEpoch(a.s.session!, b.s.session!);
    for (let i = 0; i < 2; i++) {
      a.s.peerUnreachable(epoch, 'ice-failed');
      await settle();
    }
    const leftBefore = ofType(b, 'peer-left').length;
    server.invokes.length = 0;
    await server.backend(USERS.owner).invokeSignal({ session_id: a.s.session!, to_session_id: b.s.session!, client_msg_id: crypto.randomUUID(), pair_epoch: epoch, kind: 'restart-request', payload: { reason: 'ice-failed' } });
    await settle();
    expect(ofType(b, 'peer-left')).toHaveLength(leftBefore);
    expect(restarts()).toEqual(['ice-failed']); // só o pedido; nenhuma resposta
  });

  it('epoch de outro par ou sem par: devolve false e não mexe em nada', async () => {
    const a = await joined(USERS.owner);
    expect(a.s.peerUnreachable(1, 'ice-failed')).toBe(false);
    const g = await ghost(USERS.member);
    expect(a.s.peerUnreachable(pairEpoch(a.s.session!, g) + 1, 'ice-failed')).toBe(false);
    expect(a.s.currentPeer).toBe(g);
    expect(a.unreachable).toBe(0);
  });

  it('sala encerrada com o bye perdido: a verificação imediata encerra com 4403, sem esperar o batimento', async () => {
    const a = await joined(USERS.owner);
    const g = await ghost(USERS.member);
    server.silent = true;
    server.closeRoom();
    await settle();
    expect(a.disconnects).toEqual([]);
    a.s.peerUnreachable(pairEpoch(a.s.session!, g), 'ice-failed');
    await settle();
    expect(a.disconnects).toEqual([DISCONNECT.session]); // uma vez só, mesmo com várias verificações
  });

  it('membro removido durante a falha: not-member no roster encerra com 4403', async () => {
    const a = await joined(USERS.owner);
    const g = await ghost(USERS.member);
    server.rpcFaults.set('get_roster', 'not-member');
    a.s.peerUnreachable(pairEpoch(a.s.session!, g), 'ice-failed');
    await settle();
    expect(a.disconnects).toEqual([DISCONNECT.session]);
  });

  it('bye do suspeito: é esquecido e não volta a ser esperado', async () => {
    const a = await joined(USERS.owner);
    const b = await joined(USERS.member);
    const epoch = pairEpoch(a.s.session!, b.s.session!);
    server.silent = true; // o pedido não chega a B
    a.s.peerUnreachable(epoch, 'ice-failed');
    await settle();
    server.silent = false;
    b.s.close();
    await b.s.closed;
    await settle();
    expect(a.logs).toContain('Par saiu (bye).');
    expect(a.s.currentPeer).toBeNull();
    expect(ofType(a, 'peer-left')).toHaveLength(1); // o PeerCall já tinha sido avisado
  });

  it('sinal de um suspeito prova que ele está vivo: volta a ser o par', async () => {
    const a = await joined(USERS.owner);
    const b = await joined(USERS.member);
    const epoch = pairEpoch(a.s.session!, b.s.session!);
    server.silent = true;
    a.s.peerUnreachable(epoch, 'ice-failed');
    await settle();
    server.silent = false;
    b.s.send({ type: 'signal', epoch, payload: { kind: 'candidate', candidate: null } });
    await settle();
    expect(a.s.currentPeer).toBe(b.s.session);
  });

  it('restart-request de terceira sessão ou com motivo `gap` não derruba o par atual', async () => {
    server.nextSessionIds = [LOW, MID, HIGH];
    const a = await joined(USERS.owner);
    const b = await joined(USERS.member);
    const third = await ghost(USERS.member);
    const left = ofType(a, 'peer-left').length;
    await server.backend(USERS.member).invokeSignal({ session_id: third, to_session_id: a.s.session!, client_msg_id: crypto.randomUUID(), pair_epoch: pairEpoch(a.s.session!, third), kind: 'restart-request', payload: { reason: 'ice-failed' } });
    await server.backend(USERS.member).invokeSignal({ session_id: b.s.session!, to_session_id: a.s.session!, client_msg_id: crypto.randomUUID(), pair_epoch: pairEpoch(a.s.session!, b.s.session!), kind: 'restart-request', payload: { reason: 'gap' } });
    await settle();
    expect(a.s.currentPeer).toBe(b.s.session);
    expect(ofType(a, 'peer-left')).toHaveLength(left);
  });
});

// ---------- ponta a ponta com o PeerCall ----------

interface Side {
  call: PeerCall;
  phases: CallPhase[];
  errors: string[];
  logs: string[];
  pcs: FakePeerConnection[];
}

function side(user: string): Side {
  const s: Side = { call: undefined as unknown as PeerCall, phases: [], errors: [], logs: [], pcs: [] };
  const deps: CallDeps = {
    getUserMedia: async () => new FakeStream() as unknown as MediaStream,
    createPeerConnection: (config) => {
      const pc = new FakePeerConnection(config);
      s.pcs.push(pc);
      return pc as unknown as RTCPeerConnection;
    },
    createSignaling: (handlers) => {
      const sig = new SupabaseSignaling({ backend: server.backend(user), roomId: ROOM, selfUserId: user, handlers, iceServers: STUN, log: (m) => s.logs.push(m) });
      open.push(sig);
      return sig;
    },
    iceMode: 'direct',
  };
  s.call = new PeerCall(deps, {
    onPhase: (phase, error) => {
      s.phases.push(phase);
      if (error) s.errors.push(error);
    },
    onSession: () => undefined,
    onInvite: () => undefined,
    onPeerStates: () => undefined,
    onLocalStream: () => undefined,
    onRemoteStream: () => undefined,
    onStats: () => undefined,
    onLog: (m) => s.logs.push(m),
  });
  calls.push(s.call);
  return s;
}

async function start(s: Side): Promise<void> {
  await s.call.start({ kind: 'room' });
  await settle();
}

function iceFails(s: Side): void {
  const pc = s.pcs.at(-1)!;
  pc.connectionState = 'failed';
  pc.onconnectionstatechange?.();
}

describe('PeerCall: falha de ICE não é mais fatal enquanto houver recuperação', () => {
  it('interrupção com os dois vivos: refaz o par e volta a conectar, sem erro e sem sessão nova', async () => {
    const owner = side(USERS.owner);
    const member = side(USERS.member);
    await start(owner);
    await start(member);
    expect([owner.call.phase, member.call.phase]).toEqual(['connected', 'connected']);
    const [o, m] = [owner.pcs.length, member.pcs.length];

    iceFails(owner);
    await settle(3000);

    expect([owner.call.phase, member.call.phase]).toEqual(['connected', 'connected']);
    expect(owner.pcs).toHaveLength(o + 1);
    expect(member.pcs).toHaveLength(m + 1);
    expect(owner.errors).toEqual([]);
    expect(member.errors).toEqual([]);
    expect(server.liveSessions()).toHaveLength(2);
  });

  it('queda real do par: fica aguardando, sem erro; a nova sessão do par conecta', async () => {
    const owner = side(USERS.owner);
    await start(owner);
    const member = side(USERS.member);
    await start(member);
    // Queda sem bye: o canal do membro some, a sessão continua viva no roster.
    const crashed = server.liveSessions(USERS.member)[0]!;
    server.topics.delete(`oryn:s:${crashed}`);
    iceFails(owner);
    await settle(3000);
    expect(owner.call.phase).toBe('waiting-peer');
    expect(owner.errors).toEqual([]);

    const back = side(USERS.member);
    await start(back);
    await settle(3000);
    expect(owner.call.phase).toBe('connected');
    expect(back.call.phase).toBe('connected');
  });

  it('entrar com só uma fantasma na sala: o tempo de negociação vence, fica aguardando, e o par real conecta', async () => {
    await ghost(USERS.member);
    const owner = side(USERS.owner);
    await start(owner);
    expect(owner.call.phase).toBe('negotiating');
    await vi.advanceTimersByTimeAsync(20_000);
    await settle();
    expect(owner.call.phase).toBe('waiting-peer');
    expect(owner.errors).toEqual([]);
    const member = side(USERS.member);
    await start(member);
    await settle(3000);
    expect(owner.call.phase).toBe('connected');
    expect(member.call.phase).toBe('connected');
  });

  it('sem caminho entre dois vivos: sem loop; esgotadas as tentativas, a falha de ICE aparece como antes', async () => {
    const owner = side(USERS.owner);
    const member = side(USERS.member);
    await start(owner);
    await start(member);
    for (let i = 0; i < 2; i++) {
      iceFails(owner);
      await settle(3000);
      expect(owner.call.phase).toBe('connected');
    }
    iceFails(owner);
    await settle(3000);
    expect(owner.call.phase).toBe('failed');
    expect(owner.errors.at(-1)).toBe('A conexão WebRTC falhou (nenhum par ICE funcionou).');
  });

  it('bye perdido com a sala encerrada: o 4403 chega logo depois da falha de ICE, sem esperar o batimento', async () => {
    const owner = side(USERS.owner);
    const member = side(USERS.member);
    await start(owner);
    await start(member);
    server.silent = true;
    server.closeRoom();
    await settle();
    iceFails(member);
    await settle();
    expect(member.call.phase).toBe('failed');
    expect(member.errors.at(-1)).toContain(`código ${DISCONNECT.session}`);
  });

  it('4403: o código continua no registro, mas sem o rótulo de erro; outros códigos continuam como erro', async () => {
    const owner = side(USERS.owner);
    const member = side(USERS.member);
    await start(owner);
    await start(member);
    server.closeRoom();
    await settle(3000);
    expect(member.logs.filter((l) => l.includes('4403'))).toEqual(['Desconexão: Conexão com a sinalização perdida (código 4403).']);
    expect(member.logs.some((l) => l.startsWith('Erro:'))).toBe(false);
  });
});

describe('apresentação', () => {
  it('fase depois do motivo confirmado: informação encerra; erro continua como falha', () => {
    expect(disconnectPhase({ tone: 'info', text: 'A sala foi encerrada pelo dono.' })).toBe('ended');
    expect(disconnectPhase({ tone: 'error', text: 'Esta conta não participa mais desta sala.' })).toBe('failed');
  });

  it('o aviso de par inalcançável é informativo e não cita código técnico', () => {
    expect(PEER_UNREACHABLE.tone).toBe('info');
    expect(PEER_UNREACHABLE.text).not.toMatch(/4\d{3}|código|erro/i);
  });
});
