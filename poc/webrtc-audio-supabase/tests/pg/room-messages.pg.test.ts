// Chat por sala sob concorrência em PostgreSQL 17 REAL. Cada chamada usa conexão e transação próprias. Gatilhos com
// pg_sleep alargam a janela de corrida, e o controle sem a trava da sala prova que os testes detectam o problema.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgServer } from './pg-server.ts';

let db: PgServer;

beforeAll(async () => {
  db = await PgServer.start();
}, 180_000);
afterAll(async () => {
  await db?.stop();
});

async function newRoom(): Promise<{ owner: { uid: string }; member: { uid: string }; room: string }> {
  const owner = await db.newUser();
  const creator = (await db.admin<{ t: string }>('select oryn.admin_issue_creator_invite(60, 5) as t'))[0]!.t;
  await db.rpc(owner, 'public.redeem_creator_invite', { p_token: creator });
  const room = (await db.rpc<{ create_room: string }>(owner, 'public.create_room', { p_name: 'pg17', p_display_name: 'Dono', p_max_members: 2 }))[0]!.create_room;
  const member = await db.newUser();
  const token = (await db.rpc<{ token: string }>(owner, 'public.create_room_invite', { p_room_id: room, p_ttl_minutes: 10 }))[0]!.token;
  await db.rpc(member, 'public.redeem_room_invite', { p_token: token, p_display_name: 'Amigo' });
  return { owner, member, room };
}

const send = (actor: { uid: string }, room: string, body: string, nonce = randomUUID(), fn = 'public.send_room_message') =>
  db.call<{ seq: string; body: string }>(actor, fn, { p_room_id: room, p_client_nonce: nonce, p_body: body });

async function slowInsert(seconds: number): Promise<() => Promise<void>> {
  await db.admin(`create or replace function public.t_slow_chat() returns trigger language plpgsql as $$ begin perform pg_sleep(${seconds}); return new; end $$`);
  await db.admin(`create trigger t_slow_chat after insert on oryn.room_messages for each row execute function public.t_slow_chat()`);
  return async () => {
    await db.admin(`drop trigger t_slow_chat on oryn.room_messages`);
    await db.admin(`drop function public.t_slow_chat()`);
  };
}

describe('Chat por sala — send_room_message sob concorrência (PostgreSQL 17 real)', () => {
  it('envios simultâneos de dois membros: seq sem lacuna nem repetição, e nenhum erro', async () => {
    const r = await newRoom();
    const results = await Promise.all(Array.from({ length: 24 }, (_, i) => send(i % 2 ? r.owner : r.member, r.room, `m${i}`)));
    expect(results.map((x) => x.error)).toEqual(Array(24).fill(null));
    const stored = await db.admin<{ seq: string }>('select seq from oryn.room_messages where room_id = $1 order by seq', [r.room]);
    expect(stored.map((x) => Number(x.seq))).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
  }, 60_000);

  it('o mesmo identificador em paralelo grava uma só mensagem, e todos recebem a mesma', async () => {
    const r = await newRoom();
    const nonce = randomUUID();
    const results = await Promise.all(Array.from({ length: 8 }, () => send(r.owner, r.room, 'uma vez', nonce)));
    expect(results.map((x) => x.error)).toEqual(Array(8).fill(null));
    expect(new Set(results.map((x) => String(x.rows[0]!.seq))).size).toBe(1);
    expect((await db.admin<{ n: number }>('select count(*)::int as n from oryn.room_messages where room_id = $1', [r.room]))[0]!.n).toBe(1);
  }, 60_000);

  it('limite de taxa exato em paralelo: 30 aceitas e as demais recusadas', async () => {
    const r = await newRoom();
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => send(r.owner, r.room, `m${i}`)));
    expect(results.filter((x) => x.error === null)).toHaveLength(30);
    expect(results.filter((x) => x.error !== null).every((x) => /rate-limited/.test(x.error!.message))).toBe(true);
  }, 60_000);

  it('quem lê enquanto outro envio confirma nunca perde mensagem pelo cursor', async () => {
    const r = await newRoom();
    const undo = await slowInsert(0.05);
    try {
      const sends = Promise.all(Array.from({ length: 12 }, (_, i) => send(i % 2 ? r.owner : r.member, r.room, `m${i}`)));
      const seen: number[] = [];
      let cursor = 0;
      while (seen.length < 12) {
        const page = await db.rpc<{ seq: string }>(r.member, 'public.list_room_messages', { p_room_id: r.room, p_after_seq: cursor });
        for (const m of page) seen.push(Number(m.seq));
        if (page.length > 0) cursor = Number(page.at(-1)!.seq);
      }
      await sends;
      expect(seen).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    } finally {
      await undo();
    }
  }, 60_000);

  it('envio e encerramento juntos: sem impasse; ou a mensagem entrou antes, ou recebe room-closed', async () => {
    const undo = await slowInsert(0.1);
    try {
      for (let round = 0; round < 4; round++) {
        const r = await newRoom();
        const [sent, closed] = await Promise.all([send(r.member, r.room, 'na hora'), db.call(r.owner, 'public.close_room', { p_room_id: r.room })]);
        expect(closed.error).toBeNull();
        const stored = (await db.admin<{ n: number }>('select count(*)::int as n from oryn.room_messages where room_id = $1', [r.room]))[0]!.n;
        if (sent.error === null) expect(stored).toBe(1);
        else {
          expect(sent.error.message).toMatch(/room-closed/);
          expect(stored).toBe(0);
        }
      }
    } finally {
      await undo();
    }
  }, 120_000);

  it('o chat não trava a entrada na chamada: join_room conclui com um envio em curso na mesma sala', async () => {
    const r = await newRoom();
    const undo = await slowInsert(0.6);
    try {
      const sending = send(r.member, r.room, 'demorada');
      await new Promise((resolve) => setTimeout(resolve, 150));
      const started = Date.now();
      const joined = await db.call(r.member, 'public.join_room', { p_room_id: r.room });
      expect(joined.error).toBeNull();
      expect(Date.now() - started).toBeLessThan(450);
      expect((await sending).error).toBeNull();
    } finally {
      await undo();
    }
  }, 60_000);

  it('controle: sem a trava da sala, a mesma corrida viola o contrato (o teste detecta o problema)', async () => {
    const r = await newRoom();
    const def = (await db.admin<{ d: string }>(`select pg_get_functiondef('public.send_room_message(uuid,uuid,text)'::regprocedure) as d`))[0]!.d;
    const unlocked = def.replace('FUNCTION public.send_room_message(', 'FUNCTION public.send_room_message_unlocked(').replace(/\s+for no key update/gi, '');
    expect(unlocked).not.toBe(def);
    await db.asMigrationOwner(unlocked);
    await db.asMigrationOwner('grant execute on function public.send_room_message_unlocked(uuid,uuid,text) to authenticated');
    const undo = await slowInsert(0.2);
    try {
      const results = await Promise.all(Array.from({ length: 40 }, (_, i) => send(r.owner, r.room, `m${i}`, randomUUID(), 'public.send_room_message_unlocked')));
      // Sem a trava, cada envio conta antes de o anterior confirmar: o limite de 30 é ultrapassado.
      expect(results.filter((x) => x.error === null).length).toBeGreaterThan(30);
    } finally {
      await undo();
      await db.asMigrationOwner('drop function public.send_room_message_unlocked(uuid,uuid,text)');
    }
  }, 60_000);
});
