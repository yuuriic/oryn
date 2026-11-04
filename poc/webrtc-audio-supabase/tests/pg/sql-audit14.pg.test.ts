// 14_mvp01_r2_ab_audit.sql em PostgreSQL 17 REAL (o do Supabase): a matriz completa fica no PGlite
// (tests/sql-audit14-local.test.ts); aqui, um percurso de ponta a ponta confirma que o script roda no servidor
// real com o mesmo resultado (percentile_cont, to_char, bool_and, READ ONLY) e não escreve nada.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PgServer } from './pg-server.ts';

const SQL = readFileSync(fileURLToPath(new URL('../../integration/sql/14_mvp01_r2_ab_audit.sql', import.meta.url)), 'utf8');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
interface Row {
  item: string;
  actual: string;
  status: string;
}

let db: PgServer;
beforeAll(async () => {
  db = await PgServer.start();
}, 180_000);
afterAll(async () => {
  await db?.stop();
});

/** O script inteiro numa conexão só (BEGIN … ROLLBACK); em erro, desfaz para devolver a conexão limpa. */
async function exec(text: string): Promise<Row[]> {
  const c = await db.pool.connect();
  try {
    const res = (await c.query(text)) as unknown as { fields?: { name: string }[]; rows: Row[] }[];
    return res.find((r) => r.fields?.some((f) => f.name === 'status'))!.rows;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
const one = (rows: Row[], prefix: string) => rows.filter((r) => r.item.startsWith(prefix));
async function snapshot(): Promise<string> {
  const tables = await db.admin<{ t: string }>(`select format('%I.%I', schemaname, tablename) as t from pg_tables where schemaname in ('oryn', 'realtime', 'auth') order by 1`);
  const out: string[] = [];
  for (const { t } of tables) out.push(`${t}:${(await db.admin<{ h: string }>(`select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h from ${t} x`))[0]!.h}`);
  return out.join('\n');
}

it('PG17: classes, A1 antes e depois do close_room, sem escrita, sem UUID completo, READ ONLY e marcadores', async () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  const t0 = iso(Date.now() - 10 * 60_000);
  const owner = await db.newUser();
  await db.rpc(owner, 'public.redeem_creator_invite', { p_token: (await db.admin<{ t: string }>('select oryn.admin_issue_creator_invite(60, 1) as t'))[0]!.t });
  const room = (await db.rpc<{ create_room: string }>(owner, 'public.create_room', { p_name: 'pg17-audit', p_display_name: 'Dono', p_max_members: 3 }))[0]!.create_room;
  const member = await db.newUser();
  const token = (await db.rpc<{ token: string }>(owner, 'public.create_room_invite', { p_room_id: room, p_ttl_minutes: 10 }))[0]!.token;
  await db.rpc(member, 'public.redeem_room_invite', { p_token: token, p_display_name: 'NomePessoalMembro' });
  const join = async (u: { uid: string }) => (await db.rpc<{ session_id: string }>(u, 'public.join_room', { p_room_id: room }))[0]!.session_id;
  const o = await join(owner);
  const m = await join(member);
  const signal = async (u: { uid: string }, from: string, to: string, publish = true) => {
    const args = { p_session_id: from, p_to_session_id: to, p_client_msg_id: crypto.randomUUID(), p_kind: 'candidate', p_pair_epoch: 1, p_payload_bytes: 900 };
    const id = (await db.rpc<{ msg_id: string }>(u, 'public.authorize_signal', args))[0]!.msg_id;
    if (publish) for (const s of ['publishing', 'published']) await db.rpc('service', 'public.set_signal_state', { p_msg_id: id, p_state: s });
    return id;
  };
  const confirmed = await signal(member, m, o);
  expect(await db.rpc(owner, 'public.ack_signals', { p_session_id: o, p_msg_ids: [confirmed] })).toEqual([{ ack_signals: 1 }]);
  await signal(member, m, o); // PENDENTE (dono vivo, recém-publicado)
  const exhausted = await signal(member, m, o);
  await db.admin(`update oryn.signal_log set updated_at = now() - interval '20 seconds' where msg_id = $1`, [exhausted]);
  await signal(owner, o, m, false); // INCONCLUSIVO-SEM
  const audit = () => exec(SQL.replaceAll('<<ROOM_ID>>', room).replaceAll('<<T0_UTC>>', t0).replaceAll('<<T1_UTC>>', iso(Date.now() + 10 * 60_000)));

  let before = await snapshot();
  let rows = await audit();
  expect(await snapshot()).toBe(before);
  expect(one(rows, 'INFO B2 classes')[0]!.actual).toBe('1 / 1 / 1 / 0 / 0 / 1');
  expect(one(rows, 'A1 sala encerrada')[0]!.status).toBe('FAIL');
  expect(one(rows, 'INFO B3')[0]!.actual).toMatch(/^1 \/ \d+ \/ \d+ \/ \d+$/);

  await db.rpc(owner, 'public.close_room', { p_room_id: room });
  before = await snapshot();
  rows = await audit();
  expect(await snapshot()).toBe(before);
  expect(rows.filter((r) => r.status === 'FAIL')).toEqual([]);
  expect(one(rows, 'A1 sessões vivas')[0]!.actual).toBe('2 de 2');
  expect(one(rows, 'INFO B2 classes')[0]!.actual).toBe('1 / 0 / 1 / 1 / 0 / 1'); // o PENDENTE vira FIM-JANELA
  const text = JSON.stringify(rows);
  expect(text).not.toMatch(UUID);
  expect(text).not.toContain('NomePessoalMembro');

  const injected = SQL.replace(/rollback;\s*$/, `update oryn.rooms set name = 'x';\nrollback;`)
    .replaceAll('<<ROOM_ID>>', room).replaceAll('<<T0_UTC>>', t0).replaceAll('<<T1_UTC>>', iso(Date.now() + 60_000));
  await expect(exec(injected)).rejects.toThrow(/read-only transaction/);
  await expect(exec(SQL)).rejects.toThrow(/uuid/i);
  expect(await snapshot()).toBe(before);
});
