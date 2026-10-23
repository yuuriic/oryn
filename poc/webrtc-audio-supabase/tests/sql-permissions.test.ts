// Permissões de funções e tabelas (02C.1A), verificadas no CATÁLOGO do Postgres real (PGlite) e por
// tentativas efetivas com os papéis anon/authenticated/service_role do shim. O shim concede os privilégios
// PADRÃO do Supabase no schema public; estes testes provam que as migrações os neutralizam.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestDb } from './helpers/db.ts';
import { scenario, type Scenario } from './helpers/fixtures.ts';

let db: TestDb;
let s: Scenario;

beforeAll(async () => {
  db = await TestDb.create();
  s = await scenario(db);
});
afterAll(() => db.close());

const USER_RPCS = [
  'redeem_creator_invite(text)',
  'create_room(text,text,integer)',
  'create_room_invite(uuid,integer)',
  'revoke_room_invite(uuid)',
  'redeem_room_invite(text,text)',
  'join_room(uuid)',
  'touch_session(uuid)',
  'leave_room(uuid)',
  'get_roster(uuid)',
  'authorize_signal(uuid,uuid,uuid,text,integer,integer)',
  'ack_signals(uuid,uuid[])',
];
const DOMAIN_TABLES = ['creator_grants', 'creator_invites', 'rooms', 'room_members', 'room_invites', 'room_sessions', 'pair_counters', 'signal_log'];

const canExecute = async (role: string, signature: string): Promise<boolean> =>
  (await db.admin<{ ok: boolean }>(`select has_function_privilege($1, $2, 'execute') as ok`, [role, signature]))[0]!.ok;

describe('EXECUTE explícito', () => {
  it.each(USER_RPCS)('public.%s: authenticated sim; anon e PUBLIC não', async (sig) => {
    expect(await canExecute('authenticated', `public.${sig}`)).toBe(true);
    expect(await canExecute('anon', `public.${sig}`)).toBe(false);
    const publicGrant = await db.admin<{ n: number }>(
      `select count(*)::int as n from pg_proc p, aclexplode(p.proacl) a where p.oid = $1::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'`,
      [`public.${sig}`],
    );
    expect(publicGrant[0]!.n).toBe(0);
  });

  it('set_signal_state: só service_role (nem authenticated, nem anon)', async () => {
    expect(await canExecute('service_role', 'public.set_signal_state(uuid,text)')).toBe(true);
    expect(await canExecute('authenticated', 'public.set_signal_state(uuid,text)')).toBe(false);
    expect(await canExecute('anon', 'public.set_signal_state(uuid,text)')).toBe(false);
  });

  it('funções internas do schema oryn: nenhum papel de cliente executa (exceto o predicado do Realtime)', async () => {
    for (const sig of ['oryn.admin_issue_creator_invite(integer,integer)', 'oryn.publish_control(uuid,uuid,text,jsonb)', 'oryn.new_token()', 'oryn.token_hash(text)', 'oryn.is_active_member(uuid,uuid)']) {
      for (const role of ['anon', 'authenticated', 'service_role']) expect(await canExecute(role, sig), `${role} ${sig}`).toBe(false);
    }
    expect(await canExecute('authenticated', 'oryn_realtime.can_receive_topic(text)')).toBe(true);
    expect(await canExecute('anon', 'oryn_realtime.can_receive_topic(text)')).toBe(false);
    expect(await canExecute('service_role', 'oryn_realtime.can_receive_topic(text)')).toBe(false);
  });

  it('tentativas efetivas: anon não chama RPCs; authenticated não chama set_signal_state nem funções internas', async () => {
    expect(await db.rpcError('anon', 'public.join_room', { p_room_id: s.room })).toMatch(/permission denied/);
    expect(await db.rpcError('anon', 'public.redeem_room_invite', { p_token: 'A'.repeat(43), p_display_name: 'x' })).toMatch(/permission denied/);
    expect(await db.rpcError(s.owner, 'public.set_signal_state', { p_msg_id: s.room, p_state: 'published' })).toMatch(/permission denied/);
    expect(await db.rpcError(s.owner, 'oryn.admin_issue_creator_invite', { p_ttl_minutes: 60, p_max_open_rooms: 5 })).toMatch(/permission denied/);
    expect(await db.rpcError('service', 'oryn.admin_issue_creator_invite', { p_ttl_minutes: 60, p_max_open_rooms: 5 })).toMatch(/permission denied/);
    expect(await db.rpcError(s.owner, 'realtime.send', { payload: {}, event: 'x', topic: `oryn:s:${s.memberSession}` })).toMatch(/permission denied/);
  });

  it('SECURITY DEFINER sempre com search_path vazio', async () => {
    const rows = await db.admin<{ fn: string; cfg: string[] | null }>(
      `select p.oid::regprocedure::text as fn, p.proconfig as cfg from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'oryn', 'oryn_realtime') and p.prosecdef`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(14);
    for (const r of rows) expect(r.cfg, r.fn).toContain('search_path=""');
  });
});

describe('tabelas de domínio: acesso direto negado', () => {
  it('RLS habilitado e NENHUMA política nas tabelas do schema oryn', async () => {
    const rls = await db.admin<{ relname: string; rls: boolean }>(
      `select c.relname, c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'oryn' and c.relkind = 'r' order by 1`,
    );
    expect(rls.map((r) => r.relname).sort()).toEqual([...DOMAIN_TABLES].sort());
    expect(rls.every((r) => r.rls)).toBe(true);
    expect((await db.admin<{ n: number }>(`select count(*)::int as n from pg_policies where schemaname = 'oryn'`))[0]!.n).toBe(0);
  });

  it.each(DOMAIN_TABLES)('oryn.%s: nenhum privilégio para anon/authenticated/service_role', async (table) => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        const ok = (await db.admin<{ ok: boolean }>(`select has_table_privilege($1, $2, $3) as ok`, [role, `oryn.${table}`, priv]))[0]!.ok;
        expect(ok, `${role} ${priv} oryn.${table}`).toBe(false);
      }
    }
  });

  it('tentativas efetivas de leitura e escrita direta são negadas (inclusive forjar sessão)', async () => {
    const attempts = [
      'select * from oryn.rooms',
      'select * from oryn.room_invites',
      `insert into oryn.room_members (room_id, user_id, role, display_name) values ('${s.room}', '${s.member.uid}', 'owner', 'x')`,
      `update oryn.room_sessions set user_id = '${s.member.uid}'`,
      `insert into oryn.signal_log (session_id, to_session_id, client_msg_id, kind, pair_epoch, seq, payload_bytes) values ('${s.memberSession}', '${s.ownerSession}', gen_random_uuid(), 'offer', 1, 1, 10)`,
      'delete from oryn.signal_log',
    ];
    for (const sql of attempts) {
      await expect(db.as(s.member, (tx) => tx.query(sql)), sql).rejects.toThrow(/permission denied/);
    }
  });

  it('nenhuma coluna de domínio guarda SDP, candidatos ou payload; nenhuma RPC recebe payload', async () => {
    const cols = await db.admin<{ c: string }>(`select column_name as c from information_schema.columns where table_schema = 'oryn'`);
    expect(cols.map((r) => r.c).filter((c) => /sdp|candidate|payload$|ice|ip_|address/i.test(c))).toEqual([]);
    const args = await db.admin<{ a: string }>(
      `select pg_get_function_arguments(p.oid) as a from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'authorize_signal'`,
    );
    expect(args[0]!.a).not.toMatch(/payload\s+(jsonb|text)/);
  });
});
