// Registro e estados da sinalização no banco (02C.1A): remetente/destinatário validados no servidor,
// tentativa de forjar remetente, idempotência por client_msg_id, sequência por par, limites, transições de
// publicação (accepted → publishing → published | failed) e confirmação (acknowledged) pelo destinatário.
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestDb } from './helpers/db.ts';
import { createRoom, joinWithInvite, openSession, scenario, signalArgs, type Scenario } from './helpers/fixtures.ts';

let db: TestDb;
let s: Scenario;
beforeEach(async () => {
  db = await TestDb.create();
  s = await scenario(db);
});
afterEach(() => db.close());

type Auth = { msg_id: string; seq: number; from_user: string; room_id: string; state: string; duplicate: boolean };
const authorize = async (actor: { uid: string }, args: Record<string, unknown>): Promise<Auth> =>
  (await db.rpc<Auth>(actor, 'public.authorize_signal', args))[0]!;
const setState = async (msgId: string, state: string) => (await db.rpc<{ set_signal_state: string }>('service', 'public.set_signal_state', { p_msg_id: msgId, p_state: state }))[0]!.set_signal_state;
const setStateError = (msgId: string, state: string) => db.rpcError('service', 'public.set_signal_state', { p_msg_id: msgId, p_state: state });

describe('remetente e destinatário validados pelo servidor', () => {
  it('aceita sessão própria → destino vivo da mesma sala; remetente vem do JWT', async () => {
    const r = await authorize(s.member, signalArgs(s.memberSession, s.ownerSession));
    expect(r).toMatchObject({ seq: 1, state: 'accepted', duplicate: false, from_user: s.member.uid, room_id: s.room });
  });

  it('forjar remetente: usar a sessão de OUTRO usuário como origem → session-invalid', async () => {
    expect(await db.rpcError(s.member, 'public.authorize_signal', signalArgs(s.ownerSession, s.memberSession))).toBe('session-invalid');
  });

  it('acesso entre salas: destino em outra sala → recipient-invalid (mesmo sendo o mesmo dono)', async () => {
    const other = await createRoom(db, s.owner, 3, 'Outra');
    const outsider = await joinWithInvite(db, other, s.owner, 'Fora');
    const outsiderSession = await openSession(db, outsider, other);
    expect(await db.rpcError(s.owner, 'public.authorize_signal', signalArgs(s.ownerSession, outsiderSession))).toBe('recipient-invalid');
    expect(await db.rpcError(outsider, 'public.authorize_signal', signalArgs(outsiderSession, s.ownerSession))).toBe('recipient-invalid');
  });

  it('destino inexistente, encerrado ou sem batimento → recipient-invalid; origem encerrada → session-invalid', async () => {
    expect(await db.rpcError(s.member, 'public.authorize_signal', signalArgs(s.memberSession, randomUUID()))).toBe('recipient-invalid');
    await db.rpc(s.owner, 'public.leave_room', { p_session_id: s.ownerSession });
    expect(await db.rpcError(s.member, 'public.authorize_signal', signalArgs(s.memberSession, s.ownerSession))).toBe('recipient-invalid');
    await db.rpc(s.member, 'public.leave_room', { p_session_id: s.memberSession });
    expect(await db.rpcError(s.member, 'public.authorize_signal', signalArgs(s.memberSession, s.ownerSession))).toBe('session-invalid');
  });

  it('usuário sem sessão na sala (estranho) → session-invalid', async () => {
    const stranger = await db.newUser();
    expect(await db.rpcError(stranger, 'public.authorize_signal', signalArgs(s.memberSession, s.ownerSession))).toBe('session-invalid');
  });
});

describe('validação de argumentos e limites', () => {
  it.each([
    ['tamanho zero', { p_payload_bytes: 0 }],
    ['acima de 16 KiB', { p_payload_bytes: 16_385 }],
    ['tipo desconhecido', { p_kind: 'relay-audio' }],
    ['epoch negativo', { p_pair_epoch: -1 }],
    ['client_msg_id nulo', { p_client_msg_id: null }],
  ])('%s → invalid-argument', async (_name, over) => {
    expect(await db.rpcError(s.member, 'public.authorize_signal', signalArgs(s.memberSession, s.ownerSession, over))).toBe('invalid-argument');
  });

  it('origem igual ao destino → invalid-argument', async () => {
    expect(await db.rpcError(s.member, 'public.authorize_signal', signalArgs(s.memberSession, s.memberSession))).toBe('invalid-argument');
  });

  it('limite de taxa: 40 mensagens em 10 s por sessão; a 41ª é recusada', async () => {
    for (let i = 0; i < 40; i++) await authorize(s.member, signalArgs(s.memberSession, s.ownerSession, { p_kind: 'candidate', p_payload_bytes: 200 }));
    expect(await db.rpcError(s.member, 'public.authorize_signal', signalArgs(s.memberSession, s.ownerSession))).toBe('rate-limited');
  });
});

describe('idempotência e sequência', () => {
  it('repetir client_msg_id com os mesmos dados devolve o MESMO msg_id/seq e não cria nova linha', async () => {
    const args = signalArgs(s.memberSession, s.ownerSession);
    const a = await authorize(s.member, args);
    const b = await authorize(s.member, args);
    expect(b).toMatchObject({ msg_id: a.msg_id, seq: a.seq, duplicate: true, state: 'accepted' });
    expect((await db.admin<{ n: number }>('select count(*)::int as n from oryn.signal_log'))[0]!.n).toBe(1);
  });

  it('repetir client_msg_id com dados diferentes → idempotency-conflict', async () => {
    const args = signalArgs(s.memberSession, s.ownerSession);
    await authorize(s.member, args);
    expect(await db.rpcError(s.member, 'public.authorize_signal', { ...args, p_kind: 'answer' })).toBe('idempotency-conflict');
    expect(await db.rpcError(s.member, 'public.authorize_signal', { ...args, p_payload_bytes: 901 })).toBe('idempotency-conflict');
  });

  it('o mesmo client_msg_id em sessões diferentes são mensagens diferentes', async () => {
    const id = randomUUID();
    const a = await authorize(s.member, signalArgs(s.memberSession, s.ownerSession, { p_client_msg_id: id }));
    const b = await authorize(s.owner, signalArgs(s.ownerSession, s.memberSession, { p_client_msg_id: id, p_kind: 'answer' }));
    expect(a.msg_id).not.toBe(b.msg_id);
  });

  it('seq é por par remetente→destino, crescente e independente por direção', async () => {
    const seqs = [];
    for (let i = 0; i < 3; i++) seqs.push((await authorize(s.member, signalArgs(s.memberSession, s.ownerSession))).seq);
    expect(seqs).toEqual([1, 2, 3]);
    expect((await authorize(s.owner, signalArgs(s.ownerSession, s.memberSession))).seq).toBe(1);
  });

  it('o registro nunca guarda payload: só tipo, epoch, seq e tamanho', async () => {
    await authorize(s.member, signalArgs(s.memberSession, s.ownerSession));
    const row = (await db.admin<Record<string, unknown>>('select * from oryn.signal_log'))[0]!;
    expect(Object.keys(row).sort()).toEqual(['attempts', 'client_msg_id', 'created_at', 'kind', 'msg_id', 'pair_epoch', 'payload_bytes', 'seq', 'session_id', 'state', 'to_session_id', 'updated_at']);
  });
});

describe('estados de publicação e confirmação', () => {
  it('caminho feliz: accepted → publishing → published → acknowledged (pelo destinatário)', async () => {
    const r = await authorize(s.member, signalArgs(s.memberSession, s.ownerSession));
    expect(await setState(r.msg_id, 'publishing')).toBe('publishing');
    expect(await setState(r.msg_id, 'published')).toBe('published');
    expect(await setState(r.msg_id, 'published')).toBe('published'); // idempotente
    expect((await db.rpc<{ ack_signals: number }>(s.owner, 'public.ack_signals', { p_session_id: s.ownerSession, p_msg_ids: [r.msg_id] }))[0]!.ack_signals).toBe(1);
    expect((await db.admin<{ state: string }>('select state from oryn.signal_log'))[0]!.state).toBe('acknowledged');
  });

  it('falha entre registro e publicação: a repetição devolve o estado e permite republicar com o mesmo msg_id', async () => {
    const args = signalArgs(s.memberSession, s.ownerSession);
    const r = await authorize(s.member, args);
    // 1ª execução morreu depois de registrar (accepted) e antes de publicar.
    const again = await authorize(s.member, args);
    expect(again).toMatchObject({ msg_id: r.msg_id, duplicate: true, state: 'accepted' });
    expect(await setState(r.msg_id, 'publishing')).toBe('publishing');
    // 2ª execução morreu durante a publicação: publishing → publishing é aceito como retentativa.
    expect(await setState(r.msg_id, 'publishing')).toBe('publishing');
    expect(await setState(r.msg_id, 'failed')).toBe('failed');
    expect(await setState(r.msg_id, 'publishing')).toBe('publishing');
    expect(await setState(r.msg_id, 'published')).toBe('published');
    expect((await db.admin<{ attempts: number }>('select attempts from oryn.signal_log'))[0]!.attempts).toBe(3);
  });

  it('transições inválidas e limite de tentativas', async () => {
    const r = await authorize(s.member, signalArgs(s.memberSession, s.ownerSession));
    expect(await setStateError(r.msg_id, 'published')).toBe('invalid-transition'); // accepted → published
    expect(await setStateError(r.msg_id, 'acknowledged')).toBe('invalid-transition');
    for (let i = 0; i < 5; i++) await setState(r.msg_id, 'publishing');
    expect(await setStateError(r.msg_id, 'publishing')).toBe('retry-limit');
    await setState(r.msg_id, 'published');
    expect(await setStateError(r.msg_id, 'publishing')).toBe('invalid-transition'); // published não volta
    expect(await setStateError(randomUUID(), 'publishing')).toBe('not-found');
  });

  it('confirmação: só o destinatário, só mensagens publicadas, lote limitado', async () => {
    const r = await authorize(s.member, signalArgs(s.memberSession, s.ownerSession));
    expect((await db.rpc<{ ack_signals: number }>(s.owner, 'public.ack_signals', { p_session_id: s.ownerSession, p_msg_ids: [r.msg_id] }))[0]!.ack_signals).toBe(0); // ainda accepted
    await setState(r.msg_id, 'publishing');
    await setState(r.msg_id, 'published');
    expect((await db.rpc<{ ack_signals: number }>(s.member, 'public.ack_signals', { p_session_id: s.memberSession, p_msg_ids: [r.msg_id] }))[0]!.ack_signals).toBe(0); // remetente não confirma
    expect(await db.rpcError(s.member, 'public.ack_signals', { p_session_id: s.ownerSession, p_msg_ids: [r.msg_id] })).toBe('session-invalid'); // sessão alheia
    expect(await db.rpcError(s.owner, 'public.ack_signals', { p_session_id: s.ownerSession, p_msg_ids: Array.from({ length: 65 }, () => randomUUID()) })).toBe('invalid-argument');
  });
});
