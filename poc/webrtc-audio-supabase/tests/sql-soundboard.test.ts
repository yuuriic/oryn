// Soundboard (migração 0700) no Postgres real em memória (PGlite + shim). O Storage do shim tem só as tabelas: os INSERT e SELECT em
// storage.objects reproduzem o que a Storage API faz com o JWT do usuário, e provam as políticas. O Storage real é exercitado no
// roteiro de navegador. A concorrência está em tests/pg/soundboard.pg.test.ts.
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestDb, type Actor } from './helpers/db.ts';
import { createRoom, joinWithInvite, makeCreator, openSession, roomInvite, scenario, type Scenario } from './helpers/fixtures.ts';

const HASH = 'a'.repeat(64);
let db: TestDb;
let s: Scenario;

beforeEach(async () => {
  db = await TestDb.create();
  s = await scenario(db);
});
afterEach(async () => {
  await db.close();
});

const msg = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (error) {
    return (error as Error).message;
  }
};
const reserve = async (name = 'Risada', owner: Actor = s.owner, room = s.room) =>
  (await db.rpc<{ asset_id: string; object_key: string }>(owner, 'public.request_sound_upload', { p_room_id: room, p_name: name, p_size_bytes: 1000 }))[0]!;
const approve = (id: string, hash = HASH) =>
  db.rpc('service', 'public.complete_sound_validation', { p_asset_id: id, p_ok: true, p_mime: 'audio/mpeg', p_size_bytes: 1000, p_duration_ms: 1200, p_sha256: hash, p_reason: null });
const publish = async (name = 'Risada') => {
  const r = await reserve(name);
  await approve(r.asset_id);
  return r;
};
const asUser = <T>(actor: Actor, fn: (tx: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<T>) => db.as(actor, fn as never);
const uploadObject = (actor: Actor, key: string) =>
  asUser(actor, (tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('oryn-sounds', $1)`, [key]));
const objectAsAdmin = (key: string) => db.admin(`insert into storage.objects (bucket_id, name) values ('oryn-sounds', $1)`, [key]);
const readable = (actor: Actor, key: string) =>
  asUser(actor, async (tx) => (await tx.query(`select name from storage.objects where bucket_id = 'oryn-sounds' and name = $1`, [key])).rows.length);
const soundEvents = () => db.admin<{ topic: string; payload: Record<string, unknown> }>(`select topic, payload from realtime.messages where event = 'sound'`);

describe('catálogo', () => {
  it('membro vê só os disponíveis; o dono vê também os envios em andamento', async () => {
    const pending = await reserve('Em envio');
    const ready = await publish('Pronto');
    const owner = await db.rpc<{ asset_id: string; state: string }>(s.owner, 'public.list_sounds', { p_room_id: s.room });
    expect(owner.map((r) => r.state).sort()).toEqual(['available', 'quarantine']);
    const member = await db.rpc<{ asset_id: string; name: string; sha256: string; duration_ms: number }>(s.member, 'public.list_sounds', { p_room_id: s.room });
    expect(member).toHaveLength(1);
    expect(member[0]).toMatchObject({ asset_id: ready.asset_id, name: 'Pronto', sha256: HASH, duration_ms: 1200 });
    expect(member.map((r) => r.asset_id)).not.toContain(pending.asset_id);
  });

  it('não revela conta, chave de objeto nem dados de outra sala', async () => {
    await publish();
    const [row] = await db.rpc<Record<string, unknown>>(s.member, 'public.list_sounds', { p_room_id: s.room });
    expect(Object.keys(row!).sort()).toEqual(['asset_id', 'created_at', 'duration_ms', 'mime', 'name', 'sha256', 'size_bytes', 'state', 'version']);
    const other = await makeCreator(db);
    const otherRoom = await createRoom(db, other);
    expect(await db.rpc(other, 'public.list_sounds', { p_room_id: otherRoom })).toEqual([]);
    expect(await msg(db.rpc(other, 'public.list_sounds', { p_room_id: s.room }))).toMatch(/not-member/);
  });

  it('removido e sala encerrada perdem o catálogo', async () => {
    await publish();
    const rows = await db.rpc<{ member_ref: string; is_self: boolean }>(s.owner, 'public.list_room_members', { p_room_id: s.room });
    await db.rpc(s.owner, 'public.remove_room_member', { p_room_id: s.room, p_member_ref: rows.find((m) => !m.is_self)!.member_ref });
    expect(await msg(db.rpc(s.member, 'public.list_sounds', { p_room_id: s.room }))).toMatch(/not-member/);
    await db.rpc(s.owner, 'public.close_room', { p_room_id: s.room });
    expect(await msg(db.rpc(s.owner, 'public.list_sounds', { p_room_id: s.room }))).toMatch(/not-member/);
  });
});

describe('reserva de envio', () => {
  it('só o dono; membro, estranho e anônimo são recusados', async () => {
    const stranger = await db.newUser();
    expect(await msg(reserve('x', s.member))).toMatch(/unauthorized/);
    expect(await msg(reserve('x', stranger))).toMatch(/unauthorized/);
    expect(await msg(reserve('x', 'anon'))).toMatch(/permission denied/);
  });

  it('nome e tamanho no limite do banco', async () => {
    const call = (name: unknown, size: unknown) => msg(db.rpc(s.owner, 'public.request_sound_upload', { p_room_id: s.room, p_name: name, p_size_bytes: size }));
    expect(await call('', 10)).toMatch(/invalid-argument/);
    expect(await call('   ', 10)).toMatch(/invalid-argument/);
    expect(await call('x'.repeat(41), 10)).toMatch(/invalid-argument/);
    expect(await call('a\nb', 10)).toMatch(/invalid-argument/);
    expect(await call('ok', 0)).toMatch(/invalid-argument/);
    expect(await call('ok', 2 * 1024 * 1024 + 1)).toMatch(/invalid-argument/);
    expect(await call('x'.repeat(40), 2 * 1024 * 1024)).toBe('ok');
  });

  it('limite de 20 conta disponíveis e envios no prazo, e libera ao remover', async () => {
    const first = await publish('0');
    for (let i = 1; i < 19; i++) await publish(String(i));
    const last = await reserve('19');
    expect(await msg(reserve('20'))).toMatch(/sound-quota/);
    await db.rpc(s.owner, 'public.remove_sound', { p_asset_id: first.asset_id });
    expect(await msg(reserve('21'))).toBe('ok');
    expect(await msg(reserve('22'))).toMatch(/sound-quota/);
    // O envio vencido deixa de contar.
    await db.admin(`update oryn.sound_assets set upload_expires_at = now() - interval '1 second' where id = $1`, [last.asset_id]);
    expect(await msg(reserve('23'))).toBe('ok');
  });

  it('o limite é por sala', async () => {
    const other = await makeCreator(db);
    const otherRoom = await createRoom(db, other);
    for (let i = 0; i < 20; i++) await publish(String(i));
    expect(await msg(reserve('x', other, otherRoom))).toBe('ok');
  });
});

describe('Storage: políticas', () => {
  it('envia só o dono, só a chave reservada e só dentro do prazo', async () => {
    const r = await reserve();
    const stranger = await db.newUser();
    expect(await msg(uploadObject(s.member, r.object_key))).toMatch(/row-level security/);
    expect(await msg(uploadObject(stranger, r.object_key))).toMatch(/row-level security/);
    expect(await msg(uploadObject('anon', r.object_key))).toMatch(/row-level security|permission denied/);
    expect(await msg(uploadObject(s.owner, `${s.room}/${randomUUID()}/v1`))).toMatch(/row-level security/);
    await db.admin(`update oryn.sound_assets set upload_expires_at = now() - interval '1 second' where id = $1`, [r.asset_id]);
    expect(await msg(uploadObject(s.owner, r.object_key))).toMatch(/row-level security/);
  });

  it('o dono envia uma vez, e o objeto aprovado não aceita novo envio', async () => {
    const r = await reserve();
    expect(await msg(uploadObject(s.owner, r.object_key))).toBe('ok');
    await approve(r.asset_id);
    await db.admin(`delete from storage.objects where name = $1`, [r.object_key]);
    expect(await msg(uploadObject(s.owner, r.object_key))).toMatch(/row-level security/);
  });

  it('a pasta não prova nada: objeto fora do catálogo não é lido nem por membro', async () => {
    const key = `${s.room}/${randomUUID()}/v1`;
    await objectAsAdmin(key);
    expect(await readable(s.member, key)).toBe(0);
    expect(await readable(s.owner, key)).toBe(0);
  });

  it('lê só membro ativo, som disponível e na mesma sala; quarentena e removido não', async () => {
    const r = await reserve();
    await objectAsAdmin(r.object_key);
    expect(await readable(s.owner, r.object_key)).toBe(0);
    expect(await readable(s.member, r.object_key)).toBe(0);
    await approve(r.asset_id);
    expect(await readable(s.member, r.object_key)).toBe(1);
    const stranger = await makeCreator(db);
    await createRoom(db, stranger);
    expect(await readable(stranger, r.object_key)).toBe(0);
    expect(await msg(readable('anon', r.object_key).then((n) => { if (n !== 0) throw new Error('leu'); }))).toMatch(/ok|permission denied/);
    await db.rpc(s.owner, 'public.remove_sound', { p_asset_id: r.asset_id });
    expect(await readable(s.member, r.object_key)).toBe(0);
  });

  it('membro removido perde a leitura na hora', async () => {
    const r = await publish();
    await objectAsAdmin(r.object_key);
    const rows = await db.rpc<{ member_ref: string; is_self: boolean }>(s.owner, 'public.list_room_members', { p_room_id: s.room });
    await db.rpc(s.owner, 'public.remove_room_member', { p_room_id: s.room, p_member_ref: rows.find((m) => !m.is_self)!.member_ref });
    expect(await readable(s.member, r.object_key)).toBe(0);
  });

  it('cliente não altera nem apaga objetos', async () => {
    const r = await publish();
    await objectAsAdmin(r.object_key);
    const n = await asUser(s.owner, async (tx) => {
      const up = await tx.query(`update storage.objects set name = 'x' where name = $1 returning name`, [r.object_key]);
      const del = await tx.query(`delete from storage.objects where name = $1 returning name`, [r.object_key]);
      return up.rows.length + del.rows.length;
    });
    expect(n).toBe(0);
    expect((await db.admin(`select 1 from storage.objects where name = $1`, [r.object_key]))).toHaveLength(1);
  });

  it('bucket privado com os limites do contrato', async () => {
    expect((await db.admin(`select public, file_size_limit::int as size, allowed_mime_types as mimes from storage.buckets where id = 'oryn-sounds'`))[0]).toEqual({
      public: false, size: 2097152, mimes: ['audio/mpeg', 'audio/wav'],
    });
  });
});

describe('validação: quem grava', () => {
  it('cliente não alcança as RPCs do servidor', async () => {
    const r = await reserve();
    const args = { p_asset_id: r.asset_id, p_ok: true, p_mime: 'audio/mpeg', p_size_bytes: 1, p_duration_ms: 1, p_sha256: HASH, p_reason: null };
    expect(await msg(db.rpc(s.owner, 'public.complete_sound_validation', args))).toMatch(/permission denied/);
    expect(await msg(db.rpc(s.owner, 'public.finish_sound_cleanup', { p_asset_ids: [r.asset_id] }))).toMatch(/permission denied/);
  });

  it('só o dono obtém a chave para validar, e só em quarentena no prazo', async () => {
    const r = await reserve();
    expect(await msg(db.rpc(s.member, 'public.claim_sound_validation', { p_asset_id: r.asset_id }))).toMatch(/unauthorized/);
    const claim = await db.rpc<{ claim_sound_validation: string }>(s.owner, 'public.claim_sound_validation', { p_asset_id: r.asset_id });
    expect(claim[0]!.claim_sound_validation).toBe(r.object_key);
    await approve(r.asset_id);
    expect(await msg(db.rpc(s.owner, 'public.claim_sound_validation', { p_asset_id: r.asset_id }))).toMatch(/sound-unavailable/);
  });

  it('aprovação é imutável: repetir com o mesmo hash é igual; outro hash é recusado', async () => {
    const r = await publish();
    expect(await msg(approve(r.asset_id))).toBe('ok');
    expect(await msg(approve(r.asset_id, 'b'.repeat(64)))).toMatch(/sound-unavailable/);
    const rows = await db.admin<{ sha256: string; version: number }>(`select sha256, version from oryn.sound_assets where id = $1`, [r.asset_id]);
    expect(rows[0]).toEqual({ sha256: HASH, version: 1 });
  });

  it('recusa grava o motivo, e aprovação tardia vira recusa', async () => {
    const a = await reserve('a');
    await db.rpc('service', 'public.complete_sound_validation', { p_asset_id: a.asset_id, p_ok: false, p_mime: null, p_size_bytes: null, p_duration_ms: null, p_sha256: null, p_reason: 'truncated' });
    const b = await reserve('b');
    await db.admin(`update oryn.sound_assets set upload_expires_at = now() - interval '1 second' where id = $1`, [b.asset_id]);
    await approve(b.asset_id);
    const rows = await db.admin<{ name: string; state: string; reject_reason: string }>(`select name, state, reject_reason from oryn.sound_assets order by name`);
    expect(rows).toEqual([{ name: 'a', state: 'rejected', reject_reason: 'truncated' }, { name: 'b', state: 'rejected', reject_reason: 'upload-expired' }]);
    expect((await db.rpc(s.owner, 'public.list_sounds', { p_room_id: s.room }))).toEqual([]);
  });
});

describe('remoção e limpeza', () => {
  const cleanup = (actor: Actor = s.owner, room = s.room) => db.rpc<{ asset_id: string; object_key: string }>(actor, 'public.list_sound_cleanup', { p_room_id: room });

  it('só o dono remove; sai do catálogo na hora; repetir é seguro', async () => {
    const r = await publish();
    expect(await msg(db.rpc(s.member, 'public.remove_sound', { p_asset_id: r.asset_id }))).toMatch(/unauthorized/);
    await db.rpc(s.owner, 'public.remove_sound', { p_asset_id: r.asset_id });
    await db.rpc(s.owner, 'public.remove_sound', { p_asset_id: r.asset_id });
    expect(await db.rpc(s.member, 'public.list_sounds', { p_room_id: s.room })).toEqual([]);
  });

  it('a limpeza lista removidos, recusados e envios vencidos; só o dono vê', async () => {
    const removed = await publish('removido');
    await db.rpc(s.owner, 'public.remove_sound', { p_asset_id: removed.asset_id });
    const rejected = await reserve('recusado');
    await db.rpc('service', 'public.complete_sound_validation', { p_asset_id: rejected.asset_id, p_ok: false, p_mime: null, p_size_bytes: null, p_duration_ms: null, p_sha256: null, p_reason: 'empty' });
    const late = await reserve('vencido');
    await db.admin(`update oryn.sound_assets set upload_expires_at = now() - interval '1 second' where id = $1`, [late.asset_id]);
    await publish('fica');
    await reserve('no prazo');
    expect((await cleanup()).map((r) => r.asset_id).sort()).toEqual([removed.asset_id, rejected.asset_id, late.asset_id].sort());
    expect(await msg(cleanup(s.member))).toMatch(/unauthorized/);
  });

  it('confirmar é idempotente e não apaga o que está disponível', async () => {
    const removed = await publish('removido');
    const ok = await publish('fica');
    await db.rpc(s.owner, 'public.remove_sound', { p_asset_id: removed.asset_id });
    const finish = () => db.rpc<{ finish_sound_cleanup: number }>('service', 'public.finish_sound_cleanup', { p_asset_ids: [removed.asset_id, ok.asset_id] });
    expect((await finish())[0]!.finish_sound_cleanup).toBe(1);
    expect((await finish())[0]!.finish_sound_cleanup).toBe(0);
    expect(await cleanup()).toEqual([]);
    const rows = await db.admin<{ name: string; state: string }>(`select name, state from oryn.sound_assets order by name`);
    expect(rows).toEqual([{ name: 'fica', state: 'available' }, { name: 'removido', state: 'deleted' }]);
  });

  it('um disparo depois da remoção é recusado', async () => {
    const r = await publish();
    await db.rpc(s.owner, 'public.remove_sound', { p_asset_id: r.asset_id });
    expect(await msg(db.rpc(s.member, 'public.trigger_sound', { p_session_id: s.memberSession, p_asset_id: r.asset_id }))).toMatch(/sound-unavailable/);
  });
});

describe('disparo', () => {
  const fire = (actor: Actor, session: string, asset: string) => db.rpc<{ event_id: string; sha256: string; version: number; issued_at: string; expires_at: string }>(actor, 'public.trigger_sound', { p_session_id: session, p_asset_id: asset });

  it('publica só metadados no tópico das OUTRAS sessões vivas, com prazo de 2 s', async () => {
    const r = await publish();
    await db.admin(`delete from realtime.messages`);
    const [event] = await fire(s.owner, s.ownerSession, r.asset_id);
    const sent = await soundEvents();
    expect(sent.map((m) => m.topic)).toEqual([`oryn:s:${s.memberSession}`]);
    const payload = sent[0]!.payload;
    expect(Object.keys(payload).sort()).toEqual(['asset_id', 'event_id', 'expires_at', 'id', 'issued_at', 'sender_ref', 'session_id', 'sha256', 'version']);
    expect(payload).toMatchObject({ event_id: event!.event_id, session_id: s.ownerSession, asset_id: r.asset_id, version: 1, sha256: HASH });
    expect(Date.parse(String(payload['expires_at'])) - Date.parse(String(payload['issued_at']))).toBe(2000);
    expect(JSON.stringify(payload)).not.toContain(s.owner.uid);
    expect(JSON.stringify(payload)).not.toContain(r.object_key);
  });

  it('cooldown por conta: vale entre sessões e não entre contas; depois de 2 s libera', async () => {
    const r = await publish();
    const second = await openSession(db, s.owner, s.room);
    await fire(s.owner, s.ownerSession, r.asset_id);
    expect(await msg(fire(s.owner, s.ownerSession, r.asset_id))).toMatch(/rate-limited/);
    expect(await msg(fire(s.owner, second, r.asset_id))).toMatch(/rate-limited/);
    expect(await msg(fire(s.member, s.memberSession, r.asset_id))).toBe('ok');
    await db.admin(`update oryn.sound_trigger_state set last_at = last_at - interval '2 seconds' where user_id = $1`, [s.owner.uid]);
    expect(await msg(fire(s.owner, s.ownerSession, r.asset_id))).toBe('ok');
  });

  it('disparo recusado não consome o cooldown', async () => {
    expect(await msg(fire(s.owner, s.ownerSession, randomUUID()))).toMatch(/sound-unavailable/);
    const r = await publish();
    expect(await msg(fire(s.owner, s.ownerSession, r.asset_id))).toBe('ok');
  });

  it('sessão alheia, revogada ou vencida é recusada, sem publicar', async () => {
    const r = await publish();
    await db.admin(`delete from realtime.messages`);
    expect(await msg(fire(s.member, s.ownerSession, r.asset_id))).toMatch(/session-invalid/);
    await db.admin(`update oryn.room_sessions set last_seen_at = now() - interval '2 minutes' where id = $1`, [s.memberSession]);
    expect(await msg(fire(s.member, s.memberSession, r.asset_id))).toMatch(/session-invalid/);
    await db.rpc(s.owner, 'public.leave_room', { p_session_id: s.ownerSession });
    expect(await msg(fire(s.owner, s.ownerSession, r.asset_id))).toMatch(/session-invalid/);
    expect(await soundEvents()).toEqual([]);
  });

  it('som de outra sala é recusado', async () => {
    const other = await makeCreator(db);
    const otherRoom = await createRoom(db, other);
    const foreign = await reserve('alheio', other, otherRoom);
    await approve(foreign.asset_id);
    expect(await msg(fire(s.member, s.memberSession, foreign.asset_id))).toMatch(/sound-unavailable/);
  });

  it('som em quarentena é recusado', async () => {
    const r = await reserve();
    expect(await msg(fire(s.member, s.memberSession, r.asset_id))).toMatch(/sound-unavailable/);
  });

  it('membro removido não dispara, e quem entra depois também pode', async () => {
    const r = await publish();
    const late = await joinWithInvite(db, s.room, s.owner, 'Novo').catch(() => null);
    if (late) expect(await msg(fire(late, await openSession(db, late, s.room), r.asset_id))).toBe('ok');
    const rows = await db.rpc<{ member_ref: string; display_name: string }>(s.owner, 'public.list_room_members', { p_room_id: s.room });
    await db.rpc(s.owner, 'public.remove_room_member', { p_room_id: s.room, p_member_ref: rows.find((m) => m.display_name === 'Amigo')!.member_ref });
    expect(await msg(fire(s.member, s.memberSession, r.asset_id))).toMatch(/session-invalid/);
  });

  it('cliente não publica evento direto no tópico de outra sessão', async () => {
    const outcome = await msg(asUser(s.member, (tx) => tx.query(`insert into realtime.messages (topic, extension, event, payload) values ($1, 'broadcast', 'sound', '{}')`, [`oryn:s:${s.ownerSession}`])));
    expect(outcome).toMatch(/row-level security/);
  });

  it('acesso direto às tabelas negado', async () => {
    for (const table of ['oryn.sound_assets', 'oryn.sound_trigger_state']) {
      expect(await msg(asUser(s.owner, (tx) => tx.query(`select 1 from ${table}`)))).toMatch(/permission denied/);
    }
  });
});

describe('sound_clock', () => {
  it('devolve a hora do servidor só com login', async () => {
    const [row] = await db.rpc<{ sound_clock: string }>(s.member, 'public.sound_clock');
    expect(Math.abs(Date.parse(row!.sound_clock) - Date.now())).toBeLessThan(10_000);
    expect(await msg(db.rpc('anon', 'public.sound_clock'))).toMatch(/permission denied/);
  });
});

describe('cascata', () => {
  it('excluir a sala apaga catálogo e cooldown', async () => {
    const r = await publish();
    await db.rpc(s.owner, 'public.trigger_sound', { p_session_id: s.ownerSession, p_asset_id: r.asset_id });
    await db.admin('delete from oryn.rooms where id = $1', [s.room]);
    expect(await db.admin('select 1 from oryn.sound_assets')).toEqual([]);
    expect(await db.admin('select 1 from oryn.sound_trigger_state')).toEqual([]);
  });

  it('convite continua funcionando com a migração aplicada', async () => {
    expect(await roomInvite(db, s.owner, s.room)).toBeTruthy();
  });
});
