// Papel SQL `anon` × usuário ANÔNIMO do Supabase Auth (02C.2C.1). No Supabase, quem fez signInAnonymously()
// recebe JWT com role = authenticated e is_anonymous = true: é `authenticated` para o Postgres. O papel
// `anon` é só a chave publicável SEM JWT de usuário. As políticas e grants da Oryn não podem confundir os dois:
// - usuário anônimo autenticado: passa pela autorização por convite/sessão, como qualquer authenticated;
// - papel anon: nenhuma RPC, nenhum tópico oryn:*, nem com um `sub` forjado nas claims.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestDb } from './helpers/db.ts';
import { scenario, type Scenario } from './helpers/fixtures.ts';

let db: TestDb;
let s: Scenario;

beforeAll(async () => {
  db = await TestDb.create();
  s = await scenario(db); // os usuários dos cenários usam claims com is_anonymous = true (helpers/db.ts)
});
afterAll(() => db.close());

/** Executa como o papel SQL `anon`, com claims arbitrárias (simula um JWT anon com `sub` forjado). */
const asAnonWithClaims = <T>(claims: Record<string, unknown>, sql: string, params: unknown[] = [], topic?: string) =>
  db.pg.transaction(async (tx) => {
    await tx.exec('set local role anon');
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    if (topic) await tx.query(`select set_config('realtime.topic', $1, true)`, [topic]);
    return (await tx.query<T>(sql, params)).rows;
  });

describe('usuário anônimo autenticado (role authenticated, is_anonymous = true)', () => {
  it('as políticas da Oryn são só para authenticated e anon; nenhuma depende de is_anonymous', async () => {
    const rows = await db.admin<{ policyname: string; roles: string[]; qual: string | null; with_check: string | null }>(
      `select policyname, roles, qual, with_check from pg_policies where schemaname = 'realtime' and policyname like 'oryn_%' order by 1`,
    );
    expect(rows.map((r) => [r.policyname, [...r.roles].sort()])).toEqual([
      ['oryn_receive_own_session_topic', ['authenticated']],
      ['oryn_topics_no_client_write', ['anon', 'authenticated']],
      ['oryn_topics_read_guard', ['authenticated']],
      ['oryn_topics_read_guard_anon', ['anon']],
    ]);
    for (const r of rows) expect(`${r.qual ?? ''} ${r.with_check ?? ''}`, r.policyname).not.toMatch(/is_anonymous/);
  });

  it('com convite, entra, assina o próprio tópico e sinaliza — como qualquer authenticated', async () => {
    expect(await db.canReceive(s.member, `oryn:s:${s.memberSession}`)).toBe(true);
    const r = await db.rpc<{ state: string }>(s.member, 'public.authorize_signal', {
      p_session_id: s.memberSession, p_to_session_id: s.ownerSession, p_client_msg_id: crypto.randomUUID(),
      p_kind: 'offer', p_pair_epoch: 1, p_payload_bytes: 100,
    });
    expect(r[0]!.state).toBe('accepted');
  });

  it('o mesmo usuário com is_anonymous = false tem exatamente a mesma autorização (a claim não é critério)', async () => {
    const r = await db.as(s.member, async (tx) => {
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: s.member.uid, role: 'authenticated', is_anonymous: false })]);
      return (await tx.query<{ n: number }>(`select count(*)::int as n from public.get_roster($1)`, [s.room])).rows;
    });
    expect(r[0]!.n).toBe(2);
  });
});

describe('papel SQL anon (chave publicável sem JWT de usuário)', () => {
  it('nenhuma RPC executa, mesmo com o `sub` de um membro forjado nas claims', async () => {
    for (const sql of [
      `select * from public.join_room($1)`,
      `select * from public.get_roster($1)`,
    ]) {
      await expect(asAnonWithClaims({ sub: s.member.uid, role: 'anon' }, sql, [s.room]), sql).rejects.toThrow(/permission denied/);
    }
  });

  it('não lê o tópico de uma sessão viva, mesmo com o `sub` do dono dela forjado', async () => {
    await db.admin(`insert into realtime.messages (topic, extension, event, payload, private) values ($1, 'broadcast', 'probe', '{}', true)`, [`oryn:s:${s.memberSession}`]);
    const rows = await asAnonWithClaims<{ n: number }>(
      { sub: s.member.uid, role: 'anon' },
      `select count(*)::int as n from realtime.messages where topic = realtime.topic()`,
      [],
      `oryn:s:${s.memberSession}`,
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('não escreve em tópicos oryn:* (nem em maiúsculas), mesmo com claims forjadas', async () => {
    for (const topic of [`oryn:s:${s.memberSession}`, `ORYN:S:${s.memberSession}`]) {
      await expect(
        asAnonWithClaims({ sub: s.member.uid, role: 'anon' }, `insert into realtime.messages (topic, extension, event, payload, private) values (realtime.topic(), 'broadcast', 'x', '{}', true)`, [], topic),
        topic,
      ).rejects.toThrow(/row-level security/);
    }
  });

  it('anon não tem USAGE no schema oryn nem no oryn_realtime', async () => {
    const r = await db.admin<{ a: boolean; b: boolean }>(`select has_schema_privilege('anon', 'oryn', 'USAGE') as a, has_schema_privilege('anon', 'oryn_realtime', 'USAGE') as b`);
    expect(r[0]).toEqual({ a: false, b: false });
  });
});
