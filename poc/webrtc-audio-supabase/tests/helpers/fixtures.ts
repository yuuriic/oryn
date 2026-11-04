// Cenário montado SEMPRE pelos fluxos reais (RPCs), nunca por inserção direta nas tabelas de domínio:
// administrador emite convite de criador → dono resgata → cria sala → emite convite de sala → membro
// resgata → ambos abrem sessão.
import { randomUUID } from 'node:crypto';
import type { TestDb } from './db.ts';

export interface Scenario {
  owner: { uid: string };
  member: { uid: string };
  room: string;
  ownerSession: string;
  memberSession: string;
}

export async function creatorToken(db: TestDb, ttlMinutes = 60, maxOpenRooms = 2): Promise<string> {
  const rows = await db.admin<{ t: string }>('select oryn.admin_issue_creator_invite($1, $2) as t', [ttlMinutes, maxOpenRooms]);
  return rows[0]!.t;
}

export async function makeCreator(db: TestDb, maxOpenRooms = 2): Promise<{ uid: string }> {
  const user = await db.newUser();
  await db.rpc(user, 'public.redeem_creator_invite', { p_token: await creatorToken(db, 60, maxOpenRooms) });
  return user;
}

export async function createRoom(db: TestDb, owner: { uid: string }, maxMembers = 3, name = 'Partida'): Promise<string> {
  const rows = await db.rpc<{ create_room: string }>(owner, 'public.create_room', { p_name: name, p_display_name: 'Dono', p_max_members: maxMembers });
  return rows[0]!.create_room;
}

export async function roomInvite(db: TestDb, owner: { uid: string }, room: string, ttl = 10): Promise<string> {
  const rows = await db.rpc<{ token: string }>(owner, 'public.create_room_invite', { p_room_id: room, p_ttl_minutes: ttl });
  return rows[0]!.token;
}

export async function joinWithInvite(db: TestDb, room: string, owner: { uid: string }, name = 'Amigo'): Promise<{ uid: string }> {
  const user = await db.newUser();
  await db.rpc(user, 'public.redeem_room_invite', { p_token: await roomInvite(db, owner, room), p_display_name: name });
  return user;
}

export async function openSession(db: TestDb, user: { uid: string }, room: string): Promise<string> {
  const rows = await db.rpc<{ session_id: string }>(user, 'public.join_room', { p_room_id: room });
  return rows[0]!.session_id;
}

export async function scenario(db: TestDb): Promise<Scenario> {
  const owner = await makeCreator(db);
  const room = await createRoom(db, owner);
  const member = await joinWithInvite(db, room, owner);
  const ownerSession = await openSession(db, owner, room);
  const memberSession = await openSession(db, member, room);
  return { owner, member, room, ownerSession, memberSession };
}

export function signalArgs(from: string, to: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    p_session_id: from,
    p_to_session_id: to,
    p_client_msg_id: randomUUID(),
    p_kind: 'offer',
    p_pair_epoch: 1,
    p_payload_bytes: 900,
    ...over,
  };
}
