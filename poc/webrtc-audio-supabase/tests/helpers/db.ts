// Banco de teste: Postgres REAL em memória (PGlite) + shim do Supabase + migrações versionadas, aplicadas
// na ordem. Cada chamada "como usuário" roda numa transação própria com o papel e as claims do JWT, como
// o PostgREST faz numa RPC (falha → rollback de tudo que a chamada fez).
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite, type Transaction } from '@electric-sql/pglite';

const root = fileURLToPath(new URL('../..', import.meta.url));
const shim = readFileSync(fileURLToPath(new URL('./supabase-shim.sql', import.meta.url)), 'utf8');
const migrationsDir = `${root}supabase/migrations`;

export type Actor = { uid: string } | 'anon' | 'service';

export class TestDb {
  readonly pg: PGlite;
  private constructor(pg: PGlite) {
    this.pg = pg;
  }

  static async create(): Promise<TestDb> {
    const pg = new PGlite();
    await pg.exec(shim);
    // Migrações aplicadas pelo dono NÃO superusuário (como o `postgres` do Supabase).
    await pg.exec('set role migration_owner');
    for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
      await pg.exec(readFileSync(`${migrationsDir}/${file}`, 'utf8'));
    }
    await pg.exec('reset role');
    return new TestDb(pg);
  }

  close(): Promise<void> {
    return this.pg.close();
  }

  /** Executa SQL como dono do banco (administrador / migrações). */
  async admin<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pg.query<T>(sql, params)).rows;
  }

  async newUser(): Promise<{ uid: string }> {
    const uid = randomUUID();
    await this.admin('insert into auth.users (id) values ($1)', [uid]);
    return { uid };
  }

  /** Roda `fn` numa transação com o papel e as claims do ator (anon = sem JWT). */
  async as<T>(actor: Actor, fn: (tx: Transaction) => Promise<T>, settings: Record<string, string> = {}): Promise<T> {
    return this.pg.transaction(async (tx) => {
      if (actor === 'anon') {
        await tx.exec('set local role anon');
      } else if (actor === 'service') {
        await tx.exec('set local role service_role');
        await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'service_role' })]);
      } else {
        await tx.exec('set local role authenticated');
        await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: actor.uid, role: 'authenticated', is_anonymous: true })]);
      }
      for (const [k, v] of Object.entries(settings)) await tx.query('select set_config($1, $2, true)', [k, v]);
      return fn(tx);
    });
  }

  /** Chama uma RPC com argumentos nomeados, como o cliente faria via PostgREST. */
  async rpc<T = Record<string, unknown>>(actor: Actor, fn: string, args: Record<string, unknown> = {}): Promise<T[]> {
    const names = Object.keys(args);
    const call = names.map((n, i) => `${n} => $${i + 1}`).join(', ');
    return this.as(actor, async (tx) => (await tx.query<T>(`select * from ${fn}(${call})`, names.map((n) => args[n]))).rows);
  }

  /** Mensagem de erro de uma RPC (ou null se não falhou). */
  async rpcError(actor: Actor, fn: string, args: Record<string, unknown> = {}): Promise<string | null> {
    try {
      await this.rpc(actor, fn, args);
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }

  /**
   * Aproximação da checagem do Realtime para ASSINAR um tópico privado: há uma mensagem no tópico e o
   * usuário consegue vê-la sob RLS com realtime.topic() = tópico. (O servidor Realtime real faz uma
   * checagem equivalente; o comportamento exato é NOT VERIFIED.)
   */
  async canReceive(actor: Actor, topic: string): Promise<boolean> {
    await this.admin(`insert into realtime.messages (topic, extension, event, payload, private) values ($1, 'broadcast', 'probe', '{}', true)`, [topic]);
    try {
      const rows = await this.as(actor, async (tx) => (await tx.query<{ n: number }>(`select count(*)::int as n from realtime.messages where topic = realtime.topic() and extension = 'broadcast'`)).rows, { 'realtime.topic': topic });
      return (rows[0]?.n ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /** Aproximação da checagem de ENVIO por Broadcast do cliente num tópico privado. */
  async canClientBroadcast(actor: Actor, topic: string): Promise<boolean> {
    try {
      await this.as(actor, (tx) => tx.query(`insert into realtime.messages (topic, extension, event, payload, private) values (realtime.topic(), 'broadcast', 'forged', '{"from_session":"x"}', true)`), { 'realtime.topic': topic });
      return true;
    } catch {
      return false;
    }
  }
}
