// Auditoria das funções SECURITY DEFINER (02C.1B.0A), em Postgres real (PGlite) com o shim do Supabase.
// 1. Catálogo: o conjunto de funções expostas em `public` é EXATAMENTE o contrato; ninguém além do dono e
//    do papel previsto tem EXECUTE, inclusive por herança de PUBLIC (proacl NULL = padrão do Postgres).
// 2. Autorização interna: cada RPC de usuário chama oryn.require_uid() e recusa usuário sem convite,
//    sessão alheia e IDs arbitrários, SEM efeito colateral no banco.
// 3. Independência de RLS: as funções rodam como dono das tabelas (que ignora RLS sem FORCE), então a
//    proteção é a lógica interna. A mesma matriz roda de novo com o RLS DESLIGADO e dá o mesmo resultado.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestDb, type Actor } from './helpers/db.ts';
import { roomInvite, scenario, signalArgs, type Scenario } from './helpers/fixtures.ts';

const USER_RPCS: Record<string, string> = {
  redeem_creator_invite: 'public.redeem_creator_invite(text)',
  create_room: 'public.create_room(text,text,integer)',
  create_room_invite: 'public.create_room_invite(uuid,integer)',
  revoke_room_invite: 'public.revoke_room_invite(uuid)',
  redeem_room_invite: 'public.redeem_room_invite(text,text)',
  join_room: 'public.join_room(uuid)',
  touch_session: 'public.touch_session(uuid)',
  leave_room: 'public.leave_room(uuid)',
  get_roster: 'public.get_roster(uuid)',
  authorize_signal: 'public.authorize_signal(uuid,uuid,uuid,text,integer,integer)',
  ack_signals: 'public.ack_signals(uuid,uuid[])',
  list_my_rooms: 'public.list_my_rooms()',
  close_room: 'public.close_room(uuid)',
  send_room_message: 'public.send_room_message(uuid,uuid,text)',
  list_room_messages: 'public.list_room_messages(uuid,bigint,bigint,integer)',
  list_room_members: 'public.list_room_members(uuid)',
  get_voice_participants: 'public.get_voice_participants(uuid)',
  leave_room_membership: 'public.leave_room_membership(uuid)',
  remove_room_member: 'public.remove_room_member(uuid,text)',
  sound_clock: 'public.sound_clock()',
  list_sounds: 'public.list_sounds(uuid)',
  request_sound_upload: 'public.request_sound_upload(uuid,text,integer)',
  claim_sound_validation: 'public.claim_sound_validation(uuid)',
  remove_sound: 'public.remove_sound(uuid)',
  list_sound_cleanup: 'public.list_sound_cleanup(uuid)',
  trigger_sound: 'public.trigger_sound(uuid,uuid)',
  list_channels: 'public.list_channels(uuid)',
  create_channel: 'public.create_channel(uuid,text,text)',
  archive_channel: 'public.archive_channel(uuid)',
  send_channel_message: 'public.send_channel_message(uuid,uuid,text)',
  list_channel_messages: 'public.list_channel_messages(uuid,bigint,bigint,integer)',
  join_voice_channel: 'public.join_voice_channel(uuid)',
  get_channel_participants: 'public.get_channel_participants(uuid)',
};
const SERVICE_RPCS: Record<string, string> = {
  set_signal_state: 'public.set_signal_state(uuid,text)',
  complete_sound_validation: 'public.complete_sound_validation(uuid,boolean,text,integer,integer,text,text)',
  finish_sound_cleanup: 'public.finish_sound_cleanup(uuid[])',
};

/** Quem, além do dono, pode ter EXECUTE em cada função das schemas da Oryn. Ausente = ninguém. */
const ALLOWED_GRANTEES: Record<string, string[]> = {
  ...Object.fromEntries(Object.values(USER_RPCS).map((sig) => [sig, ['authenticated']])),
  ...Object.fromEntries(Object.values(SERVICE_RPCS).map((sig) => [sig, ['service_role']])),
  'oryn_realtime.can_receive_topic(text)': ['authenticated'],
  'oryn_realtime.can_read_sound(text)': ['authenticated'],
  'oryn_realtime.can_upload_sound(text)': ['authenticated'],
};

// Token com formato válido (43 caracteres base64url) que não corresponde a nenhum convite.
const randomToken = () => Buffer.from(randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), 'hex').toString('base64url');

interface Case {
  label: string;
  actor: Actor;
  fn: string;
  args: Record<string, unknown>;
  error: RegExp | null; // null = não falha, mas também não pode alterar nada
}

interface DefaultChannels { text: string; voice: string }

function matrix(s: Scenario, stranger: { uid: string }, inviteToken: string, ch: DefaultChannels): Case[] {
  const rnd = randomUUID;
  return [
    { label: 'sem convite: resgata convite de criador inexistente', actor: stranger, fn: 'redeem_creator_invite', args: { p_token: randomToken() }, error: /invite-invalid/ },
    { label: 'sem convite: token malformado', actor: stranger, fn: 'redeem_creator_invite', args: { p_token: "x' or 1=1 --" }, error: /invite-invalid/ },
    { label: 'sem convite de criador: cria sala', actor: stranger, fn: 'create_room', args: { p_name: 'x', p_display_name: 'x', p_max_members: 3 }, error: /unauthorized/ },
    { label: 'membro sem convite de criador: cria sala', actor: s.member, fn: 'create_room', args: { p_name: 'x', p_display_name: 'x', p_max_members: 3 }, error: /unauthorized/ },
    { label: 'estranho: emite convite na sala alheia', actor: stranger, fn: 'create_room_invite', args: { p_room_id: s.room, p_ttl_minutes: 10 }, error: /unauthorized/ },
    { label: 'membro (não dono): emite convite', actor: s.member, fn: 'create_room_invite', args: { p_room_id: s.room, p_ttl_minutes: 10 }, error: /unauthorized/ },
    { label: 'dono: emite convite em sala arbitrária', actor: s.owner, fn: 'create_room_invite', args: { p_room_id: rnd(), p_ttl_minutes: 10 }, error: /unauthorized/ },
    { label: 'estranho: revoga convites da sala alheia', actor: stranger, fn: 'revoke_room_invite', args: { p_room_id: s.room }, error: /unauthorized/ },
    { label: 'membro (não dono): revoga convites', actor: s.member, fn: 'revoke_room_invite', args: { p_room_id: s.room }, error: /unauthorized/ },
    { label: 'sala arbitrária: revoga convites', actor: s.owner, fn: 'revoke_room_invite', args: { p_room_id: rnd() }, error: /unauthorized/ },
    { label: 'sem convite: resgata convite de sala inexistente', actor: stranger, fn: 'redeem_room_invite', args: { p_token: randomToken(), p_display_name: 'x' }, error: /invite-invalid/ },
    { label: 'já membro: resgata convite válido (não consome)', actor: s.member, fn: 'redeem_room_invite', args: { p_token: inviteToken, p_display_name: 'x' }, error: /already-member/ },
    { label: 'estranho: entra na sala alheia', actor: stranger, fn: 'join_room', args: { p_room_id: s.room }, error: /not-member/ },
    { label: 'sala arbitrária: entra', actor: s.member, fn: 'join_room', args: { p_room_id: rnd() }, error: /not-member/ },
    { label: 'estranho: batimento da sessão alheia', actor: stranger, fn: 'touch_session', args: { p_session_id: s.memberSession }, error: /session-invalid/ },
    { label: 'dono: batimento da sessão do membro', actor: s.owner, fn: 'touch_session', args: { p_session_id: s.memberSession }, error: /session-invalid/ },
    { label: 'sessão arbitrária: batimento', actor: s.member, fn: 'touch_session', args: { p_session_id: rnd() }, error: /session-invalid/ },
    { label: 'estranho: encerra sessão alheia', actor: stranger, fn: 'leave_room', args: { p_session_id: s.memberSession }, error: /session-invalid/ },
    { label: 'dono: encerra sessão do membro', actor: s.owner, fn: 'leave_room', args: { p_session_id: s.memberSession }, error: /session-invalid/ },
    { label: 'sessão arbitrária: encerra', actor: s.member, fn: 'leave_room', args: { p_session_id: rnd() }, error: /session-invalid/ },
    { label: 'estranho: lê participantes', actor: stranger, fn: 'get_roster', args: { p_room_id: s.room }, error: /not-member/ },
    { label: 'sala arbitrária: lê participantes', actor: s.member, fn: 'get_roster', args: { p_room_id: rnd() }, error: /not-member/ },
    { label: 'estranho: sinaliza usando sessão alheia', actor: stranger, fn: 'authorize_signal', args: signalArgs(s.memberSession, s.ownerSession), error: /session-invalid/ },
    { label: 'dono: sinaliza como se fosse o membro', actor: s.owner, fn: 'authorize_signal', args: signalArgs(s.memberSession, s.ownerSession), error: /session-invalid/ },
    { label: 'sessões arbitrárias: sinaliza', actor: s.member, fn: 'authorize_signal', args: signalArgs(rnd(), rnd()), error: /session-invalid/ },
    { label: 'destino arbitrário: sinaliza', actor: s.member, fn: 'authorize_signal', args: signalArgs(s.memberSession, rnd()), error: /recipient-invalid/ },
    { label: 'estranho: confirma mensagens na sessão alheia', actor: stranger, fn: 'ack_signals', args: { p_session_id: s.memberSession, p_msg_ids: [rnd()] }, error: /session-invalid/ },
    { label: 'sessão arbitrária: confirma', actor: s.member, fn: 'ack_signals', args: { p_session_id: rnd(), p_msg_ids: [rnd()] }, error: /session-invalid/ },
    { label: 'própria sessão, mensagens arbitrárias: nada muda', actor: s.member, fn: 'ack_signals', args: { p_session_id: s.memberSession, p_msg_ids: [rnd()] }, error: null },
    { label: 'usuário: transição de publicação (só service_role)', actor: s.owner, fn: 'set_signal_state', args: { p_msg_id: rnd(), p_state: 'published' }, error: /permission denied/ },
    { label: 'anon: transição de publicação', actor: 'anon', fn: 'set_signal_state', args: { p_msg_id: rnd(), p_state: 'published' }, error: /permission denied/ },
    { label: 'anon: entra na sala', actor: 'anon', fn: 'join_room', args: { p_room_id: s.room }, error: /permission denied/ },
    { label: 'estranho: lista salas (nenhuma, nada muda)', actor: stranger, fn: 'list_my_rooms', args: {}, error: null },
    { label: 'anon: lista salas', actor: 'anon', fn: 'list_my_rooms', args: {}, error: /permission denied/ },
    { label: 'estranho: encerra sala alheia', actor: stranger, fn: 'close_room', args: { p_room_id: s.room }, error: /unauthorized/ },
    { label: 'membro (não dono): encerra a sala', actor: s.member, fn: 'close_room', args: { p_room_id: s.room }, error: /unauthorized/ },
    { label: 'dono: encerra sala arbitrária', actor: s.owner, fn: 'close_room', args: { p_room_id: rnd() }, error: /unauthorized/ },
    { label: 'anon: encerra sala', actor: 'anon', fn: 'close_room', args: { p_room_id: s.room }, error: /permission denied/ },
    { label: 'estranho: envia mensagem', actor: stranger, fn: 'send_room_message', args: { p_room_id: s.room, p_client_nonce: rnd(), p_body: 'x' }, error: /unauthorized/ },
    { label: 'anon: envia mensagem', actor: 'anon', fn: 'send_room_message', args: { p_room_id: s.room, p_client_nonce: rnd(), p_body: 'x' }, error: /permission denied/ },
    { label: 'estranho: lê mensagens', actor: stranger, fn: 'list_room_messages', args: { p_room_id: s.room }, error: /unauthorized/ },
    { label: 'anon: lê mensagens', actor: 'anon', fn: 'list_room_messages', args: { p_room_id: s.room }, error: /permission denied/ },
    { label: 'estranho: lista membros', actor: stranger, fn: 'list_room_members', args: { p_room_id: s.room }, error: /unauthorized/ },
    { label: 'anon: lista membros', actor: 'anon', fn: 'list_room_members', args: { p_room_id: s.room }, error: /permission denied/ },
    { label: 'estranho: lista participantes', actor: stranger, fn: 'get_voice_participants', args: { p_room_id: s.room }, error: /not-member/ },
    { label: 'anon: lista participantes', actor: 'anon', fn: 'get_voice_participants', args: { p_room_id: s.room }, error: /permission denied/ },
    { label: 'estranho: sai da sala', actor: stranger, fn: 'leave_room_membership', args: { p_room_id: s.room }, error: /unauthorized/ },
    { label: 'dono: abandona a sala', actor: s.owner, fn: 'leave_room_membership', args: { p_room_id: s.room }, error: /owner-cannot-leave/ },
    { label: 'anon: sai da sala', actor: 'anon', fn: 'leave_room_membership', args: { p_room_id: s.room }, error: /permission denied/ },
    { label: 'membro: remove outro', actor: s.member, fn: 'remove_room_member', args: { p_room_id: s.room, p_member_ref: 'x' }, error: /unauthorized/ },
    { label: 'estranho: remove membro', actor: stranger, fn: 'remove_room_member', args: { p_room_id: s.room, p_member_ref: 'x' }, error: /unauthorized/ },
    { label: 'dono: referência inexistente', actor: s.owner, fn: 'remove_room_member', args: { p_room_id: s.room, p_member_ref: 'x' }, error: /unauthorized/ },
    { label: 'anon: remove membro', actor: 'anon', fn: 'remove_room_member', args: { p_room_id: s.room, p_member_ref: 'x' }, error: /permission denied/ },
    { label: 'anon: hora do servidor', actor: 'anon', fn: 'sound_clock', args: {}, error: /permission denied/ },
    { label: 'estranho: catálogo', actor: stranger, fn: 'list_sounds', args: { p_room_id: s.room }, error: /not-member/ },
    { label: 'anon: catálogo', actor: 'anon', fn: 'list_sounds', args: { p_room_id: s.room }, error: /permission denied/ },
    { label: 'membro: reserva envio', actor: s.member, fn: 'request_sound_upload', args: { p_room_id: s.room, p_name: 'x', p_size_bytes: 10 }, error: /unauthorized/ },
    { label: 'estranho: reserva envio', actor: stranger, fn: 'request_sound_upload', args: { p_room_id: s.room, p_name: 'x', p_size_bytes: 10 }, error: /unauthorized/ },
    { label: 'anon: reserva envio', actor: 'anon', fn: 'request_sound_upload', args: { p_room_id: s.room, p_name: 'x', p_size_bytes: 10 }, error: /permission denied/ },
    { label: 'estranho: valida som', actor: stranger, fn: 'claim_sound_validation', args: { p_asset_id: rnd() }, error: /unauthorized/ },
    { label: 'anon: valida som', actor: 'anon', fn: 'claim_sound_validation', args: { p_asset_id: rnd() }, error: /permission denied/ },
    { label: 'estranho: remove som', actor: stranger, fn: 'remove_sound', args: { p_asset_id: rnd() }, error: /unauthorized/ },
    { label: 'anon: remove som', actor: 'anon', fn: 'remove_sound', args: { p_asset_id: rnd() }, error: /permission denied/ },
    { label: 'membro: lista limpeza', actor: s.member, fn: 'list_sound_cleanup', args: { p_room_id: s.room }, error: /unauthorized/ },
    { label: 'anon: lista limpeza', actor: 'anon', fn: 'list_sound_cleanup', args: { p_room_id: s.room }, error: /permission denied/ },
    { label: 'estranho: dispara som', actor: stranger, fn: 'trigger_sound', args: { p_session_id: rnd(), p_asset_id: rnd() }, error: /session-invalid/ },
    { label: 'anon: dispara som', actor: 'anon', fn: 'trigger_sound', args: { p_session_id: rnd(), p_asset_id: rnd() }, error: /permission denied/ },
    // 0900: canais.
    { label: 'estranho: lista canais', actor: stranger, fn: 'list_channels', args: { p_room_id: s.room }, error: /unauthorized/ },
    { label: 'sala arbitrária: lista canais', actor: s.member, fn: 'list_channels', args: { p_room_id: rnd() }, error: /unauthorized/ },
    { label: 'anon: lista canais', actor: 'anon', fn: 'list_channels', args: { p_room_id: s.room }, error: /permission denied/ },
    { label: 'membro (não dono): cria canal', actor: s.member, fn: 'create_channel', args: { p_room_id: s.room, p_name: 'x', p_kind: 'text' }, error: /unauthorized/ },
    { label: 'estranho: cria canal', actor: stranger, fn: 'create_channel', args: { p_room_id: s.room, p_name: 'x', p_kind: 'voice' }, error: /unauthorized/ },
    { label: 'dono: tipo de canal inválido', actor: s.owner, fn: 'create_channel', args: { p_room_id: s.room, p_name: 'x', p_kind: 'video' }, error: /invalid-argument/ },
    { label: 'dono: nome repetido do padrão', actor: s.owner, fn: 'create_channel', args: { p_room_id: s.room, p_name: 'CONVERSA', p_kind: 'text' }, error: /name-taken/ },
    { label: 'anon: cria canal', actor: 'anon', fn: 'create_channel', args: { p_room_id: s.room, p_name: 'x', p_kind: 'text' }, error: /permission denied/ },
    { label: 'membro (não dono): arquiva canal', actor: s.member, fn: 'archive_channel', args: { p_channel_id: ch.text }, error: /unauthorized/ },
    { label: 'dono: arquiva canal padrão', actor: s.owner, fn: 'archive_channel', args: { p_channel_id: ch.voice }, error: /invalid-argument/ },
    { label: 'canal arbitrário: arquiva', actor: s.owner, fn: 'archive_channel', args: { p_channel_id: rnd() }, error: /unauthorized/ },
    { label: 'anon: arquiva canal', actor: 'anon', fn: 'archive_channel', args: { p_channel_id: ch.text }, error: /permission denied/ },
    { label: 'estranho: envia no canal', actor: stranger, fn: 'send_channel_message', args: { p_channel_id: ch.text, p_client_nonce: rnd(), p_body: 'x' }, error: /unauthorized/ },
    { label: 'membro: envia no canal de voz', actor: s.member, fn: 'send_channel_message', args: { p_channel_id: ch.voice, p_client_nonce: rnd(), p_body: 'x' }, error: /invalid-argument/ },
    { label: 'canal arbitrário: envia', actor: s.member, fn: 'send_channel_message', args: { p_channel_id: rnd(), p_client_nonce: rnd(), p_body: 'x' }, error: /unauthorized/ },
    { label: 'anon: envia no canal', actor: 'anon', fn: 'send_channel_message', args: { p_channel_id: ch.text, p_client_nonce: rnd(), p_body: 'x' }, error: /permission denied/ },
    { label: 'estranho: lê canal', actor: stranger, fn: 'list_channel_messages', args: { p_channel_id: ch.text }, error: /unauthorized/ },
    { label: 'membro: lê canal de voz como texto', actor: s.member, fn: 'list_channel_messages', args: { p_channel_id: ch.voice }, error: /invalid-argument/ },
    { label: 'anon: lê canal', actor: 'anon', fn: 'list_channel_messages', args: { p_channel_id: ch.text }, error: /permission denied/ },
    { label: 'estranho: entra na voz do canal', actor: stranger, fn: 'join_voice_channel', args: { p_channel_id: ch.voice }, error: /not-member/ },
    { label: 'membro: entra no canal de texto como voz', actor: s.member, fn: 'join_voice_channel', args: { p_channel_id: ch.text }, error: /invalid-argument/ },
    { label: 'canal arbitrário: entra', actor: s.member, fn: 'join_voice_channel', args: { p_channel_id: rnd() }, error: /not-member/ },
    { label: 'anon: entra na voz do canal', actor: 'anon', fn: 'join_voice_channel', args: { p_channel_id: ch.voice }, error: /permission denied/ },
    { label: 'estranho: participantes do canal', actor: stranger, fn: 'get_channel_participants', args: { p_channel_id: ch.voice }, error: /not-member/ },
    { label: 'membro: participantes de canal de texto', actor: s.member, fn: 'get_channel_participants', args: { p_channel_id: ch.text }, error: /invalid-argument/ },
    { label: 'anon: participantes do canal', actor: 'anon', fn: 'get_channel_participants', args: { p_channel_id: ch.voice }, error: /permission denied/ },
  ];
}

/** Impressão digital de TODO o conteúdo do schema oryn e de realtime.messages. */
async function fingerprint(db: TestDb): Promise<string> {
  const tables = await db.admin<{ t: string }>(`select c.oid::regclass::text as t from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'oryn' and c.relkind = 'r' order by 1`);
  const parts: string[] = [];
  for (const { t } of [...tables, { t: 'realtime.messages' }]) {
    const rows = await db.admin<{ h: string | null }>(`select md5(string_agg(x::text, '|' order by x::text)) as h from ${t} x`);
    parts.push(`${t}=${rows[0]?.h ?? 'vazio'}`);
  }
  return parts.join(';');
}

async function runMatrix(db: TestDb): Promise<void> {
  const s = await scenario(db);
  const stranger = await db.newUser();
  const inviteToken = await roomInvite(db, s.owner, s.room);
  const defaults = await db.admin<{ id: string; kind: 'text' | 'voice' }>('select id, kind from oryn.channels where room_id = $1 and is_default', [s.room]);
  const ch = Object.fromEntries(defaults.map((d) => [d.kind, d.id])) as unknown as DefaultChannels;
  for (const c of matrix(s, stranger, inviteToken, ch)) {
    const before = await fingerprint(db);
    const error = await db.rpcError(c.actor, `public.${c.fn}`, c.args);
    if (c.error) expect(error, c.label).toMatch(c.error);
    else expect(error, c.label).toBeNull();
    expect(await fingerprint(db), `${c.label}: sem efeito colateral`).toBe(before);
  }
}

describe('catálogo: funções expostas e privilégio EXECUTE', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await TestDb.create();
  });
  afterAll(() => db.close());

  it('public contém EXATAMENTE as 14 RPCs do contrato, todas SECURITY DEFINER com search_path vazio', async () => {
    const rows = await db.admin<{ sig: string; definer: boolean; cfg: string[] | null }>(
      `select p.oid::regprocedure::text as sig, p.prosecdef as definer, p.proconfig as cfg
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' order by 1`,
    );
    const expected = [...Object.values(USER_RPCS), ...Object.values(SERVICE_RPCS)].map((s) => s.replace('public.', '')).sort();
    expect(rows.map((r) => r.sig).sort()).toEqual(expected);
    for (const r of rows) {
      expect(r.definer, r.sig).toBe(true);
      expect(r.cfg, r.sig).toContain('search_path=""');
    }
  });

  it('nenhum papel além do dono e do previsto tem EXECUTE — inclusive PUBLIC (proacl NULL conta como padrão)', async () => {
    const rows = await db.admin<{ sig: string; grantee: string }>(
      `select n.nspname || '.' || p.proname || '(' || replace(oidvectortypes(p.proargtypes), ' ', '') || ')' as sig,
              case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
              aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where n.nspname in ('public', 'oryn', 'oryn_realtime') and a.privilege_type = 'EXECUTE' and a.grantee <> p.proowner`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(ALLOWED_GRANTEES[r.sig] ?? [], `${r.grantee} executa ${r.sig}`).toContain(r.grantee);
    // E cada papel previsto tem de fato o EXECUTE (o contrato não ficou vazio).
    for (const [sig, roles] of Object.entries(ALLOWED_GRANTEES)) {
      for (const role of roles) expect((await db.admin<{ ok: boolean }>(`select has_function_privilege($1, $2, 'EXECUTE') as ok`, [role, sig]))[0]!.ok, `${role} ${sig}`).toBe(true);
    }
  });

  it('papéis de cliente não herdam privilégios de nenhum outro papel', async () => {
    const rows = await db.admin<{ member: string; role: string }>(
      `select pg_get_userbyid(m.member) as member, pg_get_userbyid(m.roleid) as role from pg_auth_members m
        where pg_get_userbyid(m.member) in ('anon', 'authenticated')`,
    );
    expect(rows).toEqual([]);
  });

  it('toda RPC de usuário deriva o chamador de auth.uid() (oryn.require_uid) antes de qualquer acesso', async () => {
    for (const sig of Object.values(USER_RPCS)) {
      const src = (await db.admin<{ src: string }>(`select prosrc as src from pg_proc where oid = $1::regprocedure`, [sig]))[0]!.src;
      expect(src, sig).toMatch(/v_uid uuid := oryn\.require_uid\(\)/);
    }
  });

  it('a proteção NÃO é o RLS: funções e tabelas têm o mesmo dono, sem FORCE ROW LEVEL SECURITY', async () => {
    const owners = await db.admin<{ owner: string }>(
      `select distinct pg_get_userbyid(p.proowner) as owner from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'oryn', 'oryn_realtime') and p.prosecdef
       union
       select distinct pg_get_userbyid(c.relowner) from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'oryn' and c.relkind = 'r'`,
    );
    expect(owners.map((o) => o.owner)).toEqual(['migration_owner']);
    const forced = await db.admin<{ n: number }>(`select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'oryn' and c.relforcerowsecurity`);
    expect(forced[0]!.n).toBe(0);
  });
});

describe('autorização interna: sem convite, sessões alheias e IDs arbitrários (RLS ligado)', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await TestDb.create();
  });
  afterAll(() => db.close());

  it('cada chamada é recusada com o código esperado e não altera nada', async () => {
    await runMatrix(db);
  });
});

describe('autorização interna com RLS DESLIGADO nas tabelas de domínio (independência de RLS)', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await TestDb.create();
    await db.pg.exec('set role migration_owner');
    const tables = await db.admin<{ t: string }>(`select c.oid::regclass::text as t from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'oryn' and c.relkind = 'r'`);
    for (const { t } of tables) await db.pg.exec(`alter table ${t} disable row level security`);
    await db.pg.exec('reset role');
  });
  afterAll(() => db.close());

  it('a mesma matriz dá os mesmos resultados, sem efeito colateral', async () => {
    await runMatrix(db);
  });

  it('e o acesso direto às tabelas continua negado pelos privilégios (não pelo RLS)', async () => {
    const s = await scenario(db);
    await expect(db.as(s.member, (tx) => tx.query('select * from oryn.rooms'))).rejects.toThrow(/permission denied/);
  });
});
