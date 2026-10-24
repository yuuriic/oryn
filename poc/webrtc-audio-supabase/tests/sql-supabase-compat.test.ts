// Compatibilidade com o Supabase real observado na 02C.2A (02C.2B). PGlite + shim ajustado:
// A1 — a migração 0300 não altera realtime.messages; só exige RLS ligado (e para inteira se não estiver);
// fidelidade do shim — realtime.send INVOKER, `id` injetado, erros viram WARNING, dono distinto;
// M3 — sem partição, o evento de controle se perde em silêncio (comportamento do real, documentado).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseControlEvent } from '../src/contracts.ts';
import { TestDb, migrationFiles } from './helpers/db.ts';
import { scenario } from './helpers/fixtures.ts';

const ORYN_POLICIES = `select count(*)::int as n from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname like 'oryn_%'`;

describe('A1 — migração 0300: asserção de RLS em vez de ALTER TABLE', () => {
  it('nenhuma migração altera, troca o dono ou mexe no RLS de tabelas do Supabase (auth, realtime, storage)', () => {
    for (const [file, sql] of migrationFiles()) {
      const code = sql.replace(/--.*$/gm, '');
      expect(code, file).not.toMatch(/alter\s+table\s+(if\s+exists\s+)?(only\s+)?"?(auth|realtime|storage)"?\./i);
      expect(code, file).not.toMatch(/owner\s+to/i);
      expect(code, file).not.toMatch(/(disable|force|no\s+force)\s+row\s+level\s+security/i);
    }
  });

  it('com RLS ligado (como o Supabase entrega): aplica e cria as 4 políticas da Oryn', async () => {
    const db = await TestDb.create();
    try {
      expect((await db.admin<{ n: number }>(ORYN_POLICIES))[0]!.n).toBe(4);
      const rls = await db.admin<{ rls: boolean; owner: string }>(`select relrowsecurity as rls, pg_get_userbyid(relowner) as owner from pg_class where oid = 'realtime.messages'::regclass`);
      expect(rls[0]).toEqual({ rls: true, owner: 'supabase_realtime_admin' }); // dono intocado
    } finally {
      await db.close();
    }
  });

  it('com RLS DESLIGADO: 0300 para com erro claro, não cria nenhuma política e não liga o RLS por conta própria', async () => {
    const db = await TestDb.createBare();
    try {
      await db.admin('alter table realtime.messages disable row level security');
      const [m100, m200, m300] = migrationFiles();
      await db.migrate(m100![1]);
      await db.migrate(m200![1]);
      await expect(db.migrate(m300![1])).rejects.toThrow(/oryn-0300: RLS desligado em realtime\.messages/);
      expect((await db.admin<{ n: number }>(ORYN_POLICIES))[0]!.n).toBe(0);
      expect((await db.admin<{ rls: boolean }>(`select relrowsecurity as rls from pg_class where oid = 'realtime.messages'::regclass`))[0]!.rls).toBe(false);
      // Depois de o Supabase religar o RLS, a mesma migração aplica normalmente.
      await db.admin('alter table realtime.messages enable row level security');
      await db.migrate(m300![1]);
      expect((await db.admin<{ n: number }>(ORYN_POLICIES))[0]!.n).toBe(4);
    } finally {
      await db.close();
    }
  });
});

describe('shim fiel ao Supabase observado (realtime.send e realtime.messages)', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await TestDb.create();
  });
  afterAll(() => db.close());

  it('realtime.send: SECURITY INVOKER, EXECUTE para PUBLIC, dono supabase_realtime_admin', async () => {
    const rows = await db.admin<{ secdef: boolean; owner: string; pub: boolean }>(
      `select p.prosecdef as secdef, pg_get_userbyid(p.proowner) as owner,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as pub
         from pg_proc p where p.oid = 'realtime.send(jsonb,text,text,boolean)'::regprocedure`,
    );
    expect(rows[0]).toEqual({ secdef: false, owner: 'supabase_realtime_admin', pub: true });
  });

  it('realtime.messages: particionada, RLS ligado, dono distinto do dono das migrações', async () => {
    const rows = await db.admin<{ kind: string; rls: boolean; owner: string }>(`select relkind::text as kind, relrowsecurity as rls, pg_get_userbyid(relowner) as owner from pg_class where oid = 'realtime.messages'::regclass`);
    expect(rows[0]).toEqual({ kind: 'p', rls: true, owner: 'supabase_realtime_admin' });
  });

  it('o realtime.send injeta `id` no payload e o cliente aceita o evento', async () => {
    const s = await scenario(db);
    const hello = await db.admin<{ id: string; payload: Record<string, unknown> }>(`select id::text, payload from realtime.messages where topic = $1 and event = 'hello'`, [`oryn:s:${s.ownerSession}`]);
    expect(hello[0]!.payload['id']).toBe(hello[0]!.id);
    expect(parseControlEvent('hello', hello[0]!.payload)).not.toBeNull();
  });

  it('erro dentro do realtime.send vira WARNING: quem chamou não falha', async () => {
    // Payload que não é objeto faz o jsonb_set falhar dentro do realtime.send.
    await expect(db.admin(`select realtime.send('"texto"'::jsonb, 'x', 'oryn:s:teste', true)`)).resolves.toBeDefined();
  });
});

describe('M3 — sem partição do dia, o evento de controle some em silêncio (como no Supabase real)', () => {
  it('join_room conclui, mas o hello não é gravado nem entregue', async () => {
    const db = await TestDb.create();
    try {
      const s = await scenario(db);
      await db.admin('alter table realtime.messages detach partition realtime.messages_shim');
      const before = (await db.admin<{ n: number }>(`select count(*)::int as n from realtime.messages`))[0]!.n;
      const rows = await db.rpc<{ session_id: string }>(s.member, 'public.join_room', { p_room_id: s.room });
      expect(rows[0]!.session_id).toBeDefined(); // a RPC NÃO falha
      expect((await db.admin<{ n: number }>(`select count(*)::int as n from realtime.messages`))[0]!.n).toBe(before);
      expect(before).toBe(0); // sem partição nada é visível; os eventos anteriores estão na partição desanexada
    } finally {
      await db.close();
    }
  });
});
