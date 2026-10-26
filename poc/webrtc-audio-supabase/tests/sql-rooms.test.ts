// Salas, convites, sessões e autorização dos tópicos privados (02C.1A), no Postgres real (PGlite) com o
// shim do Supabase. Casos negativos obrigatórios: não autenticado, anônimo sem convite, convite
// expirado/revogado/reutilizado, acesso entre salas, sessão de outro usuário.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestDb } from './helpers/db.ts';
import { createRoom, creatorToken, joinWithInvite, makeCreator, openSession, roomInvite, scenario, signalArgs } from './helpers/fixtures.ts';
import { parseControlEvent } from '../src/contracts.ts';

let db: TestDb;
beforeEach(async () => {
  db = await TestDb.create();
});
afterEach(() => db.close());

describe('não autenticado e anônimo sem convite', () => {
  it('papel authenticated SEM usuário no JWT → unauthorized em toda RPC de usuário', async () => {
    const ghost = { uid: '' } as { uid: string };
    const err = await db
      .as(ghost, async (tx) => {
        await tx.query(`select set_config('request.jwt.claims', '{"role":"authenticated"}', true)`);
        return tx.query(`select public.create_room('x', 'y', 3)`);
      })
      .then(() => null, (e: Error) => e.message);
    expect(err).toBe('unauthorized');
  });

  it('anônimo autenticado, sem convite de criador, não cria sala; sem convite de sala, não entra nem lê', async () => {
    const s = await scenario(db);
    const stranger = await db.newUser();
    expect(await db.rpcError(stranger, 'public.create_room', { p_name: 'x', p_display_name: 'y', p_max_members: 3 })).toBe('unauthorized');
    expect(await db.rpcError(stranger, 'public.join_room', { p_room_id: s.room })).toBe('not-member');
    expect(await db.rpcError(stranger, 'public.get_roster', { p_room_id: s.room })).toBe('not-member');
    expect(await db.rpcError(stranger, 'public.create_room_invite', { p_room_id: s.room, p_ttl_minutes: 10 })).toBe('unauthorized');
    expect(await db.rpcError(stranger, 'public.redeem_room_invite', { p_token: 'A'.repeat(43), p_display_name: 'x' })).toBe('invite-invalid');
    expect(await db.rpcError(stranger, 'public.redeem_room_invite', { p_token: 'curto', p_display_name: 'x' })).toBe('invite-invalid');
    expect(await db.canReceive(stranger, `oryn:s:${s.ownerSession}`)).toBe(false);
  });
});

describe('primeira sala: só com convite de criador emitido pelo administrador', () => {
  it('convite de criador: uso único, expira e pode ser revogado', async () => {
    const token = await creatorToken(db);
    const a = await db.newUser();
    const b = await db.newUser();
    expect((await db.rpc<{ redeem_creator_invite: number }>(a, 'public.redeem_creator_invite', { p_token: token }))[0]!.redeem_creator_invite).toBe(2);
    expect(await db.rpcError(b, 'public.redeem_creator_invite', { p_token: token })).toBe('invite-invalid');

    const expired = await creatorToken(db);
    await db.admin(`update oryn.creator_invites set created_at = now() - interval '2 hours', expires_at = now() - interval '1 second' where used_at is null`);
    expect(await db.rpcError(b, 'public.redeem_creator_invite', { p_token: expired })).toBe('invite-invalid');

    const revoked = await creatorToken(db);
    await db.admin(`update oryn.creator_invites set revoked_at = now() where used_at is null and revoked_at is null`);
    expect(await db.rpcError(b, 'public.redeem_creator_invite', { p_token: revoked })).toBe('invite-invalid');
  });

  it('limite de salas abertas por criador (2): a terceira é recusada', async () => {
    const owner = await makeCreator(db, 2);
    await createRoom(db, owner);
    await createRoom(db, owner);
    expect(await db.rpcError(owner, 'public.create_room', { p_name: 'x', p_display_name: 'y', p_max_members: 3 })).toBe('limit-reached');
  });

  it('nomes e capacidade inválidos → invalid-argument', async () => {
    const owner = await makeCreator(db);
    for (const args of [
      { p_name: '', p_display_name: 'y', p_max_members: 3 },
      { p_name: 'x'.repeat(41), p_display_name: 'y', p_max_members: 3 },
      { p_name: 'x', p_display_name: 'a\u0007b', p_max_members: 3 },
      { p_name: 'x', p_display_name: 'y', p_max_members: 1 },
      { p_name: 'x', p_display_name: 'y', p_max_members: 11 },
    ]) {
      expect(await db.rpcError(owner, 'public.create_room', args), JSON.stringify(args)).toBe('invalid-argument');
    }
  });
});

describe('convites de sala', () => {
  it('uso único: o segundo resgate do mesmo convite é recusado', async () => {
    const owner = await makeCreator(db);
    const room = await createRoom(db, owner);
    const token = await roomInvite(db, owner, room);
    const a = await db.newUser();
    const b = await db.newUser();
    await db.rpc(a, 'public.redeem_room_invite', { p_token: token, p_display_name: 'A' });
    expect(await db.rpcError(b, 'public.redeem_room_invite', { p_token: token, p_display_name: 'B' })).toBe('invite-invalid');
  });

  it('expirado e revogado → invite-invalid', async () => {
    const owner = await makeCreator(db);
    const room = await createRoom(db, owner);
    const expired = await roomInvite(db, owner, room);
    await db.admin(`update oryn.room_invites set created_at = now() - interval '1 hour', expires_at = now() - interval '1 second'`);
    const u = await db.newUser();
    expect(await db.rpcError(u, 'public.redeem_room_invite', { p_token: expired, p_display_name: 'U' })).toBe('invite-invalid');
    const revoked = await roomInvite(db, owner, room);
    expect((await db.rpc<{ revoke_room_invite: number }>(owner, 'public.revoke_room_invite', { p_room_id: room }))[0]!.revoke_room_invite).toBe(1);
    expect(await db.rpcError(u, 'public.redeem_room_invite', { p_token: revoked, p_display_name: 'U' })).toBe('invite-invalid');
  });

  it('só o dono emite e revoga convites; no máximo 3 pendentes', async () => {
    const owner = await makeCreator(db);
    const room = await createRoom(db, owner, 10);
    const member = await joinWithInvite(db, room, owner);
    expect(await db.rpcError(member, 'public.create_room_invite', { p_room_id: room, p_ttl_minutes: 10 })).toBe('unauthorized');
    expect(await db.rpcError(member, 'public.revoke_room_invite', { p_room_id: room })).toBe('unauthorized');
    for (let i = 0; i < 3; i++) await roomInvite(db, owner, room);
    expect(await db.rpcError(owner, 'public.create_room_invite', { p_room_id: room, p_ttl_minutes: 10 })).toBe('limit-reached');
    expect(await db.rpcError(owner, 'public.create_room_invite', { p_room_id: room, p_ttl_minutes: 61 })).toBe('invalid-argument');
  });

  it('sala cheia: convite pendente não entra e NÃO é consumido; já membro não consome', async () => {
    const owner = await makeCreator(db);
    const room = await createRoom(db, owner, 2);
    const t1 = await roomInvite(db, owner, room);
    const t2 = await roomInvite(db, owner, room);
    const a = await db.newUser();
    const b = await db.newUser();
    await db.rpc(a, 'public.redeem_room_invite', { p_token: t1, p_display_name: 'A' });
    expect(await db.rpcError(b, 'public.redeem_room_invite', { p_token: t2, p_display_name: 'B' })).toBe('room-full');
    expect(await db.rpcError(owner, 'public.create_room_invite', { p_room_id: room, p_ttl_minutes: 10 })).toBe('room-full');
    expect(await db.rpcError(a, 'public.redeem_room_invite', { p_token: t2, p_display_name: 'A' })).toBe('already-member');
    const pending = await db.admin<{ n: number }>(`select count(*)::int as n from oryn.room_invites where used_at is null`);
    expect(pending[0]!.n).toBe(1);
  });

  it('o token nunca é guardado: só o hash SHA-256 (32 bytes)', async () => {
    const owner = await makeCreator(db);
    const room = await createRoom(db, owner);
    const token = await roomInvite(db, owner, room);
    const dump = JSON.stringify(await db.admin('select * from oryn.room_invites')) + JSON.stringify(await db.admin('select * from oryn.creator_invites'));
    expect(dump).not.toContain(token);
    const len = await db.admin<{ n: number }>('select octet_length(token_hash) as n from oryn.room_invites');
    expect(len[0]!.n).toBe(32);
  });
});

describe('sessões e acesso entre salas', () => {
  it('sessão vinculada ao usuário: outro usuário não toca, não sai e não usa a sessão alheia', async () => {
    const s = await scenario(db);
    expect(await db.rpcError(s.member, 'public.touch_session', { p_session_id: s.ownerSession })).toBe('session-invalid');
    expect(await db.rpcError(s.member, 'public.leave_room', { p_session_id: s.ownerSession })).toBe('session-invalid');
    expect(await db.canReceive(s.member, `oryn:s:${s.ownerSession}`)).toBe(false);
    expect(await db.canReceive(s.member, `oryn:s:${s.memberSession}`)).toBe(true);
  });

  it('membro de uma sala não entra, não lê participantes e não assina tópicos de outra sala', async () => {
    const s = await scenario(db);
    const other = await createRoom(db, s.owner, 3, 'Outra');
    const outsider = await joinWithInvite(db, other, s.owner, 'Fora');
    const outsiderSession = await openSession(db, outsider, other);
    expect(await db.rpcError(s.member, 'public.join_room', { p_room_id: other })).toBe('not-member');
    expect(await db.rpcError(s.member, 'public.get_roster', { p_room_id: other })).toBe('not-member');
    expect(await db.canReceive(s.member, `oryn:s:${outsiderSession}`)).toBe(false);
    expect(await db.canReceive(outsider, `oryn:s:${s.memberSession}`)).toBe(false);
  });

  it('participantes: só sessões vivas, com indicação de "eu"; sem dados de rede', async () => {
    const s = await scenario(db);
    const roster = await db.rpc<{ session_id: string; display_name: string; is_self: boolean }>(s.member, 'public.get_roster', { p_room_id: s.room });
    expect(roster.map((r) => [r.display_name, r.is_self])).toEqual([['Dono', false], ['Amigo', true]]);
    expect(Object.keys(roster[0]!).sort()).toEqual(['display_name', 'is_self', 'joined_at', 'session_id']);
  });

  it('entrar avisa as demais sessões (hello) e sair avisa (bye) — eventos só com UUID e rótulo', async () => {
    const s = await scenario(db);
    const hello = await db.admin<{ event: string; payload: Record<string, unknown> }>(`select event, payload from realtime.messages where topic = $1 and event = 'hello'`, [`oryn:s:${s.ownerSession}`]);
    expect(hello).toHaveLength(1);
    // 02C.2B: o realtime.send injeta `id` (UUID da mensagem), como no Supabase real; o cliente o aceita.
    expect(Object.keys(hello[0]!.payload).sort()).toEqual(['id', 'label', 'session_id']);
    expect(parseControlEvent('hello', hello[0]!.payload)).toEqual({ event: 'hello', session_id: s.memberSession, label: 'Amigo' });
    await db.rpc(s.member, 'public.leave_room', { p_session_id: s.memberSession });
    const bye = await db.admin<{ payload: Record<string, unknown> }>(`select payload from realtime.messages where topic = $1 and event = 'bye'`, [`oryn:s:${s.ownerSession}`]);
    expect(bye).toHaveLength(1);
    expect(Object.keys(bye[0]!.payload).sort()).toEqual(['id', 'session_id']);
    expect(parseControlEvent('bye', bye[0]!.payload)).toEqual({ event: 'bye', session_id: s.memberSession });
    await db.rpc(s.member, 'public.leave_room', { p_session_id: s.memberSession }); // idempotente
  });

  it('sessão encerrada ou sem batimento: não renova, não assina e deixa de aparecer', async () => {
    const s = await scenario(db);
    await db.rpc(s.member, 'public.leave_room', { p_session_id: s.memberSession });
    expect(await db.rpcError(s.member, 'public.touch_session', { p_session_id: s.memberSession })).toBe('session-invalid');
    expect(await db.canReceive(s.member, `oryn:s:${s.memberSession}`)).toBe(false);

    await db.admin(`update oryn.room_sessions set last_seen_at = now() - interval '91 seconds' where id = $1`, [s.ownerSession]);
    expect(await db.canReceive(s.owner, `oryn:s:${s.ownerSession}`)).toBe(false);
    expect(await db.rpcError(s.owner, 'public.touch_session', { p_session_id: s.ownerSession })).toBe('session-invalid');
    expect(await db.rpc(s.owner, 'public.get_roster', { p_room_id: s.room })).toEqual([]);
  });

  // 02C.3D.1 (F1): touch_session gravava a revogação 'expired' e logo depois lançava o erro, que desfazia a
  // gravação. A sessão vencida continua recusada em todo caminho e nunca volta a valer; a revogação que
  // persiste é a do join_room, nas sessões do próprio usuário.
  it('sessão vencida: touch_session não grava nada antes do erro, e a sessão nunca volta a valer', async () => {
    const s = await scenario(db);
    const src = (await db.admin<{ src: string }>(`select prosrc as src from pg_proc where oid = 'public.touch_session(uuid)'::regprocedure`))[0]!.src;
    // Comandos de escrita (a trava `for no key update` não conta).
    const writes = [...src.matchAll(/\b(update\s+oryn\.|insert\s+into|delete\s+from)/gi)].map((m) => m.index!);
    expect(writes, 'só o UPDATE do batimento').toHaveLength(1);
    expect(writes[0]!, 'nenhuma escrita antes do último raise').toBeGreaterThan(src.lastIndexOf('raise exception'));

    const stale = `now() - interval '91 seconds'`;
    await db.admin(`update oryn.room_sessions set last_seen_at = ${stale} where id = $1`, [s.ownerSession]);
    const before = await db.admin(`select last_seen_at, revoked_at from oryn.room_sessions where id = $1`, [s.ownerSession]);
    for (let i = 0; i < 2; i++) {
      expect(await db.rpcError(s.owner, 'public.touch_session', { p_session_id: s.ownerSession })).toBe('session-invalid');
    }
    expect(await db.admin(`select last_seen_at, revoked_at from oryn.room_sessions where id = $1`, [s.ownerSession])).toEqual(before);
    expect(await db.rpcError(s.owner, 'public.authorize_signal', signalArgs(s.ownerSession, s.memberSession))).toBe('session-invalid');
    expect(await db.rpcError(s.member, 'public.authorize_signal', signalArgs(s.memberSession, s.ownerSession))).toBe('recipient-invalid');
    expect(await db.canReceive(s.owner, `oryn:s:${s.ownerSession}`)).toBe(false);
    expect((await db.rpc<{ session_id: string }>(s.member, 'public.get_roster', { p_room_id: s.room })).map((r) => r.session_id)).toEqual([s.memberSession]);

    // A próxima entrada do dono revoga de vez a sessão vencida; ela continua inválida.
    const fresh = await openSession(db, s.owner, s.room);
    expect(await db.admin(`select revoke_reason from oryn.room_sessions where id = $1`, [s.ownerSession])).toEqual([{ revoke_reason: 'expired' }]);
    expect(await db.rpcError(s.owner, 'public.touch_session', { p_session_id: s.ownerSession })).toBe('session-invalid');
    expect(await db.rpcError(s.owner, 'public.touch_session', { p_session_id: fresh })).toBeNull();
  });

  it('no máximo 2 sessões vivas por usuário por sala', async () => {
    const s = await scenario(db);
    await openSession(db, s.member, s.room);
    expect(await db.rpcError(s.member, 'public.join_room', { p_room_id: s.room })).toBe('limit-reached');
  });
});

describe('canais Realtime: cliente nunca envia nos tópicos oryn:*', () => {
  it('Broadcast direto do cliente é negado no próprio tópico, no alheio e para anon', async () => {
    const s = await scenario(db);
    expect(await db.canClientBroadcast(s.member, `oryn:s:${s.memberSession}`)).toBe(false);
    expect(await db.canClientBroadcast(s.member, `oryn:s:${s.ownerSession}`)).toBe(false);
    expect(await db.canClientBroadcast('anon', `oryn:s:${s.ownerSession}`)).toBe(false);
  });

  it('tópicos fora do padrão ou sem sessão não são assináveis', async () => {
    const s = await scenario(db);
    for (const topic of ['oryn:s:nao-e-uuid', `oryn:x:${s.memberSession}`, 'oryn:s:', `oryn:s:${s.memberSession}:extra`]) {
      expect(await db.canReceive(s.member, topic), topic).toBe(false);
    }
    expect(await db.canReceive('anon', `oryn:s:${s.memberSession}`)).toBe(false);
  });
});
