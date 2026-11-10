// Canais persistentes (0900) em Postgres real (PGlite) com o shim do Supabase. Cenários pelos fluxos reais (RPCs);
// inserção direta só para provar as barreiras do próprio banco (chaves compostas e gatilhos).
// Concorrência entre conexões fica em tests/pg/channels.pg.test.ts (o PGlite tem uma conexão só).
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestDb, migrationFiles, type Actor } from './helpers/db.ts';
import { createRoom, joinWithInvite, makeCreator, openSession, scenario, signalArgs, type Scenario } from './helpers/fixtures.ts';

interface Channel { channel_id: string; kind: 'text' | 'voice'; name: string; position: number; is_default: boolean; archived_at: string | null }
interface Msg { seq: string; body: string; is_mine: boolean }

let db: TestDb;
const channels = (actor: Actor, room: string) => db.rpc<Channel>(actor, 'public.list_channels', { p_room_id: room });
const defaults = async (room: string) => {
  const rows = await db.admin<{ id: string; kind: 'text' | 'voice' }>('select id, kind from oryn.channels where room_id = $1 and is_default', [room]);
  return Object.fromEntries(rows.map((r) => [r.kind, r.id])) as { text: string; voice: string };
};
const createChannel = async (actor: Actor, room: string, name: string, kind: 'text' | 'voice') =>
  (await db.rpc<{ create_channel: string }>(actor, 'public.create_channel', { p_room_id: room, p_name: name, p_kind: kind }))[0]!.create_channel;
const sendIn = (actor: Actor, channel: string, body: string, nonce: string = randomUUID()) =>
  db.rpc<Msg>(actor, 'public.send_channel_message', { p_channel_id: channel, p_client_nonce: nonce, p_body: body });
const readIn = async (actor: Actor, channel: string) => (await db.rpc<Msg>(actor, 'public.list_channel_messages', { p_channel_id: channel })).map((m) => m.body);
const readRoom = async (actor: Actor, room: string) => (await db.rpc<Msg>(actor, 'public.list_room_messages', { p_room_id: room })).map((m) => m.body);
const joinChannel = async (actor: Actor, channel: string) =>
  (await db.rpc<{ session_id: string }>(actor, 'public.join_voice_channel', { p_channel_id: channel }))[0]!.session_id;
const hellosTo = async (session: string) =>
  (await db.admin<{ n: number }>(`select count(*)::int as n from realtime.messages where topic = $1 and event = 'hello'`, [`oryn:s:${session}`]))[0]!.n;

describe('migração 0900 sobre dados legados', () => {
  it('preserva mensagens, sessões, contadores e membros; liga tudo aos canais padrão; RPCs antigas respondem igual', async () => {
    db = await TestDb.createBare();
    try {
      const files = migrationFiles();
      expect(files.map(([f]) => f)).toHaveLength(9);
      for (const [, m] of files.slice(0, 8)) await db.migrate(m);
      // Estado anterior, montado pelas RPCs da 0800: duas salas, mensagens, sessão viva e encerrada, sala encerrada.
      const s = await scenario(db);
      const other = await createRoom(db, s.owner, 2, 'Encerrada');
      await db.rpc(s.owner, 'public.send_room_message', { p_room_id: s.room, p_client_nonce: randomUUID(), p_body: 'primeira' });
      await db.rpc(s.member, 'public.send_room_message', { p_room_id: s.room, p_client_nonce: randomUUID(), p_body: 'segunda' });
      await db.rpc(s.owner, 'public.send_room_message', { p_room_id: other, p_client_nonce: randomUUID(), p_body: 'antiga' });
      await db.rpc(s.member, 'public.leave_room', { p_session_id: s.memberSession });
      await db.rpc(s.owner, 'public.close_room', { p_room_id: other });
      const snap = async () => ({
        messages: await db.admin(`select room_id, seq, author_id, client_nonce, body, created_at from oryn.room_messages order by room_id, seq`),
        sessions: await db.admin(`select id, room_id, user_id, created_at, last_seen_at, revoked_at, revoke_reason from oryn.room_sessions order by id`),
        counters: await db.admin(`select * from oryn.room_message_counters order by room_id`),
        members: await db.admin(`select * from oryn.room_members order by room_id, user_id`),
        invites: await db.admin(`select * from oryn.room_invites order by id`),
        rooms: await db.admin(`select * from oryn.rooms order by id`),
      });
      const rpcs = async () => ({
        list: await db.rpc(s.member, 'public.list_room_messages', { p_room_id: s.room }),
        voice: await db.rpc(s.member, 'public.get_voice_participants', { p_room_id: s.room }),
        roster: await db.rpc(s.owner, 'public.get_roster', { p_room_id: s.room }),
        members: await db.rpc(s.owner, 'public.list_room_members', { p_room_id: s.room }),
        rooms: await db.rpc(s.owner, 'public.list_my_rooms'),
        closedHistory: await db.rpc(s.owner, 'public.list_room_messages', { p_room_id: other }),
      });
      const before = await snap();
      const beforeRpcs = await rpcs();

      await db.migrate(files[8]![1]);

      expect(await snap()).toEqual(before); // nenhuma linha apagada, alterada ou renumerada
      expect(await rpcs()).toEqual(beforeRpcs); // o cliente publicado vê exatamente o mesmo
      for (const room of [s.room, other]) {
        const d = await defaults(room);
        expect(d.text && d.voice, room).toBeTruthy();
        const rows = await db.admin<{ kind: string; name: string; is_default: boolean; archived_at: string | null }>(
          'select kind, name, is_default, archived_at from oryn.channels where room_id = $1 order by kind', [room]);
        expect(rows).toEqual([{ kind: 'text', name: 'conversa', is_default: true, archived_at: null }, { kind: 'voice', name: 'voz', is_default: true, archived_at: null }]);
      }
      const orphans = await db.admin<{ m: number; s: number }>(`
        select (select count(*)::int from oryn.room_messages m join oryn.channels c on c.id = m.channel_id where not (c.is_default and c.kind = 'text' and c.room_id = m.room_id)) as m,
               (select count(*)::int from oryn.room_sessions x join oryn.channels c on c.id = x.channel_id where not (c.is_default and c.kind = 'voice' and c.room_id = x.room_id)) as s`);
      expect(orphans[0]).toEqual({ m: 0, s: 0 });
      // Depois da migração, o fluxo antigo continua: nova mensagem e nova sessão vão para os padrões.
      await db.rpc(s.member, 'public.send_room_message', { p_room_id: s.room, p_client_nonce: randomUUID(), p_body: 'terceira' });
      expect(await readRoom(s.member, s.room)).toEqual(['primeira', 'segunda', 'terceira']);
      expect(await readIn(s.member, (await defaults(s.room)).text)).toEqual(['primeira', 'segunda', 'terceira']);
      await openSession(db, s.member, s.room);
      expect(await db.rpc(s.owner, 'public.get_channel_participants', { p_channel_id: (await defaults(s.room)).voice })).toHaveLength(2);
    } finally {
      await db.close();
    }
  });

  it('reaplicar a 0900 falha sem alterar nada (não é idempotente por desenho)', async () => {
    db = await TestDb.create();
    try {
      const s = await scenario(db);
      const before = await db.admin('select count(*)::int as n from oryn.channels');
      // A 0900 roda em BEGIN: o primeiro erro (objeto já existente) aborta a transação inteira.
      await expect(db.migrate(migrationFiles()[8]![1])).rejects.toThrow(/already exists|transaction is aborted/);
      await db.pg.exec('rollback');
      await db.pg.exec('reset role');
      expect(await db.admin('select count(*)::int as n from oryn.channels')).toEqual(before);
      expect(await channels(s.owner, s.room)).toHaveLength(2);
    } finally {
      await db.close();
    }
  });
});

describe('canais (0900)', () => {
  let s: Scenario;
  let d: { text: string; voice: string };
  beforeEach(async () => {
    db = await TestDb.create();
    s = await scenario(db);
    d = await defaults(s.room);
  });
  afterEach(() => db.close());

  it('sala nova nasce com os dois canais padrão (create_room inalterado); a lista é igual para dono e membro', async () => {
    const room = await createRoom(db, s.owner, 2, 'Nova');
    const list = await channels(s.owner, room);
    expect(list.map((c) => [c.kind, c.name, c.is_default, c.archived_at])).toEqual([['text', 'conversa', true, null], ['voice', 'voz', true, null]]);
    expect(await channels(s.member, s.room)).toEqual(await channels(s.owner, s.room));
  });

  it('dono cria canais de texto e de voz; membro não; nome repetido (sem diferenciar maiúsculas) e tipo inválido são recusados', async () => {
    const t = await createChannel(s.owner, s.room, 'estratégia', 'text');
    const v = await createChannel(s.owner, s.room, 'Partida 2', 'voice');
    const list = await channels(s.member, s.room);
    expect(list.map((c) => c.name)).toEqual(['conversa', 'estratégia', 'voz', 'Partida 2']);
    expect(list.find((c) => c.channel_id === t)!.position).toBe(1);
    expect(list.find((c) => c.channel_id === v)!.kind).toBe('voice');
    expect(await db.rpcError(s.member, 'public.create_channel', { p_room_id: s.room, p_name: 'x', p_kind: 'text' })).toMatch(/unauthorized/);
    expect(await db.rpcError(s.owner, 'public.create_channel', { p_room_id: s.room, p_name: 'ESTRATÉGIA', p_kind: 'text' })).toMatch(/name-taken/);
    expect(await db.rpcError(s.owner, 'public.create_channel', { p_room_id: s.room, p_name: 'estratégia', p_kind: 'voice' })).toBeNull(); // outro tipo
    expect(await db.rpcError(s.owner, 'public.create_channel', { p_room_id: s.room, p_name: '', p_kind: 'text' })).toMatch(/invalid-argument/);
    expect(await db.rpcError(s.owner, 'public.create_channel', { p_room_id: s.room, p_name: 'a'.repeat(41), p_kind: 'text' })).toMatch(/invalid-argument/);
    expect(await db.rpcError(s.owner, 'public.create_channel', { p_room_id: s.room, p_name: 'a\u0007', p_kind: 'text' })).toMatch(/invalid-argument/);
  });

  it('limite de 20 canais ativos por espaço; arquivar libera vaga e o nome', async () => {
    const made: string[] = [];
    for (let i = 0; i < 18; i++) made.push(await createChannel(s.owner, s.room, `c${i}`, i % 2 ? 'voice' : 'text'));
    expect(await db.rpcError(s.owner, 'public.create_channel', { p_room_id: s.room, p_name: 'demais', p_kind: 'text' })).toMatch(/limit-reached/);
    await db.rpc(s.owner, 'public.archive_channel', { p_channel_id: made[0] });
    expect(await createChannel(s.owner, s.room, 'c0', 'text')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('mensagens ficam no canal: isolamento entre canais do mesmo espaço; RPCs antigas veem só o texto padrão', async () => {
    const t = await createChannel(s.owner, s.room, 'estratégia', 'text');
    await sendIn(s.member, d.text, 'no padrão');
    await sendIn(s.owner, t, 'no novo');
    await db.rpc(s.owner, 'public.send_room_message', { p_room_id: s.room, p_client_nonce: randomUUID(), p_body: 'cliente antigo' });
    expect(await readIn(s.member, t)).toEqual(['no novo']);
    expect(await readIn(s.member, d.text)).toEqual(['no padrão', 'cliente antigo']);
    expect(await readRoom(s.member, s.room)).toEqual(['no padrão', 'cliente antigo']);
    // seq é a ordem do espaço: cada canal vê uma subsequência crescente.
    const all = await db.admin<{ seq: string; channel_id: string }>('select seq, channel_id from oryn.room_messages where room_id = $1 order by seq', [s.room]);
    expect(all.map((r) => Number(r.seq))).toEqual([1, 2, 3]);
    const page = await db.rpc<Msg>(s.member, 'public.list_channel_messages', { p_channel_id: d.text, p_after_seq: 1 });
    expect(page.map((m) => [Number(m.seq), m.body])).toEqual([[3, 'cliente antigo']]);
  });

  it('isolamento entre espaços: canal de outro espaço é recusado pelas RPCs e pela chave composta', async () => {
    const owner2 = await makeCreator(db);
    const room2 = await createRoom(db, owner2, 2, 'Outro');
    const d2 = await defaults(room2);
    expect(await db.rpcError(s.member, 'public.send_channel_message', { p_channel_id: d2.text, p_client_nonce: randomUUID(), p_body: 'x' })).toMatch(/unauthorized/);
    expect(await db.rpcError(s.member, 'public.list_channel_messages', { p_channel_id: d2.text })).toMatch(/unauthorized/);
    expect(await db.rpcError(s.member, 'public.join_voice_channel', { p_channel_id: d2.voice })).toMatch(/not-member/);
    expect(await db.rpcError(s.member, 'public.get_channel_participants', { p_channel_id: d2.voice })).toMatch(/not-member/);
    expect(await db.rpcError(s.owner, 'public.archive_channel', { p_channel_id: await createChannel(owner2, room2, 'alheio', 'text') })).toMatch(/unauthorized/);
    // Barreira do banco: mesmo por inserção direta, mensagem/sessão não aponta para canal de outro espaço.
    await expect(db.admin(`insert into oryn.room_messages (room_id, seq, author_id, client_nonce, body, created_at, channel_id)
      values ($1, 99, $2, gen_random_uuid(), 'x', now(), $3)`, [s.room, s.member.uid, d2.text])).rejects.toThrow(/invalid-argument|foreign key/);
    await expect(db.admin(`insert into oryn.room_sessions (room_id, user_id, channel_id) values ($1, $2, $3)`, [s.room, s.member.uid, d2.voice]))
      .rejects.toThrow(/invalid-argument|foreign key/);
    // Sem o gatilho (desligado só nesta transação, desfeita no fim), sobra a chave composta (sala, canal).
    try {
      await expect(db.pg.exec(`begin; alter table oryn.room_messages disable trigger oryn_message_channel;
        insert into oryn.room_messages (room_id, seq, author_id, client_nonce, body, created_at, channel_id)
        values ('${s.room}', 98, '${s.member.uid}', gen_random_uuid(), 'x', now(), '${d2.text}')`)).rejects.toThrow(/foreign key/);
    } finally {
      await db.pg.exec('rollback');
    }
    expect((await db.admin<{ on: string }>(`select tgenabled as on from pg_trigger where tgname = 'oryn_message_channel'`))[0]!.on).toBe('O');
  });

  it('tipo do canal: texto não vira voz e voz não recebe mensagem (RPCs e gatilhos)', async () => {
    expect(await db.rpcError(s.member, 'public.send_channel_message', { p_channel_id: d.voice, p_client_nonce: randomUUID(), p_body: 'x' })).toMatch(/invalid-argument/);
    expect(await db.rpcError(s.member, 'public.list_channel_messages', { p_channel_id: d.voice })).toMatch(/invalid-argument/);
    expect(await db.rpcError(s.member, 'public.join_voice_channel', { p_channel_id: d.text })).toMatch(/invalid-argument/);
    expect(await db.rpcError(s.member, 'public.get_channel_participants', { p_channel_id: d.text })).toMatch(/invalid-argument/);
    await expect(db.admin(`insert into oryn.room_messages (room_id, seq, author_id, client_nonce, body, created_at, channel_id)
      values ($1, 99, $2, gen_random_uuid(), 'x', now(), $3)`, [s.room, s.member.uid, d.voice])).rejects.toThrow(/invalid-argument/);
    await expect(db.admin(`insert into oryn.room_sessions (room_id, user_id, channel_id) values ($1, $2, $3)`, [s.room, s.member.uid, d.text]))
      .rejects.toThrow(/invalid-argument/);
  });

  it('idempotência por canal: repetir devolve a original; o mesmo identificador noutro canal é recusado', async () => {
    const t = await createChannel(s.owner, s.room, 'estratégia', 'text');
    const nonce = randomUUID();
    const first = await sendIn(s.member, t, 'oi', nonce);
    expect(await sendIn(s.member, t, 'oi', nonce)).toEqual(first);
    expect(await db.rpcError(s.member, 'public.send_channel_message', { p_channel_id: d.text, p_client_nonce: nonce, p_body: 'oi' })).toMatch(/invalid-argument/);
    expect(await db.rpcError(s.member, 'public.send_room_message', { p_room_id: s.room, p_client_nonce: nonce, p_body: 'oi' })).toMatch(/invalid-argument/);
    expect(await readIn(s.member, t)).toEqual(['oi']);
  });

  it('arquivar: só o dono, padrões não, idempotente; texto fica legível e sem envio; voz expulsa e recusa entrada', async () => {
    const t = await createChannel(s.owner, s.room, 'arquivo', 'text');
    const v = await createChannel(s.owner, s.room, 'sala 2', 'voice');
    await sendIn(s.member, t, 'antes');
    const nonce = randomUUID();
    const kept = await sendIn(s.member, t, 'repetível', nonce);
    // Sessões de voz: o dono no canal novo, o membro sai do padrão e entra no canal novo também.
    await db.rpc(s.owner, 'public.leave_room', { p_session_id: s.ownerSession });
    await db.rpc(s.member, 'public.leave_room', { p_session_id: s.memberSession });
    const ownerV = await joinChannel(s.owner, v);
    const memberV = await joinChannel(s.member, v);
    expect(await db.rpcError(s.member, 'public.archive_channel', { p_channel_id: t })).toMatch(/unauthorized/);
    expect(await db.rpcError(s.owner, 'public.archive_channel', { p_channel_id: d.text })).toMatch(/invalid-argument/);
    expect(await db.rpcError(s.owner, 'public.archive_channel', { p_channel_id: d.voice })).toMatch(/invalid-argument/);
    const at = (await db.rpc<{ archive_channel: string }>(s.owner, 'public.archive_channel', { p_channel_id: t }))[0]!.archive_channel;
    expect((await db.rpc<{ archive_channel: string }>(s.owner, 'public.archive_channel', { p_channel_id: t }))[0]!.archive_channel).toEqual(at);
    expect(await readIn(s.member, t)).toEqual(['antes', 'repetível']);
    expect(await db.rpcError(s.member, 'public.send_channel_message', { p_channel_id: t, p_client_nonce: randomUUID(), p_body: 'depois' })).toMatch(/channel-archived/);
    expect(await sendIn(s.member, t, 'repetível', nonce)).toEqual(kept); // resposta perdida continua recuperável
    const byeBefore = (await db.admin<{ n: number }>(`select count(*)::int as n from realtime.messages where event = 'bye'`))[0]!.n;
    await db.rpc(s.owner, 'public.archive_channel', { p_channel_id: v });
    const revoked = await db.admin<{ id: string; revoke_reason: string }>('select id, revoke_reason from oryn.room_sessions where id = any($1::uuid[]) order by id', [[ownerV, memberV]]);
    expect(revoked.map((r) => r.revoke_reason)).toEqual(['channel-archived', 'channel-archived']);
    expect((await db.admin<{ n: number }>(`select count(*)::int as n from realtime.messages where event = 'bye'`))[0]!.n).toBeGreaterThan(byeBefore);
    expect(await db.rpcError(s.member, 'public.join_voice_channel', { p_channel_id: v })).toMatch(/channel-archived/);
    expect(await db.rpcError(s.member, 'public.touch_session', { p_session_id: memberV })).toMatch(/session-invalid/);
    const listed = await channels(s.member, s.room);
    expect(listed.slice(-2).map((c) => [c.name, c.archived_at !== null])).toEqual([['arquivo', true], ['sala 2', true]]); // arquivados no fim
  });

  it('sala encerrada: canais legíveis, sem criar, arquivar, enviar ou entrar', async () => {
    const t = await createChannel(s.owner, s.room, 'extra', 'text');
    await sendIn(s.member, t, 'guardada');
    await db.rpc(s.owner, 'public.close_room', { p_room_id: s.room });
    expect(await channels(s.member, s.room)).toHaveLength(3);
    expect(await readIn(s.member, t)).toEqual(['guardada']);
    expect(await db.rpcError(s.owner, 'public.create_channel', { p_room_id: s.room, p_name: 'y', p_kind: 'text' })).toMatch(/room-closed/);
    expect(await db.rpcError(s.owner, 'public.archive_channel', { p_channel_id: t })).toMatch(/room-closed/);
    expect(await db.rpcError(s.member, 'public.send_channel_message', { p_channel_id: t, p_client_nonce: randomUUID(), p_body: 'x' })).toMatch(/room-closed/);
    expect(await db.rpcError(s.member, 'public.join_voice_channel', { p_channel_id: d.voice })).toMatch(/not-member/);
  });

  it('membro removido perde canais, mensagens e voz; quem nunca foi membro também não alcança nada', async () => {
    const third = await joinWithInvite(db, s.room, s.owner, 'Terceiro');
    expect(await channels(third, s.room)).toHaveLength(2); // enquanto membro, vê os canais
    const thirdRef = (await db.rpc<{ member_ref: string; is_self: boolean }>(third, 'public.list_room_members', { p_room_id: s.room })).find((m) => m.is_self)!.member_ref;
    await db.rpc(s.owner, 'public.remove_room_member', { p_room_id: s.room, p_member_ref: thirdRef });
    expect(await db.rpcError(third, 'public.list_channels', { p_room_id: s.room })).toMatch(/unauthorized/);
    expect(await db.rpcError(third, 'public.list_channel_messages', { p_channel_id: d.text })).toMatch(/unauthorized/);
    expect(await db.rpcError(third, 'public.send_channel_message', { p_channel_id: d.text, p_client_nonce: randomUUID(), p_body: 'x' })).toMatch(/unauthorized/);
    expect(await db.rpcError(third, 'public.join_voice_channel', { p_channel_id: d.voice })).toMatch(/not-member/);
  });

  it('voz por canal: participantes, hello e sinalização ficam no canal; RPCs antigas veem só a voz padrão', async () => {
    const v = await createChannel(s.owner, s.room, 'sala 2', 'voice');
    const third = await joinWithInvite(db, s.room, s.owner, 'Terceiro');
    const ownerHellos = await hellosTo(s.ownerSession);
    const thirdV = await joinChannel(third, v);
    expect(await hellosTo(s.ownerSession)).toBe(ownerHellos); // quem está na voz padrão não recebe o hello do outro canal
    const inV = await db.rpc<{ session_id: string }>(s.member, 'public.get_channel_participants', { p_channel_id: v });
    expect(inV.map((p) => p.session_id)).toEqual([thirdV]);
    const inDefault = await db.rpc<{ session_id: string }>(s.member, 'public.get_channel_participants', { p_channel_id: d.voice });
    expect(inDefault.map((p) => p.session_id).sort()).toEqual([s.ownerSession, s.memberSession].sort());
    expect((await db.rpc<{ session_id: string }>(s.member, 'public.get_voice_participants', { p_room_id: s.room })).map((p) => p.session_id).sort())
      .toEqual([s.ownerSession, s.memberSession].sort());
    expect((await db.rpc<{ session_id: string }>(s.member, 'public.get_roster', { p_room_id: s.room })).map((p) => p.session_id).sort())
      .toEqual([s.ownerSession, s.memberSession].sort());
    // Sinalização: mesmo canal passa; canal diferente do mesmo espaço é recusado como destinatário inválido.
    expect(await db.rpcError(s.member, 'public.authorize_signal', signalArgs(s.memberSession, s.ownerSession))).toBeNull();
    expect(await db.rpcError(s.member, 'public.authorize_signal', signalArgs(s.memberSession, thirdV))).toMatch(/recipient-invalid/);
    expect(await db.rpcError(third, 'public.authorize_signal', signalArgs(thirdV, s.ownerSession))).toMatch(/recipient-invalid/);
    // O bye de quem sai vai só para o próprio canal.
    const byeToOwner = async () => (await db.admin<{ n: number }>(`select count(*)::int as n from realtime.messages where topic = $1 and event = 'bye'`, [`oryn:s:${s.ownerSession}`]))[0]!.n;
    const before = await byeToOwner();
    await db.rpc(third, 'public.leave_room', { p_session_id: thirdV });
    expect(await byeToOwner()).toBe(before);
    // O tópico continua por sessão: quem está num canal recebe só o próprio tópico.
    expect(await db.canReceive(third, `oryn:s:${thirdV}`)).toBe(false); // sessão encerrada
  });

  it('uma voz por usuário em cada espaço: sessão viva noutro canal impede a entrada; sair libera; limite de 2 sessões mantido', async () => {
    const v = await createChannel(s.owner, s.room, 'sala 2', 'voice');
    expect(await db.rpcError(s.member, 'public.join_voice_channel', { p_channel_id: v })).toMatch(/in-other-channel/);
    // Segunda sessão no MESMO canal (outra aba) continua permitida, até 2.
    const second = await joinChannel(s.member, d.voice);
    expect(await db.rpcError(s.member, 'public.join_voice_channel', { p_channel_id: d.voice })).toMatch(/limit-reached/);
    await db.rpc(s.member, 'public.leave_room', { p_session_id: s.memberSession });
    await db.rpc(s.member, 'public.leave_room', { p_session_id: second });
    const inV = await joinChannel(s.member, v);
    expect(await db.rpcError(s.member, 'public.join_room', { p_room_id: s.room })).toMatch(/in-other-channel/); // cliente antigo também respeita
    // Sessão sem batimento noutro canal não prende o usuário: expira na entrada seguinte.
    await db.admin(`update oryn.room_sessions set last_seen_at = now() - interval '5 minutes' where id = $1`, [inV]);
    expect(await openSession(db, s.member, s.room)).toMatch(/^[0-9a-f-]{36}$/);
    expect((await db.admin<{ revoke_reason: string }>('select revoke_reason from oryn.room_sessions where id = $1', [inV]))[0]!.revoke_reason).toBe('expired');
    // Entre espaços diferentes nada muda: o mesmo usuário pode estar na voz de outro espaço.
    const owner2 = await makeCreator(db);
    const room2 = await createRoom(db, owner2, 2, 'Outro');
    const member2 = await joinWithInvite(db, room2, owner2, 'Visitante');
    expect(member2).toBeTruthy();
    expect(await db.rpcError(s.owner, 'public.join_voice_channel', { p_channel_id: (await defaults(room2)).voice })).toMatch(/not-member/);
  });

  it('capacidade inalterada: sala nova com mais de 4 lugares continua recusada; canais não mudam o limite de membros', async () => {
    expect(await db.rpcError(s.owner, 'public.create_room', { p_name: 'Grande', p_display_name: 'Dono', p_max_members: 5 })).toMatch(/invalid-argument/);
    await createChannel(s.owner, s.room, 'sala 2', 'voice');
    expect((await db.admin<{ max_members: number }>('select max_members from oryn.rooms where id = $1', [s.room]))[0]!.max_members).toBe(3);
  });
});
