// Concorrência e compatibilidade em PostgreSQL 17 REAL (02C.2B, M5 e "outros riscos"). Cada chamada usa
// conexão e transação próprias. Gatilhos de teste com pg_sleep alargam a janela de corrida para que o
// resultado não dependa de sorte; cada correção é comparada com a versão SEM a trava ("legado"), que deve
// falhar no mesmo cenário (prova de que o teste detecta a corrida).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgServer, type CallResult } from './pg-server.ts';

let db: PgServer;

beforeAll(async () => {
  db = await PgServer.start();
}, 180_000);
afterAll(async () => {
  await db?.stop();
});

interface Room {
  owner: { uid: string };
  room: string;
}

async function newRoom(maxMembers = 10): Promise<Room> {
  const owner = await db.newUser();
  const token = (await db.admin<{ t: string }>('select oryn.admin_issue_creator_invite(60, 5) as t'))[0]!.t;
  await db.rpc(owner, 'public.redeem_creator_invite', { p_token: token });
  const room = (await db.rpc<{ create_room: string }>(owner, 'public.create_room', { p_name: 'pg17', p_display_name: 'Dono', p_max_members: maxMembers }))[0]!.create_room;
  return { owner, room };
}

async function addMember(r: Room, name = 'Amigo'): Promise<{ uid: string }> {
  const user = await db.newUser();
  const token = (await db.rpc<{ token: string }>(r.owner, 'public.create_room_invite', { p_room_id: r.room, p_ttl_minutes: 10 }))[0]!.token;
  await db.rpc(user, 'public.redeem_room_invite', { p_token: token, p_display_name: name });
  return user;
}

const join = async (user: { uid: string }, room: string) => (await db.rpc<{ session_id: string }>(user, 'public.join_room', { p_room_id: room }))[0]!.session_id;

/** Gatilho de teste que segura a transação (alarga a janela de corrida). Devolve a função de remoção. */
async function slow(table: string, timing: 'before' | 'after', seconds = 0.4, event: 'insert' | 'update' = 'insert'): Promise<() => Promise<void>> {
  const name = `t_slow_${table.replace('.', '_')}_${timing}_${event}`;
  await db.admin(`create or replace function public.${name}() returns trigger language plpgsql as $$ begin perform pg_sleep(${seconds}); return new; end $$`);
  await db.admin(`create trigger ${name} ${timing} ${event} on ${table} for each row execute function public.${name}()`);
  return async () => {
    await db.admin(`drop trigger ${name} on ${table}`);
    await db.admin(`drop function public.${name}()`);
  };
}

/** Cria `public.<fn>_legacy`: a mesma função, só sem as travas FOR NO KEY UPDATE (versão anterior ao 02C.2B). */
async function legacy(fn: string, signature: string): Promise<string> {
  const def = (await db.admin<{ d: string }>(`select pg_get_functiondef($1::regprocedure) as d`, [`public.${signature}`]))[0]!.d;
  const body = def
    .replace(`FUNCTION public.${fn}(`, `FUNCTION public.${fn}_legacy(`)
    .replace(/\s+for no key update/gi, '');
  await db.asMigrationOwner(body);
  await db.asMigrationOwner(`grant execute on function public.${fn}_legacy${signature.slice(fn.length)} to authenticated`);
  return `public.${fn}_legacy`;
}

const codes = (results: CallResult<unknown>[]) => results.map((r) => r.error?.message ?? 'ok').sort();

describe('PostgreSQL 17 real: migrações e pós-voo', () => {
  it('as quatro migrações aplicam em PostgreSQL 17 (o mesmo major do Supabase)', async () => {
    const v = (await db.admin<{ v: string }>('select version() as v'))[0]!.v;
    expect(v).toMatch(/^PostgreSQL 17\./);
    expect((await db.admin<{ n: number }>(`select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`))[0]!.n).toBe(14);
  });

  it('pós-voo em PostgreSQL 17: zero FAIL', async () => {
    const results = await db.asMigrationOwner(readFileSync(fileURLToPath(new URL('../../integration/sql/01_postflight.sql', import.meta.url)), 'utf8'));
    const rows = results.find((r) => r.fields?.some((f) => f.name === 'status'))!.rows as { item: string; status: string }[];
    expect(rows.filter((r) => r.status === 'FAIL')).toEqual([]);
    expect(rows.length).toBeGreaterThan(300);
  });

  it('pré-voo em PostgreSQL 17 roda somente leitura', async () => {
    const results = await db.asMigrationOwner(readFileSync(fileURLToPath(new URL('../../integration/sql/00_preflight.sql', import.meta.url)), 'utf8'));
    expect(results.some((r) => r.fields?.some((f) => f.name === 'policy_grant'))).toBe(true);
  });
});

describe('M5 — join_room: limite de 2 sessões sob chamadas simultâneas', () => {
  it('6 entradas simultâneas do mesmo usuário → exatamente 2 sessões; as demais limit-reached', async () => {
    const r = await newRoom();
    const user = await addMember(r);
    const undo = await slow('oryn.room_sessions', 'after');
    try {
      const results = await Promise.all(Array.from({ length: 6 }, () => db.call(user, 'public.join_room', { p_room_id: r.room })));
      expect(codes(results)).toEqual(['limit-reached', 'limit-reached', 'limit-reached', 'limit-reached', 'ok', 'ok']);
    } finally {
      await undo();
    }
    const alive = await db.admin<{ n: number }>(`select count(*)::int as n from oryn.room_sessions where room_id = $1 and user_id = $2 and revoked_at is null`, [r.room, user.uid]);
    expect(alive[0]!.n).toBe(2);
  }, 60_000);

  it('controle: a versão SEM a trava ultrapassa o limite no mesmo cenário', async () => {
    const r = await newRoom();
    const user = await addMember(r);
    const fn = await legacy('join_room', 'join_room(uuid)');
    const undo = await slow('oryn.room_sessions', 'after');
    try {
      const results = await Promise.all(Array.from({ length: 6 }, () => db.call(user, fn, { p_room_id: r.room })));
      expect(results.filter((x) => x.error === null).length).toBeGreaterThan(2);
    } finally {
      await undo();
    }
  }, 60_000);

  it('usuários diferentes na mesma sala não se bloqueiam nem se impedem (sem trava da sala inteira)', async () => {
    const r = await newRoom();
    const users: { uid: string }[] = [];
    for (let i = 0; i < 5; i++) users.push(await addMember(r, `U${i}`)); // em série: no máximo 3 convites pendentes
    const undo = await slow('oryn.room_sessions', 'after', 1);
    try {
      const t0 = Date.now();
      const results = await Promise.all(users.map((u) => db.call(u, 'public.join_room', { p_room_id: r.room })));
      const elapsed = Date.now() - t0;
      expect(codes(results)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
      // Em série seriam ≥ 5 s (5 × 1 s). Em paralelo, perto de 1 s; margem larga para runners lentos.
      expect(elapsed).toBeLessThan(3_500);
    } finally {
      await undo();
    }
  }, 60_000);

  it('regressão sequencial: a 3ª entrada continua recusada', async () => {
    const r = await newRoom();
    const user = await addMember(r);
    await join(user, r.room);
    await join(user, r.room);
    expect((await db.call(user, 'public.join_room', { p_room_id: r.room })).error?.message).toBe('limit-reached');
  });
});

describe('authorize_signal sob concorrência (idempotência, limite de taxa, impasse)', () => {
  async function pair(): Promise<{ a: { uid: string }; b: { uid: string }; sa: string; sb: string; room: string }> {
    const r = await newRoom();
    const b = await addMember(r);
    return { a: r.owner, b, sa: await join(r.owner, r.room), sb: await join(b, r.room), room: r.room };
  }
  const args = (from: string, to: string, clientMsgId = randomUUID()) => ({
    p_session_id: from, p_to_session_id: to, p_client_msg_id: clientMsgId, p_kind: 'candidate', p_pair_epoch: 1, p_payload_bytes: 200,
  });

  it('6 repetições SIMULTÂNEAS do mesmo client_msg_id → mesmo msg_id, 1 linha, nenhum erro bruto de chave única', async () => {
    const p = await pair();
    const same = args(p.sa, p.sb);
    const undo = await slow('oryn.signal_log', 'after');
    try {
      const results = await Promise.all(Array.from({ length: 6 }, () => db.call<{ msg_id: string; duplicate: boolean }>(p.a, 'public.authorize_signal', same)));
      expect(results.map((r) => r.error)).toEqual(Array(6).fill(null));
      expect(new Set(results.map((r) => r.rows[0]!.msg_id)).size).toBe(1);
      expect(results.filter((r) => r.rows[0]!.duplicate === false)).toHaveLength(1);
    } finally {
      await undo();
    }
    expect((await db.admin<{ n: number }>(`select count(*)::int as n from oryn.signal_log where session_id = $1`, [p.sa]))[0]!.n).toBe(1);
  }, 60_000);

  it('controle: sem a trava, repetições simultâneas expõem o erro bruto de chave única (23505)', async () => {
    const p = await pair();
    const fn = await legacy('authorize_signal', 'authorize_signal(uuid,uuid,uuid,text,integer,integer)');
    const same = args(p.sa, p.sb);
    const undo = await slow('oryn.signal_log', 'after');
    try {
      const results = await Promise.all(Array.from({ length: 6 }, () => db.call(p.a, fn, same)));
      expect(results.some((r) => r.error?.code === '23505')).toBe(true);
    } finally {
      await undo();
    }
  }, 60_000);

  it('limite de taxa exato: 45 mensagens simultâneas → 40 aceitas, 5 rate-limited', async () => {
    const p = await pair();
    const undo = await slow('oryn.signal_log', 'after', 0.02);
    try {
      const results = await Promise.all(Array.from({ length: 45 }, () => db.call(p.a, 'public.authorize_signal', args(p.sa, p.sb))));
      expect(results.filter((r) => r.error === null)).toHaveLength(40);
      expect(results.filter((r) => r.error?.message === 'rate-limited')).toHaveLength(5);
    } finally {
      await undo();
    }
  }, 60_000);

  it('A→B e B→A simultâneos: nenhum impasse (40P01) e seq contíguo por direção', async () => {
    const p = await pair();
    // Segura cada chamada DEPOIS de travar a própria sessão e ANTES da chave estrangeira para a sessão do
    // outro lado: exatamente a janela em que FOR UPDATE causaria impasse.
    const undo = await slow('oryn.pair_counters', 'before', 0.2);
    try {
      const calls = [
        ...Array.from({ length: 10 }, () => db.call<{ seq: number }>(p.a, 'public.authorize_signal', args(p.sa, p.sb))),
        ...Array.from({ length: 10 }, () => db.call<{ seq: number }>(p.b, 'public.authorize_signal', args(p.sb, p.sa))),
      ];
      const results = await Promise.all(calls);
      expect(results.filter((r) => r.error).map((r) => r.error!.code)).toEqual([]);
      const seqs = (from: string) => db.admin<{ seq: number }>(`select seq::int as seq from oryn.signal_log where session_id = $1 order by seq`, [from]);
      expect((await seqs(p.sa)).map((r) => r.seq)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
      expect((await seqs(p.sb)).map((r) => r.seq)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    } finally {
      await undo();
    }
  }, 60_000);

  it('controle: com FOR UPDATE (em vez de NO KEY UPDATE), A→B e B→A simultâneos entram em impasse', async () => {
    const p = await pair();
    const def = (await db.admin<{ d: string }>(`select pg_get_functiondef('public.authorize_signal(uuid,uuid,uuid,text,integer,integer)'::regprocedure) as d`))[0]!.d;
    await db.asMigrationOwner(def.replace('FUNCTION public.authorize_signal(', 'FUNCTION public.authorize_signal_forupdate(').replace(/for no key update/gi, 'for update'));
    await db.asMigrationOwner('grant execute on function public.authorize_signal_forupdate(uuid,uuid,uuid,text,integer,integer) to authenticated');
    const undo = await slow('oryn.pair_counters', 'before', 0.5);
    try {
      const results = await Promise.all([
        db.call(p.a, 'public.authorize_signal_forupdate', args(p.sa, p.sb)),
        db.call(p.b, 'public.authorize_signal_forupdate', args(p.sb, p.sa)),
      ]);
      expect(results.some((r) => r.error?.code === '40P01')).toBe(true);
    } finally {
      await undo();
    }
  }, 60_000);
});

describe('convites sob concorrência (#15 em PostgreSQL real)', () => {
  it('6 resgates SIMULTÂNEOS do mesmo convite → exatamente 1 sucesso, 5 invite-invalid', async () => {
    const r = await newRoom();
    const token = (await db.rpc<{ token: string }>(r.owner, 'public.create_room_invite', { p_room_id: r.room, p_ttl_minutes: 10 }))[0]!.token;
    const users = await Promise.all(Array.from({ length: 6 }, () => db.newUser()));
    const undo = await slow('oryn.room_members', 'after');
    try {
      const results = await Promise.all(users.map((u, i) => db.call(u, 'public.redeem_room_invite', { p_token: token, p_display_name: `R${i}` })));
      expect(codes(results)).toEqual(['invite-invalid', 'invite-invalid', 'invite-invalid', 'invite-invalid', 'invite-invalid', 'ok']);
    } finally {
      await undo();
    }
  }, 60_000);

  it('última vaga disputada por dois convites diferentes → exatamente 1 entra, o outro room-full', async () => {
    const r = await newRoom(3);
    await addMember(r); // dono + 1 = 2 de 3
    const t1 = (await db.rpc<{ token: string }>(r.owner, 'public.create_room_invite', { p_room_id: r.room, p_ttl_minutes: 10 }))[0]!.token;
    const t2 = (await db.rpc<{ token: string }>(r.owner, 'public.create_room_invite', { p_room_id: r.room, p_ttl_minutes: 10 }))[0]!.token;
    const [u1, u2] = [await db.newUser(), await db.newUser()];
    const undo = await slow('oryn.room_members', 'after');
    try {
      const results = await Promise.all([
        db.call(u1, 'public.redeem_room_invite', { p_token: t1, p_display_name: 'V1' }),
        db.call(u2, 'public.redeem_room_invite', { p_token: t2, p_display_name: 'V2' }),
      ]);
      expect(codes(results)).toEqual(['ok', 'room-full']);
    } finally {
      await undo();
    }
  }, 60_000);
});

// MVP 01 — close_room em concorrência. Cada cenário força UMA ordem de chegada com gatilhos pg_sleep e roda
// também a ordem inversa; os controles reproduzem as versões rejeitadas (o teste detecta o defeito).
// "Utilizável" = um resgate de verdade funciona: é tentado com um usuário novo para cada token.
describe('MVP 01 — close_room sob concorrência (PostgreSQL 17 real)', () => {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadlocks = (results: CallResult<unknown>[]) => results.filter((x) => x.error?.code === '40P01').map((x) => x.error!.message);
  const live = async (room: string) =>
    (await db.admin<{ n: number }>(`select count(*)::int as n from oryn.room_sessions where room_id = $1 and revoked_at is null`, [room]))[0]!.n;
  const pendingRows = async (room: string) =>
    (await db.admin<{ n: number }>(
      `select count(*)::int as n from oryn.room_invites where room_id = $1 and used_at is null and revoked_at is null and expires_at > now()`, [room]))[0]!.n;
  const invite = async (r: Room) => (await db.rpc<{ token: string }>(r.owner, 'public.create_room_invite', { p_room_id: r.room, p_ttl_minutes: 10 }))[0]!.token;
  /** Quantos dos tokens ainda deixam alguém entrar (tentativa real, cada uma com um usuário novo). */
  const usable = async (tokens: string[]) => {
    let n = 0;
    for (const t of tokens) if ((await db.call(await db.newUser(), 'public.redeem_room_invite', { p_token: t, p_display_name: 'Teste' })).error === null) n += 1;
    return n;
  };
  const byes = async (sessions: string[]) =>
    await db.admin<{ topic: string; sid: string }>(
      `select topic, payload->>'session_id' as sid from realtime.messages where event = 'bye' and topic = any ($1) order by 1, 2`,
      [sessions.map((s) => `oryn:s:${s}`)],
    );
  /** Variante de close_room com outro corpo (controles). */
  async function variant(name: string, edit: (body: string) => string): Promise<string> {
    const def = (await db.admin<{ d: string }>(`select pg_get_functiondef('public.close_room(uuid)'::regprocedure) as d`))[0]!.d;
    const renamed = def.replace('FUNCTION public.close_room(', `FUNCTION public.${name}(`);
    const body = edit(renamed);
    expect(body).not.toBe(renamed);
    await db.asMigrationOwner(body);
    await db.asMigrationOwner(`grant execute on function public.${name}(uuid) to authenticated`);
    return `public.${name}`;
  }

  describe('1. × redeem_room_invite', () => {
    it('encerramento primeiro: o resgate espera a sala, reconfere e recusa; sem impasse; nada utilizável', async () => {
      const r = await newRoom();
      await join(r.owner, r.room);
      const token = await invite(r);
      const undo = await slow('oryn.room_sessions', 'before', 1, 'update'); // segura o close_room com a sala travada
      try {
        const closing = db.call(r.owner, 'public.close_room', { p_room_id: r.room });
        await pause(300);
        const redeem = await db.call(await db.newUser(), 'public.redeem_room_invite', { p_token: token, p_display_name: 'Fora' });
        const closed = await closing;
        expect(deadlocks([closed, redeem])).toEqual([]);
        expect(closed.error).toBeNull();
        expect(redeem.error?.message).toBe('invite-invalid');
      } finally {
        await undo();
      }
      // O convite estava travado pelo resgate quando o encerramento passou: ficou sem revoked_at, mas é inútil.
      expect(await pendingRows(r.room)).toBe(1);
      expect(await usable([token])).toBe(0);
    }, 60_000);

    it('resgate primeiro: o encerramento espera a sala e depois trata o membro novo; sem impasse', async () => {
      const r = await newRoom();
      const token = await invite(r);
      const guest = await db.newUser();
      const undo = await slow('oryn.room_members', 'after', 1); // segura o resgate com convite e sala travados
      try {
        const redeem = db.call(guest, 'public.redeem_room_invite', { p_token: token, p_display_name: 'Novo' });
        await pause(300);
        const closed = await db.call(r.owner, 'public.close_room', { p_room_id: r.room });
        const redeemed = await redeem;
        expect(deadlocks([closed, redeemed])).toEqual([]);
        expect(redeemed.error).toBeNull();
        expect(closed.error).toBeNull();
      } finally {
        await undo();
      }
      expect(await pendingRows(r.room)).toBe(0);
      expect((await db.call(guest, 'public.join_room', { p_room_id: r.room })).error?.message).toBe('not-member');
    }, 60_000);

    it('controle: esperando pelos convites (versão rejeitada), o mesmo cenário entra em impasse', async () => {
      const r = await newRoom();
      await join(r.owner, r.room);
      const token = await invite(r);
      const fn = await variant('close_room_waits', (b) => b.replace(/\s+skip locked/i, ''));
      const undo = await slow('oryn.room_sessions', 'before', 1, 'update');
      try {
        const closing = db.call(r.owner, fn, { p_room_id: r.room });
        await pause(300);
        const redeem = await db.call(await db.newUser(), 'public.redeem_room_invite', { p_token: token, p_display_name: 'Fora' });
        expect(deadlocks([await closing, redeem])).toHaveLength(1);
      } finally {
        await undo();
      }
    }, 60_000);
  });

  describe('2. × revoke_room_invite (vários convites)', () => {
    /** Sala com 2 convites pendentes em que o PRIMEIRO inserido tem o MAIOR id (ordem de varredura ≠ ordem de id). */
    async function roomWithCrossedInvites(): Promise<{ r: Room; tokens: string[] }> {
      const r = await newRoom();
      await join(r.owner, r.room);
      for (let i = 0; i < 20; i++) {
        const tokens = [await invite(r), await invite(r)];
        const crossed = await db.admin<{ ok: boolean }>(
          `select (array_agg(id order by ctid))[1] > (array_agg(id order by ctid))[2] as ok
             from oryn.room_invites where room_id = $1 and revoked_at is null`, [r.room]);
        if (crossed[0]!.ok) return { r, tokens };
        await db.rpc(r.owner, 'public.revoke_room_invite', { p_room_id: r.room });
      }
      throw new Error('não consegui montar convites cruzados');
    }

    it('revogação primeiro (segurando um convite) e encerramento depois: sem impasse; tudo revogado; nada utilizável', async () => {
      const { r, tokens } = await roomWithCrossedInvites();
      const undo = await slow('oryn.room_invites', 'before', 0.5, 'update');
      try {
        const revoking = db.call(r.owner, 'public.revoke_room_invite', { p_room_id: r.room });
        await pause(150);
        const closed = await db.call(r.owner, 'public.close_room', { p_room_id: r.room });
        const revoked = await revoking;
        expect(deadlocks([closed, revoked])).toEqual([]);
        expect(closed.error).toBeNull();
        expect(revoked.error).toBeNull();
      } finally {
        await undo();
      }
      expect(await pendingRows(r.room)).toBe(0);
      expect(await usable(tokens)).toBe(0);
    }, 60_000);

    it('encerramento primeiro e revogação depois: sem impasse; tudo revogado', async () => {
      const { r, tokens } = await roomWithCrossedInvites();
      const undo = await slow('oryn.room_invites', 'before', 0.5, 'update');
      try {
        const closing = db.call(r.owner, 'public.close_room', { p_room_id: r.room });
        await pause(150);
        const revoked = await db.call(r.owner, 'public.revoke_room_invite', { p_room_id: r.room });
        const closed = await closing;
        expect(deadlocks([closed, revoked])).toEqual([]);
        expect(closed.error).toBeNull();
      } finally {
        await undo();
      }
      expect(await pendingRows(r.room)).toBe(0);
      expect(await usable(tokens)).toBe(0);
    }, 60_000);

    it('controle: travando os convites em ordem de id ANTES da sala (opção B), o mesmo cenário entra em impasse', async () => {
      const { r } = await roomWithCrossedInvites();
      const fn = await variant('close_room_option_b', (b) => b
        .replace(/\s+skip locked/i, '')
        .replace(/begin\n  select r\.closed_at into v_closed/, `begin
  perform 1 from oryn.room_invites i
   where i.room_id = p_room_id and i.used_at is null and i.revoked_at is null and i.expires_at > pg_catalog.now()
   order by i.id for no key update;
  select r.closed_at into v_closed`));
      const undo = await slow('oryn.room_invites', 'before', 0.5, 'update');
      try {
        const revoking = db.call(r.owner, 'public.revoke_room_invite', { p_room_id: r.room });
        await pause(150);
        const closed = await db.call(r.owner, fn, { p_room_id: r.room });
        expect(deadlocks([closed, await revoking])).toHaveLength(1);
      } finally {
        await undo();
      }
    }, 60_000);
  });

  describe('3. × create_room_invite', () => {
    it('emissão primeiro: o encerramento espera a sala e revoga também o convite recém-emitido', async () => {
      const r = await newRoom();
      const undo = await slow('oryn.room_invites', 'after', 1);
      try {
        const creating = db.call<{ token: string }>(r.owner, 'public.create_room_invite', { p_room_id: r.room, p_ttl_minutes: 10 });
        await pause(300);
        const closed = await db.call(r.owner, 'public.close_room', { p_room_id: r.room });
        const created = await creating;
        expect(deadlocks([closed, created])).toEqual([]);
        expect(created.error).toBeNull();
        expect(closed.error).toBeNull();
        expect(await pendingRows(r.room)).toBe(0);
        expect(await usable([created.rows[0]!.token])).toBe(0);
      } finally {
        await undo();
      }
    }, 60_000);

    it('encerramento primeiro: a emissão espera a sala, reconfere e recusa (unauthorized)', async () => {
      const r = await newRoom();
      await join(r.owner, r.room);
      const undo = await slow('oryn.room_sessions', 'before', 1, 'update');
      try {
        const closing = db.call(r.owner, 'public.close_room', { p_room_id: r.room });
        await pause(300);
        const created = await db.call(r.owner, 'public.create_room_invite', { p_room_id: r.room, p_ttl_minutes: 10 });
        const closed = await closing;
        expect(deadlocks([closed, created])).toEqual([]);
        expect(created.error?.message).toBe('unauthorized');
      } finally {
        await undo();
      }
      expect(await pendingRows(r.room)).toBe(0);
    }, 60_000);
  });

  describe('4. × join_room', () => {
    it('entrada primeiro: o encerramento espera a linha de membro e revoga também a sessão recém-criada (com bye)', async () => {
      const r = await newRoom();
      const member = await addMember(r);
      const ownerSession = await join(r.owner, r.room);
      const undo = await slow('oryn.room_sessions', 'after', 1);
      try {
        const joining = db.call<{ session_id: string }>(member, 'public.join_room', { p_room_id: r.room });
        await pause(150);
        const t0 = Date.now();
        const closing = await db.call(r.owner, 'public.close_room', { p_room_id: r.room });
        const waited = Date.now() - t0;
        const joined = await joining;
        expect(deadlocks([closing, joined])).toEqual([]);
        expect(joined.error).toBeNull();
        expect(closing.error).toBeNull();
        expect(waited).toBeGreaterThan(500); // esperou o join_room terminar
        const memberSession = joined.rows[0]!.session_id;
        expect(await live(r.room)).toBe(0);
        const reasons = await db.admin<{ reason: string }>(`select distinct revoke_reason as reason from oryn.room_sessions where room_id = $1`, [r.room]);
        expect(reasons).toEqual([{ reason: 'room-closed' }]);
        // A sessão nova foi vista pelo encerramento (snapshot novo depois da espera): recebeu o bye do dono.
        expect(await byes([memberSession])).toEqual([{ topic: `oryn:s:${memberSession}`, sid: ownerSession }]);
      } finally {
        await undo();
      }
    }, 60_000);

    it('encerramento primeiro: a entrada espera a linha de membro e, ao reconferir, recusa (not-member) sem criar sessão', async () => {
      const r = await newRoom();
      const member = await addMember(r);
      const undo = await slow('oryn.rooms', 'before', 1, 'update');
      try {
        const closing = db.call(r.owner, 'public.close_room', { p_room_id: r.room });
        await pause(150);
        const joined = await db.call(member, 'public.join_room', { p_room_id: r.room });
        expect(deadlocks([await closing, joined])).toEqual([]);
        expect(joined.error?.message).toBe('not-member');
        const rows = await db.admin<{ n: number }>(`select count(*)::int as n from oryn.room_sessions where room_id = $1 and user_id = $2`, [r.room, member.uid]);
        expect(rows[0]!.n).toBe(0);
      } finally {
        await undo();
      }
    }, 60_000);

    it('controle: SEM as travas, o mesmo cenário deixa uma sessão viva em sala encerrada (o teste detecta a corrida)', async () => {
      const r = await newRoom();
      const member = await addMember(r);
      const fn = await variant('close_room_unlocked', (b) => b
        .replace(/ for no key update;\n  if not found then/, ';\n  if not found then')
        .replace(/\n  perform 1 from oryn\.room_members m where m\.room_id = p_room_id order by m\.user_id for no key update;/, ''));
      const undo = await slow('oryn.room_sessions', 'after', 1);
      try {
        const joining = db.call<{ session_id: string }>(member, 'public.join_room', { p_room_id: r.room });
        await pause(150);
        expect((await db.call(r.owner, fn, { p_room_id: r.room })).error).toBeNull();
        const joined = await joining;
        expect(joined.error).toBeNull();
        expect(await live(r.room)).toBe(1);
        // Mesmo assim, a sessão órfã é inútil: a sala está fechada para todo caminho de uso.
        expect((await db.call(member, 'public.touch_session', { p_session_id: joined.rows[0]!.session_id })).error?.message).toBe('session-invalid');
      } finally {
        await undo();
      }
    }, 60_000);
  });

  describe('5. vários convites e operações simultâneas', () => {
    it('8 rodadas de disputa mista: nenhum impasse, nenhuma sessão viva, nenhum convite utilizável', async () => {
      const undoA = await slow('oryn.room_sessions', 'after', 0.1);
      const undoB = await slow('oryn.room_invites', 'before', 0.1, 'update');
      const all: CallResult<unknown>[] = [];
      try {
        for (let round = 0; round < 8; round++) {
          const r = await newRoom();
          const [m1, m2] = [await addMember(r, 'M1'), await addMember(r, 'M2')];
          const s1 = await join(m1, r.room);
          const ownerSession = await join(r.owner, r.room);
          const tokens = [await invite(r), await invite(r), await invite(r)];
          const outsiders = [await db.newUser(), await db.newUser(), await db.newUser()];
          const results = await Promise.all([
            db.call(r.owner, 'public.close_room', { p_room_id: r.room }),
            ...tokens.map((t, i) => db.call(outsiders[i]!, 'public.redeem_room_invite', { p_token: t, p_display_name: 'Fora' })),
            db.call(r.owner, 'public.revoke_room_invite', { p_room_id: r.room }),
            db.call<{ token: string }>(r.owner, 'public.create_room_invite', { p_room_id: r.room, p_ttl_minutes: 10 }),
            db.call(r.owner, 'public.close_room', { p_room_id: r.room }),
            db.call(m2, 'public.join_room', { p_room_id: r.room }),
            db.call(m2, 'public.join_room', { p_room_id: r.room }),
            db.call(m1, 'public.touch_session', { p_session_id: s1 }),
            db.call(r.owner, 'public.leave_room', { p_session_id: ownerSession }),
          ]);
          all.push(...results);
          expect(deadlocks(results), `rodada ${round}`).toEqual([]);
          expect(results[0]!.error, `rodada ${round}`).toBeNull();
          expect(results[6]!.error, `rodada ${round}`).toBeNull();
          expect(await live(r.room), `rodada ${round}`).toBe(0);
          const created = (results[5]!.rows as { token: string }[])[0]?.token;
          expect(await usable(created ? [...tokens, created] : tokens), `rodada ${round}`).toBe(0);
          expect((await db.call(m2, 'public.join_room', { p_room_id: r.room })).error?.message, `rodada ${round}`).toBe('not-member');
        }
      } finally {
        await undoA();
        await undoB();
      }
      const allowed = new Set(['ok', 'not-member', 'limit-reached', 'session-invalid', 'unauthorized', 'invite-invalid', 'room-full']);
      for (const c of codes(all)) expect(allowed, c).toContain(c);
    }, 180_000);
  });

  describe('6. vários close_room simultâneos', () => {
    it('6 ao mesmo tempo: 1 efeito, o mesmo closed_at para todos, bye uma única vez; depois, idempotente', async () => {
      const r = await newRoom();
      const member = await addMember(r);
      const [s1, s2] = [await join(r.owner, r.room), await join(member, r.room)];
      const results = await Promise.all(Array.from({ length: 6 }, () => db.call<{ close_room: string }>(r.owner, 'public.close_room', { p_room_id: r.room })));
      expect(deadlocks(results)).toEqual([]);
      expect(results.map((x) => x.error)).toEqual(Array(6).fill(null));
      const stamps = new Set(results.map((x) => String(x.rows[0]!.close_room)));
      expect(stamps.size).toBe(1);
      expect(await live(r.room)).toBe(0);
      const expected = [{ topic: `oryn:s:${s1}`, sid: s2 }, { topic: `oryn:s:${s2}`, sid: s1 }].sort((a, b) => a.topic.localeCompare(b.topic));
      expect(await byes([s1, s2])).toEqual(expected);
      // Mais tarde, de novo: mesmo closed_at, nenhum bye novo.
      const again = await db.rpc<{ close_room: string }>(r.owner, 'public.close_room', { p_room_id: r.room });
      expect(String(again[0]!.close_room)).toBe([...stamps][0]);
      expect(await byes([s1, s2])).toEqual(expected);
    }, 60_000);
  });
});
