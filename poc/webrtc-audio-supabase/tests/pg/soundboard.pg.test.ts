// Soundboard sob concorrência em PostgreSQL 17 REAL. Cada chamada usa conexão e transação próprias.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgServer } from './pg-server.ts';

let db: PgServer;

beforeAll(async () => {
  db = await PgServer.start();
}, 180_000);
afterAll(async () => {
  await db?.stop();
});

const HASH = 'c'.repeat(64);
const code = (x: { error: { message: string } | null }) => x.error?.message ?? 'ok';

const newRoom = async () => {
  const owner = await db.newUser();
  const creator = (await db.admin<{ t: string }>('select oryn.admin_issue_creator_invite(60, 5) as t'))[0]!.t;
  await db.rpc(owner, 'public.redeem_creator_invite', { p_token: creator });
  const room = (await db.rpc<{ create_room: string }>(owner, 'public.create_room', { p_name: 'pg17', p_display_name: 'Dono', p_max_members: 4 }))[0]!.create_room;
  const session = (await db.rpc<{ session_id: string }>(owner, 'public.join_room', { p_room_id: room }))[0]!.session_id;
  return { owner, room, session };
};
const reserve = (r: { owner: { uid: string }; room: string }, name: string) =>
  db.call<{ asset_id: string }>(r.owner, 'public.request_sound_upload', { p_room_id: r.room, p_name: name, p_size_bytes: 1000 });
const approve = (id: string) =>
  db.rpc('service', 'public.complete_sound_validation', { p_asset_id: id, p_ok: true, p_mime: 'audio/wav', p_size_bytes: 1000, p_duration_ms: 500, p_sha256: HASH, p_reason: null });
const counted = async (room: string) =>
  (await db.admin<{ n: number }>(`select count(*)::int as n from oryn.sound_assets where room_id = $1 and state in ('available', 'quarantine')`, [room]))[0]!.n;

describe('limite de 20 sons', () => {
  it('40 reservas simultâneas: exatamente 20 passam, e as outras recebem sound-quota', async () => {
    const r = await newRoom();
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => reserve(r, `som ${i}`)));
    const codes = results.map(code);
    expect(codes.filter((c) => c === 'ok')).toHaveLength(20);
    expect(codes.filter((c) => c === 'sound-quota')).toHaveLength(20);
    expect(await counted(r.room)).toBe(20);
  }, 60_000);

  it('com 19 já publicados, reservas simultâneas só preenchem a última vaga', async () => {
    const r = await newRoom();
    for (let i = 0; i < 19; i++) {
      const res = await reserve(r, `base ${i}`);
      await approve(res.rows[0]!.asset_id);
    }
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => reserve(r, `novo ${i}`)));
    expect(results.map(code).filter((c) => c === 'ok')).toHaveLength(1);
    expect(await counted(r.room)).toBe(20);
  }, 60_000);

  it('remoção e reserva simultâneas nunca ultrapassam o limite', async () => {
    const r = await newRoom();
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await reserve(r, `base ${i}`);
      ids.push(res.rows[0]!.asset_id);
      await approve(res.rows[0]!.asset_id);
    }
    await Promise.all([
      db.call(r.owner, 'public.remove_sound', { p_asset_id: ids[0] }),
      ...Array.from({ length: 5 }, (_, i) => reserve(r, `novo ${i}`)),
    ]);
    expect(await counted(r.room)).toBeLessThanOrEqual(20);
  }, 60_000);
});

describe('cooldown', () => {
  it('20 disparos simultâneos da mesma conta: um passa, um único evento sai', async () => {
    const r = await newRoom();
    const res = await reserve(r, 'som');
    const id = res.rows[0]!.asset_id;
    await approve(id);
    const other = await db.newUser();
    const token = (await db.rpc<{ token: string }>(r.owner, 'public.create_room_invite', { p_room_id: r.room, p_ttl_minutes: 10 }))[0]!.token;
    await db.rpc(other, 'public.redeem_room_invite', { p_token: token, p_display_name: 'Amigo' });
    await db.rpc(other, 'public.join_room', { p_room_id: r.room });
    await db.admin(`delete from realtime.messages where event = 'sound'`);
    const results = await Promise.all(Array.from({ length: 20 }, () => db.call(r.owner, 'public.trigger_sound', { p_session_id: r.session, p_asset_id: id })));
    const codes = results.map(code);
    expect(codes.filter((c) => c === 'ok')).toHaveLength(1);
    expect(codes.filter((c) => c === 'rate-limited')).toHaveLength(19);
    const events = await db.admin<{ n: number }>(`select count(*)::int as n from realtime.messages where event = 'sound'`);
    expect(events[0]!.n).toBe(1);
  }, 60_000);

  it('duas contas disparam ao mesmo tempo sem uma bloquear a outra', async () => {
    const r = await newRoom();
    const res = await reserve(r, 'som');
    const id = res.rows[0]!.asset_id;
    await approve(id);
    const other = await db.newUser();
    const token = (await db.rpc<{ token: string }>(r.owner, 'public.create_room_invite', { p_room_id: r.room, p_ttl_minutes: 10 }))[0]!.token;
    await db.rpc(other, 'public.redeem_room_invite', { p_token: token, p_display_name: 'Amigo' });
    const session = (await db.rpc<{ session_id: string }>(other, 'public.join_room', { p_room_id: r.room }))[0]!.session_id;
    const results = await Promise.all([
      db.call(r.owner, 'public.trigger_sound', { p_session_id: r.session, p_asset_id: id }),
      db.call(other, 'public.trigger_sound', { p_session_id: session, p_asset_id: id }),
    ]);
    expect(results.map(code)).toEqual(['ok', 'ok']);
  }, 60_000);
});

describe('corrida entre remoção e disparo', () => {
  it('nunca erro bruto: ou tocou antes, ou foi recusado', async () => {
    const r = await newRoom();
    const res = await reserve(r, 'som');
    const id = res.rows[0]!.asset_id;
    await approve(id);
    const [fire] = await Promise.all([
      db.call(r.owner, 'public.trigger_sound', { p_session_id: r.session, p_asset_id: id }),
      db.call(r.owner, 'public.remove_sound', { p_asset_id: id }),
    ]);
    expect(['ok', 'sound-unavailable']).toContain(code(fire));
  }, 60_000);
});
