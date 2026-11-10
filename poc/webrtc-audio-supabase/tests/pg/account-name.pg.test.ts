import { afterAll, beforeAll, expect, it } from 'vitest';
import { PgServer } from './pg-server.ts';
let db: PgServer;
beforeAll(async () => { db = await PgServer.start(); }, 180_000);
afterAll(async () => { await db?.stop(); });

it('renomeações concorrentes e criação por cliente antigo convergem sem deadlock ou troca de identidade', async () => {
  const owner = await db.newUser();
  const token = (await db.admin<{ token: string }>('select oryn.admin_issue_creator_invite(60,5) as token'))[0]!.token;
  await db.rpc(owner, 'public.redeem_creator_invite', { p_token: token });
  await db.admin('update auth.users set raw_user_meta_data=\'{"display_name":"Inicial"}\' where id=$1', [owner.uid]);
  const rename = (name: string) => db.admin('update auth.users set raw_user_meta_data=jsonb_build_object(\'display_name\',$2::text) where id=$1', [owner.uid, name]);
  const results = await Promise.all([
    rename('Primeiro'),
    db.rpc<{ create_room: string }>(owner, 'public.create_room', { p_name: 'Concorrente', p_display_name: 'Cliente antigo', p_max_members: 4 }),
    rename('Segundo'),
  ]);
  const room = (results[1] as { create_room: string }[])[0]!.create_room;
  const final = (await db.admin<{ name: string }>('select raw_user_meta_data->>\'display_name\' as name from auth.users where id=$1', [owner.uid]))[0]!.name;
  expect(['Primeiro', 'Segundo']).toContain(final);
  const members = await db.rpc<{ display_name: string; role: string }>(owner, 'public.list_room_members', { p_room_id: room });
  expect(members).toHaveLength(1);
  expect(members[0]).toMatchObject({ display_name: final, role: 'owner' });
  expect((await db.admin<{ name: string }>('select display_name as name from oryn.room_members where room_id=$1', [room]))[0]!.name).toBe('Cliente antigo');
});
