// Salas de grupo e ciclo de vida de membros (migração 0600) no Postgres real em memória (PGlite + shim). Cenários pelos
// fluxos reais (RPCs). A concorrência está em tests/pg/room-membership.pg.test.ts.
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestDb, type Actor } from './helpers/db.ts';
import { createRoom, joinWithInvite, makeCreator, openSession, roomInvite, scenario, type Scenario } from './helpers/fixtures.ts';

interface Member {
  member_ref: string;
  display_name: string;
  role: string;
  is_self: boolean;
  in_call: boolean;
  joined_at: string;
}
interface Participant {
  session_id: string;
  participant_ref: string;
  display_name: string;
  is_self: boolean;
  joined_at: string;
}

let db: TestDb;
let s: Scenario;
beforeEach(async () => {
  db = await TestDb.create();
  s = await scenario(db);
});
afterEach(() => db.close());

const members = (actor: Actor, room: string = s.room) => db.rpc<Member>(actor, 'public.list_room_members', { p_room_id: room });
const voice = (actor: Actor, room: string = s.room) => db.rpc<Participant>(actor, 'public.get_voice_participants', { p_room_id: room });
const leave = (actor: Actor, room: string = s.room) => db.rpcError(actor, 'public.leave_room_membership', { p_room_id: room });
const remove = (actor: Actor, ref: unknown, room: string = s.room) => db.rpcError(actor, 'public.remove_room_member', { p_room_id: room, p_member_ref: ref });
const refOf = async (name: string, room: string = s.room) => (await members(s.owner, room)).find((m) => m.display_name === name)!.member_ref;
const redeem = (actor: Actor, token: string, name = 'Volta') => db.rpcError(actor, 'public.redeem_room_invite', { p_token: token, p_display_name: name });
const send = (actor: Actor, body: string, room: string = s.room) => db.rpc(actor, 'public.send_room_message', { p_room_id: room, p_client_nonce: randomUUID(), p_body: body });
const history = async (actor: Actor, room: string = s.room) => (await db.rpc<{ display_name: string; body: string }>(actor, 'public.list_room_messages', { p_room_id: room })).map((m) => [m.display_name, m.body]);
const sessionReason = async (session: string) => (await db.admin<{ r: string | null }>('select revoke_reason as r from oryn.room_sessions where id = $1', [session]))[0]!.r;

describe('capacidade', () => {
  it.each([2, 3, 4, 5])('sala de %i lugares aceita exatamente essa quantidade de contas', async (capacity) => {
    const owner = await makeCreator(db);
    const room = await createRoom(db, owner, capacity, `Sala ${capacity}`);
    for (let i = 1; i < capacity; i++) await joinWithInvite(db, room, owner, `M${i}`);
    expect(await db.rpcError(owner, 'public.create_room_invite', { p_room_id: room, p_ttl_minutes: 10 })).toMatch(/^room-full$/);
    expect(await members(owner, room)).toHaveLength(capacity);
  });

  it('a quinta conta é recusada numa sala de quatro, mesmo com convite emitido antes de lotar', async () => {
    const owner = await makeCreator(db);
    const room = await createRoom(db, owner, 4, 'Quatro');
    const spare = await roomInvite(db, owner, room);
    for (const name of ['A', 'B', 'C']) await joinWithInvite(db, room, owner, name);
    expect(await redeem(await db.newUser(), spare)).toMatch(/^room-full$/);
    expect(await members(owner, room)).toHaveLength(4);
    // O convite não foi consumido pela recusa.
    expect((await db.admin<{ used: boolean }>('select used_at is not null as used from oryn.room_invites where token_hash = oryn.token_hash($1)', [spare]))[0]!.used).toBe(false);
  });

  it('a sexta conta é recusada numa sala de cinco (1000), mesmo com convite emitido antes de lotar', async () => {
    const owner = await makeCreator(db);
    const room = await createRoom(db, owner, 5, 'Cinco');
    const spare = await roomInvite(db, owner, room);
    for (const name of ['A', 'B', 'C', 'D']) await joinWithInvite(db, room, owner, name);
    expect(await redeem(await db.newUser(), spare)).toMatch(/^room-full$/);
    expect(await members(owner, room)).toHaveLength(5);
    expect(await db.rpcError(owner, 'public.create_room_invite', { p_room_id: room, p_ttl_minutes: 10 })).toMatch(/^room-full$/);
    expect((await db.admin<{ used: boolean }>('select used_at is not null as used from oryn.room_invites where token_hash = oryn.token_hash($1)', [spare]))[0]!.used).toBe(false);
  });

  it('sala de cinco: as cinco contas entram na voz e cada uma vê as outras quatro', async () => {
    const owner = await makeCreator(db);
    const room = await createRoom(db, owner, 5, 'Cinco na voz');
    const people = [owner];
    for (const name of ['A', 'B', 'C', 'D']) people.push(await joinWithInvite(db, room, owner, name));
    for (const p of people) await openSession(db, p, room);
    for (const p of people) {
      const list = await voice(p, room);
      expect(list).toHaveLength(5);
      expect(list.filter((x) => !x.is_self)).toHaveLength(4);
      expect(new Set(list.map((x) => x.participant_ref)).size).toBe(5);
    }
  });

  it('saída e substituição numa sala de cinco: a vaga liberada aceita uma conta nova, e a sexta continua recusada', async () => {
    const owner = await makeCreator(db);
    const room = await createRoom(db, owner, 5, 'Rodízio');
    const joined = [];
    for (const name of ['A', 'B', 'C', 'D']) joined.push(await joinWithInvite(db, room, owner, name));
    expect(await leave(joined[0]!, room)).toBeNull();
    expect(await members(owner, room)).toHaveLength(4);
    const substitute = await joinWithInvite(db, room, owner, 'E');
    expect(substitute).toBeTruthy();
    expect(await members(owner, room)).toHaveLength(5);
    expect(await db.rpcError(owner, 'public.create_room_invite', { p_room_id: room, p_ttl_minutes: 10 })).toMatch(/^room-full$/);
  });

  it.each([6, 10])('sala nova com %i lugares é recusada pelo backend', async (capacity) => {
    const owner = await makeCreator(db);
    expect(await db.rpcError(owner, 'public.create_room', { p_name: 'Grande', p_display_name: 'Dono', p_max_members: capacity })).toMatch(/^invalid-argument$/);
    expect((await db.admin<{ n: number }>('select count(*)::int as n from oryn.rooms where owner_id = $1', [owner.uid]))[0]!.n).toBe(0);
  });

  it('inserção direta com mais de 5 também é recusada; o limite está na tabela, não só na RPC', async () => {
    await expect(db.admin(`insert into oryn.rooms (owner_id, name, max_members) values ($1, 'x', 6)`, [s.owner.uid])).rejects.toThrow(/invalid-argument/);
    await db.admin(`insert into oryn.rooms (owner_id, name, max_members) values ($1, 'cinco', 5)`, [s.owner.uid]);
  });

  it('sala antiga com mais de 5 lugares não é invalidada', async () => {
    await db.admin('alter table oryn.rooms disable trigger oryn_room_capacity');
    await db.admin(`insert into oryn.rooms (owner_id, name, max_members) values ($1, 'antiga', 10)`, [s.owner.uid]);
    await db.admin('alter table oryn.rooms enable trigger oryn_room_capacity');
    await db.admin(`update oryn.rooms set name = 'antiga 2' where name = 'antiga'`);
    expect((await db.admin<{ m: number }>(`select max_members as m from oryn.rooms where name = 'antiga 2'`))[0]!.m).toBe(10);
  });

  it('sair libera a vaga para um convite novo', async () => {
    const owner = await makeCreator(db);
    const room = await createRoom(db, owner, 2, 'Dois');
    const member = await joinWithInvite(db, room, owner, 'M');
    expect(await leave(member, room)).toBeNull();
    await joinWithInvite(db, room, owner, 'N');
    expect((await members(owner, room)).map((m) => m.display_name).sort()).toEqual(['Dono', 'N']);
  });
});

describe('list_room_members', () => {
  it('exatamente os campos do contrato, sem conta de ninguém; dono primeiro', async () => {
    const rows = await members(s.member);
    expect(Object.keys(rows[0]!).sort()).toEqual(['display_name', 'in_call', 'is_self', 'joined_at', 'member_ref', 'role']);
    expect(rows.map((m) => [m.display_name, m.role, m.is_self])).toEqual([['Dono', 'owner', false], ['Amigo', 'member', true]]);
    const text = JSON.stringify(rows);
    expect(text).not.toContain(s.owner.uid);
    expect(text).not.toContain(s.member.uid);
  });

  it('a referência é opaca, estável na sala e diferente entre salas', async () => {
    const other = await createRoom(db, s.owner, 2, 'Outra');
    const here = (await members(s.owner)).find((m) => m.is_self)!.member_ref;
    const there = (await members(s.owner, other)).find((m) => m.is_self)!.member_ref;
    expect(here).toMatch(/^[0-9a-f]{32}$/);
    expect(here).not.toBe(there);
    expect((await members(s.owner)).find((m) => m.is_self)!.member_ref).toBe(here);
  });

  it('in_call acompanha a sessão viva, não a pertença', async () => {
    expect((await members(s.owner)).map((m) => m.in_call)).toEqual([true, true]);
    await db.rpc(s.member, 'public.leave_room', { p_session_id: s.memberSession });
    expect((await members(s.owner)).map((m) => m.in_call)).toEqual([true, false]);
    await db.admin(`update oryn.room_sessions set last_seen_at = now() - interval '5 minutes' where id = $1`, [s.ownerSession]);
    expect((await members(s.owner)).map((m) => m.in_call)).toEqual([false, false]);
  });

  it('recusas: estranho, sala inexistente, membro removido e anônimo; sala encerrada segue legível a membro', async () => {
    expect(await db.rpcError(await db.newUser(), 'public.list_room_members', { p_room_id: s.room })).toMatch(/^unauthorized$/);
    expect(await db.rpcError(s.owner, 'public.list_room_members', { p_room_id: randomUUID() })).toMatch(/^unauthorized$/);
    expect(await db.rpcError('anon', 'public.list_room_members', { p_room_id: s.room })).toMatch(/permission denied/);
    expect(await db.rpcError('service', 'public.list_room_members', { p_room_id: s.room })).toMatch(/permission denied/);
    expect(await leave(s.member)).toBeNull();
    expect(await db.rpcError(s.member, 'public.list_room_members', { p_room_id: s.room })).toMatch(/^unauthorized$/);
    await db.rpc(s.owner, 'public.close_room', { p_room_id: s.room });
    expect(await members(s.owner)).toHaveLength(1);
  });
});

describe('get_voice_participants', () => {
  it('distingue contas de sessões: a mesma conta tem a mesma referência em duas sessões', async () => {
    const second = await openSession(db, s.member, s.room);
    const rows = await voice(s.owner);
    expect(rows.map((r) => r.session_id)).toEqual([s.ownerSession, s.memberSession, second]);
    expect(Object.keys(rows[0]!).sort()).toEqual(['display_name', 'is_self', 'joined_at', 'participant_ref', 'session_id']);
    expect(rows[1]!.participant_ref).toBe(rows[2]!.participant_ref);
    expect(rows[0]!.participant_ref).not.toBe(rows[1]!.participant_ref);
    expect(rows.map((r) => r.is_self)).toEqual([true, false, false]);
    expect(JSON.stringify(rows)).not.toContain(s.member.uid);
  });

  it('não lista sessão vencida nem revogada; a referência é a mesma da lista de membros', async () => {
    await db.rpc(s.member, 'public.leave_room', { p_session_id: s.memberSession });
    const rows = await voice(s.owner);
    expect(rows.map((r) => r.session_id)).toEqual([s.ownerSession]);
    expect(rows[0]!.participant_ref).toBe((await members(s.owner)).find((m) => m.is_self)!.member_ref);
  });

  it('recusas com o mesmo código do roster, que a chamada em curso já trata: not-member', async () => {
    expect(await db.rpcError(await db.newUser(), 'public.get_voice_participants', { p_room_id: s.room })).toMatch(/^not-member$/);
    expect(await db.rpcError(s.owner, 'public.get_voice_participants', { p_room_id: randomUUID() })).toMatch(/^not-member$/);
    expect(await db.rpcError('anon', 'public.get_voice_participants', { p_room_id: s.room })).toMatch(/permission denied/);
    await db.rpc(s.owner, 'public.close_room', { p_room_id: s.room });
    expect(await db.rpcError(s.owner, 'public.get_voice_participants', { p_room_id: s.room })).toMatch(/^not-member$/);
  });
});

describe('leave_room_membership', () => {
  it('revoga as sessões, retira o acesso e avisa os demais; as mensagens continuam para quem ficou', async () => {
    await send(s.member, 'antes de sair');
    expect(await leave(s.member)).toBeNull();
    expect(await sessionReason(s.memberSession)).toBe('left');
    expect(await db.rpcError(s.member, 'public.touch_session', { p_session_id: s.memberSession })).toMatch(/session-invalid/);
    expect(await db.rpcError(s.member, 'public.join_room', { p_room_id: s.room })).toMatch(/not-member/);
    expect(await db.rpcError(s.member, 'public.list_room_messages', { p_room_id: s.room })).toMatch(/^unauthorized$/);
    expect(await db.rpc(s.member, 'public.list_my_rooms')).toEqual([]);
    expect(await history(s.owner)).toEqual([['Amigo', 'antes de sair']]);
    const byes = await db.admin<{ payload: { session_id: string } }>(`select payload from realtime.messages where event = 'bye' and topic = $1`, [`oryn:s:${s.ownerSession}`]);
    expect(byes.map((b) => b.payload.session_id)).toContain(s.memberSession);
  });

  it('o dono não abandona a sala', async () => {
    expect(await leave(s.owner)).toMatch(/^owner-cannot-leave$/);
    expect(await members(s.owner)).toHaveLength(2);
    expect(await sessionReason(s.ownerSession)).toBeNull();
  });

  it('repetir, estranho, sala inexistente e anônimo: a mesma recusa, sem efeito', async () => {
    expect(await leave(s.member)).toBeNull();
    expect(await leave(s.member)).toMatch(/^unauthorized$/);
    expect(await leave(await db.newUser())).toMatch(/^unauthorized$/);
    expect(await leave(s.owner, randomUUID())).toMatch(/^unauthorized$/);
    expect(await leave('anon')).toMatch(/permission denied/);
    expect(await leave('service')).toMatch(/permission denied/);
  });

  it('sair de sala encerrada: permitido; ela deixa de aparecer', async () => {
    await db.rpc(s.owner, 'public.close_room', { p_room_id: s.room });
    expect(await leave(s.member)).toBeNull();
    expect(await db.rpc(s.member, 'public.list_my_rooms')).toEqual([]);
  });

  it('um convite da sala emitido antes da saída não traz o membro de volta; um emitido depois traz', async () => {
    const old = await roomInvite(db, s.owner, s.room);
    expect(await leave(s.member)).toBeNull();
    expect(await redeem(s.member, old)).toMatch(/^invite-invalid$/);
    expect((await members(s.owner)).map((m) => m.display_name)).toEqual(['Dono']);
    expect((await db.admin<{ used: boolean }>('select used_at is not null as used from oryn.room_invites where token_hash = oryn.token_hash($1)', [old]))[0]!.used).toBe(false);
    // O mesmo convite segue válido para outra conta: sair não revoga convite do dono.
    expect(await redeem(await db.newUser(), old, 'Outra')).toBeNull();
    await db.rpc(s.owner, 'public.revoke_room_invite', { p_room_id: s.room });
    const fresh = await roomInvite(db, s.owner, s.room);
    await db.admin('update oryn.rooms set max_members = 3 where id = $1', [s.room]);
    expect(await redeem(s.member, fresh, 'De volta')).toBeNull();
    expect((await members(s.owner)).map((m) => m.display_name)).toEqual(['Dono', 'Outra', 'De volta']);
  });
});

describe('remove_room_member', () => {
  it('o dono remove: sessões revogadas, convites pendentes revogados e histórico preservado', async () => {
    await send(s.member, 'fica no histórico');
    const pending = await roomInvite(db, s.owner, s.room);
    expect(await remove(s.owner, await refOf('Amigo'))).toBeNull();
    expect(await sessionReason(s.memberSession)).toBe('removed');
    expect(await db.rpcError(s.member, 'public.touch_session', { p_session_id: s.memberSession })).toMatch(/session-invalid/);
    expect(await db.rpcError(s.member, 'public.get_roster', { p_room_id: s.room })).toMatch(/not-member/);
    expect(await db.rpcError(s.member, 'public.get_voice_participants', { p_room_id: s.room })).toMatch(/not-member/);
    expect(await db.rpcError(s.member, 'public.list_room_messages', { p_room_id: s.room })).toMatch(/^unauthorized$/);
    expect(await db.rpcError(s.member, 'public.send_room_message', { p_room_id: s.room, p_client_nonce: randomUUID(), p_body: 'x' })).toMatch(/^unauthorized$/);
    expect(await history(s.owner)).toEqual([['Amigo', 'fica no histórico']]);
    expect(await redeem(await db.newUser(), pending)).toMatch(/^invite-invalid$/);
  });

  it('o bye chega também à sessão de quem foi removido, e ela é a única forma de saber na hora', async () => {
    expect(await remove(s.owner, await refOf('Amigo'))).toBeNull();
    const byes = await db.admin<{ topic: string }>(`select topic from realtime.messages where event = 'bye' order by topic`);
    expect(byes.map((b) => b.topic).sort()).toEqual([`oryn:s:${s.memberSession}`, `oryn:s:${s.ownerSession}`].sort());
  });

  it('convite antigo não reativa quem foi removido, mesmo com o convite escapando da revogação', async () => {
    const old = await roomInvite(db, s.owner, s.room);
    await db.admin(`update oryn.room_members set removed_at = clock_timestamp() where room_id = $1 and user_id = $2`, [s.room, s.member.uid]);
    expect(await redeem(s.member, old)).toMatch(/^invite-invalid$/);
    expect((await members(s.owner)).map((m) => m.display_name)).toEqual(['Dono']);
  });

  it('convite expirado ou revogado continua recusado', async () => {
    expect(await remove(s.owner, await refOf('Amigo'))).toBeNull();
    const expired = await roomInvite(db, s.owner, s.room);
    await db.admin(`update oryn.room_invites set expires_at = created_at + interval '1 second', created_at = created_at - interval '1 hour' where token_hash = oryn.token_hash($1)`, [expired]);
    await db.admin(`update oryn.room_invites set expires_at = now() - interval '1 minute' where token_hash = oryn.token_hash($1)`, [expired]);
    expect(await redeem(s.member, expired)).toMatch(/^invite-invalid$/);
    const revoked = await roomInvite(db, s.owner, s.room);
    await db.rpc(s.owner, 'public.revoke_room_invite', { p_room_id: s.room });
    expect(await redeem(s.member, revoked)).toMatch(/^invite-invalid$/);
  });

  it.each([false, true])('convite emitido depois da remoção permite voltar, com o histórico anterior (nome global: %s)', async (globalName) => {
    if (globalName) await db.admin(`update auth.users set raw_user_meta_data = '{"display_name":"Nome global"}' where id = $1`, [s.member.uid]);
    await send(s.member, 'primeira vez');
    const name = globalName ? 'Nome global' : 'Amigo';
    const after = globalName ? 'Nome global' : 'Voltei';
    // O relógio de parede do PGlite vem de Date.now(), com resolução de 1 ms.
    // Chamadas sequenciais não garantem timestamps distintos. O cenário exige
    // convite ESTRITAMENTE posterior: controla o relógio, sem sleep nem retry.
    const time = Date.now() + 1_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(time);
    try {
      expect(await remove(s.owner, await refOf(name))).toBeNull();
      clock.mockReturnValue(time + 1);
      const fresh = await roomInvite(db, s.owner, s.room);
      const [order] = await db.admin<{ after: boolean }>(`select i.created_at > m.removed_at as after
        from oryn.room_invites i join oryn.room_members m on m.room_id = i.room_id
        where i.token_hash = oryn.token_hash($1) and m.user_id = $2`, [fresh, s.member.uid]);
      expect(order!.after).toBe(true);
      expect(await redeem(s.member, fresh, 'Voltei')).toBeNull();
      expect((await members(s.owner)).map((m) => m.display_name)).toEqual(['Dono', after]);
      expect(await history(s.member)).toEqual([[after, 'primeira vez']]);
      expect(await db.rpcError(s.member, 'public.join_room', { p_room_id: s.room })).toBeNull();
    } finally { clock.mockRestore(); }
  });

  it('convite com timestamp igual ao da remoção não reativa o membro nem é consumido', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1_000);
    try {
      expect(await remove(s.owner, await refOf('Amigo'))).toBeNull();
      const fresh = await roomInvite(db, s.owner, s.room);
      const [order] = await db.admin<{ equal: boolean }>(`select i.created_at = m.removed_at as equal
        from oryn.room_invites i join oryn.room_members m on m.room_id = i.room_id
        where i.token_hash = oryn.token_hash($1) and m.user_id = $2`, [fresh, s.member.uid]);
      expect(order!.equal).toBe(true);
      expect(await redeem(s.member, fresh)).toBe('invite-invalid');
      expect((await members(s.owner)).map((m) => m.display_name)).toEqual(['Dono']);
      expect((await db.admin<{ used: boolean }>('select used_at is not null as used from oryn.room_invites where token_hash = oryn.token_hash($1)', [fresh]))[0]!.used).toBe(false);
      expect(await sessionReason(s.memberSession)).toBe('removed');
    } finally { clock.mockRestore(); }
  });

  it('só o dono remove; qualquer outro recebe a mesma recusa, sem efeito', async () => {
    const third = await joinWithInvite(db, s.room, s.owner, 'Terceiro');
    const ref = await refOf('Terceiro');
    expect(await remove(s.member, ref)).toMatch(/^unauthorized$/);
    expect(await remove(await db.newUser(), ref)).toMatch(/^unauthorized$/);
    expect(await remove('anon', ref)).toMatch(/permission denied/);
    expect(await remove('service', ref)).toMatch(/permission denied/);
    expect(await remove(s.owner, ref, randomUUID())).toMatch(/^unauthorized$/);
    expect((await members(third)).length).toBe(3);
  });

  it('não permite autorremoção, nem remover por referência de outra sala, inválida ou nula', async () => {
    const own = (await members(s.owner)).find((m) => m.is_self)!.member_ref;
    expect(await remove(s.owner, own)).toMatch(/^unauthorized$/);
    const other = await createRoom(db, s.owner, 2, 'Outra');
    await joinWithInvite(db, other, s.owner, 'Lá');
    expect(await remove(s.owner, await refOf('Lá', other))).toMatch(/^unauthorized$/);
    for (const bad of ['', 'x'.repeat(32), s.member.uid, `' or 1=1 --`, null]) expect(await remove(s.owner, bad), String(bad)).toMatch(/^unauthorized$/);
    expect(await members(s.owner)).toHaveLength(2);
  });

  it('dono de outra sala não alcança esta; membro removido não repete; sala encerrada recusa', async () => {
    const other = await makeCreator(db);
    expect(await remove(other, await refOf('Amigo'))).toMatch(/^unauthorized$/);
    const ref = await refOf('Amigo');
    expect(await remove(s.owner, ref)).toBeNull();
    expect(await remove(s.owner, ref)).toMatch(/^unauthorized$/);
    const third = await joinWithInvite(db, s.room, s.owner, 'Terceiro');
    const thirdRef = await refOf('Terceiro');
    await db.rpc(s.owner, 'public.close_room', { p_room_id: s.room });
    expect(await remove(s.owner, thirdRef)).toMatch(/^unauthorized$/);
    expect((await db.admin<{ removed: boolean }>('select removed_at is not null as removed from oryn.room_members where room_id = $1 and user_id = $2', [s.room, third.uid]))[0]!.removed).toBe(false);
  });

  it('papel e identidade não podem ser manipulados: as RPCs só aceitam a referência e não mudam papéis', async () => {
    const before = await db.admin('select user_id, role from oryn.room_members where room_id = $1 order by user_id', [s.room]);
    await remove(s.member, await refOf('Dono'));
    await leave(s.owner);
    expect(await db.admin('select user_id, role from oryn.room_members where room_id = $1 order by user_id', [s.room])).toEqual(before);
    expect(await db.rpcError(s.member, 'public.remove_room_member', { p_room_id: s.room, p_member_ref: await refOf('Dono'), p_role: 'owner' })).not.toBeNull();
  });
});

describe('o que a 0600 não muda', () => {
  it('salas de dois lugares, convite, chat e sessão seguem iguais', async () => {
    const owner = await makeCreator(db);
    const room = await createRoom(db, owner, 2, 'Par');
    const member = await joinWithInvite(db, room, owner, 'Par');
    await openSession(db, owner, room);
    await openSession(db, member, room);
    await send(member, 'oi', room);
    expect(await history(owner, room)).toEqual([['Par', 'oi']]);
    expect(await db.rpc(owner, 'public.get_roster', { p_room_id: room })).toHaveLength(2);
    expect(await db.rpcError(owner, 'public.create_room_invite', { p_room_id: room, p_ttl_minutes: 10 })).toMatch(/^room-full$/);
  });

  it('nenhum papel de cliente executa as funções internas', async () => {
    for (const sig of ['oryn.member_ref(uuid,uuid)', 'oryn.enforce_room_capacity()', 'oryn.guard_member_reactivation()', 'oryn.end_membership(uuid,uuid,text)']) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect((await db.admin<{ ok: boolean }>(`select has_function_privilege($1, $2, 'execute') as ok`, [role, sig]))[0]!.ok, `${role} ${sig}`).toBe(false);
      }
    }
  });
});
