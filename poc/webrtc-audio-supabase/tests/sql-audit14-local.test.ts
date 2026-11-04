// 14_mvp01_r2_ab_audit.sql (MVP 01, auditoria das Frentes A e B) executado de verdade no PGlite com as migrações.
// Os sinais nascem pelos fluxos reais (authorize_signal, set_signal_state, ack_signals, leave_room, close_room); só os
// horários das fronteiras (updated_at, revoked_at, last_seen_at) são fixados pelo administrador, para que as classes
// não dependam do relógio. Garante: nenhuma escrita, nenhum dado sensível na saída, marcadores obrigatórios.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TestDb } from './helpers/db.ts';
import { createRoom, makeCreator, openSession, roomInvite, signalArgs } from './helpers/fixtures.ts';

const SQL = readFileSync(fileURLToPath(new URL('../integration/sql/14_mvp01_r2_ab_audit.sql', import.meta.url)), 'utf8');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const CLASSES = 'CONFIRMADO / PENDENTE / ESGOTADO / FIM-JANELA / INCONCLUSIVO-FIM / INCONCLUSIVO-SEM';

interface Row {
  item: string;
  expected: string;
  actual: string;
  status: 'PASS' | 'FAIL' | 'INFO';
}

const fill = (room: string, t0: string, t1: string) => SQL.replaceAll('<<ROOM_ID>>', room).replaceAll('<<T0_UTC>>', t0).replaceAll('<<T1_UTC>>', t1);
async function run(db: TestDb, text: string): Promise<Row[]> {
  const res = await db.pg.exec(text);
  return res.find((r) => r.fields.some((f) => f.name === 'status'))!.rows as Row[];
}
const rowsWith = (rows: Row[], prefix: string) => rows.filter((r) => r.item.startsWith(prefix));
function one(rows: Row[], prefix: string): Row {
  const found = rowsWith(rows, prefix);
  expect(found, prefix).toHaveLength(1);
  return found[0]!;
}
/** Classe de cada sinal não confirmado, por id curto. */
const classes = (rows: Row[]) => Object.fromEntries(rowsWith(rows, 'INFO B2 sinal ').map((r) => [r.item.slice(-8), r.item.split(' ')[3]!]));
const counts = (rows: Row[]) => one(rows, 'INFO B2 classes').actual;

/** Conteúdo de oryn.*, realtime.* e auth.*: o mesmo antes e depois = a auditoria não escreveu nada. */
async function snapshot(db: TestDb): Promise<string> {
  const tables = await db.admin<{ t: string }>(`select format('%I.%I', schemaname, tablename) as t from pg_tables where schemaname in ('oryn', 'realtime', 'auth') order by 1`);
  const out: string[] = [];
  for (const { t } of tables) out.push(`${t}:${(await db.admin<{ h: string }>(`select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h from ${t} x`))[0]!.h}`);
  return out.join('\n');
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Sala com OWNER e MEMBER (display_name pessoal, para provar que não vaza) e a sessão viva do OWNER. Três lugares:
 *  com dois, a sala fica cheia e o create_room_invite dos cenários de convite pendente responde room-full. */
async function world() {
  const db = await TestDb.create();
  const t0 = iso(Date.now() - 10 * 60_000);
  const owner = await makeCreator(db);
  const room = await createRoom(db, owner, 3, 'Rodada AB');
  const member = await db.newUser();
  await db.rpc(member, 'public.redeem_room_invite', { p_token: await roomInvite(db, owner, room), p_display_name: 'NomePessoalMembro' });
  const ownerSession = await openSession(db, owner, room);
  const audit = (t1 = iso(Date.now() + 10 * 60_000), r = room, start = t0) => run(db, fill(r, start, t1));
  /** Sinal real de `from` para `to`; `published` = passa por publishing → published (como a Edge Function). */
  const signal = async (user: { uid: string }, from: string, to: string, state: 'accepted' | 'publishing' | 'published' | 'failed' = 'published') => {
    const id = (await db.rpc<{ msg_id: string }>(user, 'public.authorize_signal', signalArgs(from, to, { p_kind: 'candidate' })))[0]!.msg_id;
    const path = { accepted: [], publishing: ['publishing'], published: ['publishing', 'published'], failed: ['publishing', 'failed'] }[state];
    for (const s of path) await db.rpc('service', 'public.set_signal_state', { p_msg_id: id, p_state: s });
    return id;
  };
  return { db, t0, owner, member, room, ownerSession, audit, signal };
}
type World = Awaited<ReturnType<typeof world>>;

/** Fixa o horário do published (updated_at) `seconds` antes do fim do receptor revogado. */
async function publishedBeforeEnd(w: World, id: string, receiverRevokedAt: string, seconds: number) {
  await w.db.admin(`update oryn.signal_log set updated_at = $2::timestamptz - make_interval(secs => $3), created_at = $2::timestamptz - make_interval(secs => $3 + 0.05) where msg_id = $1`, [id, receiverRevokedAt, seconds]);
}

describe('14_mvp01_r2_ab_audit.sql: marcadores, janela e sala', () => {
  it('script sem parâmetros (e com só parte dos marcadores trocada) falha de propósito, sem linhas', async () => {
    const w = await world();
    try {
      await expect(w.db.pg.exec(SQL)).rejects.toThrow(/uuid/i);
      await w.db.pg.exec('rollback');
      await expect(w.db.pg.exec(SQL.replaceAll('<<ROOM_ID>>', w.room))).rejects.toThrow(/timestamp|time zone|date/i);
      await w.db.pg.exec('rollback');
      await expect(w.db.pg.exec(SQL.replaceAll('<<ROOM_ID>>', w.room).replaceAll('<<T0_UTC>>', w.t0))).rejects.toThrow(/timestamp|time zone|date/i);
      await w.db.pg.exec('rollback');
    } finally {
      await w.db.close();
    }
  });

  it('janela inválida: invertida ou de 2 h ou mais → J1 FAIL', async () => {
    const w = await world();
    try {
      const now = Date.now();
      expect(one(await w.audit(iso(now - 60_000), w.room, iso(now)), 'J1').status).toBe('FAIL');
      expect(one(await w.audit(iso(now + 60_000), w.room, iso(now - 2 * 3_600_000 + 60_000)), 'J1').status).toBe('FAIL');
      expect(one(await w.audit(), 'J1').status).toBe('PASS');
    } finally {
      await w.db.close();
    }
  });

  it('sala inexistente: R1, A1 e B0 FAIL; nada da sala', async () => {
    const w = await world();
    try {
      const rows = await w.audit(undefined, '00000000-0000-4000-8000-000000000000');
      for (const p of ['R1', 'A1 sala encerrada', 'A1 sessões vivas', 'B0 sinais']) expect(one(rows, p).status, p).toBe('FAIL');
      expect(rowsWith(rows, 'INFO sessão')).toEqual([]);
      expect(rows.findIndex((r) => r.status !== 'FAIL')).toBe(rows.filter((r) => r.status === 'FAIL').length); // FAIL primeiro
    } finally {
      await w.db.close();
    }
  });

  it('sala aberta: A1 FAIL (sala aberta, sessão não revogada); a sessão viva aparece como (viva)', async () => {
    const w = await world();
    try {
      await w.signal(w.owner, w.ownerSession, await openSession(w.db, w.member, w.room));
      const rows = await w.audit();
      expect([one(rows, 'R1').status, one(rows, 'R2').status, one(rows, 'B0 sinais').status]).toEqual(['PASS', 'PASS', 'PASS']);
      expect(one(rows, 'A1 sala encerrada')).toMatchObject({ status: 'FAIL', actual: '(aberta)' });
      expect(one(rows, 'A1 nenhuma sessão não revogada')).toMatchObject({ status: 'FAIL', actual: '2' });
      expect(rowsWith(rows, 'INFO sessão').every((r) => r.actual.endsWith('motivo=(viva)'))).toBe(true);
      expect(one(rows, 'INFO sala').actual).toMatch(/^[0-9a-f]{8} \/ [0-9a-f]{8} \/ 3 \/ \(aberta\)$/);
    } finally {
      await w.db.close();
    }
  });
});

describe('14_mvp01_r2_ab_audit.sql: Frente A (A1)', () => {
  it('sala encerrada corretamente (uma sessão saiu antes, duas vivas no fechamento): A1 PASS e nenhum FAIL', async () => {
    const w = await world();
    try {
      const early = await openSession(w.db, w.member, w.room);
      await w.signal(w.owner, w.ownerSession, early);
      await w.db.rpc(w.member, 'public.leave_room', { p_session_id: early });
      await openSession(w.db, w.member, w.room);
      await roomInvite(w.db, w.owner, w.room); // convite pendente: o close_room o revoga
      await w.db.rpc(w.owner, 'public.close_room', { p_room_id: w.room });
      const rows = await w.audit();
      for (const p of ['A1 sala encerrada', 'A1 sessões vivas', 'A1 nenhuma sessão não revogada', 'A1 nenhum convite']) expect(one(rows, p).status, p).toBe('PASS');
      expect(one(rows, 'A1 sessões vivas').actual).toBe('2 de 2');
      expect(rows.filter((r) => r.status === 'FAIL')).toEqual([]);
      expect(rowsWith(rows, 'INFO sessão').map((r) => r.actual.split('motivo=')[1]).sort()).toEqual(['left', 'room-closed', 'room-closed']);
    } finally {
      await w.db.close();
    }
  });

  it.each([
    ['motivo errado', `update oryn.room_sessions set revoke_reason = 'expired' where id = $1`],
    ['instante diferente do closed_at', `update oryn.room_sessions set revoked_at = revoked_at + interval '1 second' where id = $1`],
  ])('revogação incorreta (%s) → A1 FAIL, 1 de 2', async (_label, mutation) => {
    const w = await world();
    try {
      const m = await openSession(w.db, w.member, w.room);
      await w.db.rpc(w.owner, 'public.close_room', { p_room_id: w.room });
      await w.db.admin(mutation, [m]);
      const rows = await w.audit();
      expect(one(rows, 'A1 sessões vivas')).toMatchObject({ status: 'FAIL', actual: '1 de 2' });
    } finally {
      await w.db.close();
    }
  });

  it('sessão que ficou sem revogação depois do fechamento → A1 FAIL', async () => {
    const w = await world();
    try {
      const m = await openSession(w.db, w.member, w.room);
      await w.db.rpc(w.owner, 'public.close_room', { p_room_id: w.room });
      await w.db.admin(`update oryn.room_sessions set revoked_at = null, revoke_reason = null where id = $1`, [m]);
      const rows = await w.audit();
      expect(one(rows, 'A1 sessões vivas').status).toBe('FAIL');
      expect(one(rows, 'A1 nenhuma sessão não revogada')).toMatchObject({ status: 'FAIL', actual: '1' });
    } finally {
      await w.db.close();
    }
  });

  it('convite ainda utilizável depois do fechamento → A1 FAIL; usado, revogado ou vencido não conta', async () => {
    const w = await world();
    try {
      await roomInvite(w.db, w.owner, w.room);
      await w.db.rpc(w.owner, 'public.close_room', { p_room_id: w.room });
      expect(one(await w.audit(), 'A1 nenhum convite').status).toBe('PASS');
      await w.db.admin(`update oryn.room_invites set revoked_at = null where room_id = $1 and used_at is null`, [w.room]);
      expect(one(await w.audit(), 'A1 nenhum convite')).toMatchObject({ status: 'FAIL', actual: '1' });
      await w.db.admin(`update oryn.room_invites set created_at = now() - interval '1 hour', expires_at = now() - interval '59 minutes' where room_id = $1 and used_at is null`, [w.room]);
      expect(one(await w.audit(), 'A1 nenhum convite').status).toBe('PASS');
    } finally {
      await w.db.close();
    }
  });
});

describe('14_mvp01_r2_ab_audit.sql: Frente B (classes dos acks)', () => {
  it('ACK confirmado: CONFIRMADO, sem linha de sinal; B1 acknowledged = Σ respostas; B3 com a latência', async () => {
    const w = await world();
    try {
      const m = await openSession(w.db, w.member, w.room);
      const a = await w.signal(w.member, m, w.ownerSession);
      const b = await w.signal(w.member, m, w.ownerSession);
      const answers = await w.db.rpc<{ ack_signals: number }>(w.owner, 'public.ack_signals', { p_session_id: w.ownerSession, p_msg_ids: [a, b] });
      expect(answers).toEqual([{ ack_signals: 2 }]);
      const rows = await w.audit();
      expect(counts(rows)).toBe('2 / 0 / 0 / 0 / 0 / 0');
      expect(classes(rows)).toEqual({});
      const owner = rowsWith(rows, 'INFO B1 receptor owner').find((r) => r.item.includes('acknowledged (='))!;
      expect(owner.actual).toBe('2 / 2');
      expect(one(rows, 'INFO B3').actual).toMatch(/^2 \/ \d+ \/ \d+ \/ \d+$/);
    } finally {
      await w.db.close();
    }
  });

  it('receptor vivo: publicado há 14 s → PENDENTE; há 16 s → ESGOTADO (não é prova isolada de defeito)', async () => {
    const w = await world();
    try {
      const m = await openSession(w.db, w.member, w.room);
      const pending = await w.signal(w.member, m, w.ownerSession);
      const exhausted = await w.signal(w.member, m, w.ownerSession);
      await w.db.admin(`update oryn.signal_log set updated_at = now() - interval '14 seconds' where msg_id = $1`, [pending]);
      await w.db.admin(`update oryn.signal_log set updated_at = now() - interval '16 seconds' where msg_id = $1`, [exhausted]);
      const rows = await w.audit();
      expect(classes(rows)).toEqual({ [pending.slice(0, 8)]: 'PENDENTE', [exhausted.slice(0, 8)]: 'ESGOTADO' });
      for (const r of rowsWith(rows, 'INFO B2 sinal ')) expect(r.actual).toContain('fim_receptor=(vivo)');
      expect(rows.filter((r) => r.status === 'FAIL').map((r) => r.item)).not.toContain(expect.stringMatching(/^B/)); // B2 é INFO: veredito cruzado com o cliente
    } finally {
      await w.db.close();
    }
  });

  it('encerramento durante a janela de ACK: fronteiras exatas de 3,5 s e 15 s (receptor revogado)', async () => {
    const w = await world();
    try {
      const m = await openSession(w.db, w.member, w.room);
      const cases: [number, string][] = [[-1, 'FIM-JANELA'], [0, 'FIM-JANELA'], [3.499, 'FIM-JANELA'], [3.5, 'INCONCLUSIVO-FIM'], [14.999, 'INCONCLUSIVO-FIM'], [15, 'ESGOTADO'], [40, 'ESGOTADO']];
      const ids: string[] = [];
      for (let i = 0; i < cases.length; i++) ids.push(await w.signal(w.owner, w.ownerSession, m));
      await w.db.rpc(w.member, 'public.leave_room', { p_session_id: m });
      const end = iso(Date.now() - 60_000);
      await w.db.admin(`update oryn.room_sessions set revoked_at = $2, last_seen_at = $2::timestamptz - interval '1 second' where id = $1`, [m, end]);
      for (let i = 0; i < cases.length; i++) await publishedBeforeEnd(w, ids[i]!, end, cases[i]![0]);
      const rows = await w.audit();
      expect(classes(rows)).toEqual(Object.fromEntries(ids.map((id, i) => [id.slice(0, 8), cases[i]![1]])));
      expect(counts(rows)).toBe('0 / 0 / 2 / 3 / 2 / 0');
      const slack = (id: string) => one(rows, `INFO B2 sinal ${classes(rows)[id.slice(0, 8)]} ${id.slice(0, 8)}`).actual.match(/folga_s=(\S+)/)![1];
      expect(cases.map((_, i) => slack(ids[i]!))).toEqual(['-1.000', '0.000', '3.499', '3.500', '14.999', '15.000', '40.000']);
    } finally {
      await w.db.close();
    }
  });

  it('sessão vencida sem revogação: o fim é last_seen_at + 90 s (não now()); aparece como (vencida, não revogada)', async () => {
    const w = await world();
    try {
      const m = await openSession(w.db, w.member, w.room);
      const id = await w.signal(w.owner, w.ownerSession, m);
      await w.db.admin(`update oryn.room_sessions set last_seen_at = now() - interval '200 seconds' where id = $1`, [m]);
      await w.db.admin(`update oryn.signal_log set updated_at = (select last_seen_at + interval '89 seconds' from oryn.room_sessions where id = $2) where msg_id = $1`, [id, m]);
      const rows = await w.audit();
      expect(classes(rows)).toEqual({ [id.slice(0, 8)]: 'FIM-JANELA' }); // fim = last_seen + 90 s, 1 s depois do published
      expect(one(rows, `INFO sessão member ${m.slice(0, 8)}`).actual).toContain('motivo=(vencida, não revogada)');
    } finally {
      await w.db.close();
    }
  });

  it('sinal que nunca chegou a published (accepted, publishing, failed): INCONCLUSIVO-SEM, sem folga', async () => {
    const w = await world();
    try {
      const m = await openSession(w.db, w.member, w.room);
      const ids = [await w.signal(w.owner, w.ownerSession, m, 'accepted'), await w.signal(w.owner, w.ownerSession, m, 'publishing'), await w.signal(w.owner, w.ownerSession, m, 'failed')];
      const rows = await w.audit();
      expect(counts(rows)).toBe('0 / 0 / 0 / 0 / 0 / 3');
      for (const id of ids) expect(one(rows, `INFO B2 sinal INCONCLUSIVO-SEM ${id.slice(0, 8)}`).actual).toMatch(/folga_s=- tentativas_publicação=\d/);
      // ack de quem ainda não está em published não conta (contrato da 0200) e não muda a classe
      expect(await w.db.rpc(w.member, 'public.ack_signals', { p_session_id: m, p_msg_ids: ids })).toEqual([{ ack_signals: 0 }]);
      expect(counts(await w.audit())).toBe('0 / 0 / 0 / 0 / 0 / 3');
    } finally {
      await w.db.close();
    }
  });

  it('sinais de outra sala na janela: fora das classes, contados à parte', async () => {
    const w = await world();
    try {
      const m = await openSession(w.db, w.member, w.room);
      await w.signal(w.owner, w.ownerSession, m);
      const owner2 = await makeCreator(w.db);
      const room2 = await createRoom(w.db, owner2, 2, 'Outra');
      const guest = await w.db.newUser();
      await w.db.rpc(guest, 'public.redeem_room_invite', { p_token: await roomInvite(w.db, owner2, room2), p_display_name: 'Outro' });
      await w.signal(owner2, await openSession(w.db, owner2, room2), await openSession(w.db, guest, room2));
      const rows = await w.audit();
      expect(one(rows, 'B0 sinais').actual).toBe('1');
      expect(one(rows, 'INFO B0 sinais da janela de OUTRAS').actual).toBe('1');
    } finally {
      await w.db.close();
    }
  });
});

describe('14_mvp01_r2_ab_audit.sql: segurança', () => {
  it('nenhuma escrita: oryn.*, realtime.* e auth.* idênticos antes e depois (sala aberta e encerrada)', async () => {
    const w = await world();
    try {
      const m = await openSession(w.db, w.member, w.room);
      await w.signal(w.member, m, w.ownerSession);
      let before = await snapshot(w.db);
      await w.audit();
      expect(await snapshot(w.db)).toBe(before);
      await w.db.rpc(w.owner, 'public.close_room', { p_room_id: w.room });
      before = await snapshot(w.db);
      await w.audit();
      expect(await snapshot(w.db)).toBe(before);
    } finally {
      await w.db.close();
    }
  });

  it('a transação é READ ONLY: uma escrita injetada no bloco é recusada e nada muda', async () => {
    const w = await world();
    try {
      const before = await snapshot(w.db);
      const injected = fill(w.room, w.t0, iso(Date.now() + 60_000)).replace(/rollback;\s*$/, `update oryn.rooms set name = 'x';\nrollback;`);
      await expect(w.db.pg.exec(injected)).rejects.toThrow(/read-only transaction/);
      await w.db.pg.exec('rollback');
      expect(await snapshot(w.db)).toBe(before);
    } finally {
      await w.db.close();
    }
  });

  it('o texto do script: só uma transação READ ONLY terminada em ROLLBACK; nenhum DML/DDL fora de comentários', () => {
    const code = SQL.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n').replace(/'(?:[^']|'')*'/g, "''");
    expect(code.match(/^\s*(begin|set transaction read only|rollback|commit);/gim)?.map((s) => s.trim())).toEqual(['begin;', 'set transaction read only;', 'rollback;']);
    expect(code).not.toMatch(/\b(insert|update|delete|merge|truncate|create|alter|drop|grant|revoke|copy|call|do|execute|prepare|lock|vacuum|notify|reset)\b/i);
    expect(code).not.toMatch(/\bset\s+(role|session|local)\b/i);
    expect(code).not.toMatch(/token_hash|display_name|email|payload|request\.jwt/i);
  });

  it('sem dado sensível na saída: nenhum UUID completo, display_name ou hash de convite', async () => {
    const w = await world();
    try {
      const m = await openSession(w.db, w.member, w.room);
      await w.signal(w.member, m, w.ownerSession, 'accepted');
      await roomInvite(w.db, w.owner, w.room);
      const hashes = await w.db.admin<{ h: string }>(`select encode(token_hash, 'hex') as h from oryn.room_invites`);
      const text = JSON.stringify(await w.audit());
      expect(text).not.toMatch(UUID);
      expect(text).not.toContain('NomePessoalMembro');
      expect(text).not.toContain('Dono');
      for (const { h } of hashes) expect(text).not.toContain(h.slice(0, 16));
    } finally {
      await w.db.close();
    }
  });

  it('o rótulo das classes no INFO segue a ordem documentada', async () => {
    const w = await world();
    try {
      expect(one(await w.audit(), 'INFO B2 classes').item).toBe(`INFO B2 classes: ${CLASSES}`);
    } finally {
      await w.db.close();
    }
  });
});
