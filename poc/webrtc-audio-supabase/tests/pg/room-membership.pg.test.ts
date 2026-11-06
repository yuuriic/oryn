// Salas de grupo sob concorrência em PostgreSQL 17 REAL. Cada chamada usa conexão e transação próprias. Gatilhos com pg_sleep
// alargam a janela de corrida, para o resultado não depender de sorte.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgServer } from './pg-server.ts';

let db: PgServer;

beforeAll(async () => {
  db = await PgServer.start();
}, 180_000);
afterAll(async () => {
  await db?.stop();
});

const newRoom = async (capacity = 4) => {
  const owner = await db.newUser();
  const creator = (await db.admin<{ t: string }>('select oryn.admin_issue_creator_invite(60, 5) as t'))[0]!.t;
  await db.rpc(owner, 'public.redeem_creator_invite', { p_token: creator });
  const room = (await db.rpc<{ create_room: string }>(owner, 'public.create_room', { p_name: 'pg17', p_display_name: 'Dono', p_max_members: capacity }))[0]!.create_room;
  return { owner, room };
};
const token = async (r: { owner: { uid: string }; room: string }) => (await db.rpc<{ token: string }>(r.owner, 'public.create_room_invite', { p_room_id: r.room, p_ttl_minutes: 10 }))[0]!.token;
const addMember = async (r: { owner: { uid: string }; room: string }, name = 'Amigo') => {
  const user = await db.newUser();
  await db.rpc(user, 'public.redeem_room_invite', { p_token: await token(r), p_display_name: name });
  return user;
};
const refOf = async (r: { owner: { uid: string }; room: string }, name: string) => (await db.rpc<{ member_ref: string; display_name: string }>(r.owner, 'public.list_room_members', { p_room_id: r.room })).find((m) => m.display_name === name)!.member_ref;
const active = async (room: string) => (await db.admin<{ n: number }>('select count(*)::int as n from oryn.room_members where room_id = $1 and removed_at is null', [room]))[0]!.n;
const code = (x: { error: { message: string } | null }) => x.error?.message ?? 'ok';

async function slow(table: string, seconds: number, event: 'insert' | 'update' = 'insert'): Promise<() => Promise<void>> {
  const name = `t_slow_${table.replace('.', '_')}_${event}`;
  await db.admin(`create or replace function public.${name}() returns trigger language plpgsql as $$ begin perform pg_sleep(${seconds}); return new; end $$`);
  await db.admin(`create trigger ${name} before ${event} on ${table} for each row execute function public.${name}()`);
  return async () => {
    await db.admin(`drop trigger ${name} on ${table}`);
    await db.admin(`drop function public.${name}()`);
  };
}

describe('capacidade sob concorrência', () => {
  it.each([2, 3, 4])('resgates simultâneos numa sala de %i lugares nunca a ultrapassam', async (capacity) => {
    const r = await newRoom(capacity);
    const tokens: string[] = [];
    while (tokens.length < 3) tokens.push(await token(r));
    const users = await Promise.all(tokens.map(() => db.newUser()));
    const results = await Promise.all(users.map((u, i) => db.call(u, 'public.redeem_room_invite', { p_token: tokens[i], p_display_name: `M${i}` })));
    expect(await active(r.room)).toBeLessThanOrEqual(capacity);
    expect(results.filter((x) => x.error === null)).toHaveLength(capacity - 1);
    expect(results.filter((x) => x.error !== null).every((x) => /room-full/.test(x.error!.message))).toBe(true);
  }, 60_000);

  it('uma conta saindo e outra entrando: a vaga só é usada depois de liberada', async () => {
    const r = await newRoom(2);
    const member = await addMember(r);
    expect(code(await db.call(member, 'public.leave_room_membership', { p_room_id: r.room }))).toBe('ok');
    const next = await db.newUser();
    expect(code(await db.call(next, 'public.redeem_room_invite', { p_token: await token(r), p_display_name: 'Nova' }))).toBe('ok');
    expect(await active(r.room)).toBe(2);
  }, 60_000);
});

describe('remoção e saída sob concorrência (PostgreSQL 17 real)', () => {
  it('remoção com entrada na chamada em curso: a sessão recém-criada também é revogada, sem impasse', async () => {
    const r = await newRoom();
    const member = await addMember(r);
    const ref = await refOf(r, 'Amigo');
    const undo = await slow('oryn.room_sessions', 0.4);
    try {
      const joining = db.call<{ session_id: string }>(member, 'public.join_room', { p_room_id: r.room });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const removing = db.call(r.owner, 'public.remove_room_member', { p_room_id: r.room, p_member_ref: ref });
      const [joined, removed] = await Promise.all([joining, removing]);
      expect(code(removed)).toBe('ok');
      expect(code(joined)).toBe('ok');
      expect((await db.admin<{ n: number }>('select count(*)::int as n from oryn.room_sessions where room_id = $1 and user_id = $2 and revoked_at is null', [r.room, member.uid]))[0]!.n).toBe(0);
    } finally {
      await undo();
    }
  }, 60_000);

  it('resgate preso na trava da sala não traz de volta quem foi removido nesse intervalo', async () => {
    const r = await newRoom();
    const member = await addMember(r);
    const ref = await refOf(r, 'Amigo');
    const old = await token(r);
    await db.rpc(member, 'public.join_room', { p_room_id: r.room });
    // Segura a remoção com a sala travada, ANTES da revogação dos convites: o resgate trava o convite e fica esperando a sala,
    // e a revogação o pula (SKIP LOCKED).
    const hold = await slow('oryn.room_sessions', 0.6, 'update');
    try {
      const removing = db.call(r.owner, 'public.remove_room_member', { p_room_id: r.room, p_member_ref: ref });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const redeeming = db.call(member, 'public.redeem_room_invite', { p_token: old, p_display_name: 'Volta' });
      const [removed, redeemed] = await Promise.all([removing, redeeming]);
      expect(code(removed)).toBe('ok');
      expect(code(redeemed)).toMatch(/invite-invalid/);
      expect((await db.admin<{ removed: boolean }>('select removed_at is not null as removed from oryn.room_members where room_id = $1 and user_id = $2', [r.room, member.uid]))[0]!.removed).toBe(true);
    } finally {
      await hold();
    }
  }, 60_000);

  it('remoção, saída e encerramento ao mesmo tempo: sem impasse e com estado consistente', async () => {
    for (let round = 0; round < 5; round++) {
      const r = await newRoom();
      const a = await addMember(r, 'A');
      const b = await addMember(r, 'B');
      const refA = await refOf(r, 'A');
      await db.rpc<{ session_id: string }>(a, 'public.join_room', { p_room_id: r.room });
      await db.rpc<{ session_id: string }>(b, 'public.join_room', { p_room_id: r.room });
      const results = await Promise.all([
        db.call(r.owner, 'public.remove_room_member', { p_room_id: r.room, p_member_ref: refA }),
        db.call(a, 'public.leave_room_membership', { p_room_id: r.room }),
        db.call(b, 'public.leave_room_membership', { p_room_id: r.room }),
        db.call(r.owner, 'public.close_room', { p_room_id: r.room }),
      ]);
      for (const x of results) expect(code(x)).toMatch(/^(ok|unauthorized)$/);
      const live = await db.admin<{ n: number }>(`select count(*)::int as n from oryn.room_sessions where room_id = $1 and revoked_at is null`, [r.room]);
      expect(live[0]!.n).toBe(0);
    }
  }, 120_000);

  it('remoção com sinalização e batimento em curso: sem impasse', async () => {
    const r = await newRoom();
    const member = await addMember(r);
    const ownerSession = (await db.rpc<{ session_id: string }>(r.owner, 'public.join_room', { p_room_id: r.room }))[0]!.session_id;
    const memberSession = (await db.rpc<{ session_id: string }>(member, 'public.join_room', { p_room_id: r.room }))[0]!.session_id;
    const ref = await refOf(r, 'Amigo');
    const signal = (from: { uid: string }, a: string, b: string) => db.call(from, 'public.authorize_signal', { p_session_id: a, p_to_session_id: b, p_client_msg_id: randomUUID(), p_kind: 'offer', p_pair_epoch: 1, p_payload_bytes: 100 });
    const results = await Promise.all([
      signal(r.owner, ownerSession, memberSession),
      signal(member, memberSession, ownerSession),
      db.call(member, 'public.touch_session', { p_session_id: memberSession }),
      db.call(r.owner, 'public.remove_room_member', { p_room_id: r.room, p_member_ref: ref }),
      signal(r.owner, ownerSession, memberSession),
    ]);
    expect(code(results[3]!)).toBe('ok');
    for (const x of results) expect(code(x)).not.toMatch(/deadlock/);
    expect(await active(r.room)).toBe(1);
  }, 60_000);

  it('remoção e mensagem ao mesmo tempo: ou a mensagem entrou antes, ou recebe unauthorized', async () => {
    for (let round = 0; round < 4; round++) {
      const r = await newRoom();
      const member = await addMember(r);
      const ref = await refOf(r, 'Amigo');
      const [sent, removed] = await Promise.all([
        db.call(member, 'public.send_room_message', { p_room_id: r.room, p_client_nonce: randomUUID(), p_body: 'na hora' }),
        db.call(r.owner, 'public.remove_room_member', { p_room_id: r.room, p_member_ref: ref }),
      ]);
      expect(code(removed)).toBe('ok');
      expect(code(sent)).toMatch(/^(ok|unauthorized)$/);
      const stored = (await db.admin<{ n: number }>('select count(*)::int as n from oryn.room_messages where room_id = $1', [r.room]))[0]!.n;
      expect(stored).toBe(code(sent) === 'ok' ? 1 : 0);
    }
  }, 120_000);

  it('saída repetida em paralelo: uma funciona, as demais recebem a mesma recusa', async () => {
    const r = await newRoom();
    const member = await addMember(r);
    const results = await Promise.all(Array.from({ length: 5 }, () => db.call(member, 'public.leave_room_membership', { p_room_id: r.room })));
    expect(results.filter((x) => x.error === null)).toHaveLength(1);
    expect(results.filter((x) => x.error !== null).every((x) => /unauthorized/.test(x.error!.message))).toBe(true);
  }, 60_000);

  it('controle: sem o gatilho de reativação, o resgate preso traria de volta quem foi removido', async () => {
    const r = await newRoom();
    const member = await addMember(r);
    const ref = await refOf(r, 'Amigo');
    const old = await token(r);
    await db.rpc(member, 'public.join_room', { p_room_id: r.room });
    await db.admin('alter table oryn.room_members disable trigger oryn_member_reactivation');
    const hold = await slow('oryn.room_sessions', 0.6, 'update');
    try {
      const removing = db.call(r.owner, 'public.remove_room_member', { p_room_id: r.room, p_member_ref: ref });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const redeeming = db.call(member, 'public.redeem_room_invite', { p_token: old, p_display_name: 'Volta' });
      const [, redeemed] = await Promise.all([removing, redeeming]);
      expect(code(redeemed)).toBe('ok');
      expect((await db.admin<{ removed: boolean }>('select removed_at is not null as removed from oryn.room_members where room_id = $1 and user_id = $2', [r.room, member.uid]))[0]!.removed).toBe(false);
    } finally {
      await hold();
      await db.admin('alter table oryn.room_members enable trigger oryn_member_reactivation');
    }
  }, 60_000);
});
