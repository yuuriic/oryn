// Etapa 10 (capacidade 5, 1000): pré-voo, aplicação, pós-voo, corrida pela última vaga, reversão e reaplicação em
// PostgreSQL 17 efêmero (loopback). Não usa .env, Docker, CLI remota ou credenciais externas.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrationFiles } from '../helpers/db.ts';
import { PgServer, type CallResult } from './pg-server.ts';

let db: PgServer;
const sql = (file: string) => readFileSync(new URL(`../../integration/sql/${file}`, import.meta.url), 'utf8');
const pre = sql('40_capacity_10_preflight.sql'), post = sql('41_capacity_10_postflight.sql'), rollback = sql('97_rollback_capacity_10.sql');
const migrations = migrationFiles();
const capacity = migrations[9]!;

/** Roda como quem aplica as migrações, numa transação desfeita no fim: só leitura, para os marcadores. */
async function execute(text: string) {
  const client = await db.pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role migration_owner');
    const result = await client.query(text);
    return (Array.isArray(result) ? result.at(-1) : result)?.rows ?? [];
  } finally {
    await client.query('rollback');
    client.release();
  }
}
const marker = async (text: string) => (await execute(text))[0]?.result;
/** Script com a própria transação (a reversão): se falhar no meio, a conexão volta ao pool sem transação aberta. */
async function script(text: string): Promise<void> {
  const client = await db.pool.connect();
  try {
    await client.query('set role migration_owner');
    await client.query(text);
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.query('reset role').catch(() => undefined);
    client.release();
  }
}
const rooms = () => db.admin<{ id: string; name: string; max_members: number; closed_at: string | null }>('select id, name, max_members, closed_at from oryn.rooms order by id');
const codes = (results: CallResult<unknown>[]) => results.map((r) => r.error?.message ?? 'ok').sort();

async function creator(): Promise<{ uid: string }> {
  const owner = await db.newUser();
  const token = (await db.admin<{ t: string }>('select oryn.admin_issue_creator_invite(60, 5) as t'))[0]!.t;
  await db.rpc(owner, 'public.redeem_creator_invite', { p_token: token });
  return owner;
}
const create = (owner: { uid: string }, max: number, name = 'Sala') => db.call<{ create_room: string }>(owner, 'public.create_room', { p_name: name, p_display_name: 'Dono', p_max_members: max });
const invite = async (owner: { uid: string }, room: string) => (await db.rpc<{ token: string }>(owner, 'public.create_room_invite', { p_room_id: room, p_ttl_minutes: 10 }))[0]!.token;
async function fill(owner: { uid: string }, room: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) await db.rpc(await db.newUser(), 'public.redeem_room_invite', { p_token: await invite(owner, room), p_display_name: `M${i}` });
}
const memberCount = async (room: string) => (await db.admin<{ n: number }>('select count(*)::int as n from oryn.room_members where room_id = $1 and removed_at is null', [room]))[0]!.n;

let legacyOwner: { uid: string };
let legacyRoom: string;

beforeAll(async () => {
  db = await PgServer.start([], 9);
  await db.admin(`create schema supabase_migrations;
    create table supabase_migrations.schema_migrations(version text primary key,name text);
    grant usage on schema supabase_migrations to migration_owner;
    grant select, insert, delete on supabase_migrations.schema_migrations to migration_owner;`);
  for (const [file] of migrations.slice(0, 9)) await db.admin('insert into supabase_migrations.schema_migrations values($1,$2)', [file.slice(0, 14), file.slice(15, -4)]);
  // Dados anteriores: uma sala de 4 com 2 membros, criada pelas RPCs da 0900.
  legacyOwner = await creator();
  legacyRoom = (await create(legacyOwner, 4, 'Legado')).rows[0]!.create_room;
  await fill(legacyOwner, legacyRoom, 1);
}, 180_000);
afterAll(async () => { await db?.stop(); });

it('antes da 1000: pré-voo ok, pós-voo FAIL e sala de 5 recusada; o pré-voo recusa histórico, corpo ou ACL divergentes', async () => {
  expect(await marker(pre)).toBe('oryn-capacity-10-preflight-ok');
  expect(await marker(post)).toBe('oryn-capacity-10-postflight-FAIL');
  expect((await create(await creator(), 5)).error?.message).toBe('invalid-argument');
  await db.admin("insert into supabase_migrations.schema_migrations values('20261111000000','unexpected')");
  expect(await marker(pre)).toBe('oryn-capacity-10-preflight-FAIL');
  await db.admin("delete from supabase_migrations.schema_migrations where version='20261111000000'");
  await db.asMigrationOwner('grant execute on function oryn.enforce_room_capacity() to authenticated');
  expect(await marker(pre)).toBe('oryn-capacity-10-preflight-FAIL');
  await db.asMigrationOwner('revoke execute on function oryn.enforce_room_capacity() from authenticated');
  await db.admin('alter table oryn.rooms disable trigger oryn_room_capacity');
  expect(await marker(pre)).toBe('oryn-capacity-10-preflight-FAIL');
  await db.admin('alter table oryn.rooms enable trigger oryn_room_capacity');
  expect(await marker(pre)).toBe('oryn-capacity-10-preflight-ok');
});

it('aplica a 1000: pós-voo ok, salas existentes intactas, sala nova de 5 aceita e de 6 recusada', async () => {
  const before = await rooms();
  await db.asMigrationOwner(capacity[1]);
  await db.admin('insert into supabase_migrations.schema_migrations values($1,$2)', [capacity[0].slice(0, 14), capacity[0].slice(15, -4)]);
  expect(await marker(post)).toBe('oryn-capacity-10-postflight-ok');
  expect(await marker(pre)).toBe('oryn-capacity-10-preflight-FAIL');
  expect(await rooms()).toEqual(before);
  // A sala de 4 continua de 4: a quinta conta é recusada.
  await fill(legacyOwner, legacyRoom, 2);
  expect((await db.call(legacyOwner, 'public.create_room_invite', { p_room_id: legacyRoom, p_ttl_minutes: 10 })).error?.message).toBe('room-full');
  const owner = await creator();
  expect((await create(owner, 6)).error?.message).toBe('invalid-argument');
  const room = (await create(owner, 5, 'Cinco')).rows[0]!.create_room;
  await fill(owner, room, 4);
  expect(await memberCount(room)).toBe(5);
  expect((await db.call(owner, 'public.create_room_invite', { p_room_id: room, p_ttl_minutes: 10 })).error?.message).toBe('room-full');
});

it('última vaga de uma sala de 5 disputada por dois convites ao mesmo tempo: exatamente um entra', async () => {
  const owner = await creator();
  const room = (await create(owner, 5, 'Corrida')).rows[0]!.create_room;
  await fill(owner, room, 3); // dono + 3 = 4 de 5
  const [t1, t2] = [await invite(owner, room), await invite(owner, room)];
  // Alarga a janela de corrida: cada entrada segura a transação depois de gravar o membro.
  await db.admin('create or replace function public.t_slow_capacity() returns trigger language plpgsql as $$ begin perform pg_sleep(0.4); return new; end $$');
  await db.admin('create trigger t_slow_capacity after insert on oryn.room_members for each row execute function public.t_slow_capacity()');
  try {
    const results = await Promise.all([
      db.call(await db.newUser(), 'public.redeem_room_invite', { p_token: t1, p_display_name: 'V1' }),
      db.call(await db.newUser(), 'public.redeem_room_invite', { p_token: t2, p_display_name: 'V2' }),
    ]);
    expect(codes(results)).toEqual(['ok', 'room-full']);
    expect(await memberCount(room)).toBe(5);
  } finally {
    await db.admin('drop trigger t_slow_capacity on oryn.room_members');
    await db.admin('drop function public.t_slow_capacity()');
  }
}, 60_000);

it('reversão (97): volta ao pré-voo, mantém as salas de 5 com os membros, recusa sala nova de 5 e falha fechada se repetida', async () => {
  const fives = (await rooms()).filter((r) => r.max_members === 5);
  expect(fives.length).toBeGreaterThan(0);
  const counts = await Promise.all(fives.map((r) => memberCount(r.id)));
  await script(rollback);
  expect(await marker(pre)).toBe('oryn-capacity-10-preflight-ok');
  expect(await marker(post)).toBe('oryn-capacity-10-postflight-FAIL');
  expect((await rooms()).filter((r) => r.max_members === 5)).toEqual(fives);
  expect(await Promise.all(fives.map((r) => memberCount(r.id)))).toEqual(counts);
  expect((await create(await creator(), 5)).error?.message).toBe('invalid-argument');
  // Repetida, encontra o pós-voo ausente e não faz nada.
  await expect(script(rollback)).rejects.toThrow(/capacity-10-rollback: estado divergente/);
  expect(await marker(pre)).toBe('oryn-capacity-10-preflight-ok');
});

it('depois da reversão, a 1000 pode ser reaplicada e o pós-voo volta a confirmar', async () => {
  await db.asMigrationOwner(capacity[1]);
  await db.admin('insert into supabase_migrations.schema_migrations values($1,$2)', [capacity[0].slice(0, 14), capacity[0].slice(15, -4)]);
  expect(await marker(post)).toBe('oryn-capacity-10-postflight-ok');
  expect((await create(await creator(), 5)).error).toBeNull();
});
