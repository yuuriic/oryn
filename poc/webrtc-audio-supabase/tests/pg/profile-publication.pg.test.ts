// Só PostgreSQL 17 efêmero em loopback. Não usa .env, Docker, CLI remota ou credenciais externas.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrationFiles } from '../helpers/db.ts';
import { PgServer } from './pg-server.ts';
let db: PgServer;
const sql = (file: string) => readFileSync(new URL(`../../integration/sql/${file}`, import.meta.url), 'utf8');
const pre = sql('20_profile_08_preflight.sql'), post = sql('21_profile_08_postflight.sql');
const recovered = sql('22_profile_08_recovered.sql'), recover = sql('95_recover_profile_08.sql');
const migrations = migrationFiles();
const profile = migrations[7]![1];
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
async function marker(text: string) { return (await execute(text))[0]?.result; }
async function snapshot() {
  const tables = await db.admin<{ n: string }>(`select n.nspname || '.' || c.relname as n from pg_class c
    join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in ('auth','oryn','oryn_realtime','storage') order by 1`);
  const data = [];
  for (const { n } of tables) data.push([n, await db.admin(`select to_jsonb(t) as row from ${n} t order by to_jsonb(t)::text`)]);
  return data;
}
beforeAll(async () => {
  db = await PgServer.start([], 7);
  await db.admin(`create schema supabase_migrations;
    create table supabase_migrations.schema_migrations(version text primary key,name text);
    grant usage on schema supabase_migrations to migration_owner;
    grant select, insert on supabase_migrations.schema_migrations to migration_owner;`);
  for (const [file] of migrations.slice(0, 7)) await db.admin('insert into supabase_migrations.schema_migrations values($1,$2)', [file.slice(0, 14), file.slice(15, -4)]);
}, 180_000);
afterAll(async () => { await db?.stop(); });

it.skipIf(!process.env['ORYN_PROFILE_LOCAL_CLI'])('CLI 2.122.0 real: contrato JSON de consulta em loopback (sem Management API)', () => {
  const options = db.pool.options;
  let output: string;
  try {
    output = execFileSync(process.env['ORYN_PROFILE_LOCAL_CLI']!, [
      'db', 'query', '--db-url', `postgresql://postgres@127.0.0.1:${options.port}/postgres?sslmode=disable`,
      "select 'oryn-profile-08-preflight-ok' as result", '--output', 'json',
    ], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PGPASSWORD: String(options.password), SUPABASE_DB_PASSWORD: String(options.password) } });
  } catch (error) {
    const diagnostic = String((error as { stderr?: unknown }).stderr ?? '').replaceAll(String(options.password), '***').slice(-1800);
    throw new Error(`Consulta da CLI ao PostgreSQL descartável falhou: ${diagnostic}`);
  }
  expect(output).toMatch(/"result"\s*:\s*"oryn-profile-08-preflight-ok"/);
});

it('pré-voo exige histórico exato, hashes, contratos, ACLs, ausência de helpers/gatilho e permissões', async () => {
  expect(await marker(pre)).toBe('oryn-profile-08-preflight-ok');
  await db.admin("insert into supabase_migrations.schema_migrations values('20261110000000','unexpected')");
  expect(await marker(pre)).toBe('oryn-profile-08-preflight-FAIL');
  await db.admin("delete from supabase_migrations.schema_migrations where version='20261110000000'");
  await db.admin("update supabase_migrations.schema_migrations set name='wrong' where version='20261108000700'");
  expect(await marker(pre)).toBe('oryn-profile-08-preflight-FAIL');
  await db.admin("update supabase_migrations.schema_migrations set name='oryn_soundboard' where version='20261108000700'");
  await execute('grant execute on function public.get_roster(uuid) to anon');
  expect(await marker(pre)).toBe('oryn-profile-08-preflight-FAIL');
  await execute('revoke execute on function public.get_roster(uuid) from anon');
  await execute('create function oryn.account_display_name() returns text language sql as $$ select null::text $$');
  expect(await marker(pre)).toBe('oryn-profile-08-preflight-FAIL');
  await execute('drop function oryn.account_display_name()');
  await db.admin('revoke trigger on auth.users from migration_owner');
  expect(await marker(pre)).toBe('oryn-profile-08-preflight-FAIL');
  await db.admin('grant trigger on auth.users to migration_owner');
  expect(await marker('begin; alter function public.get_roster(uuid) volatile;\n' + pre)).toBe('oryn-profile-08-preflight-FAIL');
  expect(await marker(pre)).toBe('oryn-profile-08-preflight-ok');
});

it('falha antes do COMMIT desfaz toda a migração; permite nova tentativa com estado intacto', async () => {
  const before = await snapshot();
  await expect(execute(profile.replace(/commit;\s*$/i, 'select 1/0; commit;'))).rejects.toThrow(/division by zero/);
  expect(await marker(pre)).toBe('oryn-profile-08-preflight-ok');
  expect(await snapshot()).toEqual(before);
});

it('aplicação e recuperação preservam todos os dados; histórico retido bloqueia reaplicação', async () => {
  const owner = await db.newUser();
  const token = (await db.admin<{ token: string }>('select oryn.admin_issue_creator_invite(60,5) as token'))[0]!.token;
  await db.rpc(owner, 'public.redeem_creator_invite', { p_token: token });
  const room = (await db.rpc<{ create_room: string }>(owner, 'public.create_room', { p_name: 'Publicação local', p_display_name: 'Legado', p_max_members: 4 }))[0]!.create_room;
  await db.rpc(owner, 'public.join_room', { p_room_id: room });
  await db.rpc(owner, 'public.create_room_invite', { p_room_id: room, p_ttl_minutes: 10 });
  await db.rpc(owner, 'public.send_room_message', { p_room_id: room, p_client_nonce: '11111111-1111-4111-8111-111111111111', p_body: 'Histórico preservado' });
  await db.rpc(owner, 'public.request_sound_upload', { p_room_id: room, p_name: 'Som preservado', p_size_bytes: 100 });
  const before = await snapshot();
  await execute(profile);
  // Estado ambíguo: DDL confirmado, registro de versão ainda ausente. Nunca reaplicar.
  expect(await marker(pre)).toBe('oryn-profile-08-preflight-FAIL');
  expect(await marker(post)).toBe('oryn-profile-08-postflight-FAIL');
  await db.admin("insert into supabase_migrations.schema_migrations values('20261109224924','oryn_account_display_name')");
  expect(await marker(post)).toBe('oryn-profile-08-postflight-ok');
  expect(await marker('begin; grant execute on function oryn.normalize_account_name(text) to authenticated;\n' + post)).toBe('oryn-profile-08-postflight-FAIL');
  expect(await marker('begin; alter function oryn.account_display_name(uuid,text) security definer;\n' + post)).toBe('oryn-profile-08-postflight-FAIL');
  expect(await marker(post)).toBe('oryn-profile-08-postflight-ok');
  expect(await snapshot()).toEqual(before);
  expect(await marker(pre)).toBe('oryn-profile-08-preflight-FAIL');
  await expect(execute(profile)).rejects.toThrow(/already exists/);
  await db.admin("update auth.users set raw_user_meta_data = '{\"display_name\":\"Nome global preservado\",\"other\":true}' where id=$1", [owner.uid]);
  const afterRename = await snapshot();
  // Falha após restaurar RPCs e neutralizar o gatilho: transação inteira é desfeita.
  await expect(execute(recover.replace('do $verify$', 'select 1/0;\ndo $verify$'))).rejects.toThrow(/division by zero/);
  expect(await marker(post)).toBe('oryn-profile-08-postflight-ok');
  expect(await snapshot()).toEqual(afterRename);
  // Gatilho alterado é detectado pelo pós-voo e bloqueia recuperação antes de DDL.
  await db.admin('alter table auth.users disable trigger oryn_validate_account_name');
  expect(await marker(post)).toBe('oryn-profile-08-postflight-FAIL');
  await expect(execute(recover)).rejects.toThrow(/estado divergente/);
  await db.admin('alter table auth.users enable trigger oryn_validate_account_name');
  await execute(recover);
  expect(await marker(recovered)).toBe('oryn-profile-08-recovered-ok');
  expect(await snapshot()).toEqual(afterRename);
  expect(await marker(pre)).toBe('oryn-profile-08-preflight-FAIL');
  expect(await marker(post)).toBe('oryn-profile-08-postflight-FAIL');
  await expect(execute(recover)).rejects.toThrow(/estado divergente/);
  expect((await db.rpc<{ display_name: string }>(owner, 'public.list_room_members', { p_room_id: room }))[0]!.display_name).toBe('Legado');
  // O validador inerte não bloqueia operações legadas de metadados do Auth.
  await db.admin("update auth.users set raw_user_meta_data=raw_user_meta_data || '{\"display_name\":\"\"}' where id=$1", [owner.uid]);
  expect(await marker(recovered)).toBe('oryn-profile-08-recovered-ok');
});
