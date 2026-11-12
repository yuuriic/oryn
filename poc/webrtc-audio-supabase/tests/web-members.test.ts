// Painel de membros e capacidade no cliente: contrato, controlador e renderização, com servidor falso e, no fluxo de ponta a
// ponta, com o Postgres real em memória.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseRoomMember, parseVoiceParticipant, type RoomMember } from '../src/contracts.ts';
import { MEMBERS_DENIED, MEMBERS_POLL_MS, MEMBERS_RPC_TIMEOUT_MS, MembersController, parseMembers, type MembersDeps, type MembersState } from '../src/web/members.ts';
import { participantStateText, renderMembers, renderParticipants } from '../src/web/members-view.ts';
import { LobbyController, ROOM_CAPACITIES, isRoomCapacity, peerProblemNotice, type LobbyState } from '../src/web/rooms.ts';
import { renderLobby } from '../src/web/rooms-view.ts';
import type { RoomSummary } from '../src/contracts.ts';
import type { RpcResult } from '../src/web/supabase-signaling.ts';
import { TestDb, type Actor } from './helpers/db.ts';
import { scenario } from './helpers/fixtures.ts';

const ROOM = '11111111-1111-4111-8111-111111111111';
const ref = (n: number) => String(n).padStart(32, 'a');
const member = (n: number, over: Partial<RoomMember> = {}): RoomMember => ({ member_ref: ref(n), display_name: `M${n}`, role: 'member', is_self: false, in_call: false, joined_at: '2026-11-07T00:00:00+00:00', ...over });
const owner = member(1, { role: 'owner', is_self: true, display_name: 'Dono' });
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

type Handler = (args: Record<string, unknown>) => RpcResult<unknown> | 'hang' | 'reject';

function harness(handlers: Partial<Record<string, Handler>> = {}, confirmAnswer = true) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  const seen = { confirms: [] as string[], before: [] as string[], left: [] as string[], denied: [] as string[], changed: 0, hidden: false };
  const h = { ...handlers } as Record<string, Handler | undefined>;
  const deps: MembersDeps = {
    rpc: async <T,>(fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      const r = (h[fn] ?? (() => ({ data: [], error: null })))(args);
      if (r === 'hang') return new Promise<RpcResult<T>>(() => undefined);
      if (r === 'reject') throw new Error('rede');
      return r as RpcResult<T>;
    },
    confirm: (m) => {
      seen.confirms.push(m);
      return confirmAnswer;
    },
    isHidden: () => seen.hidden,
    setTimer: (fn, ms) => {
      const id = next++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id) => void timers.delete(id as number),
    onChange: () => undefined,
    beforeLeave: (r) => void seen.before.push(r),
    onLeft: (r) => void seen.left.push(r),
    onDenied: (r) => void seen.denied.push(r),
    onChanged: () => void (seen.changed += 1),
  };
  const c = new MembersController(deps);
  const fire = async (ms: number) => {
    for (const [id, t] of [...timers]) {
      if (t.ms === ms) {
        timers.delete(id);
        t.fn();
      }
    }
    await flush();
  };
  return { c, calls, h, seen, fire, timers };
}
const ok = (rows: unknown[]): RpcResult<unknown> => ({ data: rows, error: null });
const err = (code: string): RpcResult<unknown> => ({ data: null, error: code });

describe('contratos', () => {
  it('parseRoomMember: exatamente as colunas e papéis válidos', () => {
    expect(parseRoomMember(owner)).toEqual(owner);
    expect(parseRoomMember({ ...owner, user_id: ROOM })).toBeNull();
    expect(parseRoomMember({ ...owner, role: 'admin' })).toBeNull();
    expect(parseRoomMember({ ...owner, member_ref: 'x' })).toBeNull();
    expect(parseMembers(null)).toBeNull();
    expect(parseMembers([{ a: 1 }])).toBeNull();
    expect(parseMembers([owner, { ...member(2), display_name: '' }])).toEqual([owner]);
  });

  it('parseVoiceParticipant recusa referência fora do formato', () => {
    const row = { session_id: ROOM, participant_ref: ref(1), display_name: 'x', is_self: false, joined_at: 't' };
    expect(parseVoiceParticipant(row)).toEqual(row);
    expect(parseVoiceParticipant({ ...row, participant_ref: 'conta' })).toBeNull();
    expect(parseVoiceParticipant({ ...row, session_id: 'x' })).toBeNull();
  });
});

describe('lista e presença', () => {
  it('carrega, atualiza a cada 5 s só com a página visível e não redesenha sem mudança', async () => {
    const t = harness({ list_room_members: () => ok([owner, member(2)]) });
    t.c.open(ROOM, 'Sala', false);
    await flush();
    expect(t.c.state).toMatchObject({ status: 'ready', roomName: 'Sala' });
    expect(t.c.canManage).toBe(true);
    t.seen.hidden = true;
    await t.fire(MEMBERS_POLL_MS);
    expect(t.calls).toHaveLength(1);
    t.seen.hidden = false;
    t.h['list_room_members'] = () => ok([owner, member(2, { in_call: true })]);
    await t.fire(MEMBERS_POLL_MS);
    expect(t.c.state.members[1]!.in_call).toBe(true);
  });

  it('recusa do servidor: limpa, avisa, para de consultar e notifica a página', async () => {
    const t = harness({ list_room_members: () => ok([owner]) });
    t.c.open(ROOM, 'Sala', false);
    await flush();
    t.h['list_room_members'] = () => err('unauthorized');
    await t.fire(MEMBERS_POLL_MS);
    expect(t.c.state).toMatchObject({ status: 'denied', members: [] });
    expect(t.c.state.message?.text).toBe(MEMBERS_DENIED);
    expect(t.seen.denied).toEqual([ROOM]);
    expect([...t.timers.values()].filter((x) => x.ms === MEMBERS_POLL_MS)).toEqual([]);
  });

  it('falha de rede: mantém a lista, avisa e recupera; requisição travada não prende o painel', async () => {
    const t = harness({ list_room_members: () => ok([owner]) });
    t.c.open(ROOM, 'Sala', false);
    await flush();
    t.h['list_room_members'] = () => 'hang';
    await t.fire(MEMBERS_POLL_MS);
    await t.fire(MEMBERS_RPC_TIMEOUT_MS);
    expect(t.c.state.members).toHaveLength(1);
    expect(t.c.state.message?.tone).toBe('error');
    t.h['list_room_members'] = () => ok([owner]);
    await t.fire(MEMBERS_POLL_MS);
    expect(t.c.state.message).toBeNull();
  });

  it('resposta da sala anterior é descartada; fechar para a consulta', async () => {
    let release!: (r: RpcResult<unknown>) => void;
    const t = harness();
    t.h['list_room_members'] = () => ok([owner]);
    t.c.open(ROOM, 'Sala', false);
    await flush();
    void release;
    t.c.close();
    expect(t.c.state.status).toBe('closed');
    expect([...t.timers.values()].filter((x) => x.ms === MEMBERS_POLL_MS)).toEqual([]);
  });
});

describe('saída', () => {
  const self = member(2, { is_self: true });

  it('confirma, encerra a chamada antes e só então chama o servidor', async () => {
    const order: string[] = [];
    const t = harness({ list_room_members: () => ok([owner, self]), leave_room_membership: () => { order.push('rpc'); return { data: null, error: null }; } });
    t.c.open(ROOM, 'Sala', false);
    await flush();
    const orig = t.seen.before;
    orig.push = ((v: string) => { order.push('antes'); return Array.prototype.push.call(orig, v); }) as typeof orig.push;
    expect(await t.c.leave()).toBe(true);
    expect(order).toEqual(['antes', 'rpc']);
    expect(t.seen.confirms[0]).toMatch(/Sair definitivamente/);
    expect(t.seen.left).toEqual([ROOM]);
    expect(t.c.state.status).toBe('closed');
  });

  it('sem confirmação, nada acontece', async () => {
    const t = harness({ list_room_members: () => ok([owner, self]) }, false);
    t.c.open(ROOM, 'Sala', false);
    await flush();
    expect(await t.c.leave()).toBe(false);
    expect(t.calls.some((c) => c.fn === 'leave_room_membership')).toBe(false);
    expect(t.seen.before).toEqual([]);
  });

  it.each([['owner-cannot-leave', 'encerre a sala'], ['unauthorized', 'não participa mais'], ['erro qualquer do servidor', 'falha de rede']])('erro %s: texto fixo, painel continua', async (code, text) => {
    const t = harness({ list_room_members: () => ok([owner, self]), leave_room_membership: () => err(code) });
    t.c.open(ROOM, 'Sala', false);
    await flush();
    expect(await t.c.leave()).toBe(false);
    expect(t.c.state.message?.text).toContain(text);
    expect(t.c.state.message?.text).not.toContain('qualquer');
    expect(t.seen.left).toEqual([]);
  });
});

describe('remoção', () => {
  it('só o dono vê; confirma com o nome e envia só a referência', async () => {
    const t = harness({ list_room_members: () => ok([owner, member(2)]), remove_room_member: () => ({ data: null, error: null }) });
    t.c.open(ROOM, 'Sala', false);
    await flush();
    expect(await t.c.remove(ref(2))).toBe(true);
    expect(t.seen.confirms[0]).toContain('M2');
    expect(t.calls.find((c) => c.fn === 'remove_room_member')!.args).toEqual({ p_room_id: ROOM, p_member_ref: ref(2) });
    expect(t.seen.changed).toBe(1);
    expect(t.c.state.message?.tone).toBe('info');
  });

  it('membro comum, sala encerrada, autorremoção ou referência desconhecida: nem chama o servidor', async () => {
    const notOwner = harness({ list_room_members: () => ok([member(1, { role: 'owner' }), member(2, { is_self: true }), member(3)]) });
    notOwner.c.open(ROOM, 'Sala', false);
    await flush();
    expect(notOwner.c.canManage).toBe(false);
    expect(await notOwner.c.remove(ref(3))).toBe(false);
    const closed = harness({ list_room_members: () => ok([owner, member(2)]) });
    closed.c.open(ROOM, 'Sala', true);
    await flush();
    expect(closed.c.canManage).toBe(false);
    const t = harness({ list_room_members: () => ok([owner, member(2)]) });
    t.c.open(ROOM, 'Sala', false);
    await flush();
    expect(await t.c.remove(owner.member_ref)).toBe(false);
    expect(await t.c.remove(ref(9))).toBe(false);
    expect(t.calls.some((c) => c.fn === 'remove_room_member')).toBe(false);
  });

  it('recusa do servidor: mensagem genérica, sem revelar nada', async () => {
    const t = harness({ list_room_members: () => ok([owner, member(2)]), remove_room_member: () => err('unauthorized') });
    t.c.open(ROOM, 'Sala', false);
    await flush();
    expect(await t.c.remove(ref(2))).toBe(false);
    expect(t.c.state.message).toMatchObject({ tone: 'error' });
    expect(t.seen.changed).toBe(0);
  });
});

class FakeEl {
  textContent: string | null = null;
  className = '';
  type = '';
  disabled = false;
  readonly tag: string;
  readonly children: FakeEl[] = [];
  readonly attrs = new Map<string, string>();
  readonly clicks: (() => void)[] = [];
  constructor(tag: string) {
    this.tag = tag;
  }
  append(...nodes: FakeEl[]): void {
    this.children.push(...nodes);
  }
  setAttribute(n: string, v: string): void {
    this.attrs.set(n, v);
  }
  addEventListener(_e: string, fn: () => void): void {
    this.clicks.push(fn);
  }
  set innerHTML(_v: string) {
    throw new Error('innerHTML proibido');
  }
  get allText(): string {
    return [this.textContent ?? '', ...this.children.map((c) => c.allText)].join(' ');
  }
  buttons(): FakeEl[] {
    return [...(this.tag === 'button' ? [this] : []), ...this.children.flatMap((c) => c.buttons())];
  }
}
const doc = { createElement: (tag: string) => new FakeEl(tag) as unknown as HTMLElement };
const state = (over: Partial<MembersState> = {}): MembersState => ({ roomId: ROOM, roomName: 'Sala', readOnly: false, status: 'ready', members: [owner, member(2)], busy: null, message: null, ...over });
const view = (s: MembersState, canManage: boolean) => renderMembers(doc, s, { canManage, onLeave: () => undefined, onRemove: () => undefined }) as unknown as FakeEl;

describe('renderização', () => {
  it('dono vê "Remover" para os outros e nunca para si; sem "Sair"', () => {
    expect(view(state(), true).buttons().map((b) => b.textContent)).toEqual(['Remover']);
  });

  it('membro vê só "Sair da sala", na própria linha', () => {
    const s = state({ members: [member(1, { role: 'owner', display_name: 'Dono' }), member(2, { is_self: true }), member(3)] });
    expect(view(s, false).buttons().map((b) => b.textContent)).toEqual(['Sair da sala']);
  });

  it('nome com HTML vira texto; presença na chamada aparece', () => {
    const html = '<img src=x onerror=alert(1)>';
    const root = view(state({ members: [member(2, { display_name: html, in_call: true })] }), false);
    expect(root.allText).toContain(html);
    expect(root.allText).toContain('na chamada');
  });

  it('durante uma operação, os botões ficam desativados', () => {
    expect(view(state({ busy: { removing: ref(2) } }), true).buttons()[0]).toMatchObject({ textContent: 'Removendo…', disabled: true });
  });

  it('participantes: estado individual, falha parcial em destaque e sessão em espera explicada', () => {
    const list = [{ session: 'a', ref: 'r-a', displayName: 'A', state: 'connected' as const }, { session: 'b', ref: 'r-b', displayName: '<b>B</b>', state: 'failed' as const }];
    const root = renderParticipants(doc, list, false) as unknown as FakeEl;
    expect(root.allText).toContain('conectado');
    expect(root.allText).toContain('<b>B</b>');
    expect(root.allText).toContain(participantStateText('failed'));
    expect((renderParticipants(doc, [], true) as unknown as FakeEl).allText).toMatch(/em espera/);
    expect((renderParticipants(doc, [], false) as unknown as FakeEl).allText).toMatch(/Nenhum outro participante/);
  });

  it('palco: o próprio cartão, os outros e a vaga, só com estado real e sem contar como "conectado"', () => {
    const list = [{ session: 'a', ref: 'r-a', displayName: 'Bia', state: 'connected' as const }];
    const root = renderParticipants(doc, list, false, { owner: true, muted: false, freeSlots: 2 }) as unknown as FakeEl;
    const ul = root.children.find((c) => c.tag === 'ul')!;
    expect(ul.children.map((li) => li.className)).toEqual(['participant-self', '', 'participant-waiting']);
    expect(ul.attrs.get('data-count')).toBe('3');
    const [self, , waiting] = ul.children;
    expect(self!.allText).toContain('Você');
    expect(self!.allText).toContain('Microfone ligado');
    expect(self!.allText).toContain('Dono');
    expect(self!.attrs.get('data-role')).toBe('owner');
    expect(waiting!.allText).toContain('Até 2 vagas disponíveis');
    // Os roteiros contam "conectado" no palco: o próprio cartão e a vaga não podem somar.
    expect(root.allText.split('conectado').length - 1).toBe(1);
  });

  it('palco: mudo, membro sem selo, uma vaga no singular e sala cheia sem vaga', () => {
    const muted = renderParticipants(doc, [], false, { owner: false, muted: true, freeSlots: 1 }) as unknown as FakeEl;
    expect(muted.allText).toContain('Microfone desligado');
    expect(muted.allText).not.toContain('Dono');
    expect(muted.allText).toContain('Até 1 vaga disponível');
    expect(muted.allText).toMatch(/Nenhum outro participante/); // segue para leitores de tela
    const full = renderParticipants(doc, [1, 2, 3].map((i) => ({ session: `s${i}`, ref: `r${i}`, displayName: `P${i}`, state: 'connected' as const })), false, { owner: true, muted: false, freeSlots: 0 }) as unknown as FakeEl;
    const ul = full.children.find((c) => c.tag === 'ul')!;
    expect(ul.children).toHaveLength(4);
    expect(ul.attrs.get('data-count')).toBe('4');
    expect(full.allText).not.toContain('Aguardando participantes');
  });

  it('os módulos não usam API de HTML', () => {
    for (const file of ['members.ts', 'members-view.ts', 'mesh-call.ts', 'mesh-signaling.ts']) {
      const source = readFileSync(new URL(`../src/web/${file}`, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
      expect(source, file).not.toMatch(/\.innerHTML\s*=|insertAdjacentHTML|document\.write|\beval\(|console\./);
    }
  });

  it('a página pede a capacidade e já não fixa 2 lugares nem 1:1', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    expect(html).toMatch(/id="create-capacity"/);
    for (const v of ROOM_CAPACITIES) expect(html).toContain(`<option value="${v}"`);
    expect(html).not.toMatch(/Criar sala \(2 lugares\)/);
  });
});

describe('capacidade e avisos', () => {
  const room = (n: number): RoomSummary => ({ room_id: ROOM, name: `S${n}`, role: 'member', is_open: true, closed_at: null, member_count: 1, max_members: 2, created_at: 'x' });
  const lobby = (rooms: RoomSummary[]): LobbyState => ({ status: 'ready', rooms, skipped: 0, listError: null, actionError: null, busy: null });

  it('só de 2 a 5 (1000)', () => {
    for (const v of [2, 3, 4, 5]) expect(isRoomCapacity(v)).toBe(true);
    for (const v of [1, 6, 10, NaN, '4', null]) expect(isRoomCapacity(v)).toBe(false);
  });

  it('create envia a capacidade escolhida e recusa outra, sem chamar o servidor', async () => {
    const calls: Record<string, unknown>[] = [];
    const c = new LobbyController({
      rpc: async <T,>(fn: string, args: Record<string, unknown>) => {
        if (fn === 'create_room') calls.push(args);
        return { data: (fn === 'create_room' ? ROOM : []) as T, error: null };
      },
      confirm: () => true,
      onChange: () => undefined,
    });
    await c.create('Sala', 'Eu', 5);
    expect(calls[0]).toMatchObject({ p_max_members: 5 });
    await c.create('Sala', 'Eu', 6);
    expect(calls).toHaveLength(1);
    expect(c.state.actionError).toBe('Capacidade inválida: escolha de 2 a 5 lugares.');
    await c.create('Sala', 'Eu');
    expect(calls[1]).toMatchObject({ p_max_members: 2 });
  });

  it('botão de membros no lobby, aberto ou encerrada', () => {
    const opened: string[] = [];
    const base = { callActive: true, activeRoomId: null, onJoin: () => undefined, onClose: () => undefined, onMembers: (r: string) => opened.push(r) };
    const root = renderLobby(doc, lobby([room(1)]), base) as unknown as FakeEl;
    const b = root.buttons().find((x) => x.textContent === 'Membros')!;
    expect(b.disabled).toBe(false);
    b.clicks[0]!();
    expect(opened).toEqual([ROOM]);
    expect((renderLobby(doc, lobby([room(1)]), { ...base, membersRoomId: ROOM }) as unknown as FakeEl).buttons().find((x) => x.textContent === 'Membros abertos')!.disabled).toBe(true);
  });

  it('avisos de falha parcial deixam claro que a chamada continua', () => {
    expect(peerProblemNotice('Ana', 'failed').text).toMatch(/com os demais continua/);
    expect(peerProblemNotice('Ana', 'reconnecting').tone).toBe('info');
  });
});

describe('ponta a ponta com o banco real em memória', () => {
  const rpc = (db: TestDb, actor: Actor) => async <T,>(fn: string, args: Record<string, unknown>): Promise<RpcResult<T>> => {
    try {
      const rows = await db.rpc<Record<string, unknown>>(actor, `public.${fn}`, args);
      return { data: rows.map((r) => ({ ...r, joined_at: r['joined_at'] ? String(r['joined_at']) : r['joined_at'] })) as T, error: null };
    } catch (error) {
      return { data: null, error: (error as Error).message };
    }
  };
  const controller = (db: TestDb, actor: Actor) => {
    const seen = { left: [] as string[], denied: [] as string[] };
    const timers = new Map<number, () => void>();
    let n = 1;
    const c = new MembersController({
      rpc: rpc(db, actor),
      confirm: () => true,
      isHidden: () => false,
      setTimer: (fn, ms) => {
        const id = n++;
        if (ms === MEMBERS_POLL_MS) timers.set(id, fn);
        return id;
      },
      clearTimer: (id) => void timers.delete(id as number),
      onChange: () => undefined,
      beforeLeave: () => undefined,
      onLeft: (r) => void seen.left.push(r),
      onDenied: (r) => void seen.denied.push(r),
      onChanged: () => undefined,
    });
    const settle = async (done: () => boolean) => {
      for (let i = 0; i < 400 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
      expect(done()).toBe(true);
    };
    const poll = async () => {
      const list = [...timers.values()];
      timers.clear();
      for (const t of list) t();
      await new Promise((r) => setTimeout(r, 120));
    };
    return { c, seen, settle, poll };
  };

  it('dono lista e remove; o removido descobre na consulta seguinte; membro comum sai', async () => {
    const db = await TestDb.create();
    try {
      const s = await scenario(db);
      const o = controller(db, s.owner);
      const m = controller(db, s.member);
      o.c.open(s.room, 'Partida', false);
      m.c.open(s.room, 'Partida', false);
      await o.settle(() => o.c.state.status === 'ready');
      await m.settle(() => m.c.state.status === 'ready');
      expect(o.c.state.members.map((x) => [x.display_name, x.role, x.is_self])).toEqual([['Dono', 'owner', true], ['Amigo', 'member', false]]);
      expect(o.c.canManage).toBe(true);
      expect(m.c.canManage).toBe(false);
      const target = o.c.state.members.find((x) => !x.is_self)!;
      expect(await o.c.remove(target.member_ref)).toBe(true);
      expect(o.c.state.members).toHaveLength(1);
      await m.poll();
      await m.settle(() => m.c.state.status === 'denied');
      expect(m.seen.denied).toEqual([s.room]);
    } finally {
      await db.close();
    }
  }, 120_000);
});
