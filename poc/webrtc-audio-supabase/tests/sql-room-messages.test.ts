// Chat por sala — send_room_message e list_room_messages (migração 0500) no Postgres real em memória (PGlite + shim). Cenários
// pelos fluxos reais (RPCs). A concorrência está em tests/pg/room-messages.pg.test.ts.
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestDb, type Actor } from './helpers/db.ts';
import { createRoom, joinWithInvite, makeCreator, scenario, type Scenario } from './helpers/fixtures.ts';

interface Row {
  seq: number | string;
  display_name: string;
  is_mine: boolean;
  client_nonce: string | null;
  body: string;
  created_at: string;
}

let db: TestDb;
let s: Scenario;
beforeEach(async () => {
  db = await TestDb.create();
  s = await scenario(db);
});
afterEach(() => db.close());

const send = async (actor: Actor, room: string, body: string, nonce: string = randomUUID()) =>
  (await db.rpc<Row>(actor, 'public.send_room_message', { p_room_id: room, p_client_nonce: nonce, p_body: body }))[0]!;
const sendError = (actor: Actor, room: string, body: unknown, nonce: unknown = randomUUID()) =>
  db.rpcError(actor, 'public.send_room_message', { p_room_id: room, p_client_nonce: nonce, p_body: body });
const list = (actor: Actor, room: string, args: Record<string, unknown> = {}) =>
  db.rpc<Row>(actor, 'public.list_room_messages', { p_room_id: room, ...args });
const seqs = (rows: Row[]) => rows.map((r) => Number(r.seq));
const count = async () => (await db.admin<{ n: number }>('select count(*)::int as n from oryn.room_messages'))[0]!.n;
const fill = async (actor: Actor, room: string, n: number) => {
  // Direto, sem passar pelo limite de taxa: só para montar histórico grande.
  const uid = (actor as { uid: string }).uid;
  await db.admin(
    `insert into oryn.room_messages (room_id, seq, author_id, client_nonce, body, created_at)
     select $1, g, $2, gen_random_uuid(), 'm' || g, now() - interval '1 hour' from generate_series(1, $3::int) g`,
    [room, uid, n],
  );
  await db.admin('insert into oryn.room_message_counters (room_id, last_seq) values ($1, $2) on conflict (room_id) do update set last_seq = excluded.last_seq', [room, n]);
};

describe('send_room_message', () => {
  it('membros enviam; o autor vem do JWT e a resposta tem exatamente os campos do contrato', async () => {
    const nonce = randomUUID();
    const row = await send(s.member, s.room, 'Oi, tudo bem?', nonce);
    expect(Object.keys(row).sort()).toEqual(['body', 'client_nonce', 'created_at', 'display_name', 'is_mine', 'seq']);
    expect(row).toMatchObject({ display_name: 'Amigo', is_mine: true, client_nonce: nonce, body: 'Oi, tudo bem?' });
    expect(Number(row.seq)).toBe(1);
    const stored = await db.admin<{ author_id: string }>('select author_id from oryn.room_messages');
    expect(stored).toEqual([{ author_id: s.member.uid }]);
  });

  it('o contador também é privado: nenhum papel de cliente o alcança', async () => {
    for (const actor of [s.owner, 'anon', 'service'] as Actor[]) {
      await expect(db.as(actor, (tx) => tx.query('select * from oryn.room_message_counters'))).rejects.toThrow(/permission denied/);
    }
  });

  it('seq é sequencial e separado por sala', async () => {
    const other = await createRoom(db, s.owner, 2, 'Outra');
    expect(Number((await send(s.owner, s.room, 'a')).seq)).toBe(1);
    expect(Number((await send(s.member, s.room, 'b')).seq)).toBe(2);
    expect(Number((await send(s.owner, other, 'c')).seq)).toBe(1);
  });

  it('idempotência: o mesmo identificador devolve a mensagem original e não grava outra', async () => {
    const nonce = randomUUID();
    const first = await send(s.owner, s.room, 'uma vez', nonce);
    await send(s.member, s.room, 'no meio');
    const again = await send(s.owner, s.room, 'uma vez', nonce);
    expect(again).toEqual(first);
    expect(await count()).toBe(2);
  });

  it('idempotência por sala e por autor: o mesmo identificador em outra sala ou de outro autor é outra mensagem', async () => {
    const nonce = randomUUID();
    const other = await createRoom(db, s.owner, 2, 'Outra');
    await send(s.owner, s.room, 'x', nonce);
    await send(s.member, s.room, 'x', nonce);
    await send(s.owner, other, 'x', nonce);
    expect(await count()).toBe(3);
  });

  it('o mesmo identificador com outro texto é recusado, sem alterar a original', async () => {
    const nonce = randomUUID();
    await send(s.owner, s.room, 'original', nonce);
    expect(await sendError(s.owner, s.room, 'trocado', nonce)).toMatch(/^invalid-argument$/);
    expect((await list(s.owner, s.room))[0]!.body).toBe('original');
  });

  it.each([
    ['vazio', ''],
    ['só espaços e quebras', ' \n\t '],
    ['controle', 'a\u0007b'],
    ['retorno de carro', 'a\r\nb'],
    ['DEL', 'a\u007fb'],
    ['acima de 4000', 'x'.repeat(4001)],
    ['nulo', null],
  ])('texto inválido (%s): invalid-argument, nada gravado', async (_label, body) => {
    expect(await sendError(s.owner, s.room, body)).toMatch(/^invalid-argument$/);
    expect(await count()).toBe(0);
  });

  it('identificador nulo: invalid-argument', async () => {
    expect(await sendError(s.owner, s.room, 'a', null)).toMatch(/^invalid-argument$/);
  });

  it('aceita quebra de linha, tabulação, emoji e 4000 pontos de código', async () => {
    const emojis = '😀'.repeat(4000);
    expect((await send(s.owner, s.room, 'linha 1\n\tlinha 2')).body).toBe('linha 1\n\tlinha 2');
    expect((await send(s.owner, s.room, emojis)).body).toBe(emojis);
  });

  it('HTML é guardado como texto, sem transformação', async () => {
    const html = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    await send(s.owner, s.room, html);
    expect((await list(s.member, s.room))[0]!.body).toBe(html);
  });

  it('limite de taxa: 30 por minuto por autor em cada sala; repetir não consome; passado o minuto, libera', async () => {
    const nonces = Array.from({ length: 30 }, () => randomUUID());
    for (const n of nonces) await send(s.owner, s.room, 'a', n);
    expect(await sendError(s.owner, s.room, 'a')).toMatch(/^rate-limited$/);
    // Repetir uma já gravada continua respondendo: é a recuperação de resposta perdida.
    expect(Number((await send(s.owner, s.room, 'a', nonces[0])).seq)).toBe(1);
    // O outro membro e outra sala têm limites próprios.
    await send(s.member, s.room, 'b');
    await send(s.owner, await createRoom(db, s.owner, 2, 'Outra'), 'c');
    await db.admin(`update oryn.room_messages set created_at = created_at - interval '61 seconds'`);
    await send(s.owner, s.room, 'a');
  });
});

describe('autorização e isolamento', () => {
  it('estranho, sala inexistente e anônimo: mesma recusa no envio e na leitura', async () => {
    const stranger = await db.newUser();
    await send(s.owner, s.room, 'segredo');
    expect(await sendError(stranger, s.room, 'a')).toMatch(/^unauthorized$/);
    expect(await sendError(s.owner, randomUUID(), 'a')).toMatch(/^unauthorized$/);
    expect(await db.rpcError(stranger, 'public.list_room_messages', { p_room_id: s.room })).toMatch(/^unauthorized$/);
    expect(await db.rpcError(s.owner, 'public.list_room_messages', { p_room_id: randomUUID() })).toMatch(/^unauthorized$/);
    expect(await sendError('anon', s.room, 'a')).toMatch(/permission denied/);
    expect(await db.rpcError('anon', 'public.list_room_messages', { p_room_id: s.room })).toMatch(/permission denied/);
    expect(await count()).toBe(1);
  });

  it('membro de outra sala não alcança esta', async () => {
    const owner2 = await makeCreator(db);
    const room2 = await createRoom(db, owner2, 2, 'Alheia');
    await send(s.owner, s.room, 'daqui');
    await send(owner2, room2, 'de lá');
    expect((await list(s.owner, s.room)).map((r) => r.body)).toEqual(['daqui']);
    expect((await list(owner2, room2)).map((r) => r.body)).toEqual(['de lá']);
    expect(await db.rpcError(owner2, 'public.list_room_messages', { p_room_id: s.room })).toMatch(/^unauthorized$/);
    expect(await sendError(owner2, s.room, 'a')).toMatch(/^unauthorized$/);
  });

  it('membro removido não lê nem envia; o histórico dele continua para os demais', async () => {
    await send(s.member, s.room, 'antes de sair');
    await db.admin('update oryn.room_members set removed_at = now() where room_id = $1 and user_id = $2', [s.room, s.member.uid]);
    expect(await sendError(s.member, s.room, 'a')).toMatch(/^unauthorized$/);
    expect(await db.rpcError(s.member, 'public.list_room_messages', { p_room_id: s.room })).toMatch(/^unauthorized$/);
    expect((await list(s.owner, s.room)).map((r) => [r.display_name, r.is_mine, r.body])).toEqual([['Amigo', false, 'antes de sair']]);
  });

  it('não expõe a conta de terceiros: identificador da tentativa só para o autor, e nenhum UUID de usuário', async () => {
    const nonce = randomUUID();
    await send(s.member, s.room, 'oi', nonce);
    const [mine] = await list(s.member, s.room);
    const [theirs] = await list(s.owner, s.room);
    expect(mine).toMatchObject({ is_mine: true, client_nonce: nonce });
    expect(theirs).toMatchObject({ is_mine: false, client_nonce: null, display_name: 'Amigo' });
    expect(JSON.stringify(theirs)).not.toContain(s.member.uid);
  });

  it('acesso direto à tabela é negado a todos os papéis de cliente', async () => {
    for (const actor of [s.owner, 'anon', 'service'] as Actor[]) {
      await expect(db.as(actor, (tx) => tx.query('select * from oryn.room_messages'))).rejects.toThrow(/permission denied/);
    }
  });

  it('autor que nunca foi membro é barrado pela chave estrangeira, mesmo em inserção direta', async () => {
    const stranger = await db.newUser();
    await expect(
      db.admin(`insert into oryn.room_messages (room_id, seq, author_id, client_nonce, body, created_at) values ($1, 99, $2, gen_random_uuid(), 'x', now())`, [s.room, stranger.uid]),
    ).rejects.toThrow(/foreign key/);
  });

  it('não publica nada no Realtime: o chat não passa pela sinalização', async () => {
    const before = await db.admin<{ n: number }>('select count(*)::int as n from realtime.messages');
    await send(s.owner, s.room, 'sem evento');
    await list(s.member, s.room);
    expect(await db.admin<{ n: number }>('select count(*)::int as n from realtime.messages')).toEqual(before);
  });
});

describe('sala encerrada', () => {
  it('somente leitura: lê o histórico e recusa novas mensagens', async () => {
    await send(s.owner, s.room, 'última');
    await db.rpc(s.owner, 'public.close_room', { p_room_id: s.room });
    expect(await sendError(s.member, s.room, 'tarde demais')).toMatch(/^room-closed$/);
    expect((await list(s.member, s.room)).map((r) => r.body)).toEqual(['última']);
    expect((await list(s.owner, s.room)).map((r) => r.body)).toEqual(['última']);
  });

  it('repetir uma mensagem gravada antes do encerramento devolve a original', async () => {
    const nonce = randomUUID();
    const first = await send(s.owner, s.room, 'a tempo', nonce);
    await db.rpc(s.owner, 'public.close_room', { p_room_id: s.room });
    expect(await send(s.owner, s.room, 'a tempo', nonce)).toEqual(first);
    expect(await count()).toBe(1);
  });

  it('estranho continua recusado, sem saber que a sala foi encerrada', async () => {
    await db.rpc(s.owner, 'public.close_room', { p_room_id: s.room });
    expect(await sendError(await db.newUser(), s.room, 'a')).toMatch(/^unauthorized$/);
  });
});

describe('list_room_messages: persistência e paginação', () => {
  it('sem histórico: lista vazia', async () => {
    expect(await list(s.owner, s.room)).toEqual([]);
  });

  it('sem cursor: as mais recentes, em ordem crescente, limite padrão de 50', async () => {
    await fill(s.owner, s.room, 60);
    expect(seqs(await list(s.member, s.room))).toEqual(Array.from({ length: 50 }, (_, i) => i + 11));
  });

  it('p_before_seq percorre todo o histórico sem pular nem repetir', async () => {
    await fill(s.owner, s.room, 25);
    const seen: number[] = [];
    let before: number | null = null;
    for (;;) {
      const page = await list(s.member, s.room, { p_limit: 10, ...(before === null ? {} : { p_before_seq: before }) });
      if (page.length === 0) break;
      seen.unshift(...seqs(page));
      before = Number(page[0]!.seq);
    }
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it('p_after_seq traz só as novas, das mais antigas para as mais novas', async () => {
    await fill(s.owner, s.room, 10);
    expect(seqs(await list(s.member, s.room, { p_after_seq: 7 }))).toEqual([8, 9, 10]);
    expect(seqs(await list(s.member, s.room, { p_after_seq: 2, p_limit: 3 }))).toEqual([3, 4, 5]);
    expect(await list(s.member, s.room, { p_after_seq: 10 })).toEqual([]);
  });

  it.each([
    ['limite 0', { p_limit: 0 }],
    ['limite 101', { p_limit: 101 }],
    ['limite nulo', { p_limit: null }],
    ['os dois cursores', { p_before_seq: 5, p_after_seq: 1 }],
  ])('%s: invalid-argument', async (_label, args) => {
    expect(await db.rpcError(s.owner, 'public.list_room_messages', { p_room_id: s.room, ...args })).toMatch(/^invalid-argument$/);
  });

  it('o nome vem da sala, por isso difere entre membros', async () => {
    const third = await joinWithInvite(db, s.room, s.owner, 'Terceiro');
    await send(third, s.room, 'oi');
    await send(s.owner, s.room, 'olá');
    expect((await list(s.member, s.room)).map((r) => r.display_name)).toEqual(['Terceiro', 'Dono']);
  });

  it('não consome limite de taxa nem altera dados', async () => {
    await send(s.owner, s.room, 'x');
    const before = await db.admin('select * from oryn.room_messages');
    for (let i = 0; i < 40; i++) await list(s.owner, s.room, { p_after_seq: 0 });
    expect(await db.admin('select * from oryn.room_messages')).toEqual(before);
  });

});

describe('exclusão em cascata', () => {
  const counters = async () => (await db.admin<{ n: number }>('select count(*)::int as n from oryn.room_message_counters'))[0]!.n;

  it('conta de um membro: apaga só as mensagens dele; a sala, o histórico dos demais e a sala do dono continuam', async () => {
    await send(s.member, s.room, 'do membro');
    await send(s.owner, s.room, 'do dono');
    await db.admin('delete from auth.users where id = $1', [s.member.uid]);
    expect((await list(s.owner, s.room)).map((r) => r.body)).toEqual(['do dono']);
    expect((await db.rpc(s.owner, 'public.list_my_rooms'))[0]).toMatchObject({ room_id: s.room, member_count: 1 });
  });

  it('regressão: seq nunca é reutilizado; depois da exclusão da última mensagem, o cursor alcança a seguinte', async () => {
    await send(s.owner, s.room, 'a');
    const last = Number((await send(s.member, s.room, 'última, do membro')).seq);
    await db.admin('delete from auth.users where id = $1', [s.member.uid]);
    const next = Number((await send(s.owner, s.room, 'seguinte')).seq);
    expect(next).toBe(last + 1);
    expect((await list(s.owner, s.room, { p_after_seq: last })).map((r) => r.body)).toEqual(['seguinte']);
    expect(seqs(await list(s.owner, s.room))).toEqual([1, 3]); // lacuna esperada, sem paginação quebrada
    expect(seqs(await list(s.owner, s.room, { p_before_seq: 3 }))).toEqual([1]);
  });

  it('conta do dono: apaga a sala e TODAS as mensagens, inclusive as do outro membro', async () => {
    await send(s.member, s.room, 'do membro');
    await send(s.owner, s.room, 'do dono');
    await db.admin('delete from auth.users where id = $1', [s.owner.uid]);
    expect(await count()).toBe(0);
    expect(await counters()).toBe(0);
    expect(await db.rpc(s.member, 'public.list_my_rooms')).toEqual([]);
    expect(await db.rpcError(s.member, 'public.list_room_messages', { p_room_id: s.room })).toMatch(/^unauthorized$/);
  });

  it('exclusão direta da sala: mensagens e contador vão junto; outras salas ficam', async () => {
    const other = await createRoom(db, s.owner, 2, 'Outra');
    await send(s.owner, s.room, 'aqui');
    await send(s.owner, other, 'lá');
    await db.admin('delete from oryn.rooms where id = $1', [s.room]);
    expect((await list(s.owner, other)).map((r) => r.body)).toEqual(['lá']);
    expect(await count()).toBe(1);
    expect(await counters()).toBe(1);
  });

  it('remoção de membro (removed_at) não apaga mensagem: só retira o acesso', async () => {
    await send(s.member, s.room, 'fica');
    await db.admin('update oryn.room_members set removed_at = now() where room_id = $1 and user_id = $2', [s.room, s.member.uid]);
    expect(await count()).toBe(1);
  });

  it('encerrar a sala não apaga mensagem nem contador', async () => {
    await send(s.owner, s.room, 'fica');
    await db.rpc(s.owner, 'public.close_room', { p_room_id: s.room });
    expect(await count()).toBe(1);
    expect(await counters()).toBe(1);
  });

  it('um envio que falha não consome número: seq segue contínuo', async () => {
    await send(s.owner, s.room, 'a');
    expect(await sendError(s.owner, s.room, '   ')).toMatch(/invalid-argument/);
    expect(Number((await send(s.owner, s.room, 'b')).seq)).toBe(2);
  });
});
