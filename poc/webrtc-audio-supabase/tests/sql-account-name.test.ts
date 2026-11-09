import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestDb, migrationFiles } from './helpers/db.ts';
import { createRoom, roomInvite, scenario } from './helpers/fixtures.ts';
import { normalizeDisplayName } from '../src/web/identity.ts';
let db: TestDb;
beforeAll(async () => { db = await TestDb.create(); });
afterAll(async () => { await db?.close(); });
const rename = (uid: string, value: unknown) => db.admin('update auth.users set raw_user_meta_data = jsonb_build_object(\'display_name\', $2::jsonb) where id = $1', [uid, JSON.stringify(value)]);
describe('identidade no servidor', () => {
  it('metadados antigos malformados usam o fallback e não bloqueiam outras atualizações do Auth', async () => {
    const legacy = await TestDb.createBare();
    try {
      const files = migrationFiles();
      for (const [, sql] of files.slice(0, 7)) await legacy.migrate(sql);
      const s = await scenario(legacy);
      await legacy.admin('update auth.users set raw_user_meta_data=\'{"display_name":123}\' where id=$1', [s.owner.uid]);
      await legacy.migrate(files[7]![1]);
      await legacy.admin('update auth.users set raw_user_meta_data=raw_user_meta_data || \'{"other":"value"}\' where id=$1', [s.owner.uid]);
      expect((await legacy.rpc<{ display_name: string; is_self: boolean }>(s.owner, 'public.list_room_members', { p_room_id: s.room })).find((m) => m.is_self)?.display_name).toBe('Dono');
    } finally { await legacy.close(); }
  });
  it('normalização SQL e cliente coincidem, incluindo Unicode e limites', async () => {
    for (const value of ['', ' ', '\tAna', 'A\u0085B', ' Ana \u2003  Silva ', '🎮'.repeat(32), '🎮'.repeat(33), '\u00a0']) {
      const rows = await db.admin<{ name: string | null }>('select oryn.normalize_account_name($1) as name', [value]);
      expect(rows[0]!.name, JSON.stringify(value)).toBe(normalizeDisplayName(value));
    }
  });
  it('valida criação e edição pelo Auth, não só formulários', async () => {
    const u = await db.newUser();
    for (const invalid of ['', ' ', 'x'.repeat(33), 'A\nB', 'A\u009fB', 123, null, {}]) await expect(rename(u.uid, invalid)).rejects.toThrow('invalid-display-name');
    await rename(u.uid, '  Ana   Silva  ');
    expect((await db.admin<{ name: string }>('select raw_user_meta_data->>\'display_name\' as name from auth.users where id=$1', [u.uid]))[0]!.name).toBe('Ana Silva');
    await expect(db.admin('update auth.users set raw_user_meta_data = \'{}\' where id=$1', [u.uid])).rejects.toThrow('invalid-display-name');
    await expect(db.admin('insert into auth.users(id,raw_user_meta_data) values($1,$2)', [randomUUID(), '{"display_name":" "}'])).rejects.toThrow('invalid-display-name');
  });
  it('sincroniza leituras de duas salas, voz e histórico sem alterar IDs, mensagens ou sessões', async () => {
    const s = await scenario(db);
    const room2 = await createRoom(db, s.owner, 2, 'Outra');
    const nonce = randomUUID();
    await db.rpc(s.owner, 'public.send_room_message', { p_room_id: s.room, p_client_nonce: nonce, p_body: 'Antes' });
    const before = await db.admin('select * from oryn.room_members where user_id=$1 order by room_id', [s.owner.uid]);
    const sessions = await db.admin('select * from oryn.room_sessions where user_id=$1 order by id', [s.owner.uid]);
    const messages = await db.admin('select * from oryn.room_messages where author_id=$1', [s.owner.uid]);
    await rename(s.owner.uid, 'Global');
    for (const room of [s.room, room2]) {
      const members = await db.rpc<{ display_name: string; is_self: boolean }>(s.owner, 'public.list_room_members', { p_room_id: room });
      expect(members.find((m) => m.is_self)?.display_name).toBe('Global');
    }
    for (const rpc of ['get_roster', 'get_voice_participants']) {
      const rows = await db.rpc<{ display_name: string; is_self: boolean }>(s.owner, `public.${rpc}`, { p_room_id: s.room });
      expect(rows.find((m) => m.is_self)?.display_name).toBe('Global');
    }
    expect((await db.rpc<{ display_name: string }>(s.member, 'public.list_room_messages', { p_room_id: s.room }))[0]!.display_name).toBe('Global');
    expect(await db.admin('select * from oryn.room_members where user_id=$1 order by room_id', [s.owner.uid])).toEqual(before);
    expect(await db.admin('select * from oryn.room_sessions where user_id=$1 order by id', [s.owner.uid])).toEqual(sessions);
    expect(await db.admin('select * from oryn.room_messages where author_id=$1', [s.owner.uid])).toEqual(messages);
  });
  it('clientes antigos não sobrescrevem o nome global; contas legadas mantêm nome por sala', async () => {
    const s = await scenario(db);
    await rename(s.owner.uid, 'Global');
    const r = await createRoom(db, s.owner);
    const invite = await roomInvite(db, s.owner, r);
    await rename(s.member.uid, 'Membro global');
    await db.rpc(s.member, 'public.redeem_room_invite', { p_token: invite, p_display_name: 'Cliente antigo' });
    const rows = await db.rpc<{ display_name: string }>(s.owner, 'public.list_room_members', { p_room_id: r });
    expect(rows.map((m) => m.display_name).sort()).toEqual(['Global', 'Membro global']);
    const legacy = await db.newUser();
    await db.rpc(legacy, 'public.redeem_room_invite', { p_token: await roomInvite(db, s.owner, s.room), p_display_name: 'Legado' });
    expect((await db.rpc<{ display_name: string }>(s.owner, 'public.list_room_members', { p_room_id: s.room })).some((m) => m.display_name === 'Legado')).toBe(true);
  });
  it('metadados de papel não concedem acesso; não há leitura/edição direta de outra conta', async () => {
    const s = await scenario(db); const outsider = await db.newUser();
    await db.admin('update auth.users set raw_user_meta_data=\'{"display_name":"Dono falso","role":"owner"}\' where id=$1', [outsider.uid]);
    expect(await db.rpcError(outsider, 'public.list_room_members', { p_room_id: s.room })).toBe('unauthorized');
    for (const actor of ['anon', outsider] as const) {
      await expect(db.as(actor, (tx) => tx.query('update auth.users set raw_user_meta_data=\'{}\' where id=$1', [s.owner.uid]))).rejects.toThrow();
      await expect(db.as(actor, (tx) => tx.query('select oryn.account_display_name($1,\'fallback\')', [s.owner.uid]))).rejects.toThrow();
    }
  });
});
