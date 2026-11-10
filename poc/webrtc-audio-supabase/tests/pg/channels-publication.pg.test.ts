// Etapa 9 (canais, 0900): pré-voo, aplicação, pós-voo e recuperação em PostgreSQL 17 efêmero (loopback).
// Não usa .env, Docker, CLI remota ou credenciais externas.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrationFiles } from '../helpers/db.ts';
import { PgServer } from './pg-server.ts';

let db: PgServer;
const sql = (file: string) => readFileSync(new URL(`../../integration/sql/${file}`, import.meta.url), 'utf8');
const pre = sql('30_channels_09_preflight.sql'), post = sql('31_channels_09_postflight.sql');
const recovered = sql('32_channels_09_recovered.sql'), recover = sql('96_recover_channels_09.sql');
const migrations = migrationFiles();
const channels = migrations[8]![1];

async function execute(text: string) {
  const client = await db.pool.connect();
  try {
    await client.query('set role migration_owner');
    const result = await client.query(text);
    return (Array.isArray(result) ? result.at(-1) : result)?.rows ?? [];
  } finally {
    await client.query('rollback');
    await client.query('reset role');
    client.release();
  }
}
const marker = async (text: string) => (await execute(text))[0]?.result;
/** Todo o conteúdo de auth/oryn/oryn_realtime/storage. `legacy` tira o que a 0900 acrescenta (tabela e coluna). */
async function snapshot(legacy = false) {
  const tables = await db.admin<{ n: string }>(`select n.nspname || '.' || c.relname as n from pg_class c
    join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in ('auth','oryn','oryn_realtime','storage') order by 1`);
  const data: [string, unknown][] = [];
  for (const { n } of tables) {
    if (legacy && n === 'oryn.channels') continue;
    const rows = await db.admin<{ row: Record<string, unknown> }>(`select to_jsonb(t) ${legacy ? "- 'channel_id'" : ''} as row from ${n} t order by 1::text`);
    data.push([n, rows.map((r) => r.row).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
  }
  return data;
}

let owner: { uid: string };
let member: { uid: string };
let room: string;
let closed: string;

beforeAll(async () => {
  db = await PgServer.start([], 8);
  await db.admin(`create schema supabase_migrations;
    create table supabase_migrations.schema_migrations(version text primary key,name text);
    grant usage on schema supabase_migrations to migration_owner;
    grant select, insert on supabase_migrations.schema_migrations to migration_owner;`);
  for (const [file] of migrations.slice(0, 8)) await db.admin('insert into supabase_migrations.schema_migrations values($1,$2)', [file.slice(0, 14), file.slice(15, -4)]);
  // Dados legados pelas RPCs da 0800: duas salas (uma encerrada), membros, convite, mensagens, sessões e um som.
  owner = await db.newUser();
  member = await db.newUser();
  const token = (await db.admin<{ token: string }>('select oryn.admin_issue_creator_invite(60,5) as token'))[0]!.token;
  await db.rpc(owner, 'public.redeem_creator_invite', { p_token: token });
  room = (await db.rpc<{ create_room: string }>(owner, 'public.create_room', { p_name: 'Legado', p_display_name: 'Dono', p_max_members: 4 }))[0]!.create_room;
  closed = (await db.rpc<{ create_room: string }>(owner, 'public.create_room', { p_name: 'Antiga', p_display_name: 'Dono', p_max_members: 2 }))[0]!.create_room;
  const invite = (await db.rpc<{ token: string }>(owner, 'public.create_room_invite', { p_room_id: room, p_ttl_minutes: 10 }))[0]!.token;
  await db.rpc(member, 'public.redeem_room_invite', { p_token: invite, p_display_name: 'Amigo' });
  await db.rpc(owner, 'public.create_room_invite', { p_room_id: room, p_ttl_minutes: 10 });
  await db.rpc(owner, 'public.join_room', { p_room_id: room });
  const gone = (await db.rpc<{ session_id: string }>(member, 'public.join_room', { p_room_id: room }))[0]!.session_id;
  await db.rpc(member, 'public.leave_room', { p_session_id: gone });
  await db.rpc(member, 'public.join_room', { p_room_id: room });
  for (const body of ['um', 'dois', 'três']) await db.rpc(member, 'public.send_room_message', { p_room_id: room, p_client_nonce: randomUUID(), p_body: body });
  await db.rpc(owner, 'public.send_room_message', { p_room_id: closed, p_client_nonce: randomUUID(), p_body: 'histórico' });
  await db.rpc(owner, 'public.close_room', { p_room_id: closed });
  await db.rpc(owner, 'public.request_sound_upload', { p_room_id: room, p_name: 'Som', p_size_bytes: 100 });
}, 180_000);
afterAll(async () => { await db?.stop(); });

it('pré-voo exige histórico exato, corpos e ACLs anteriores, ausência dos objetos da 0900 e permissões', async () => {
  expect(await marker(pre)).toBe('oryn-channels-09-preflight-ok');
  await db.admin("insert into supabase_migrations.schema_migrations values('20261110000000','unexpected')");
  expect(await marker(pre)).toBe('oryn-channels-09-preflight-FAIL');
  await db.admin("delete from supabase_migrations.schema_migrations where version='20261110000000'");
  await execute('grant execute on function public.leave_room(uuid) to anon');
  expect(await marker(pre)).toBe('oryn-channels-09-preflight-FAIL');
  await execute('revoke execute on function public.leave_room(uuid) from anon');
  await execute('create table oryn.channels (x int)');
  expect(await marker(pre)).toBe('oryn-channels-09-preflight-FAIL');
  await execute('drop table oryn.channels');
  await execute('create function oryn.default_channel(uuid, text) returns uuid language sql as $$ select null::uuid $$');
  expect(await marker(pre)).toBe('oryn-channels-09-preflight-FAIL');
  await execute('drop function oryn.default_channel(uuid, text)');
  expect(await marker('begin; alter function public.get_roster(uuid) volatile;\n' + pre)).toBe('oryn-channels-09-preflight-FAIL');
  expect(await marker(pre)).toBe('oryn-channels-09-preflight-ok');
});

it('falha antes do COMMIT desfaz toda a migração; o pré-voo continua OK e os dados intactos', async () => {
  const before = await snapshot();
  await expect(execute(channels.replace(/commit;\s*$/i, 'select 1/0; commit;'))).rejects.toThrow(/division by zero/);
  expect(await marker(pre)).toBe('oryn-channels-09-preflight-ok');
  expect(await snapshot()).toEqual(before);
});

it('aplicação preserva todos os dados legados; pós-voo detecta divergências; recuperação devolve o cliente antigo', async () => {
  const legacyBefore = await snapshot(true);
  const oldView = async () => ({
    messages: await db.rpc(member, 'public.list_room_messages', { p_room_id: room }),
    closedHistory: await db.rpc(owner, 'public.list_room_messages', { p_room_id: closed }),
    voice: await db.rpc(member, 'public.get_voice_participants', { p_room_id: room }),
    members: await db.rpc(owner, 'public.list_room_members', { p_room_id: room }),
  });
  const viewBefore = await oldView();
  await execute(channels);
  // Estado ambíguo: DDL confirmado, versão ainda não registrada. Nunca reaplicar.
  expect(await marker(pre)).toBe('oryn-channels-09-preflight-FAIL');
  expect(await marker(post)).toBe('oryn-channels-09-postflight-FAIL');
  await db.admin("insert into supabase_migrations.schema_migrations values('20261110000900','oryn_channels')");
  expect(await marker(post)).toBe('oryn-channels-09-postflight-ok');
  expect(await snapshot(true)).toEqual(legacyBefore);
  expect(await oldView()).toEqual(viewBefore);
  expect((await db.admin<{ n: number }>('select count(*)::int as n from oryn.channels'))[0]!.n).toBe(4);
  // Divergências que o pós-voo precisa acusar (cada uma desfeita pelo rollback do execute).
  for (const tamper of [
    'grant execute on function oryn.post_message(uuid,uuid,uuid,uuid,text) to authenticated;',
    'grant execute on function public.list_channels(uuid) to anon;',
    'alter table oryn.room_messages disable trigger oryn_message_channel;',
    'alter table oryn.room_sessions alter column channel_id drop not null;',
    'grant select on oryn.channels to authenticated;',
    'alter function oryn.open_voice_session(uuid,uuid,uuid) security definer;',
    "update oryn.channels set is_default = false where kind = 'voice' and room_id = (select min(id::text)::uuid from oryn.rooms);",
  ]) expect(await marker(`begin; ${tamper}\n${post}`), tamper).toBe('oryn-channels-09-postflight-FAIL');
  expect(await marker(post)).toBe('oryn-channels-09-postflight-ok');
  await expect(execute(channels)).rejects.toThrow(/already exists/);

  // Uso dos canais antes da recuperação: canal novo, mensagem nele e sessão na voz nova.
  const extra = (await db.rpc<{ create_channel: string }>(owner, 'public.create_channel', { p_room_id: room, p_name: 'extra', p_kind: 'text' }))[0]!.create_channel;
  await db.rpc(member, 'public.send_channel_message', { p_channel_id: extra, p_client_nonce: randomUUID(), p_body: 'no canal novo' });
  const voice2 = (await db.rpc<{ create_channel: string }>(owner, 'public.create_channel', { p_room_id: room, p_name: 'voz 2', p_kind: 'voice' }))[0]!.create_channel;
  const third = await db.newUser();
  const invite = (await db.rpc<{ token: string }>(owner, 'public.create_room_invite', { p_room_id: room, p_ttl_minutes: 10 }))[0]!.token;
  await db.rpc(third, 'public.redeem_room_invite', { p_token: invite, p_display_name: 'Terceiro' });
  await db.rpc(third, 'public.join_voice_channel', { p_channel_id: voice2 });
  const beforeRecovery = await snapshot();

  // Falha no meio da recuperação: nada muda.
  await expect(execute(recover.replace('do $verify$', 'select 1/0;\ndo $verify$'))).rejects.toThrow(/division by zero/);
  expect(await marker(post)).toBe('oryn-channels-09-postflight-ok');
  expect(await snapshot()).toEqual(beforeRecovery);
  // Estado divergente bloqueia a recuperação antes de qualquer DDL.
  await db.admin('alter table oryn.room_sessions disable trigger oryn_session_channel');
  expect(await marker(post)).toBe('oryn-channels-09-postflight-FAIL');
  await expect(execute(recover)).rejects.toThrow(/estado divergente/);
  await db.admin('alter table oryn.room_sessions enable trigger oryn_session_channel');

  await execute(recover);
  expect(await marker(recovered)).toBe('oryn-channels-09-recovered-ok');
  expect(await snapshot()).toEqual(beforeRecovery); // recuperação não toca em nenhum dado
  expect(await marker(post)).toBe('oryn-channels-09-postflight-FAIL');
  expect(await marker(pre)).toBe('oryn-channels-09-preflight-FAIL'); // histórico retido: reaplicação bloqueada
  await expect(execute(recover)).rejects.toThrow(/estado divergente/);
  // Cliente antigo funciona com os corpos restaurados; os gatilhos levam tudo ao canal padrão.
  const nonce = randomUUID();
  await db.rpc(owner, 'public.send_room_message', { p_room_id: room, p_client_nonce: nonce, p_body: 'depois da recuperação' });
  const stored = await db.admin<{ is_default: boolean }>(`select c.is_default from oryn.room_messages m join oryn.channels c on c.id = m.channel_id where m.client_nonce = $1`, [nonce]);
  expect(stored).toEqual([{ is_default: true }]);
  const sid = (await db.rpc<{ session_id: string }>(owner, 'public.join_room', { p_room_id: room }))[0]!.session_id;
  const sess = await db.admin<{ is_default: boolean; kind: string }>(`select c.is_default, c.kind from oryn.room_sessions s join oryn.channels c on c.id = s.channel_id where s.id = $1`, [sid]);
  expect(sess).toEqual([{ is_default: true, kind: 'voice' }]);
  // RPCs novas ficam inertes para clientes.
  expect((await db.call(member, 'public.list_channels', { p_room_id: room })).error?.message).toMatch(/permission denied/);
  expect((await db.call(member, 'public.join_voice_channel', { p_channel_id: voice2 })).error?.message).toMatch(/permission denied/);
  expect(await marker(recovered)).toBe('oryn-channels-09-recovered-ok');
});
