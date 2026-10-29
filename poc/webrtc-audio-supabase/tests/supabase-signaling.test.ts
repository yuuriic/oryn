// SupabaseSignaling (02C, integração): adaptador do PeerCall sobre o backend Supabase. Backend em memória com
// o núcleo REAL da Edge Function (tests/helpers/web-fakes.ts). Sem rede.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SDP_LENGTH, parseSignalRequest, type SignalEnvelope } from '../supabase/functions/_shared/signal-contract.ts';
import type { ServerMessage, SignalPayload } from '../src/web/protocol.ts';
import { DISCONNECT, RateWindow, SupabaseSignaling, fromEnvelope, isInitiator, pairEpoch, toRequestPayload, type SupabaseSignalingOptions } from '../src/web/supabase-signaling.ts';
import { FakeSupabase, ROOM, USERS, settle } from './helpers/web-fakes.ts';

const STUN = [{ urls: ['stun:stun.l.google.com:19302'] }];
const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';
const C = '00000000-0000-4000-8000-0000000000c3';
const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const cand = (n: number): SignalPayload => ({ kind: 'candidate', candidate: { candidate: `candidate:${n} 1 udp 1 192.0.2.1 5000 typ host`, sdpMid: '0', sdpMLineIndex: 0 } });

interface Client {
  s: SupabaseSignaling;
  messages: ServerMessage[];
  disconnects: number[];
  logs: string[];
}

let server: FakeSupabase;
const open: SupabaseSignaling[] = [];

function client(user: string, over: Partial<SupabaseSignalingOptions> = {}): Client {
  const c: Client = { s: undefined as unknown as SupabaseSignaling, messages: [], disconnects: [], logs: [] };
  c.s = new SupabaseSignaling({
    backend: server.backend(user),
    roomId: ROOM,
    selfUserId: user,
    handlers: { onMessage: (m) => c.messages.push(m), onDisconnected: (code) => c.disconnects.push(code), onInvalid: () => undefined },
    iceServers: STUN,
    log: (m) => c.logs.push(m),
    ...over,
  });
  open.push(c.s);
  return c;
}

async function joined(user: string, over: Partial<SupabaseSignalingOptions> = {}): Promise<Client> {
  const c = client(user, over);
  await c.s.connect();
  await settle();
  return c;
}

const ofType = <T extends ServerMessage['type']>(c: Client, type: T) => c.messages.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
const rpcs = (user: string, fn: string) => server.calls.filter((x) => x.user === user && x.fn === fn);

beforeEach(() => {
  vi.useFakeTimers();
  server = new FakeSupabase();
});

afterEach(() => {
  for (const s of open.splice(0)) s.close();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('regras determinísticas (iniciador e pair_epoch)', () => {
  it('iniciador: exatamente um dos dois lados, a menor sessão; igual qualquer que seja a ordem', () => {
    expect(isInitiator(A, B)).toBe(true);
    expect(isInitiator(B, A)).toBe(false);
    expect(isInitiator(A, A)).toBe(false);
  });

  it('pair_epoch: simétrico, sem estado, em 1..2^31-1, e diferente para pares diferentes', () => {
    expect(pairEpoch(A, B)).toBe(pairEpoch(B, A));
    expect(pairEpoch(A, B)).toBe(pairEpoch(A, B));
    for (const e of [pairEpoch(A, B), pairEpoch(A, C), pairEpoch(B, C)]) {
      expect(Number.isSafeInteger(e) && e >= 1 && e <= 2_147_483_647).toBe(true);
    }
    expect(new Set([pairEpoch(A, B), pairEpoch(A, C), pairEpoch(B, C)]).size).toBe(3);
  });

  it('limite de taxa: libera até o máximo na janela e informa a espera do próximo', () => {
    let t = 0;
    const w = new RateWindow(3, 10_000, () => t);
    expect([w.take(), w.take(), w.take()]).toEqual([0, 0, 0]);
    expect(w.take()).toBe(10_000);
    t = 4_000;
    expect(w.take()).toBe(6_000);
    t = 10_000;
    expect(w.take()).toBe(0);
  });

  it('tradução PeerCall ⇄ contrato: offer, answer, candidato e fim de coleta passam na validação da Edge Function', () => {
    const payloads: SignalPayload[] = [{ kind: 'offer', sdp }, { kind: 'answer', sdp }, cand(1), { kind: 'candidate', candidate: null }];
    for (const p of payloads) {
      const req = { session_id: A, to_session_id: B, client_msg_id: C, pair_epoch: 7, ...toRequestPayload(p) };
      expect(parseSignalRequest(JSON.stringify(req)).ok, p.kind).toBe(true);
      const env = { v: 1, msg_id: C, seq: 1, from_session: A, from_user: USERS.owner, to_session: B, sent_at: new Date().toISOString(), ...req } as unknown as SignalEnvelope;
      expect(fromEnvelope(env)).toEqual(p);
    }
    expect(toRequestPayload({ kind: 'candidate', candidate: null }).kind).toBe('end-of-candidates');
    const restart = { kind: 'restart-request', payload: { reason: 'gap' } } as unknown as SignalEnvelope;
    expect(fromEnvelope(restart)).toBeNull();
  });
});

describe('entrada na sala e descoberta do par', () => {
  it('sozinho: join_room → canal privado da própria sessão → roster; session sem par, papel provisório', async () => {
    const a = await joined(USERS.owner);
    expect(server.calls.map((x) => x.fn)).toEqual(['join_room', 'get_roster']);
    expect(server.subscribers()).toBe(1);
    expect(a.messages).toEqual([{ type: 'session', sessionId: a.s.session, role: 'guest', epoch: 0, peerPresent: false }]);
  });

  it('dois participantes: papéis complementares e o MESMO epoch, por caminhos diferentes (hello × roster)', async () => {
    const a = await joined(USERS.owner);
    const b = await joined(USERS.member);
    const joinedMsg = ofType(a, 'peer-joined')[0]!;
    const session = ofType(b, 'session')[0]!;
    expect(session.peerPresent).toBe(true);
    expect(joinedMsg.epoch).toBe(session.epoch);
    expect(joinedMsg.epoch).toBe(pairEpoch(a.s.session!, b.s.session!));
    expect(new Set([joinedMsg.role, session.role])).toEqual(new Set(['host', 'guest']));
    expect(joinedMsg.role === 'host').toBe(isInitiator(a.s.session!, b.s.session!));
  });

  it('o iniciador é a menor sessão mesmo quando ela entra por ÚLTIMO', async () => {
    server.nextSessionIds = [B, A]; // owner entra com B, member depois com A (menor)
    const owner = await joined(USERS.owner);
    const member = await joined(USERS.member);
    expect(ofType(owner, 'peer-joined')[0]!.role).toBe('guest');
    expect(ofType(member, 'session')[0]!.role).toBe('host');
  });

  it('conta não membro e limite de 2 sessões: connect falha com mensagem clara, sem canal nem sessão', async () => {
    const stranger = client(USERS.stranger);
    await expect(stranger.s.connect()).rejects.toThrow('não é membro da sala');
    await joined(USERS.owner);
    await joined(USERS.owner);
    const third = client(USERS.owner);
    await expect(third.s.connect()).rejects.toThrow('2 sessões abertas');
    expect(server.subscribers()).toBe(2);
    expect(stranger.messages).toEqual([]);
  });

  it('canal privado recusado: connect falha e a sessão aberta é encerrada (leave_room)', async () => {
    server.refuseChannels = true;
    const a = client(USERS.owner);
    await expect(a.s.connect()).rejects.toThrow('Canal privado da sessão recusado');
    await settle();
    expect(rpcs(USERS.owner, 'leave_room')).toHaveLength(1);
    expect(server.liveSessions()).toEqual([]);
  });

  it('outra aba da PRÓPRIA conta nunca vira par (roster is_self); sinal da própria conta é ignorado', async () => {
    const a = await joined(USERS.owner);
    const a2 = await joined(USERS.owner);
    expect(ofType(a, 'peer-joined')).toEqual([]);
    expect(ofType(a2, 'session')[0]!.peerPresent).toBe(false);
    // Mesmo um envelope VÁLIDO do servidor, vindo da outra sessão da mesma conta, é ignorado.
    const handlers = [...server.topics.get(`oryn:s:${a.s.session}`)!][0]!;
    handlers.onBroadcast('signal', { v: 1, msg_id: C, seq: 1, from_session: a2.s.session, from_user: USERS.owner, to_session: a.s.session, sent_at: new Date().toISOString(), kind: 'offer', pair_epoch: 1, payload: { sdp } });
    expect(a.s.counters.ignored).toBe(1);
    expect(ofType(a, 'signal')).toEqual([]);
  });

  it('1:1: uma terceira conta é ignorada enquanto há par; assume depois do bye do par', async () => {
    server.members.set(USERS.stranger, 'it-stranger');
    const a = await joined(USERS.owner);
    const b = await joined(USERS.member);
    const c = await joined(USERS.stranger);
    const bSid = b.s.session!;
    expect(a.s.currentPeer).toBe(bSid);
    expect(a.logs).toContain('Terceira sessão na sala ignorada (1:1).');
    b.s.close();
    await b.s.closed;
    await settle();
    expect(ofType(a, 'peer-left')).toEqual([{ type: 'peer-left', epoch: pairEpoch(a.s.session!, bSid) }]);
    expect(a.s.currentPeer).toBe(c.s.session);
    expect(ofType(a, 'peer-joined').at(-1)!.epoch).toBe(pairEpoch(a.s.session!, c.s.session!));
  });

  it('sinal que chega antes da descoberta inicial é guardado: `session` vem antes, e o par não é adotado em dobro', async () => {
    const b = await joined(USERS.member);
    const a = client(USERS.owner);
    await a.s.connect(); // roster inicial de A ainda pendente
    const handlers = [...server.topics.get(`oryn:s:${a.s.session}`)!][0]!;
    const epoch = pairEpoch(a.s.session!, b.s.session!);
    handlers.onBroadcast('signal', { v: 1, msg_id: C, seq: 1, from_session: b.s.session, from_user: USERS.member, to_session: a.s.session, sent_at: new Date().toISOString(), kind: 'offer', pair_epoch: epoch, payload: { sdp } });
    expect(a.messages).toEqual([]);
    await settle();
    expect(a.messages.map((m) => m.type)).toEqual(['session', 'signal']);
    expect(ofType(a, 'session')[0]).toMatchObject({ peerPresent: true, epoch });
  });
});

describe('envio e recepção de sinais (Edge Function `signal`, nunca Broadcast do cliente)', () => {
  async function pair() {
    const a = await joined(USERS.owner);
    const b = await joined(USERS.member);
    return { a, b, epoch: pairEpoch(a.s.session!, b.s.session!) };
  }

  it('o pedido leva a sessão própria e a do par; o envelope do servidor chega como `signal` com o epoch do par', async () => {
    const { a, b, epoch } = await pair();
    expect(a.s.send({ type: 'signal', epoch, payload: { kind: 'offer', sdp } })).toBe(true);
    await settle();
    const req = server.invokes[0]!;
    expect(req).toMatchObject({ session_id: a.s.session, to_session_id: b.s.session, kind: 'offer', pair_epoch: epoch, payload: { sdp } });
    expect(Object.keys(req).sort()).toEqual(['client_msg_id', 'kind', 'pair_epoch', 'payload', 'session_id', 'to_session_id']); // sem remetente
    expect(server.published[0]!.from_user).toBe(USERS.owner);
    expect(ofType(b, 'signal')).toEqual([{ type: 'signal', epoch, payload: { kind: 'offer', sdp } }]);
  });

  it('candidatos um a um, em ordem (fila serial), e fim da coleta como candidate null', async () => {
    const { a, b, epoch } = await pair();
    for (const p of [{ kind: 'offer', sdp }, cand(1), cand(2), { kind: 'candidate', candidate: null }] as SignalPayload[]) a.s.send({ type: 'signal', epoch, payload: p });
    await settle(2000);
    expect(server.invokes.map((r) => r.kind)).toEqual(['offer', 'candidate', 'candidate', 'end-of-candidates']);
    expect(server.published.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(ofType(b, 'signal').map((m) => (m.payload.kind === 'candidate' ? `c:${m.payload.candidate?.candidate.slice(10, 11) ?? 'fim'}` : m.payload.kind))).toEqual(['offer', 'c:1', 'c:2', 'c:fim']);
  });

  it('entrega duplicada (pelo menos uma vez) é descartada por msg_id', async () => {
    server.duplicateDeliveries = true;
    const { a, b, epoch } = await pair();
    a.s.send({ type: 'signal', epoch, payload: { kind: 'offer', sdp } });
    a.s.send({ type: 'signal', epoch, payload: cand(1) });
    await settle(2000);
    expect(ofType(b, 'signal')).toHaveLength(2);
    expect(b.s.counters.duplicates).toBe(2);
  });

  it('falha transitória (503 e rede) é repetida com o MESMO client_msg_id; um único envelope publicado', async () => {
    const { a, b, epoch } = await pair();
    server.invokeFaults = [{ status: 503, body: { error: 'publish-failed', retryable: true } }, 'network'];
    a.s.send({ type: 'signal', epoch, payload: { kind: 'offer', sdp } });
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(server.invokes).toHaveLength(3);
    expect(new Set(server.invokes.map((r) => r.client_msg_id)).size).toBe(1);
    expect(server.published).toHaveLength(1);
    expect(ofType(b, 'signal')).toHaveLength(1);
    expect(a.s.counters.sent).toBe(1);
  });

  it('erro definitivo (403 recipient-invalid) não é repetido; 401 encerra a sinalização (autenticação)', async () => {
    const { a, epoch } = await pair();
    server.invokeFaults = [{ status: 403, body: { error: 'recipient-invalid', retryable: false } }];
    a.s.send({ type: 'signal', epoch, payload: { kind: 'offer', sdp } });
    await settle();
    expect(server.invokes).toHaveLength(1);
    expect(a.s.counters.sendFailed).toBe(1);
    expect(a.disconnects).toEqual([]);
    server.invokeFaults = [{ status: 401, body: { error: 'unauthorized', retryable: false } }];
    a.s.send({ type: 'signal', epoch, payload: cand(1) });
    await settle();
    expect(a.disconnects).toEqual([DISCONNECT.auth]);
    expect(rpcs(USERS.owner, 'leave_room')).toHaveLength(1);
  });

  it('limite de taxa local: acima do máximo na janela, o envio ESPERA (nada é descartado)', async () => {
    const a = await joined(USERS.owner, { rateMax: 3, rateWindowMs: 10_000 });
    const b = await joined(USERS.member);
    const epoch = pairEpoch(a.s.session!, b.s.session!);
    for (let i = 1; i <= 5; i++) a.s.send({ type: 'signal', epoch, payload: cand(i) });
    await settle(2000);
    expect(server.invokes).toHaveLength(3);
    expect(a.s.queued).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    await settle(2000);
    expect(server.invokes).toHaveLength(5);
    expect(ofType(b, 'signal')).toHaveLength(5);
  });

  it('fila limitada; sinal de epoch errado, sem par ou fora do contrato (SDP grande) não sai', async () => {
    const lonely = await joined(USERS.owner);
    expect(lonely.s.send({ type: 'signal', epoch: 1, payload: { kind: 'offer', sdp } })).toBe(false); // sem par
    lonely.s.close();
    const a = await joined(USERS.owner, { maxQueue: 2, rateMax: 1 });
    const b = await joined(USERS.member);
    const epoch = pairEpoch(a.s.session!, b.s.session!);
    expect(a.s.send({ type: 'signal', epoch: epoch + 1, payload: cand(1) })).toBe(false);
    expect(a.s.send({ type: 'signal', epoch, payload: { kind: 'offer', sdp: `v=0${'x'.repeat(MAX_SDP_LENGTH)}` } })).toBe(false);
    expect(a.s.send({ type: 'signal', epoch, payload: cand(1) })).toBe(true); // sai já (rateMax 1)
    await settle();
    expect(a.s.send({ type: 'signal', epoch, payload: cand(2) })).toBe(true);
    expect(a.s.send({ type: 'signal', epoch, payload: cand(3) })).toBe(true);
    expect(a.s.send({ type: 'signal', epoch, payload: cand(4) })).toBe(false); // fila cheia (2)
    expect(server.invokes.map((r) => r.kind)).toEqual(['candidate']);
  });

  it('acks em lote (ack_signals) depois da entrega', async () => {
    const { a, b, epoch } = await pair();
    a.s.send({ type: 'signal', epoch, payload: { kind: 'offer', sdp } });
    a.s.send({ type: 'signal', epoch, payload: cand(1) });
    await settle(2000);
    // Pós-Rodada 2 (B1): o ack sai entre 1,5 e 2,5 s depois da entrega (antes ia no 1º ciclo de 1 s, a corrida).
    await vi.advanceTimersByTimeAsync(2_000);
    expect(rpcs(USERS.member, 'ack_signals')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    const acks = rpcs(USERS.member, 'ack_signals');
    expect(acks).toHaveLength(1);
    expect(acks[0]!.args['p_msg_ids']).toEqual(server.published.map((e) => e.msg_id));
    expect(b.s.counters.acked).toBe(2);
  });

  it('pedido de configuração ICE: respondido localmente só com STUN, sem credenciais', async () => {
    const a = await joined(USERS.owner);
    expect(a.s.send({ type: 'ice-request', mode: 'direct' })).toBe(true);
    await settle();
    expect(ofType(a, 'ice-config')).toEqual([{ type: 'ice-config', mode: 'direct', iceServers: STUN, expiresAt: null }]);
    expect(a.s.send({ type: 'create', operatorKey: 'x' })).toBe(false);
  });
});

describe('batimento e par que cai', () => {
  it('touch_session a cada 30 s; session-invalid encerra (4403)', async () => {
    const a = await joined(USERS.owner);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rpcs(USERS.owner, 'touch_session')).toHaveLength(2);
    server.rpcFaults.set('touch_session', 'session-invalid');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(a.disconnects).toEqual([DISCONNECT.session]);
  });

  it('uma falha genérica é tolerada; duas seguidas encerram (4408); um sucesso zera a contagem', async () => {
    const a = await joined(USERS.owner);
    server.rpcFaults.set('touch_session', 'erro de rede qualquer');
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000); // sucesso
    server.rpcFaults.set('touch_session', 'x');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(a.disconnects).toEqual([]);
    server.rpcFaults.set('touch_session', 'x');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(a.disconnects).toEqual([DISCONNECT.heartbeat]);
  });

  it('par que some sem bye (aba fechada): detectado pelo roster no batimento → peer-left', async () => {
    const a = await joined(USERS.owner);
    const b = await joined(USERS.member);
    const epoch = pairEpoch(a.s.session!, b.s.session!);
    server.expire(b.s.session!);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ofType(a, 'peer-left')).toEqual([{ type: 'peer-left', epoch }]);
    expect(a.s.currentPeer).toBeNull();
  });

  it('canal fechado pelo servidor encerra (4500); erro transitório do canal só é registrado', async () => {
    const a = await joined(USERS.owner);
    const handlers = [...server.topics.get(`oryn:s:${a.s.session}`)!][0]!;
    handlers.onStatus('CHANNEL_ERROR');
    expect(a.disconnects).toEqual([]);
    handlers.onStatus('CLOSED');
    expect(a.disconnects).toEqual([DISCONNECT.channel]);
  });
});

describe('encerramento', () => {
  it('close(): idempotente; sai da sala uma vez (bye ao par), remove o canal, para timers e descarta a fila', async () => {
    const a = await joined(USERS.owner, { rateMax: 1 });
    const b = await joined(USERS.member);
    const epoch = pairEpoch(a.s.session!, b.s.session!);
    for (let i = 1; i <= 3; i++) a.s.send({ type: 'signal', epoch, payload: cand(i) });
    await settle();
    b.s.close();
    await b.s.closed;
    a.s.close();
    a.s.close();
    await a.s.closed;
    expect(rpcs(USERS.owner, 'leave_room')).toHaveLength(1);
    expect(server.subscribers()).toBe(0);
    expect(server.liveSessions()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(a.s.queued).toBe(0);
    expect(a.s.send({ type: 'signal', epoch, payload: cand(9) })).toBe(false);
    const before = a.messages.length;
    await settle();
    expect(a.messages.length).toBe(before); // nada é emitido depois de fechar
  });

  it('bye do par → peer-left com o epoch do par; sinais ainda na fila para ele são descartados', async () => {
    const a = await joined(USERS.owner, { rateMax: 1 });
    const b = await joined(USERS.member);
    const epoch = pairEpoch(a.s.session!, b.s.session!);
    for (let i = 1; i <= 3; i++) a.s.send({ type: 'signal', epoch, payload: cand(i) });
    await settle();
    b.s.close();
    await b.s.closed;
    await settle();
    expect(ofType(a, 'peer-left')).toEqual([{ type: 'peer-left', epoch }]);
    expect(a.s.queued).toBe(0);
    expect(a.s.counters.dropped).toBeGreaterThanOrEqual(2);
  });

  it('close() durante a entrada: a sessão aberta depois é encerrada e nenhum canal fica assinado', async () => {
    const a = client(USERS.owner);
    const connecting = a.s.connect();
    a.s.close();
    await connecting;
    await settle();
    expect(server.liveSessions()).toEqual([]);
    expect(server.subscribers()).toBe(0);
    expect(a.messages).toEqual([]);
  });
});

describe('MVP 01: sala encerrada (close_room) e not-member no roster', () => {
  it('encerramento com os dois na sala: bye → peer-left → roster not-member → 4403 nos dois lados, sem esperar o batimento', async () => {
    const a = await joined(USERS.owner);
    const b = await joined(USERS.member);
    const epoch = pairEpoch(a.s.session!, b.s.session!);
    server.closeRoom();
    await settle();
    for (const c of [a, b]) {
      expect(ofType(c, 'peer-left')).toEqual([{ type: 'peer-left', epoch }]);
      expect(c.disconnects).toEqual([DISCONNECT.session]);
    }
    // Nenhum batimento foi necessário; a saída (leave_room) da sessão já revogada não dá erro.
    expect(rpcs(USERS.owner, 'touch_session')).toHaveLength(0);
    expect(a.logs.some((l) => /Saída da sala não confirmada/.test(l))).toBe(false);
  });

  it('bye perdido: o batimento encontra a sessão revogada (session-invalid) e encerra com 4403 em até 30 s', async () => {
    const a = await joined(USERS.owner);
    await joined(USERS.member);
    server.silent = true;
    server.closeRoom();
    await settle();
    expect(a.disconnects).toEqual([]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(a.disconnects).toEqual([DISCONNECT.session]);
  });

  it('roster do batimento com not-member (batimento ainda aceito) → 4403', async () => {
    const a = await joined(USERS.owner);
    await joined(USERS.member);
    server.rpcFaults.set('get_roster', 'not-member');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(a.disconnects).toEqual([DISCONNECT.session]);
  });

  it('roster inicial com not-member (sala encerrada logo depois da entrada) → 4403, sem `session`', async () => {
    server.rpcFaults.set('get_roster', 'not-member');
    const a = await joined(USERS.owner);
    expect(a.disconnects).toEqual([DISCONNECT.session]);
    expect(ofType(a, 'session')).toEqual([]);
  });

  it('só o código EXATO: outras falhas do roster (JWT, rede, texto parecido) não encerram', async () => {
    for (const fault of ['JWT expired', 'erro de rede', 'not-member-x', 'unauthorized']) {
      server = new FakeSupabase();
      const a = await joined(USERS.owner);
      await joined(USERS.member);
      server.rpcFaults.set('get_roster', fault);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(a.disconnects, fault).toEqual([]);
      expect(a.s.currentPeer, fault).not.toBeNull();
      a.s.close();
    }
  });

  it('regressão de peer-left: o par só sai da chamada (leave) → peer-left, sem desconexão, e segue esperando', async () => {
    const a = await joined(USERS.owner);
    const b = await joined(USERS.member);
    b.s.close();
    await b.s.closed;
    await settle();
    expect(ofType(a, 'peer-left')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(a.disconnects).toEqual([]);
    // Volta a entrar: vira par de novo (o primeiro peer-joined foi o da entrada inicial).
    await joined(USERS.member);
    expect(ofType(a, 'peer-joined')).toHaveLength(2);
    expect(a.disconnects).toEqual([]);
  });
});

describe('Pós-Rodada 2 (B1): ack atrasado e repetição limitada', () => {
  /** A (owner) envia `n` sinais a B (member); B usa as opções dadas. Devolve os msg_ids na ordem de envio. */
  async function scenario(n: number, overB: Partial<SupabaseSignalingOptions> = {}) {
    const a = await joined(USERS.owner);
    const b = await joined(USERS.member, overB);
    const epoch = pairEpoch(a.s.session!, b.s.session!);
    for (let i = 0; i < n; i++) a.s.send({ type: 'signal', epoch, payload: i === 0 ? { kind: 'offer', sdp } : cand(i) });
    await settle(2000);
    return { a, b, ids: () => server.published.map((e) => e.msg_id) };
  }
  const acks = () => rpcs(USERS.member, 'ack_signals');
  const states = (ids: string[]) => ids.map((id) => server.signalStates()[id]);

  it('CONTROLE (política antiga: ack no 1º ciclo, sem repetir): com `published` atrasado, o sinal fica preso em published', async () => {
    server.publishedLagMs = 1_200;
    const { b, ids } = await scenario(1, { ackDelayMs: 0, ackMaxAttempts: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(states(ids())).toEqual(['published']); // a corrida da Rodada 2, reproduzida
    expect(acks()).toHaveLength(1);
    expect(b.s.counters.acked).toBe(0);
    expect(b.s.counters.ackGivenUp).toBe(1);
  });

  it('ack antes de `published` (mesmo atraso de 1,2 s): com a correção, confirmado numa única chamada', async () => {
    server.publishedLagMs = 1_200;
    const { b, ids } = await scenario(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(states(ids())).toEqual(['acknowledged']);
    expect(acks()).toHaveLength(1);
    expect(b.s.counters).toMatchObject({ acked: 1, ackRetries: 0, ackGivenUp: 0 });
  });

  it('ack depois de `published` (sem atraso): uma chamada, sem repetição', async () => {
    const { b, ids } = await scenario(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(states(ids())).toEqual(['acknowledged', 'acknowledged']);
    expect(acks()).toHaveLength(1);
    expect(acks()[0]!.args['p_msg_ids']).toEqual(ids());
    expect(b.s.counters).toMatchObject({ acked: 2, ackRetries: 0 });
  });

  it('latência maior que a janela (6 s): zero, zero, confirmado — 3 chamadas, espera crescente', async () => {
    server.publishedLagMs = 6_000;
    const { b, ids } = await scenario(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(acks()).toHaveLength(1); // 1ª tentativa (t≈3 s): ainda publishing → 0
    await vi.advanceTimersByTimeAsync(2_000);
    expect(acks()).toHaveLength(2); // +2 s (t≈5 s): ainda publishing → 0
    await vi.advanceTimersByTimeAsync(3_000);
    expect(acks()).toHaveLength(2); // a próxima espera é de 4 s
    await vi.advanceTimersByTimeAsync(1_000);
    expect(acks()).toHaveLength(3); // t≈9 s: published (6 s) → 1
    expect(states(ids())).toEqual(['acknowledged']);
    expect(b.s.counters).toMatchObject({ acked: 1, ackRetries: 2, ackGivenUp: 0 });
  });

  it('latência acima do teto: desiste depois de 3 tentativas e não repete mais (amplificação limitada)', async () => {
    server.publishedLagMs = 60_000;
    const { b, ids } = await scenario(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(acks()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(acks()).toHaveLength(3);
    expect(states(ids())).toEqual(['published']);
    expect(b.s.counters).toMatchObject({ acked: 0, ackRetries: 2, ackGivenUp: 1 });
    expect(b.logs.some((l) => /sem retorno completo depois de 3 tentativas/.test(l))).toBe(true);
  });

  const logEntry = (id: string) => [...server.log.values()].find((l) => l.msg_id === id)!;
  const gaveUpLog = (c: Client) => c.logs.filter((l) => /sem retorno completo/.test(l));
  /** Cada lote tem ids fixos: duas chamadas ou repetem o mesmo conjunto, ou não têm id em comum. */
  function expectFixedDisjointBatches() {
    const sets = [...new Set(acks().map((c) => JSON.stringify(c.args['p_msg_ids'])))].map((s) => JSON.parse(s) as string[]);
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) expect(sets[i]!.filter((id) => sets[j]!.includes(id)), 'id em dois lotes').toEqual([]);
    }
    return sets;
  }

  it('cenário A+B: tentativa 1 conta 1, tentativa 2 conta 1 → lote completo, sem 3ª tentativa e sem desistência', async () => {
    const { b, ids } = await scenario(2);
    const [first, second] = ids() as [string, string];
    // Só o 2º sinal (B) ainda não chegou a `published` quando o 1º ack sai.
    logEntry(second).state = 'publishing';
    await vi.advanceTimersByTimeAsync(3_000);
    expect(acks()).toHaveLength(1); // tentativa 1 → 1 (A)
    expect(states([first, second])).toEqual(['acknowledged', 'publishing']);
    expect(b.s.counters).toMatchObject({ acked: 1, ackRetries: 2, ackGivenUp: 0 });
    logEntry(second).state = 'published';
    await vi.advanceTimersByTimeAsync(30_000);
    expect(acks()).toHaveLength(2); // tentativa 2 → 1 (B; A já confirmado não conta de novo); soma 2 = tamanho
    expect(states([first, second])).toEqual(['acknowledged', 'acknowledged']);
    for (const call of acks()) expect(call.args['p_msg_ids']).toEqual([first, second]);
    expect(b.s.counters).toMatchObject({ acked: 2, ackRetries: 2, ackGivenUp: 0 });
    expect(gaveUpLog(b)).toEqual([]);
  });

  it('lote parcial e depois esgotado: 1, 0, 0 → desiste só do id que faltou', async () => {
    const { b, ids } = await scenario(2);
    const [first, second] = ids() as [string, string];
    logEntry(second).state = 'publishing'; // nunca chega a `published`
    await vi.advanceTimersByTimeAsync(60_000);
    expect(acks()).toHaveLength(3);
    for (const call of acks()) expect(call.args['p_msg_ids']).toEqual([first, second]);
    expect(states([first, second])).toEqual(['acknowledged', 'publishing']);
    expect(b.s.counters).toMatchObject({ acked: 1, ackRetries: 4, ackGivenUp: 1 });
    expect(gaveUpLog(b)).toEqual(['1 confirmação(ões) de sinal sem retorno completo depois de 3 tentativas.']);
  });

  it('resposta SQL igual a zero em toda tentativa: 3 chamadas, desiste dos dois, nada depois', async () => {
    const ackArgs: string[][] = [];
    const real = server.backend(USERS.member);
    const backend = {
      ...real,
      rpc: <T,>(fn: string, args: Record<string, unknown>) => {
        if (fn !== 'ack_signals') return real.rpc<T>(fn, args);
        ackArgs.push(args['p_msg_ids'] as string[]);
        return Promise.resolve({ data: 0 as T, error: null });
      },
    };
    const a = await joined(USERS.owner);
    const b = await joined(USERS.member, { backend });
    const epoch = pairEpoch(a.s.session!, b.s.session!);
    a.s.send({ type: 'signal', epoch, payload: { kind: 'offer', sdp } });
    a.s.send({ type: 'signal', epoch, payload: cand(1) });
    await settle(2000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ackArgs).toHaveLength(3);
    for (const ids of ackArgs) expect(ids).toEqual(server.published.map((e) => e.msg_id));
    expect(b.s.counters).toMatchObject({ acked: 0, ackRetries: 4, ackGivenUp: 2 });
    expect(gaveUpLog(b)).toEqual(['2 confirmação(ões) de sinal sem retorno completo depois de 3 tentativas.']);
  });

  it('ids novos durante a repetição de um lote: entram num lote próprio; nenhum id em dois lotes; limite preservado', async () => {
    const { a, b, ids } = await scenario(1);
    const [x] = ids() as [string];
    logEntry(x).state = 'publishing';
    await vi.advanceTimersByTimeAsync(3_500); // lote [x]: tentativa 1 → 0, repetição agendada
    expect(acks()).toHaveLength(1);
    a.s.send({ type: 'signal', epoch: pairEpoch(a.s.session!, b.s.session!), payload: cand(7) });
    await vi.advanceTimersByTimeAsync(3_500); // y chega, espera a janela e sai sozinho; [x] repete (→ 0)
    const y = ids()[1]!;
    expect(states([x, y])).toEqual(['publishing', 'acknowledged']);
    logEntry(x).state = 'published';
    await vi.advanceTimersByTimeAsync(30_000); // [x] tentativa 3 → 1
    const sets = expectFixedDisjointBatches();
    expect(sets).toEqual([[x], [y]]);
    expect(acks().filter((c) => (c.args['p_msg_ids'] as string[]).includes(x))).toHaveLength(3);
    expect(acks().filter((c) => (c.args['p_msg_ids'] as string[]).includes(y))).toHaveLength(1);
    expect(states([x, y])).toEqual(['acknowledged', 'acknowledged']);
    expect(b.s.counters).toMatchObject({ acked: 2, ackRetries: 2, ackGivenUp: 0 });
    expect(gaveUpLog(b)).toEqual([]);
  });

  it('session-invalid no meio de um lote parcial: desiste só do que faltou, sem repetir', async () => {
    const { b, ids } = await scenario(2);
    const [first, second] = ids() as [string, string];
    logEntry(second).state = 'publishing';
    await vi.advanceTimersByTimeAsync(3_000); // tentativa 1 → 1
    server.rpcFaults.set('ack_signals', 'session-invalid');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(acks()).toHaveLength(2);
    expect(states([first, second])).toEqual(['acknowledged', 'publishing']);
    expect(b.s.counters).toMatchObject({ acked: 1, ackRetries: 2, ackGivenUp: 1 });
    expect(b.logs.some((l) => /session-invalid/.test(l))).toBe(true);
  });

  it('close() na espera de uma repetição: nenhum ack depois, e nenhum timer pendente', async () => {
    const { a, b, ids } = await scenario(2);
    logEntry(ids()[1]!).state = 'publishing';
    await vi.advanceTimersByTimeAsync(3_000); // parcial: repetição agendada
    expect(acks()).toHaveLength(1);
    b.s.close();
    a.s.close();
    await Promise.all([a.s.closed, b.s.closed]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(acks()).toHaveLength(1);
    expect(b.s.counters).toMatchObject({ acked: 1, ackGivenUp: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falha de rede no ack: repetida; session-invalid: descartada na hora, sem repetir', async () => {
    server.rpcFaults.set('ack_signals', 'erro de rede');
    const first = await scenario(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(states(first.ids())).toEqual(['acknowledged']);
    expect(acks()).toHaveLength(2);
    expect(first.b.logs.some((l) => /será repetida/.test(l))).toBe(true);

    server = new FakeSupabase();
    server.rpcFaults.set('ack_signals', 'session-invalid');
    const second = await scenario(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(acks()).toHaveLength(1);
    expect(second.b.s.counters).toMatchObject({ ackRetries: 0, ackGivenUp: 1 });
  });

  it('entrega duplicada: cada msg_id é confirmado uma vez só', async () => {
    server.duplicateDeliveries = true;
    const { b, ids } = await scenario(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(acks()).toHaveLength(1);
    expect(acks()[0]!.args['p_msg_ids']).toEqual(ids());
    expect(b.s.counters.acked).toBe(3);
    expect(b.s.counters.duplicates).toBeGreaterThan(0);
  });

  it('close() durante a espera: nenhum ack depois, e nenhum timer pendente', async () => {
    const { a, b } = await scenario(2);
    await vi.advanceTimersByTimeAsync(1_000); // antes da janela de 1,5 s
    b.s.close();
    a.s.close();
    await Promise.all([a.s.closed, b.s.closed]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(acks()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('close() durante um ack em curso: a resposta atrasada não reagenda nada', async () => {
    let releaseAck!: (r: { data: number | null; error: string | null }) => void;
    let ackCalls = 0;
    const real = server.backend(USERS.member);
    const backend = {
      ...real,
      rpc: <T,>(fn: string, args: Record<string, unknown>) => {
        if (fn !== 'ack_signals') return real.rpc<T>(fn, args);
        ackCalls += 1;
        return new Promise((resolve) => (releaseAck = resolve as never)) as never;
      },
    };
    const a = await joined(USERS.owner);
    const b = await joined(USERS.member, { backend });
    a.s.send({ type: 'signal', epoch: pairEpoch(a.s.session!, b.s.session!), payload: { kind: 'offer', sdp } });
    await settle(2000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(ackCalls).toBe(1); // em curso
    b.s.close();
    releaseAck({ data: 0, error: null }); // "zero" chega depois do close
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ackCalls).toBe(1);
    expect(b.s.counters).toMatchObject({ ackRetries: 0, ackGivenUp: 0 });
  });
});
