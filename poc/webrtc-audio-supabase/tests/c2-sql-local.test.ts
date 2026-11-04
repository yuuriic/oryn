// 12_c2_preflight.sql e 13_c2_postflight.sql (02C.7P-A) executados de verdade no PGlite com o shim. A "execução"
// da C2 é simulada pelos FLUXOS REAIS (RPCs da 0200, realtime.send do shim), com as 3 contas e-mail/senha.
// Garante: nenhuma escrita, nenhum dado pessoal na saída, dados anteriores separados da janela e cada resíduo
// indevido virando FAIL.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TestDb } from './helpers/db.ts';
import { creatorToken, openSession, roomInvite, signalArgs } from './helpers/fixtures.ts';

const sql = (name: string) => readFileSync(fileURLToPath(new URL(`../integration/sql/${name}`, import.meta.url)), 'utf8');

interface Row {
  item: string;
  expected: string;
  actual: string;
  status: 'PASS' | 'FAIL' | 'INFO';
}

// O shim só tem o mínimo do Auth: colunas e tabelas do Supabase usadas pelas leituras, com os mesmos nomes.
// Fuso UTC como no Supabase: realtime.messages.inserted_at é `timestamp` sem fuso (o PGlite herda o do host).
const AUTH_STUBS = `
  set time zone 'UTC';
  alter table auth.users add column email text, add column email_confirmed_at timestamptz, add column banned_until timestamptz,
    add column deleted_at timestamptz, add column is_sso_user boolean not null default false, add column last_sign_in_at timestamptz;
  create table auth.identities (id uuid primary key default gen_random_uuid(), user_id uuid not null, provider text not null);
  create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null, created_at timestamptz not null default now(), not_after timestamptz);
  create table auth.refresh_tokens (id bigserial primary key, session_id uuid, revoked boolean not null default false);
  create schema supabase_migrations;
  create table supabase_migrations.schema_migrations (version text primary key);
  insert into supabase_migrations.schema_migrations values ('20261023000100'), ('20261023000200'), ('20261023000300'), ('20261028000400');`;

const EMAILS = { owner: 'dono+oryn@teste.example', member: 'membro+oryn@teste.example', stranger: 'estranho+oryn@teste.example' };
type Accounts = Record<keyof typeof EMAILS, { uid: string }>;

/** As 3 contas como o painel cria (dias antes da C2): confirmadas, não anônimas, 1 identidade `email` cada. */
async function provision(db: TestDb): Promise<Accounts> {
  const out = {} as Accounts;
  for (const [role, email] of Object.entries(EMAILS) as [keyof typeof EMAILS, string][]) {
    const uid = randomUUID();
    await db.admin(`insert into auth.users (id, is_anonymous, email, email_confirmed_at, created_at) values ($1, false, $2, now(), now() - interval '2 days')`, [uid, email]);
    await db.admin(`insert into auth.identities (user_id, provider) values ($1, 'email')`, [uid]);
    out[role] = { uid };
  }
  return out;
}

async function setup(): Promise<{ db: TestDb; acc: Accounts }> {
  const db = await TestDb.create();
  await db.pg.exec(AUTH_STUBS);
  return { db, acc: await provision(db) };
}

const byItem = (rows: Row[]) => Object.fromEntries(rows.map((r) => [r.item.startsWith('INFO') ? r.item : r.item.split(' ')[0]!, r]));
async function run(db: TestDb, text: string): Promise<Row[]> {
  const res = await db.pg.exec(text);
  return res.find((r) => r.fields.some((f) => f.name === 'status'))!.rows as Row[];
}
const preflight = async (db: TestDb) => byItem(await run(db, sql('12_c2_preflight.sql')));
const postflight = async (db: TestDb, t0: string, t1: string) =>
  byItem(await run(db, sql('13_c2_postflight.sql').replaceAll('<<T0_UTC>>', t0).replaceAll('<<T1_UTC>>', t1)));
const statusOf = (r: Record<string, Row>, items: string[]) => items.map((i) => `${i}=${r[i]?.status}`);

/** Uma C2 password como o harness faz, pelos fluxos reais: login simulado (sessão de Auth), sala, sessões, #18, saída. */
async function simulateC2(db: TestDb, acc: Accounts): Promise<void> {
  const authSessions: string[] = [];
  for (const a of Object.values(acc)) {
    const sid = randomUUID();
    await db.admin('insert into auth.sessions (id, user_id) values ($1, $2)', [sid, a.uid]);
    await db.admin('insert into auth.refresh_tokens (session_id) values ($1)', [sid]);
    authSessions.push(sid);
  }
  await db.rpc(acc.owner, 'public.redeem_creator_invite', { p_token: await creatorToken(db, 10, 1) });
  const room = (await db.rpc<{ create_room: string }>(acc.owner, 'public.create_room', { p_name: 'it-02c4b-abcd1234', p_display_name: 'it-owner', p_max_members: 10 }))[0]!.create_room;
  await db.rpc(acc.member, 'public.redeem_room_invite', { p_token: await roomInvite(db, acc.owner, room), p_display_name: 'it-member' });
  const ownerSession = await openSession(db, acc.owner, room);
  const memberSession = await openSession(db, acc.member, room);
  for (let i = 0; i < 5; i++) await db.rpc(acc.member, 'public.authorize_signal', signalArgs(memberSession, ownerSession, { p_client_msg_id: '00000000-0000-4000-8000-000000000001', p_kind: 'candidate' }));
  await db.rpc(acc.owner, 'public.leave_room', { p_session_id: ownerSession });
  await db.rpc(acc.member, 'public.leave_room', { p_session_id: memberSession });
  // signOut local: o refresh token é revogado; a linha da sessão pode continuar (não pressupor exclusão).
  for (const sid of authSessions) await db.admin('update auth.refresh_tokens set revoked = true where session_id = $1', [sid]);
}

const iso = (ms: number) => new Date(ms).toISOString();

describe('12_c2_preflight.sql (02C.7P-A, G2/G3)', () => {
  it('3 contas confirmadas e banco vazio: contas, dados, migrações e papéis PASS; fingerprints FAIL só por causa do shim', async () => {
    const { db } = await setup();
    try {
      const r = await preflight(db);
      for (const i of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'D1', 'D2', 'D3', 'D4', 'D5', 'S1', 'S4', 'S5']) expect(r[i]?.status, `${i}: ${r[i]?.actual}`).toBe('PASS');
      expect([r['S2']!.status, r['S3']!.status]).toEqual(['FAIL', 'FAIL']); // objetos de teste do shim; no projeto real, PASS
    } finally {
      await db.close();
    }
  });

  it('nenhum e-mail na saída: contas aparecem só com id curto e impressão md5', async () => {
    const { db } = await setup();
    try {
      const rows = await run(db, sql('12_c2_preflight.sql'));
      const text = JSON.stringify(rows);
      for (const e of Object.values(EMAILS)) expect(text).not.toContain(e.split('@')[0]);
      expect(text).not.toMatch(/@teste\.example/);
      const contas = rows.filter((x) => x.item.startsWith('INFO conta '));
      expect(contas).toHaveLength(3);
      for (const c of contas) expect(c.actual).toMatch(/^id=[0-9a-f]{8} email#=[0-9a-f]{8} criada=\S+Z ultimo_login=-$/);
    } finally {
      await db.close();
    }
  });

  it.each([
    ['conta a mais (cadastro de terceiro, anônimo)', `insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true)`, ['A1', 'A2']],
    ['e-mail não confirmado', `update auth.users set email_confirmed_at = null where email like 'membro%'`, ['A3']],
    ['e-mail repetido (maiúsculas)', `update auth.users set email = upper((select email from auth.users where email like 'dono%')) where email like 'membro%'`, ['A4']],
    ['conta banida', `update auth.users set banned_until = now() + interval '1 day' where email like 'estranho%'`, ['A5']],
    ['identidade extra de outro provedor', `insert into auth.identities (user_id, provider) select id, 'google' from auth.users where email like 'dono%'`, ['A6']],
    ['sessão de Auth ativa', `with s as (insert into auth.sessions (user_id) select id from auth.users where email like 'dono%' returning id) insert into auth.refresh_tokens (session_id) select id from s`, ['A7']],
    ['sala aberta de execução anterior', null, ['D2']],
    ['convite de criador utilizável', `select oryn.admin_issue_creator_invite(10, 1)`, ['D3']],
    ['evento signal em oryn:*', `insert into realtime.messages (topic, extension, payload, event, private) values ('oryn:s:x', 'broadcast', '{"sdp":"x"}', 'signal', true)`, ['D5']],
  ])('%s → FAIL', async (_label, mutation, items) => {
    const { db, acc } = await setup();
    try {
      if (mutation) await db.admin(mutation);
      else await db.rpc(acc.owner, 'public.redeem_creator_invite', { p_token: await creatorToken(db, 10, 1) }).then(() =>
        db.rpc(acc.owner, 'public.create_room', { p_name: 'it-02c4b-anterior', p_display_name: 'x', p_max_members: 10 }));
      const r = await preflight(db);
      expect(statusOf(r, items)).toEqual(items.map((i) => `${i}=FAIL`));
    } finally {
      await db.close();
    }
  });

  it('M3: o INFO aponta QUAL conta tem sessão de Auth ativa (id curto=quantidade), sem e-mail', async () => {
    const { db, acc } = await setup();
    try {
      const item = 'INFO sessões de Auth ativas por conta (id curto=quantidade)';
      expect((await preflight(db))[item]!.actual).toBe('(nenhuma)');
      for (let i = 0; i < 2; i++) {
        await db.admin(`with s as (insert into auth.sessions (user_id) values ($1) returning id) insert into auth.refresh_tokens (session_id) select id from s`, [acc.member.uid]);
      }
      const r = await preflight(db);
      expect(r[item]!.actual).toBe(`${acc.member.uid.slice(0, 8)}=2`);
      expect(r['A7']!.status).toBe('FAIL');
    } finally {
      await db.close();
    }
  });

  it('sessão de Auth encerrada que continua como linha (refresh token revogado) NÃO conta como ativa', async () => {
    const { db } = await setup();
    try {
      await db.admin(`with s as (insert into auth.sessions (user_id) select id from auth.users where email like 'dono%' returning id)
                      insert into auth.refresh_tokens (session_id, revoked) select id, true from s`);
      const r = await preflight(db);
      expect(r['A7']!.status).toBe('PASS');
      expect(r['INFO dados anteriores: linhas em auth.sessions / refresh tokens não revogados']!.actual).toBe('1 / 0');
    } finally {
      await db.close();
    }
  });
});

describe('13_c2_postflight.sql (02C.7P-A, G2)', () => {
  it('sem trocar os marcadores <<T0_UTC>>/<<T1_UTC>>, a consulta falha (nunca roda com janela errada)', async () => {
    const { db } = await setup();
    try {
      await expect(db.pg.exec(sql('13_c2_postflight.sql'))).rejects.toThrow(/T0_UTC|invalid input syntax/);
    } finally {
      await db.close();
    }
  });

  it('C2 simulada pelos fluxos reais: tudo PASS (menos os fingerprints do shim); dados anteriores separados da janela', async () => {
    const { db, acc } = await setup();
    try {
      // Execução ANTERIOR (fora da janela), já limpa de sala aberta: sala fechada, sessão revogada, hello/bye antigos.
      await db.rpc(acc.owner, 'public.redeem_creator_invite', { p_token: await creatorToken(db, 10, 1) });
      const old = (await db.rpc<{ create_room: string }>(acc.owner, 'public.create_room', { p_name: 'it-02c4b-anterior', p_display_name: 'x', p_max_members: 10 }))[0]!.create_room;
      await db.rpc(acc.owner, 'public.leave_room', { p_session_id: await openSession(db, acc.owner, old) });
      await db.admin(`update oryn.rooms set created_at = now() - interval '1 day', closed_at = now() where id = $1`, [old]);
      await db.admin(`update oryn.room_sessions set created_at = now() - interval '1 day' where room_id = $1`, [old]);
      // publish_control só publica para OUTRAS sessões (sala de 1 sessão não gera hello): hello antigo explícito.
      await db.admin(`insert into realtime.messages (topic, extension, payload, event, private, inserted_at)
                      values ('oryn:s:00000000-0000-4000-8000-00000000000a', 'broadcast', '{"session_id":"x","label":"y"}', 'hello', true, now() - interval '1 day')`);
      await db.admin(`update oryn.creator_invites set created_at = created_at - interval '1 day', expires_at = expires_at - interval '1 day', used_at = used_at - interval '1 day'`);

      const t0 = iso(Date.now() - 1000);
      await simulateC2(db, acc);
      const r = await postflight(db, t0, iso(Date.now() + 1000));
      const fails = Object.values(r).filter((x) => x.status === 'FAIL').map((x) => `${x.item.split(' ')[0]}: ${x.actual}`);
      expect(fails).toEqual([expect.stringMatching(/^S2:/), expect.stringMatching(/^S3:/)]); // só o shim
      expect(r['R1']!.actual).toBe('1 / 1');
      expect(r['R8']!.actual).toBe('1 / 1');
      expect(r['M1']!.actual).toMatch(/^[1-9]\d* \/ [1-9]\d*$/);
      expect(r['INFO dados anteriores a T0: salas / sessões de sala / convites de sala / signal_log / realtime.messages em oryn:*']!.actual).toMatch(/^1 \/ 1 \/ 0 \/ 0 \/ [1-9]/);
      expect(r['INFO linhas de auth.sessions criadas na janela (encerradas podem continuar como linha)']!.actual).toBe('3');
      expect(r['INFO sessões de sala da janela: total / motivos de revogação']!.actual).toBe('2 / left=2');
      expect(JSON.stringify(Object.values(r))).not.toMatch(/@teste\.example/);
    } finally {
      await db.close();
    }
  });

  it.each([
    ['sessão de sala da janela não revogada', async (db: TestDb, acc: Accounts) => {
      const room = (await db.admin<{ id: string }>(`select id from oryn.rooms where name like 'it-02c4b-%'`))[0]!.id;
      await openSession(db, acc.member, room);
    }, ['R6']],
    ['convite de criador utilizável sobrando', async (db: TestDb) => void (await creatorToken(db, 10, 1)), ['R4']],
    ['mensagem de cliente fora de oryn:s:* e evento signal', async (db: TestDb) => void (await db.admin(
      `insert into realtime.messages (topic, extension, payload, event, private) values ('it-c2-x', 'broadcast', '{}', 'x', true), ('oryn:s:00000000-0000-4000-8000-000000000009', 'broadcast', '{"forged":true}', 'signal', true)`)), ['M2', 'M3']],
    ['conta nova na janela', async (db: TestDb) => void (await db.admin(`insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true)`)), ['A1', 'A8']],
    ['sessão de Auth que o signOut não encerrou', async (db: TestDb) => void (await db.admin(`update auth.refresh_tokens set revoked = false where id = (select min(id) from auth.refresh_tokens)`)), ['A7']],
  ])('%s → FAIL', async (_label, mutate, items) => {
    const { db, acc } = await setup();
    try {
      const t0 = iso(Date.now() - 1000);
      await simulateC2(db, acc);
      await mutate(db, acc);
      const r = await postflight(db, t0, iso(Date.now() + 1000));
      expect(statusOf(r, items)).toEqual(items.map((i) => `${i}=FAIL`));
    } finally {
      await db.close();
    }
  });

  it('B6: T0/T1 com 7 casas decimais (formato do horario.txt) funcionam; janela invertida ou de 30 min ou mais = J1 FAIL', async () => {
    const seven = (ms: number) => iso(ms).replace(/\.(\d{3})Z$/, (_m, frac: string) => `.${frac}4567Z`);
    const { db, acc } = await setup();
    try {
      const t0 = Date.now() - 1000;
      await simulateC2(db, acc);
      const t1 = Date.now() + 1000;
      expect(seven(t0)).toMatch(/\.\d{7}Z$/);
      const ok = await postflight(db, seven(t0), seven(t1));
      expect([ok['J1']!.status, ok['R1']!.actual, ok['R8']!.actual]).toEqual(['PASS', '1 / 1', '1 / 1']);
      expect((await postflight(db, seven(t1), seven(t0)))['J1']!.status).toBe('FAIL');
      expect((await postflight(db, iso(t1 - 30 * 60_000), iso(t1)))['J1']!.status).toBe('FAIL');
      expect((await postflight(db, iso(t1 - 29 * 60_000), iso(t1)))['J1']!.status).toBe('PASS');
    } finally {
      await db.close();
    }
  });

  it('execução que não chegou à sala (beforeAll falhou): R1 e M1 FAIL, nenhuma conta nem sessão ativa', async () => {
    const { db } = await setup();
    try {
      const r = await postflight(db, iso(Date.now() - 1000), iso(Date.now() + 1000));
      expect(statusOf(r, ['R1', 'M1', 'A1', 'A7'])).toEqual(['R1=FAIL', 'M1=FAIL', 'A1=PASS', 'A7=PASS']);
    } finally {
      await db.close();
    }
  });
});

describe('12/13: somente leitura', () => {
  it.each(['12_c2_preflight.sql', '13_c2_postflight.sql'])('%s roda em transação READ ONLY, termina em ROLLBACK e não tem comando de escrita', (name) => {
    const text = sql(name);
    expect(text).toMatch(/^begin;\r?\nset transaction read only;/m);
    expect(text.trimEnd()).toMatch(/rollback;$/);
    expect(text.replace(/--.*$/gm, '')).not.toMatch(/\b(insert|update|delete|truncate|create|drop|alter|grant|revoke|copy|call|perform)\b/i);
    // Nenhuma coluna com segredo do Auth é lida (token do refresh, senha, links de confirmação/recuperação).
    expect(text.replace(/--.*$/gm, '')).not.toMatch(/\b(token|encrypted_password|confirmation_token|recovery_token|raw_user_meta_data)\b/);
  });

  it('as definições compartilhadas (oryn_scope, platform, contas) são idênticas no 11, no 12 e no 13', () => {
    const block = (text: string, start: string, end: string) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
    const scope = (t: string) => block(t, 'oryn_scope as (', 'platform as (');
    const accounts = (t: string) => block(t, 'accounts as (', 'active_sessions as (');
    const sessions = (t: string) => block(t, 'active_sessions as (', '\n),');
    const [s11, s12, s13] = ['11_c0w_postflight.sql', '12_c2_preflight.sql', '13_c2_postflight.sql'].map(sql) as [string, string, string];
    expect(scope(s12)).toBe(scope(s11));
    expect(scope(s13)).toBe(scope(s11));
    expect(accounts(s13)).toBe(accounts(s12));
    expect(sessions(s13)).toBe(sessions(s12));
    expect(accounts(s12).length).toBeGreaterThan(400);
    expect(sessions(s12)).toMatch(/not_after[\s\S]*not coalesce\(r\.revoked, false\)/);
  });

  it('MVP 01: o oryn_scope do 08 (entradas) é idêntico ao do 07 e do 11, inclusive a fórmula do total/md5', () => {
    const core = (t: string) => t.slice(t.indexOf('oryn_scope as ('), t.indexOf('\n),', t.indexOf('oryn_scope as (')));
    const [s07, s08, s11] = ['07_initial_state.sql', '08_scope_entries.sql', '11_c0w_postflight.sql'].map(sql) as [string, string, string];
    expect(core(s08).length).toBeGreaterThan(1000);
    expect(core(s08)).toBe(core(s07));
    expect(core(s08)).toBe(core(s11));
    expect(s08).toContain(`pg_catalog.md5(coalesce(pg_catalog.string_agg(o, '|' order by o), ''))`);
    expect(s11).toContain(`pg_catalog.md5(coalesce(pg_catalog.string_agg(o, '|' order by o), ''))`);
  });

  it('MVP 01: 08 roda em transação READ ONLY, termina em ROLLBACK e não tem comando de escrita', () => {
    const text = sql('08_scope_entries.sql');
    expect(text).toMatch(/^begin;\r?\nset transaction read only;/m);
    expect(text.trimEnd()).toMatch(/rollback;$/);
    expect(text.replace(/--.*$/gm, '')).not.toMatch(/\b(insert|update|delete|truncate|create|drop|alter|grant|revoke|copy|call|perform)\b/i);
  });
});
