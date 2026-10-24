// PostgreSQL 17 REAL embutido (embedded-postgres) para testes de concorrência (02C.2B). O PGlite tem uma
// conexão só e não prova corridas nem impasses; aqui cada chamada usa a SUA conexão, como no Supabase.
// Banco temporário, porta livre local, senha fixa só deste processo (nada é exposto fora de 127.0.0.1).
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { SHIM_SQL, migrationFiles } from '../helpers/db.ts';

export type Actor = { uid: string } | 'anon' | 'service';

export interface CallResult<T> {
  rows: T[];
  error: { code: string | undefined; message: string } | null;
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('sem porta'))));
    });
  });

export class PgServer {
  private readonly epg: EmbeddedPostgres;
  private readonly dir: string;
  readonly pool: pg.Pool;
  private constructor(epg: EmbeddedPostgres, dir: string, pool: pg.Pool) {
    this.epg = epg;
    this.dir = dir;
    this.pool = pool;
  }

  static async start(): Promise<PgServer> {
    const dir = mkdtempSync(join(tmpdir(), 'oryn-pg17-'));
    const port = await freePort();
    const password = randomUUID(); // só deste processo; o servidor escuta em 127.0.0.1
    // UTF8 como o Supabase (no Windows o initdb usaria WIN1252 e recusaria acentos das migrações).
    const epg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password, port, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {} });
    await epg.initialise();
    await epg.start();
    const pool = new pg.Pool({ host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres', max: 40 });
    pool.on('error', () => {}); // conexões encerradas no stop
    const server = new PgServer(epg, dir, pool);
    await server.admin(SHIM_SQL);
    for (const [, sql] of migrationFiles()) await server.asMigrationOwner(sql);
    return server;
  }

  async stop(): Promise<void> {
    await this.pool.end();
    await this.epg.stop();
    rmSync(this.dir, { recursive: true, force: true });
  }

  /** SQL como superusuário do servidor de teste (preparo de cenários e gatilhos de teste). */
  async admin<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pool.query(sql, params);
    const last = Array.isArray(res) ? res.at(-1) : res;
    return (last?.rows ?? []) as T[];
  }

  /** SQL como o dono das migrações (como o `postgres` do Supabase); devolve todos os resultados. */
  async asMigrationOwner(sql: string): Promise<pg.QueryResult[]> {
    const c = await this.pool.connect();
    try {
      await c.query('set role migration_owner');
      const res = (await c.query(sql)) as unknown as pg.QueryResult | pg.QueryResult[];
      return Array.isArray(res) ? res : [res];
    } finally {
      await c.query('reset role').catch(() => undefined);
      c.release();
    }
  }

  async newUser(): Promise<{ uid: string }> {
    const uid = randomUUID();
    await this.admin('insert into auth.users (id) values ($1)', [uid]);
    return { uid };
  }

  /** RPC numa transação e conexão PRÓPRIAS, com o papel e as claims do ator (como o PostgREST). */
  async call<T = Record<string, unknown>>(actor: Actor, fn: string, args: Record<string, unknown> = {}): Promise<CallResult<T>> {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      if (actor === 'anon') await c.query('set local role anon');
      else if (actor === 'service') {
        await c.query('set local role service_role');
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'service_role' })]);
      } else {
        await c.query('set local role authenticated');
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: actor.uid, role: 'authenticated' })]);
      }
      const names = Object.keys(args);
      const res = await c.query(`select * from ${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')})`, names.map((n) => args[n]));
      await c.query('commit');
      return { rows: res.rows as T[], error: null };
    } catch (error) {
      await c.query('rollback').catch(() => undefined);
      const e = error as { code?: string; message: string };
      return { rows: [], error: { code: e.code, message: e.message } };
    } finally {
      c.release();
    }
  }

  async rpc<T = Record<string, unknown>>(actor: Actor, fn: string, args: Record<string, unknown> = {}): Promise<T[]> {
    const r = await this.call<T>(actor, fn, args);
    if (r.error) throw new Error(`${fn}: ${r.error.message}`);
    return r.rows;
  }
}
