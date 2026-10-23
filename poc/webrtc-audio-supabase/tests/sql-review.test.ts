// Revisão de segurança 02C.1A.1: matriz de privilégios efetivos (catálogo do Postgres real), dono não
// superusuário, RPCs sem acesso ao schema privado e barreiras restritivas do Realtime resistindo a uma
// política permissiva futura.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestDb } from './helpers/db.ts';
import { scenario, signalArgs, type Scenario } from './helpers/fixtures.ts';

let db: TestDb;
let s: Scenario;
beforeAll(async () => {
  db = await TestDb.create();
  s = await scenario(db);
});
afterAll(() => db.close());

const ROLES = ['anon', 'authenticated', 'service_role', 'migration_owner'] as const;
const yes = (rows: { ok: boolean }[]) => rows[0]!.ok;

describe('matriz de privilégios efetivos', () => {
  it('schemas: USAGE', async () => {
    const expected: Record<string, Record<(typeof ROLES)[number], boolean>> = {
      oryn: { anon: false, authenticated: false, service_role: false, migration_owner: true },
      oryn_realtime: { anon: false, authenticated: true, service_role: false, migration_owner: true },
      public: { anon: true, authenticated: true, service_role: true, migration_owner: true },
    };
    for (const [schema, byRole] of Object.entries(expected)) {
      for (const role of ROLES) {
        const ok = yes(await db.admin<{ ok: boolean }>(`select has_schema_privilege($1, $2, 'usage') as ok`, [role, schema]));
        expect(ok, `${role} USAGE ${schema}`).toBe(byRole[role]);
      }
    }
  });

  it('funções do domínio: EXECUTE por papel (exatamente o contrato)', async () => {
    const rows = await db.admin<{ fn: string; anon: boolean; authenticated: boolean; service_role: boolean }>(`
      select p.oid::regprocedure::text as fn,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
             has_function_privilege('service_role', p.oid, 'execute') as service_role
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('oryn', 'oryn_realtime')
          or (n.nspname = 'public' and p.proowner = 'migration_owner'::regrole)
       order by 1`);
    const matrix = Object.fromEntries(rows.map((r) => [r.fn, `${r.anon ? 'A' : '-'}${r.authenticated ? 'U' : '-'}${r.service_role ? 'S' : '-'}`]));
    const userRpc = '-U-';
    expect(matrix).toEqual({
      'ack_signals(uuid,uuid[])': userRpc,
      'authorize_signal(uuid,uuid,uuid,text,integer,integer)': userRpc,
      'create_room(text,text,integer)': userRpc,
      'create_room_invite(uuid,integer)': userRpc,
      'get_roster(uuid)': userRpc,
      'join_room(uuid)': userRpc,
      'leave_room(uuid)': userRpc,
      'redeem_creator_invite(text)': userRpc,
      'redeem_room_invite(text,text)': userRpc,
      'revoke_room_invite(uuid)': userRpc,
      'set_signal_state(uuid,text)': '--S',
      'touch_session(uuid)': userRpc,
      'oryn.admin_issue_creator_invite(integer,integer)': '---',
      'oryn.is_active_member(uuid,uuid)': '---',
      'oryn.is_token(text)': '---',
      'oryn.new_token()': '---',
      'oryn.publish_control(uuid,uuid,text,jsonb)': '---',
      'oryn.require_uid()': '---',
      'oryn.session_is_fresh(timestamp with time zone)': '---',
      'oryn.token_hash(text)': '---',
      'oryn.valid_label(text,integer)': '---',
      'oryn_realtime.can_receive_topic(text)': '-U-',
    });
  });

  it('dono das migrações: não é superusuário, não ignora RLS, é dono de tudo e nenhum cliente herda dele', async () => {
    const role = (await db.admin<{ rolsuper: boolean; rolbypassrls: boolean }>(`select rolsuper, rolbypassrls from pg_roles where rolname = 'migration_owner'`))[0]!;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const owners = await db.admin<{ owner: string; n: number }>(`
      select pg_get_userbyid(p.proowner) as owner, count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('oryn', 'oryn_realtime') group by 1`);
    expect(owners).toEqual([{ owner: 'migration_owner', n: 10 }]);
    const tables = await db.admin<{ owner: string }>(`select distinct tableowner as owner from pg_tables where schemaname = 'oryn'`);
    expect(tables).toEqual([{ owner: 'migration_owner' }]);
    for (const client of ['anon', 'authenticated', 'service_role']) {
      expect(yes(await db.admin<{ ok: boolean }>(`select pg_has_role($1, 'migration_owner', 'member') as ok`, [client])), client).toBe(false);
    }
  });

  it('as RPCs funcionam sem que o cliente tenha qualquer acesso ao schema privado', async () => {
    expect(yes(await db.admin<{ ok: boolean }>(`select has_schema_privilege('authenticated', 'oryn', 'usage') as ok`))).toBe(false);
    const roster = await db.rpc(s.member, 'public.get_roster', { p_room_id: s.room });
    expect(roster).toHaveLength(2);
    const r = await db.rpc<{ state: string }>(s.member, 'public.authorize_signal', signalArgs(s.memberSession, s.ownerSession));
    expect(r[0]!.state).toBe('accepted');
    await expect(db.as(s.member, (tx) => tx.query('select oryn.is_token($1)', ['x']))).rejects.toThrow(/permission denied for schema oryn/);
  });
});

describe('barreiras restritivas do Realtime', () => {
  it('tópico em maiúsculas também é protegido (sem leitura nem escrita)', async () => {
    const upper = `ORYN:S:${s.memberSession.toUpperCase()}`;
    expect(await db.canReceive(s.member, upper)).toBe(false);
    expect(await db.canClientBroadcast(s.member, upper)).toBe(false);
    expect(await db.canClientBroadcast(s.member, `Oryn:s:${s.memberSession}`)).toBe(false);
  });

  it('mesmo com uma política PERMISSIVA futura liberando tudo, os tópicos oryn:* continuam protegidos', async () => {
    const other = await TestDb.create();
    try {
      const x = await scenario(other);
      await other.pg.exec(`set role migration_owner; create policy future_open_read on realtime.messages for select to authenticated, anon using (true); create policy future_open_write on realtime.messages for insert to authenticated, anon with check (true); reset role;`);
      // Tópicos de outras funcionalidades passam a ser legíveis/graváveis (prova de que a política existe)...
      expect(await other.canReceive(x.member, 'chat:geral')).toBe(true);
      expect(await other.canClientBroadcast(x.member, 'chat:geral')).toBe(true);
      // ...mas os da Oryn continuam fechados.
      expect(await other.canReceive(x.member, `oryn:s:${x.ownerSession}`)).toBe(false);
      expect(await other.canReceive('anon', `oryn:s:${x.memberSession}`)).toBe(false);
      expect(await other.canClientBroadcast(x.member, `oryn:s:${x.memberSession}`)).toBe(false);
      expect(await other.canClientBroadcast('anon', `oryn:s:${x.memberSession}`)).toBe(false);
      // Variações de maiúsculas também ficam fechadas (a barreira compara sem distinção de caixa).
      const upper = `ORYN:S:${x.ownerSession.toUpperCase()}`;
      expect(await other.canReceive(x.member, upper)).toBe(false);
      expect(await other.canReceive('anon', upper)).toBe(false);
      expect(await other.canClientBroadcast(x.member, `Oryn:s:${x.memberSession}`)).toBe(false);
      expect(await other.canReceive(x.member, `oryn:s:${x.memberSession}`)).toBe(true); // o próprio tópico continua legível
    } finally {
      await other.close();
    }
  });

  it('presence em tópicos oryn:* é negado (leitura e escrita)', async () => {
    await db.admin(`insert into realtime.messages (topic, extension, event, payload, private) values ($1, 'presence', 'sync', '{}', true)`, [`oryn:s:${s.memberSession}`]);
    const seen = await db.as(s.member, async (tx) => (await tx.query<{ n: number }>(`select count(*)::int as n from realtime.messages where topic = realtime.topic() and extension = 'presence'`)).rows[0]!.n, { 'realtime.topic': `oryn:s:${s.memberSession}` });
    expect(seen).toBe(0);
    await expect(
      db.as(s.member, (tx) => tx.query(`insert into realtime.messages (topic, extension, event, payload, private) values (realtime.topic(), 'presence', 'track', '{}', true)`), { 'realtime.topic': `oryn:s:${s.memberSession}` }),
    ).rejects.toThrow(/row-level security/);
  });
});
