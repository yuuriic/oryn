// Canais (0900) sob concorrência em PostgreSQL 17 REAL: cada chamada com conexão e transação próprias. Gatilhos de
// teste com pg_sleep alargam a janela de corrida; cada trava é comparada com a versão SEM ela ("legado"), que deve
// falhar no mesmo cenário (prova de que o teste detecta a corrida).
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

interface Space { owner: { uid: string }; room: string; member: { uid: string }; voice: string; text: string }
async function newSpace(): Promise<Space> {
  const owner = await db.newUser();
  const token = (await db.admin<{ t: string }>('select oryn.admin_issue_creator_invite(60, 5) as t'))[0]!.t;
  await db.rpc(owner, 'public.redeem_creator_invite', { p_token: token });
  const room = (await db.rpc<{ create_room: string }>(owner, 'public.create_room', { p_name: 'pg17', p_display_name: 'Dono', p_max_members: 4 }))[0]!.create_room;
  const member = await db.newUser();
  const invite = (await db.rpc<{ token: string }>(owner, 'public.create_room_invite', { p_room_id: room, p_ttl_minutes: 10 }))[0]!.token;
  await db.rpc(member, 'public.redeem_room_invite', { p_token: invite, p_display_name: 'Amigo' });
  const d = await db.admin<{ id: string; kind: string }>('select id, kind from oryn.channels where room_id = $1 and is_default', [room]);
  return { owner, room, member, voice: d.find((c) => c.kind === 'voice')!.id, text: d.find((c) => c.kind === 'text')!.id };
}
const channel = async (s: Space, name: string, kind: 'text' | 'voice') =>
  (await db.rpc<{ create_channel: string }>(s.owner, 'public.create_channel', { p_room_id: s.room, p_name: name, p_kind: kind }))[0]!.create_channel;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Gatilho de teste que segura a transação. Devolve a função de remoção. */
async function slow(table: string, seconds = 0.5): Promise<() => Promise<void>> {
  const name = `t_slow_${table.replace('.', '_')}_${randomUUID().slice(0, 8)}`;
  await db.admin(`create function public.${name}() returns trigger language plpgsql as $$ begin perform pg_sleep(${seconds}); return new; end $$`);
  await db.admin(`create trigger ${name} before insert on ${table} for each row execute function public.${name}()`);
  return async () => {
    await db.admin(`drop trigger ${name} on ${table}`);
    await db.admin(`drop function public.${name}()`);
  };
}

/** `public.join_voice_channel_<sufixo>` igual ao real, mas sobre uma cópia do núcleo com `remover` apagado. */
async function legacyJoin(suffix: string, remove: RegExp): Promise<string> {
  const core = (await db.admin<{ d: string }>(`select pg_get_functiondef('oryn.open_voice_session(uuid,uuid,uuid)'::regprocedure) as d`))[0]!.d;
  const rpc = (await db.admin<{ d: string }>(`select pg_get_functiondef('public.join_voice_channel(uuid)'::regprocedure) as d`))[0]!.d;
  expect(core).toMatch(remove);
  await db.asMigrationOwner(core.replace('FUNCTION oryn.open_voice_session(', `FUNCTION oryn.open_voice_session_${suffix}(`).replace(remove, ''));
  await db.asMigrationOwner(rpc.replace('FUNCTION public.join_voice_channel(', `FUNCTION public.join_voice_channel_${suffix}(`)
    .replace('oryn.open_voice_session(', `oryn.open_voice_session_${suffix}(`));
  await db.asMigrationOwner(`revoke all on function public.join_voice_channel_${suffix}(uuid) from public;
    grant execute on function public.join_voice_channel_${suffix}(uuid) to authenticated`);
  return `public.join_voice_channel_${suffix}`;
}
const liveSessions = async (user: { uid: string }, room: string) =>
  (await db.admin<{ channel_id: string }>('select channel_id from oryn.room_sessions where user_id = $1 and room_id = $2 and revoked_at is null', [user.uid, room])).map((r) => r.channel_id);

describe('voz: uma participação por usuário em cada espaço', () => {
  it('duas entradas simultâneas do mesmo usuário em canais diferentes: exatamente uma passa (trava da linha de membro)', async () => {
    const s = await newSpace();
    const v2 = await channel(s, 'voz 2', 'voice');
    const undo = await slow('oryn.room_sessions');
    try {
      const [a, b] = await Promise.all([
        db.call(s.member, 'public.join_voice_channel', { p_channel_id: s.voice }),
        db.call(s.member, 'public.join_voice_channel', { p_channel_id: v2 }),
      ]);
      const errors = [a.error?.message, b.error?.message].filter(Boolean);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/in-other-channel/);
      expect(new Set(await liveSessions(s.member, s.room)).size).toBe(1);
    } finally {
      await undo();
    }
  });

  it('legado (sem a trava da linha de membro): a mesma corrida deixa o usuário em dois canais', async () => {
    const s = await newSpace();
    const v2 = await channel(s, 'voz 2', 'voice');
    const fn = await legacyJoin('nomember', /\s+for no key update/i);
    const undo = await slow('oryn.room_sessions');
    try {
      const [a, b] = await Promise.all([
        db.call(s.member, fn, { p_channel_id: s.voice }),
        db.call(s.member, fn, { p_channel_id: v2 }),
      ]);
      expect([a.error, b.error]).toEqual([null, null]);
      expect(new Set(await liveSessions(s.member, s.room)).size).toBe(2);
    } finally {
      await undo();
    }
  });
});

describe('arquivamento concorrente', () => {
  it('entrar e arquivar o mesmo canal de voz ao mesmo tempo: nenhuma sessão viva sobra no canal arquivado', async () => {
    const s = await newSpace();
    const v2 = await channel(s, 'voz 2', 'voice');
    const undo = await slow('oryn.room_sessions');
    try {
      const joining = db.call(s.member, 'public.join_voice_channel', { p_channel_id: v2 });
      await sleep(150); // a entrada já passou pela conferência e segura o canal (FOR SHARE)
      const archiving = db.call(s.owner, 'public.archive_channel', { p_channel_id: v2 });
      const [j, a] = await Promise.all([joining, archiving]);
      expect(a.error).toBeNull();
      if (!j.error) {
        // Entrou antes: o arquivamento esperou e revogou a sessão nova.
        const reason = await db.admin<{ revoke_reason: string | null }>('select revoke_reason from oryn.room_sessions where id = $1', [(j.rows[0] as { session_id: string }).session_id]);
        expect(reason).toEqual([{ revoke_reason: 'channel-archived' }]);
      } else expect(j.error.message).toMatch(/channel-archived/);
      const live = await db.admin<{ n: number }>('select count(*)::int as n from oryn.room_sessions where channel_id = $1 and revoked_at is null', [v2]);
      expect(live[0]!.n).toBe(0);
    } finally {
      await undo();
    }
  });

  it('legado (sem FOR SHARE no canal): a mesma corrida deixa uma sessão viva num canal arquivado', async () => {
    const s = await newSpace();
    const v2 = await channel(s, 'voz 2', 'voice');
    const fn = await legacyJoin('noshare', /\s+for share/i);
    const undo = await slow('oryn.room_sessions');
    try {
      const joining = db.call(s.member, fn, { p_channel_id: v2 });
      await sleep(150);
      const archiving = db.call(s.owner, 'public.archive_channel', { p_channel_id: v2 });
      const [j, a] = await Promise.all([joining, archiving]);
      expect([j.error, a.error]).toEqual([null, null]);
      const live = await db.admin<{ n: number }>('select count(*)::int as n from oryn.room_sessions where channel_id = $1 and revoked_at is null', [v2]);
      expect(live[0]!.n).toBe(1);
    } finally {
      await undo();
    }
  });

  it('enviar e arquivar o mesmo canal de texto ao mesmo tempo: serializados pela sala; nada é gravado depois do arquivamento', async () => {
    const s = await newSpace();
    const t = await channel(s, 'texto 2', 'text');
    const undo = await slow('oryn.room_messages');
    try {
      const sending = db.call(s.member, 'public.send_channel_message', { p_channel_id: t, p_client_nonce: randomUUID(), p_body: 'na corrida' });
      await sleep(150);
      const archiving = db.call(s.owner, 'public.archive_channel', { p_channel_id: t });
      const [m, a] = await Promise.all([sending, archiving]);
      expect(m.error).toBeNull();
      expect(a.error).toBeNull();
      const order = await db.admin<{ ok: boolean }>(
        'select bool_and(m.created_at < c.archived_at) as ok from oryn.room_messages m join oryn.channels c on c.id = m.channel_id where c.id = $1', [t]);
      expect(order).toEqual([{ ok: true }]);
      expect((await db.call(s.member, 'public.send_channel_message', { p_channel_id: t, p_client_nonce: randomUUID(), p_body: 'tarde' })).error?.message).toMatch(/channel-archived/);
    } finally {
      await undo();
    }
  });

  it('muitas entradas e saídas simultâneas em canais do mesmo espaço: nenhum impasse e o invariante se mantém', async () => {
    const s = await newSpace();
    const v2 = await channel(s, 'voz 2', 'voice');
    const others = [s.owner, s.member];
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      db.call(others[i % 2]!, 'public.join_voice_channel', { p_channel_id: i % 3 === 0 ? v2 : s.voice })));
    for (const r of results) if (r.error) expect(r.error.message).toMatch(/in-other-channel|limit-reached/);
    for (const u of others) {
      const live = await liveSessions(u, s.room);
      expect(new Set(live).size, 'um único canal por usuário').toBeLessThanOrEqual(1);
      expect(live.length, 'no máximo 2 sessões').toBeLessThanOrEqual(2);
    }
  });
});
