// Pré-voo e pós-voo (integration/sql) executados de verdade no PGlite com o shim (02C.2B, A3). Garante
// que os scripts rodam, que o banco migrado não tem nenhuma linha FAIL, que o que depende do painel aparece
// como NOT VERIFIED (nunca PASS) e que regressões de privilégio viram FAIL.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TestDb, migrationFiles } from './helpers/db.ts';

const sql = (name: string) => readFileSync(fileURLToPath(new URL(`../integration/sql/${name}`, import.meta.url)), 'utf8');

interface Row {
  item: string;
  expected: string;
  actual: string;
  status: 'PASS' | 'FAIL' | 'NOT VERIFIED' | 'INFO';
}

async function postflight(db: TestDb): Promise<Row[]> {
  await db.pg.exec('set role migration_owner');
  try {
    const results = await db.pg.exec(sql('01_postflight.sql'));
    return results.find((r) => r.fields.some((f) => f.name === 'status'))!.rows as Row[];
  } finally {
    await db.pg.exec('reset role');
  }
}

describe('pós-voo no banco migrado (PGlite + shim)', () => {
  it('zero FAIL; Data API e "Allow public access" como NOT VERIFIED; fatos do Supabase como INFO', async () => {
    const db = await TestDb.create();
    try {
      const rows = await postflight(db);
      expect(rows.filter((r) => r.status === 'FAIL')).toEqual([]);
      expect(rows.filter((r) => r.status === 'PASS').length).toBeGreaterThan(290);
      const notVerified = rows.filter((r) => r.status === 'NOT VERIFIED').map((r) => r.item);
      expect(notVerified).toEqual(expect.arrayContaining([expect.stringMatching(/^Data API/), expect.stringMatching(/Allow public access/)]));
      const info = rows.filter((r) => r.status === 'INFO').map((r) => r.item);
      expect(info).toEqual(expect.arrayContaining([expect.stringMatching(/^realtime\.send: EXECUTE/), expect.stringMatching(/dono/)]));
      // O EXECUTE padrão de realtime.send é registrado, não reprovado.
      expect(rows.find((r) => r.item.startsWith('realtime.send: EXECUTE'))!.actual).toBe('anon=true, authenticated=true');
    } finally {
      await db.close();
    }
  });

  it('o pré-voo roda inteiro em transação somente leitura', async () => {
    const db = await TestDb.create();
    try {
      await db.pg.exec('set role migration_owner');
      const results = await db.pg.exec(sql('00_preflight.sql'));
      await db.pg.exec('reset role');
      const p5 = results.find((r) => r.fields.some((f) => f.name === 'policy_grant'))!.rows[0] as Record<string, unknown>;
      expect(p5).toMatchObject({ owner: 'supabase_realtime_admin', rls_enabled: true, policy_grant: false }); // sem supautils local
    } finally {
      await db.close();
    }
  });
});

describe('pós-voo detecta regressões (cada uma vira FAIL)', () => {
  it.each([
    ['EXECUTE para anon numa RPC', 'grant execute on function public.join_room(uuid) to anon', /EXECUTE anon public\.join_room/],
    ['USAGE no schema privado', 'grant usage on schema oryn to authenticated', /USAGE authenticated schema oryn$/],
    ['política permissiva em tabela de domínio', 'create policy x on oryn.rooms for select to authenticated using (true)', /nenhuma política no schema oryn/],
    ['barreira restritiva de escrita removida', 'drop policy oryn_topics_no_client_write on realtime.messages', /barreira restritiva de escrita|oryn_topics_no_client_write/],
    ['join_room sem a trava (M5)', `create or replace function public.join_room(p_room_id uuid) returns table (session_id uuid, topic text)
       language plpgsql security definer set search_path = '' as $$ begin return; end $$`, /join_room trava a linha de membro/],
  ])('%s', async (_label, mutation, expectedFail) => {
    const db = await TestDb.create();
    try {
      await db.migrate(mutation);
      const fails = (await postflight(db)).filter((r) => r.status === 'FAIL').map((r) => r.item);
      expect(fails.some((i) => expectedFail.test(i)), fails.join(' | ')).toBe(true);
    } finally {
      await db.close();
    }
  });
});

describe('verificação entre migrações (05_step_checks.sql)', () => {
  it('a cada passo: nada FAIL, nada pendente até o passo atual, e o resto PENDING', async () => {
    const db = await TestDb.createBare();
    try {
      const run = async () => {
        await db.pg.exec('set role migration_owner');
        try {
          const res = await db.pg.exec(sql('05_step_checks.sql'));
          return res.find((r) => r.fields.some((f) => f.name === 'status'))!.rows as { step: number; item: string; status: string }[];
        } finally {
          await db.pg.exec('reset role');
        }
      };
      const before = await run();
      expect(before.every((r) => r.status === 'PENDING')).toBe(true);
      const files = migrationFiles();
      for (let n = 1; n <= files.length; n++) {
        await db.migrate(files[n - 1]![1]);
        const rows = await run();
        expect(rows.filter((r) => r.status === 'FAIL'), `passo ${n}`).toEqual([]);
        expect(rows.filter((r) => r.step <= n && r.status !== 'PASS'), `passo ${n}`).toEqual([]);
        expect(rows.filter((r) => r.step > n).every((r) => r.status === 'PENDING'), `passo ${n}`).toBe(true);
      }
      // Regressão no passo 1 (privilégio indevido) vira FAIL.
      await db.admin('grant select on oryn.rooms to anon');
      expect((await run()).filter((r) => r.status === 'FAIL').map((r) => r.item)).toEqual(['nenhum privilégio de anon nas tabelas de oryn']);
    } finally {
      await db.close();
    }
  });
});

describe('reversão (90_rollback.sql) depois de cada etapa', () => {
  it.each([1, 2, 3])('depois de aplicar %i migração(ões): volta ao estado vazio e a reaplicação é limpa', async (n) => {
    const db = await TestDb.createBare();
    try {
      const files = migrationFiles();
      for (let i = 0; i < n; i++) await db.migrate(files[i]![1]);
      await db.migrate(sql('90_rollback.sql'));
      const left = await db.admin<{ schemas: number; fns: number; policies: number }>(`
        select (select count(*)::int from pg_namespace where nspname in ('oryn', 'oryn_realtime')) as schemas,
               (select count(*)::int from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public') as fns,
               (select count(*)::int from pg_policies where schemaname = 'realtime' and policyname like 'oryn_%') as policies`);
      expect(left[0]).toEqual({ schemas: 0, fns: 0, policies: 0 });
      // RLS e dono de realtime.messages intocados pela reversão.
      expect((await db.admin<{ rls: boolean; owner: string }>(`select relrowsecurity as rls, pg_get_userbyid(relowner) as owner from pg_class where oid = 'realtime.messages'::regclass`))[0]).toEqual({ rls: true, owner: 'supabase_realtime_admin' });
      for (const [, m] of files) await db.migrate(m);
      expect((await postflight(db)).filter((r) => r.status === 'FAIL')).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
