// MVP 01 — list_my_rooms e close_room (migração 0400) no Postgres real em memória (PGlite + shim). Cenários
// montados pelos fluxos reais (RPCs). A concorrência está em tests/pg/concurrency.pg.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestDb } from './helpers/db.ts';
import { createRoom, joinWithInvite, makeCreator, openSession, roomInvite, scenario, signalArgs } from './helpers/fixtures.ts';

let db: TestDb;
beforeEach(async () => {
  db = await TestDb.create();
});
afterEach(() => db.close());

interface RoomRow {
  room_id: string;
  name: string;
  role: string;
  is_open: boolean;
  closed_at: string | null;
  member_count: number;
  max_members: number;
  created_at: string;
}

const list = (actor: { uid: string }) => db.rpc<RoomRow>(actor, 'public.list_my_rooms');
const close = async (actor: { uid: string }, room: string) => (await db.rpc<{ close_room: string }>(actor, 'public.close_room', { p_room_id: room }))[0]!.close_room;
const messages = (topics: string[]) =>
  db.admin<{ topic: string; event: string; payload: Record<string, unknown> }>(
    `select topic, event, payload from realtime.messages where topic = any ($1) order by topic, event`, [topics]);

describe('list_my_rooms', () => {
  it('só as salas em que o chamador é membro ativo, com exatamente os campos do contrato', async () => {
    const s = await scenario(db);
    const stranger = await db.newUser();
    expect(await list(stranger)).toEqual([]);
    const [own] = await list(s.owner);
    expect(Object.keys(own!).sort()).toEqual(['closed_at', 'created_at', 'is_open', 'max_members', 'member_count', 'name', 'role', 'room_id']);
    expect(own).toMatchObject({ room_id: s.room, name: 'Partida', role: 'owner', is_open: true, closed_at: null, member_count: 2, max_members: 3 });
    expect(await list(s.member)).toEqual([{ ...own, role: 'member' }]);
    // Sala de outra pessoa nunca aparece.
    const other = await makeCreator(db);
    await createRoom(db, other, 2, 'Alheia');
    expect((await list(s.owner)).map((r) => r.room_id)).toEqual([s.room]);
  });

  it('membro removido não vê mais a sala', async () => {
    const s = await scenario(db);
    await db.admin(`update oryn.room_members set removed_at = now() where room_id = $1 and user_id = $2`, [s.room, s.member.uid]);
    expect(await list(s.member)).toEqual([]);
    expect((await list(s.owner))[0]!.member_count).toBe(1);
  });

  it('ordem: abertas primeiro, depois as mais recentes; encerradas aparecem com is_open = false', async () => {
    const owner = await makeCreator(db, 5);
    const a = await createRoom(db, owner, 2, 'A');
    const b = await createRoom(db, owner, 2, 'B');
    const c = await createRoom(db, owner, 2, 'C');
    await db.admin(`update oryn.rooms set created_at = now() - make_interval(mins => $2) where id = $1`, [a, 30]);
    await db.admin(`update oryn.rooms set created_at = now() - make_interval(mins => $2) where id = $1`, [b, 20]);
    await db.admin(`update oryn.rooms set created_at = now() - make_interval(mins => $2) where id = $1`, [c, 10]);
    await close(owner, c);
    const rows = await list(owner);
    expect(rows.map((r) => [r.name, r.is_open])).toEqual([['B', true], ['A', true], ['C', false]]);
    expect(rows[2]!.closed_at).not.toBeNull();
  });

  it('no máximo 50 salas', async () => {
    const owner = await makeCreator(db, 1);
    for (let i = 0; i < 51; i++) await close(owner, await createRoom(db, owner, 2, `S${i}`));
    expect(await list(owner)).toHaveLength(50);
  });
});

describe('close_room', () => {
  it('encerra preservando o histórico: closed_at, sessões revogadas (room-closed), convites pendentes revogados', async () => {
    const s = await scenario(db);
    const pending = await roomInvite(db, s.owner, s.room);
    const used = await roomInvite(db, s.owner, s.room);
    await db.rpc(await db.newUser(), 'public.redeem_room_invite', { p_token: used, p_display_name: 'Usou' });
    const closedAt = await close(s.owner, s.room);
    expect(closedAt).not.toBeNull();
    const room = await db.admin<{ closed_at: string; members: number }>(
      `select closed_at, (select count(*)::int from oryn.room_members where room_id = $1) as members from oryn.rooms where id = $1`, [s.room]);
    expect(room[0]!.members).toBe(3); // nada apagado
    expect(String(room[0]!.closed_at)).toBe(String(closedAt));
    const sessions = await db.admin<{ reason: string; n: number }>(
      `select revoke_reason as reason, count(*)::int as n from oryn.room_sessions where room_id = $1 group by 1`, [s.room]);
    expect(sessions).toEqual([{ reason: 'room-closed', n: 2 }]);
    const invites = await db.admin<{ used: boolean; revoked: boolean }>(
      `select used_at is not null as used, revoked_at is not null as revoked from oryn.room_invites where room_id = $1 order by used, revoked`, [s.room]);
    // 3 convites: o do membro do cenário e o `used` (usados) e o `pending` (agora revogado).
    expect(invites).toHaveLength(3);
    expect(invites.filter((i) => !i.used && !i.revoked)).toEqual([]);
    expect(invites.filter((i) => i.used && i.revoked)).toEqual([]); // usado continua só usado
    expect((await db.rpcError(await db.newUser(), 'public.redeem_room_invite', { p_token: pending, p_display_name: 'Tarde' }))).toMatch(/invite-invalid/);
  });

  it('avisa cada sessão viva com o bye das demais (evento existente, só session_id); sessão sem batimento não recebe', async () => {
    const owner = await makeCreator(db);
    const room = await createRoom(db, owner, 4);
    const [m1, m2] = [await joinWithInvite(db, room, owner, 'M1'), await joinWithInvite(db, room, owner, 'M2')];
    const so = await openSession(db, owner, room);
    const s1 = await openSession(db, m1, room);
    const stale = await openSession(db, m2, room);
    await db.admin(`update oryn.room_sessions set last_seen_at = now() - interval '5 minutes' where id = $1`, [stale]);
    await db.admin('delete from realtime.messages');
    await close(owner, room);
    const rows = await messages([so, s1, stale].map((x) => `oryn:s:${x}`));
    expect(rows.map((r) => [r.topic, r.event, r.payload['session_id']])).toEqual([
      [`oryn:s:${s1}`, 'bye', so],
      [`oryn:s:${so}`, 'bye', s1],
    ].sort((a, b) => a[0]!.localeCompare(b[0]!)));
    for (const r of rows) expect(Object.keys(r.payload).sort()).toEqual(['id', 'session_id']);
    // A sessão sem batimento também foi revogada.
    expect((await db.admin<{ reason: string }>(`select revoke_reason as reason from oryn.room_sessions where id = $1`, [stale]))[0]!.reason).toBe('room-closed');
  });

  it('idempotente: a segunda chamada devolve o mesmo closed_at e não muda nada nem publica de novo', async () => {
    const s = await scenario(db);
    const first = await close(s.owner, s.room);
    const snapshot = async () => (await db.admin<{ h: string }>(`
      select md5(coalesce((select string_agg(x::text, '|' order by x::text) from oryn.room_sessions x), '') ||
                 coalesce((select string_agg(x::text, '|' order by x::text) from oryn.room_invites x), '') ||
                 coalesce((select string_agg(x::text, '|' order by x::text) from oryn.rooms x), '') ||
                 (select count(*)::text from realtime.messages)) as h`))[0]!.h;
    const before = await snapshot();
    expect(String(await close(s.owner, s.room))).toBe(String(first));
    expect(await snapshot()).toBe(before);
  });

  it('depois do encerramento, todo caminho de uso da sala recusa', async () => {
    const s = await scenario(db);
    const token = await roomInvite(db, s.owner, s.room);
    await close(s.owner, s.room);
    expect(await db.rpcError(s.member, 'public.join_room', { p_room_id: s.room })).toMatch(/not-member/);
    expect(await db.rpcError(s.owner, 'public.join_room', { p_room_id: s.room })).toMatch(/not-member/);
    expect(await db.rpcError(s.member, 'public.get_roster', { p_room_id: s.room })).toMatch(/not-member/);
    expect(await db.rpcError(s.member, 'public.touch_session', { p_session_id: s.memberSession })).toMatch(/session-invalid/);
    expect(await db.rpcError(s.member, 'public.authorize_signal', signalArgs(s.memberSession, s.ownerSession))).toMatch(/session-invalid/);
    expect(await db.rpcError(s.owner, 'public.create_room_invite', { p_room_id: s.room, p_ttl_minutes: 10 })).toMatch(/unauthorized/);
    expect(await db.rpcError(await db.newUser(), 'public.redeem_room_invite', { p_token: token, p_display_name: 'x' })).toMatch(/invite-invalid/);
    expect(await db.canReceive(s.member, `oryn:s:${s.memberSession}`)).toBe(false);
    // Sair de uma sessão já revogada continua sem erro (o cliente chama leave_room ao fechar).
    expect(await db.rpcError(s.member, 'public.leave_room', { p_session_id: s.memberSession })).toBeNull();
    expect((await list(s.member))[0]).toMatchObject({ room_id: s.room, is_open: false });
  });

  it('encerrar libera a concessão de salas abertas do criador', async () => {
    const owner = await makeCreator(db, 1);
    const first = await createRoom(db, owner, 2, 'Primeira');
    expect(await db.rpcError(owner, 'public.create_room', { p_name: 'Segunda', p_display_name: 'Dono', p_max_members: 2 })).toMatch(/limit-reached/);
    await close(owner, first);
    expect(await createRoom(db, owner, 2, 'Segunda')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('só o dono; sala alheia e inexistente recebem a mesma resposta', async () => {
    const s = await scenario(db);
    expect(await db.rpcError(s.member, 'public.close_room', { p_room_id: s.room })).toMatch(/unauthorized/);
    expect(await db.rpcError(s.owner, 'public.close_room', { p_room_id: '00000000-0000-4000-8000-000000000000' })).toMatch(/unauthorized/);
    expect(await db.rpcError(s.owner, 'public.close_room', { p_room_id: null })).toMatch(/unauthorized/);
    expect((await list(s.owner))[0]!.is_open).toBe(true);
  });
});
