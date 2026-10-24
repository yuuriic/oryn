// PostgreSQL 17 REAL embutido (embedded-postgres) para testes de concorrência (02C.2B). O PGlite tem uma
// conexão só e não prova corridas nem impasses; aqui cada chamada usa a SUA conexão, como no Supabase.
// Banco temporário, porta livre local, senha fixa só deste processo (nada é exposto fora de 127.0.0.1).
//
// Windows (02C.2B.1): o postgres.exe RECUSA rodar com token de administrador ("Execution of PostgreSQL by a
// user with administrative permissions is not permitted"). O runner windows-2025 do GitHub roda elevado; o
// embedded-postgres chama o postgres.exe direto e, quando ele sai, só rejeita com `undefined` ("Unknown
// Error: undefined" no CI). No Windows o servidor é iniciado e parado pelo pg_ctl do próprio pacote, que
// cria um token RESTRITO (como o PostgreSQL faz oficialmente; o initdb já faz isso sozinho). No Linux nada muda.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { SHIM_SQL, migrationFiles } from '../helpers/db.ts';

export type Actor = { uid: string } | 'anon' | 'service';

export interface CallResult<T> {
  rows: T[];
  error: { code: string | undefined; message: string } | null;
}

/** Falha de inicialização com a etapa, a causa original e o fim da saída do Postgres (senha mascarada). */
export class PgStartupError extends Error {}

function startupError(stage: string, cause: unknown, output: string, secret: string): PgStartupError {
  const reason =
    cause instanceof Error ? cause.message : cause === undefined ? 'o processo do Postgres terminou antes de aceitar conexões (o embedded-postgres não informa o motivo)' : String(cause);
  const tail = output.replaceAll(secret, '***').trim().slice(-3_000);
  const error = new PgStartupError(`[pg17:${stage}] ${reason.replaceAll(secret, '***')}${tail ? `\n--- saída do Postgres ---\n${tail}` : ''}`);
  if (cause instanceof Error) error.cause = cause;
  return error;
}

async function stage<T>(name: string, output: () => string, secret: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (cause) {
    throw startupError(name, cause, output(), secret);
  }
}

/** pg_ctl do pacote de plataforma (dependência do embedded-postgres, que o pnpm não expõe direto). */
async function windowsPgCtl(): Promise<string> {
  const fromHere = createRequire(import.meta.url);
  const fromEpg = createRequire(fromHere.resolve('embedded-postgres'));
  const platform = (await import(pathToFileURL(fromEpg.resolve('@embedded-postgres/windows-x64')).href)) as { pg_ctl: string };
  return platform.pg_ctl;
}

/**
 * Executa o pg_ctl sem shell (caminhos com espaços vão como argumentos). A saída vai para um ARQUIVO, não
 * para pipes: no Windows o postgres.exe iniciado herda os handles de saída do pg_ctl, e com pipes o Node só
 * consideraria o comando terminado quando o SERVIDOR parasse (medido: `start -w` "travado" por 310 s). Por
 * isso espera o evento `exit` (fim do pg_ctl), não `close` (fim dos pipes).
 */
function run(file: string, args: string[], outputFile: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const fd = openSync(outputFile, 'a');
    const child = spawn(file, args, { env: { ...process.env, LC_MESSAGES: 'C' }, windowsHide: true, stdio: ['ignore', fd, fd] });
    const timer = setTimeout(() => child.kill(), 90_000);
    const done = (fail: Error | null) => {
      clearTimeout(timer);
      closeSync(fd);
      const output = readFileSync(outputFile, 'utf8');
      if (fail) reject(new Error(`${fail.message}\n${output}`));
      else resolve(output);
    };
    child.once('error', (error) => done(error));
    child.once('exit', (code, signal) => done(code === 0 ? null : new Error(`pg_ctl ${args[0]} saiu com código ${code ?? 'null'} (sinal ${signal ?? 'null'})`)));
  });
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
  private readonly base: string;
  private readonly pgCtl: string | null;
  readonly pool: pg.Pool;
  private constructor(epg: EmbeddedPostgres, base: string, pgCtl: string | null, pool: pg.Pool) {
    this.epg = epg;
    this.base = base;
    this.pgCtl = pgCtl;
    this.pool = pool;
  }

  /** `serverOptions`: opções extras do servidor (só para o teste do diagnóstico de falha). */
  static async start(serverOptions: string[] = []): Promise<PgServer> {
    const base = mkdtempSync(join(tmpdir(), 'oryn-pg17-'));
    const dataDir = join(base, 'data');
    const logFile = join(base, 'server.log');
    const port = await freePort();
    const password = randomUUID(); // só deste processo; o servidor escuta em 127.0.0.1
    let captured = '';
    const capture = (m: unknown) => {
      captured = (captured + (m instanceof Error ? m.message : String(m))).slice(-20_000);
    };
    const output = () => {
      try {
        return `${captured}${readFileSync(logFile, 'utf8')}`;
      } catch {
        return captured;
      }
    };
    // UTF8 como o Supabase (no Windows o initdb usaria WIN1252 e recusaria acentos das migrações).
    const epg = new EmbeddedPostgres({
      databaseDir: dataDir, user: 'postgres', password, port, persistent: false,
      initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: serverOptions, onLog: capture, onError: capture,
    });
    let pgCtl: string | null = null;
    try {
      if (process.platform === 'win32') pgCtl = await stage('localizar pg_ctl', output, password, windowsPgCtl);
      await stage('initdb', output, password, () => epg.initialise());
      const ctl = pgCtl;
      if (ctl) {
        // -w: espera aceitar conexões; -l: log do servidor, lido no diagnóstico se falhar.
        await stage('iniciar servidor (pg_ctl)', output, password, async () => {
          capture(await run(ctl, ['start', '-D', dataDir, '-o', [`-p ${port}`, ...serverOptions].join(' '), '-l', logFile, '-w', '-t', '60'], join(base, 'pg_ctl.log')));
        });
      } else {
        await stage('iniciar servidor', output, password, () => epg.start());
      }
    } catch (error) {
      // Falhou antes de existir o servidor: para o que tiver subido e apaga o diretório temporário.
      if (pgCtl) await run(pgCtl, ['stop', '-D', dataDir, '-m', 'immediate', '-w'], join(base, 'pg_ctl.log')).catch(() => undefined);
      else await epg.stop().catch(() => undefined);
      rmSync(base, { recursive: true, force: true });
      throw error;
    }
    const pool = new pg.Pool({ host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres', max: 40 });
    pool.on('error', () => {}); // conexões encerradas no stop
    const server = new PgServer(epg, base, pgCtl, pool);
    try {
      await stage('conectar', output, password, () => server.admin('select 1'));
      await stage('aplicar shim', output, password, () => server.admin(SHIM_SQL));
      for (const [file, sql] of migrationFiles()) await stage(`aplicar ${file}`, output, password, () => server.asMigrationOwner(sql));
    } catch (error) {
      await server.stop().catch(() => undefined);
      throw error;
    }
    return server;
  }

  async stop(): Promise<void> {
    await this.pool.end();
    if (this.pgCtl) await run(this.pgCtl, ['stop', '-D', join(this.base, 'data'), '-m', 'fast', '-w'], join(this.base, 'pg_ctl.log')).catch(() => undefined);
    else await this.epg.stop();
    rmSync(this.base, { recursive: true, force: true });
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
