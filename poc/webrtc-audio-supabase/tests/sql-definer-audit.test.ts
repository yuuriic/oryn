// Auditoria das funções SECURITY DEFINER (02C.1B.0A), em Postgres real (PGlite) com o shim do Supabase.
// 1. Catálogo: o conjunto de funções expostas em `public` é EXATAMENTE o contrato; ninguém além do dono e
//    do papel previsto tem EXECUTE, inclusive por herança de PUBLIC (proacl NULL = padrão do Postgres).
// 2. Autorização interna: cada RPC de usuário chama oryn.require_uid() e recusa usuário sem convite,
//    sessão alheia e IDs arbitrários, SEM efeito colateral no banco.
// 3. Independência de RLS: as funções rodam como dono das tabelas (que ignora RLS sem FORCE), então a
//    proteção é a lógica interna. A mesma matriz roda de novo com o RLS DESLIGADO e dá o mesmo resultado.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestDb, type Actor } from './helpers/db.ts';
import { roomInvite, scenario, signalArgs, type Scenario } from './helpers/fixtures.ts';

const USER_RPCS: Record<string, string> = {
  redeem_creator_invite: 'public.redeem_creator_invite(text)',
  create_room: 'public.create_room(text,text,integer)',
  create_room_invite: 'public.create_room_invite(uuid,integer)',
  revoke_room_invite: 'public.revoke_room_invite(uuid)',
  redeem_room_invite: 'public.redeem_room_invite(text,text)',
  join_room: 'public.join_room(uuid)',
  touch_session: 'public.touch_session(uuid)',
  leave_room: 'public.leave_room(uuid)',
  get_roster: 'public.get_roster(uuid)',
  authorize_signal: 'public.authorize_signal(uuid,uuid,uuid,text,integer,integer)',
  ack_signals: 'public.ack_signals(uuid,uuid[])',
};
const SERVICE_RPCS: Record<string, string> = { set_signal_state: 'public.set_signal_state(uuid,text)' };

/** Quem, além do dono, pode ter EXECUTE em cada função das schemas da Oryn. Ausente = ninguém. */
const ALLOWED_GRANTEES: Record<string, string[]> = {
  ...Object.fromEntries(Object.values(USER_RPCS).map((sig) => [sig, ['authenticated']])),
  [SERVICE_RPCS['set_signal_state']!]: ['service_role'],
  'oryn_realtime.can_receive_topic(text)': ['authenticated'],
};

// Token com formato válido (43 caracteres base64url) que não corresponde a nenhum convite.
const randomToken = () => Buffer.from(randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), 'hex').toString('base64url');

interface Case {
  label: string;
  actor: Actor;
  fn: string;
  args: Record<string, unknown>;
  error: RegExp | null; // null = não falha, mas também não pode alterar nada
}

function matrix(s: Scenario, stranger: { uid: string }, inviteToken: string): Case[] {
  const rnd = randomUUID;
  return [
    { label: 'sem convite: resgata convite de criador inexistente', actor: stranger, fn: 'redeem_creator_invite', args: { p_token: randomToken() }, error: /invite-invalid/ },
    { label: 'sem convite: token malformado', actor: stranger, fn: 'redeem_creator_invite', args: { p_token: "x' or 1=1 --" }, error: /invite-invalid/ },
    { label: 'sem convite de criador: cria sala', actor: stranger, fn: 'create_room', args: { p_name: 'x', p_display_name: 'x', p_max_members: 3 }, error: /unauthorized/ },
    { label: 'membro sem convite de criador: cria sala', actor: s.member, fn: 'create_room', args: { p_name: 'x', p_display_name: 'x', p_max_members: 3 }, error: /unauthorized/ },
    { label: 'estranho: emite convite na sala alheia', actor: stranger, fn: 'create_room_invite', args: { p_room_id: s.room, p_ttl_minutes: 10 }, error: /unauthorized/ },
    { label: 'membro (não dono): emite convite', actor: s.member, fn: 'create_room_invite', args: { p_room_id: s.room, p_ttl_minutes: 10 }, error: /unauthorized/ },
    { label: 'dono: emite convite em sala arbitrária', actor: s.owner, fn: 'create_room_invite', args: { p_room_id: rnd(), p_ttl_minutes: 10 }, error: /unauthorized/ },
    { label: 'estranho: revoga convites da sala alheia', actor: stranger, fn: 'revoke_room_invite', args: { p_room_id: s.room }, error: /unauthorized/ },
    { label: 'membro (não dono): revoga convites', actor: s.member, fn: 'revoke_room_invite', args: { p_room_id: s.room }, error: /unauthorized/ },
    { label: 'sala arbitrária: revoga convites', actor: s.owner, fn: 'revoke_room_invite', args: { p_room_id: rnd() }, error: /unauthorized/ },
    { label: 'sem convite: resgata convite de sala inexistente', actor: stranger, fn: 'redeem_room_invite', args: { p_token: randomToken(), p_display_name: 'x' }, error: /invite-invalid/ },
    { label: 'já membro: resgata convite válido (não consome)', actor: s.member, fn: 'redeem_room_invite', args: { p_token: inviteToken, p_display_name: 'x' }, error: /already-member/ },
    { label: 'estranho: entra na sala alheia', actor: stranger, fn: 'join_room', args: { p_room_id: s.room }, error: /not-member/ },
    { label: 'sala arbitrária: entra', actor: s.member, fn: 'join_room', args: { p_room_id: rnd() }, error: /not-member/ },
    { label: 'estranho: batimento da sessão alheia', actor: stranger, fn: 'touch_session', args: { p_session_id: s.memberSession }, error: /session-invalid/ },
    { label: 'dono: batimento da sessão do membro', actor: s.owner, fn: 'touch_session', args: { p_session_id: s.memberSession }, error: /session-invalid/ },
    { label: 'sessão arbitrária: batimento', actor: s.member, fn: 'touch_session', args: { p_session_id: rnd() }, error: /session-invalid/ },
    { label: 'estranho: encerra sessão alheia', actor: stranger, fn: 'leave_room', args: { p_session_id: s.memberSession }, error: /session-invalid/ },
    { label: 'dono: encerra sessão do membro', actor: s.owner, fn: 'leave_room', args: { p_session_id: s.memberSession }, error: /session-invalid/ },
    { label: 'sessão arbitrária: encerra', actor: s.member, fn: 'leave_room', args: { p_session_id: rnd() }, error: /session-invalid/ },
    { label: 'estranho: lê participantes', actor: stranger, fn: 'get_roster', args: { p_room_id: s.room }, error: /not-member/ },
    { label: 'sala arbitrária: lê participantes', actor: s.member, fn: 'get_roster', args: { p_room_id: rnd() }, error: /not-member/ },
    { label: 'estranho: sinaliza usando sessão alheia', actor: stranger, fn: 'authorize_signal', args: signalArgs(s.memberSession, s.ownerSession), error: /session-invalid/ },
    { label: 'dono: sinaliza como se fosse o membro', actor: s.owner, fn: 'authorize_signal', args: signalArgs(s.memberSession, s.ownerSession), error: /session-invalid/ },
    { label: 'sessões arbitrárias: sinaliza', actor: s.member, fn: 'authorize_signal', args: signalArgs(rnd(), rnd()), error: /session-invalid/ },
    { label: 'destino arbitrário: sinaliza', actor: s.member, fn: 'authorize_signal', args: signalArgs(s.memberSession, rnd()), error: /recipient-invalid/ },
    { label: 'estranho: confirma mensagens na sessão alheia', actor: stranger, fn: 'ack_signals', args: { p_session_id: s.memberSession, p_msg_ids: [rnd()] }, error: /session-invalid/ },
    { label: 'sessão arbitrária: confirma', actor: s.member, fn: 'ack_signals', args: { p_session_id: rnd(), p_msg_ids: [rnd()] }, error: /session-invalid/ },
    { label: 'própria sessão, mensagens arbitrárias: nada muda', actor: s.member, fn: 'ack_signals', args: { p_session_id: s.memberSession, p_msg_ids: [rnd()] }, error: null },
    { label: 'usuário: transição de publicação (só service_role)', actor: s.owner, fn: 'set_signal_state', args: { p_msg_id: rnd(), p_state: 'published' }, error: /permission denied/ },
    { label: 'anon: transição de publicação', actor: 'anon', fn: 'set_signal_state', args: { p_msg_id: rnd(), p_state: 'published' }, error: /permission denied/ },
    { label: 'anon: entra na sala', actor: 'anon', fn: 'join_room', args: { p_room_id: s.room }, error: /permission denied/ },
  ];
}

/** Impressão digital de TODO o conteúdo do schema oryn e de realtime.messages. */
async function fingerprint(db: TestDb): Promise<string> {
  const tables = await db.admin<{ t: string }>(`select c.oid::regclass::text as t from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'oryn' and c.relkind = 'r' order by 1`);
  const parts: string[] = [];
  for (const { t } of [...tables, { t: 'realtime.messages' }]) {
    const rows = await db.admin<{ h: string | null }>(`select md5(string_agg(x::text, '|' order by x::text)) as h from ${t} x`);
    parts.push(`${t}=${rows[0]?.h ?? 'vazio'}`);
  }
  return parts.join(';');
}

async function runMatrix(db: TestDb): Promise<void> {
  const s = await scenario(db);
  const stranger = await db.newUser();
  const inviteToken = await roomInvite(db, s.owner, s.room);
  for (const c of matrix(s, stranger, inviteToken)) {
    const before = await fingerprint(db);
    const error = await db.rpcError(c.actor, `public.${c.fn}`, c.args);
    if (c.error) expect(error, c.label).toMatch(c.error);
    else expect(error, c.label).toBeNull();
    expect(await fingerprint(db), `${c.label}: sem efeito colateral`).toBe(before);
  }
}

describe('catálogo: funções expostas e privilégio EXECUTE', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await TestDb.create();
  });
  afterAll(() => db.close());

  it('public contém EXATAMENTE as 12 RPCs do contrato, todas SECURITY DEFINER com search_path vazio', async () => {
    const rows = await db.admin<{ sig: string; definer: boolean; cfg: string[] | null }>(
      `select p.oid::regprocedure::text as sig, p.prosecdef as definer, p.proconfig as cfg
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' order by 1`,
    );
    const expected = [...Object.values(USER_RPCS), ...Object.values(SERVICE_RPCS)].map((s) => s.replace('public.', '')).sort();
    expect(rows.map((r) => r.sig).sort()).toEqual(expected);
    for (const r of rows) {
      expect(r.definer, r.sig).toBe(true);
      expect(r.cfg, r.sig).toContain('search_path=""');
    }
  });

  it('nenhum papel além do dono e do previsto tem EXECUTE — inclusive PUBLIC (proacl NULL conta como padrão)', async () => {
    const rows = await db.admin<{ sig: string; grantee: string }>(
      `select n.nspname || '.' || p.proname || '(' || replace(oidvectortypes(p.proargtypes), ' ', '') || ')' as sig,
              case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
              aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where n.nspname in ('public', 'oryn', 'oryn_realtime') and a.privilege_type = 'EXECUTE' and a.grantee <> p.proowner`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(ALLOWED_GRANTEES[r.sig] ?? [], `${r.grantee} executa ${r.sig}`).toContain(r.grantee);
    // E cada papel previsto tem de fato o EXECUTE (o contrato não ficou vazio).
    for (const [sig, roles] of Object.entries(ALLOWED_GRANTEES)) {
      for (const role of roles) expect((await db.admin<{ ok: boolean }>(`select has_function_privilege($1, $2, 'EXECUTE') as ok`, [role, sig]))[0]!.ok, `${role} ${sig}`).toBe(true);
    }
  });

  it('papéis de cliente não herdam privilégios de nenhum outro papel', async () => {
    const rows = await db.admin<{ member: string; role: string }>(
      `select pg_get_userbyid(m.member) as member, pg_get_userbyid(m.roleid) as role from pg_auth_members m
        where pg_get_userbyid(m.member) in ('anon', 'authenticated')`,
    );
    expect(rows).toEqual([]);
  });

  it('toda RPC de usuário deriva o chamador de auth.uid() (oryn.require_uid) antes de qualquer acesso', async () => {
    for (const sig of Object.values(USER_RPCS)) {
      const src = (await db.admin<{ src: string }>(`select prosrc as src from pg_proc where oid = $1::regprocedure`, [sig]))[0]!.src;
      expect(src, sig).toMatch(/v_uid uuid := oryn\.require_uid\(\)/);
    }
  });

  it('a proteção NÃO é o RLS: funções e tabelas têm o mesmo dono, sem FORCE ROW LEVEL SECURITY', async () => {
    const owners = await db.admin<{ owner: string }>(
      `select distinct pg_get_userbyid(p.proowner) as owner from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'oryn', 'oryn_realtime') and p.prosecdef
       union
       select distinct pg_get_userbyid(c.relowner) from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'oryn' and c.relkind = 'r'`,
    );
    expect(owners.map((o) => o.owner)).toEqual(['migration_owner']);
    const forced = await db.admin<{ n: number }>(`select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'oryn' and c.relforcerowsecurity`);
    expect(forced[0]!.n).toBe(0);
  });
});

describe('autorização interna: sem convite, sessões alheias e IDs arbitrários (RLS ligado)', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await TestDb.create();
  });
  afterAll(() => db.close());

  it('cada chamada é recusada com o código esperado e não altera nada', async () => {
    await runMatrix(db);
  });
});

describe('autorização interna com RLS DESLIGADO nas tabelas de domínio (independência de RLS)', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await TestDb.create();
    await db.pg.exec('set role migration_owner');
    const tables = await db.admin<{ t: string }>(`select c.oid::regclass::text as t from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'oryn' and c.relkind = 'r'`);
    for (const { t } of tables) await db.pg.exec(`alter table ${t} disable row level security`);
    await db.pg.exec('reset role');
  });
  afterAll(() => db.close());

  it('a mesma matriz dá os mesmos resultados, sem efeito colateral', async () => {
    await runMatrix(db);
  });

  it('e o acesso direto às tabelas continua negado pelos privilégios (não pelo RLS)', async () => {
    const s = await scenario(db);
    await expect(db.as(s.member, (tx) => tx.query('select * from oryn.rooms'))).rejects.toThrow(/permission denied/);
  });
});
