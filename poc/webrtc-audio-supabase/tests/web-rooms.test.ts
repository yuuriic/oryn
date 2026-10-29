// Lobby de salas (MVP 01): contrato de list_my_rooms, regras do formulário, classificação da desconexão,
// controlador (carga, criação, encerramento) e renderização SÓ como texto. Sem navegador: a renderização usa
// um documento falso que recusa qualquer HTML dinâmico.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { codePointLength, isDisplayName, isRoomName, parseRoomSummary, type RoomSummary } from '../src/contracts.ts';
import {
  CLOSE_FAILED,
  CREATE_FAILED,
  DISCONNECT_CHECKING,
  DISCONNECT_KIND_MESSAGES,
  SESSION_GONE_CODE,
  describeDisconnect,
  explainDisconnect,
  formatCallError,
  isClosingOwnCall,
  type Notice,
  LIST_FAILED,
  LobbyController,
  ROOM_MAX_MEMBERS,
  classifyDisconnect,
  splitRooms,
  validateNewRoom,
  type LobbyDeps,
  type LobbyState,
} from '../src/web/rooms.ts';
import { renderLobby, statusText, type LobbyViewOptions } from '../src/web/rooms-view.ts';
import type { RpcResult } from '../src/web/supabase-signaling.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function room(n: number, over: Partial<RoomSummary> = {}): RoomSummary {
  return {
    room_id: id(n),
    name: `Sala ${n}`,
    role: 'owner',
    is_open: true,
    closed_at: null,
    member_count: 1,
    max_members: 2,
    created_at: '2026-10-28T12:00:00+00:00',
    ...over,
  };
}
const closedRoom = (n: number, over: Partial<RoomSummary> = {}) => room(n, { is_open: false, closed_at: '2026-10-28T13:00:00+00:00', ...over });

describe('contrato: parseRoomSummary', () => {
  it('aceita a linha do list_my_rooms, aberta ou encerrada', () => {
    expect(parseRoomSummary(room(1))).toEqual(room(1));
    expect(parseRoomSummary(closedRoom(2, { role: 'member' }))).toEqual(closedRoom(2, { role: 'member' }));
  });

  it('recusa linhas inconsistentes ou fora do contrato', () => {
    const bad: unknown[] = [
      null,
      [],
      { ...room(1), room_id: 'x' },
      { ...room(1), role: 'admin' },
      { ...room(1), name: '' },
      { ...room(1), name: 'a'.repeat(41) },
      { ...room(1), name: 'tab\there' },
      { ...room(1), is_open: true, closed_at: '2026-10-28T13:00:00Z' },
      { ...room(1), is_open: false, closed_at: null },
      { ...room(1), member_count: -1 },
      { ...room(1), max_members: 2.5 },
      { ...room(1), member_count: '1' },
      { ...room(1), created_at: undefined },
    ];
    for (const v of bad) expect(parseRoomSummary(v), JSON.stringify(v)).toBeNull();
  });
});

describe('regras: formulário, ordem e desconexão', () => {
  it('validateNewRoom: mesmas regras do banco, sobre o texto sem espaços nas pontas', () => {
    expect(validateNewRoom('  Partida  ', ' Ana ')).toEqual({ ok: true, name: 'Partida', displayName: 'Ana' });
    expect(validateNewRoom('a'.repeat(40), 'b'.repeat(32)).ok).toBe(true);
    for (const [n, d] of [['', 'Ana'], ['   ', 'Ana'], ['a'.repeat(41), 'Ana'], ['x\u0007', 'Ana'], ['Sala', ''], ['Sala', 'b'.repeat(33)], ['Sala', 'a\nb']]) {
      expect(validateNewRoom(n!, d!).ok, `${JSON.stringify(n)} / ${JSON.stringify(d)}`).toBe(false);
    }
  });

  it('splitRooms: abertas primeiro, preservando a ordem do servidor dentro de cada grupo', () => {
    const rooms = [closedRoom(1), room(2), closedRoom(3), room(4)];
    const { open, closed } = splitRooms(rooms);
    expect(open.map((r) => r.room_id)).toEqual([id(2), id(4)]);
    expect(closed.map((r) => r.room_id)).toEqual([id(1), id(3)]);
  });

  it('classifyDisconnect: encerrada, sem participação, sessão expirada; nada definitivo se a consulta falhar', () => {
    const ok = (data: unknown[]): RpcResult<unknown[]> => ({ data, error: null });
    expect(classifyDisconnect(id(1), ok([closedRoom(1)]))).toBe('closed');
    expect(classifyDisconnect(id(1), ok([room(1)]))).toBe('expired');
    expect(classifyDisconnect(id(1), ok([room(2)]))).toBe('not-member');
    expect(classifyDisconnect(id(1), ok([]))).toBe('not-member');
    expect(classifyDisconnect(id(1), { data: null, error: 'erro de rede' })).toBe('unknown');
    expect(classifyDisconnect(id(1), ok([{ lixo: true }]))).toBe('unknown');
    // Lista cheia (50) sem a sala: pode estar além do limite.
    expect(classifyDisconnect(id(999), ok(Array.from({ length: 50 }, (_, i) => room(i + 1))))).toBe('unknown');
    expect(DISCONNECT_KIND_MESSAGES.unknown).not.toMatch(/encerrada|expirou|não participa/);
  });
});

// ---------- controlador ----------

interface Harness {
  lobby: LobbyController;
  calls: { fn: string; args: Record<string, unknown> }[];
  states: LobbyState[];
  confirm: ReturnType<typeof vi.fn<(m: string) => boolean>>;
  closed: string[];
  server: { rooms: RoomSummary[]; fail: Map<string, string | 'throw'>; createdId: string };
}

function harness(rooms: RoomSummary[] = []): Harness {
  const h = {
    calls: [],
    states: [],
    closed: [],
    confirm: vi.fn<(m: string) => boolean>(() => true),
    server: { rooms, fail: new Map<string, string | 'throw'>(), createdId: id(77) },
  } as unknown as Harness;
  const deps: LobbyDeps = {
    rpc: async <T>(fn: string, args: Record<string, unknown>): Promise<RpcResult<T>> => {
      await Promise.resolve();
      h.calls.push({ fn, args });
      const fail = h.server.fail.get(fn);
      if (fail === 'throw') throw new Error('rede');
      if (fail) return { data: null, error: fail };
      if (fn === 'list_my_rooms') return { data: h.server.rooms as T, error: null };
      if (fn === 'create_room') {
        h.server.rooms = [room(77, { name: String(args['p_name']) }), ...h.server.rooms];
        return { data: h.server.createdId as T, error: null };
      }
      if (fn === 'close_room') {
        h.server.rooms = h.server.rooms.map((r) => (r.room_id === args['p_room_id'] ? { ...r, is_open: false, closed_at: '2026-10-28T14:00:00Z' } : r));
        return { data: '2026-10-28T14:00:00Z' as T, error: null };
      }
      return { data: null, error: 'not-found' };
    },
    confirm: (m) => h.confirm(m),
    onChange: (s) => h.states.push(s),
    onClosed: (roomId) => void h.closed.push(roomId),
  };
  h.lobby = new LobbyController(deps);
  return h;
}

describe('LobbyController: carga da lista', () => {
  it('idle → loading → ready; lista vazia fica ready sem salas', async () => {
    const h = harness([]);
    expect(h.lobby.state.status).toBe('idle');
    await h.lobby.refresh();
    expect(h.states.map((s) => s.status)).toEqual(['loading', 'ready']);
    expect(h.lobby.state.rooms).toEqual([]);
    expect(statusText(h.lobby.state)).toMatch(/Nenhuma sala/);
  });

  it('erro do servidor, falha de rede e resposta estruturalmente fora do contrato → error, com mensagem fixa', async () => {
    const { max_members: _dropped, ...missingColumn } = room(1);
    for (const setup of [
      (h: Harness) => h.server.fail.set('list_my_rooms', 'permission denied for function list_my_rooms'),
      (h: Harness) => h.server.fail.set('list_my_rooms', 'throw'),
      // Coluna faltando ou sobrando (outra versão da RPC) numa linha só: a lista inteira é recusada.
      (h: Harness) => (h.server.rooms = [room(2), missingColumn as unknown as RoomSummary]),
      (h: Harness) => (h.server.rooms = [room(2), { ...room(1), owner_id: id(9) } as unknown as RoomSummary]),
      (h: Harness) => (h.server.rooms = { room_id: id(1) } as unknown as RoomSummary[]),
    ]) {
      const h = harness([room(1)]);
      setup(h);
      await h.lobby.refresh();
      expect(h.lobby.state.status).toBe('error');
      expect(h.lobby.state.listError).toBe(LIST_FAILED);
      expect(statusText(h.lobby.state)).toBe(LIST_FAILED);
    }
  });

  it('linha com as colunas certas e valor fora da regra: ignorada e contada; as demais aparecem', async () => {
    const h = harness([room(1), { ...room(2), role: 'root' } as unknown as RoomSummary, { ...room(3), name: 'a\u0000b' }, room(4, { name: '🎮'.repeat(40) })]);
    await h.lobby.refresh();
    expect(h.lobby.state.status).toBe('ready');
    expect(h.lobby.state.rooms.map((r) => r.room_id)).toEqual([id(1), id(4)]);
    expect(h.lobby.state.skipped).toBe(2);
    expect(view(h.lobby.state).root.textContent).toMatch(/2 sala\(s\) com dados fora do padrão não exibida\(s\)/);
    await h.lobby.refresh();
    expect(h.lobby.state.skipped).toBe(2); // recontado a cada carga, não acumulado
  });

  it('uma carga antiga que termina depois não sobrescreve a mais nova; reset descarta respostas em curso', async () => {
    const h = harness([room(1)]);
    const first = h.lobby.refresh();
    h.server.rooms = [room(2)];
    const second = h.lobby.refresh();
    await Promise.all([first, second]);
    expect(h.lobby.state.rooms.map((r) => r.room_id)).toEqual([id(2)]);
    const pending = h.lobby.refresh();
    h.lobby.reset();
    await pending;
    expect(h.lobby.state).toMatchObject({ status: 'idle', rooms: [] });
  });
});

describe('LobbyController: criação', () => {
  it('sempre com 2 lugares e o texto sem espaços nas pontas; ocupado durante a chamada; recarrega a lista', async () => {
    const h = harness([]);
    await h.lobby.refresh();
    const created = await h.lobby.create('  Partida ', ' Ana ');
    expect(created).toBe(id(77));
    expect(h.calls.find((c) => c.fn === 'create_room')!.args).toEqual({ p_name: 'Partida', p_display_name: 'Ana', p_max_members: ROOM_MAX_MEMBERS });
    expect(ROOM_MAX_MEMBERS).toBe(2);
    expect(h.states.some((s) => s.busy?.kind === 'create')).toBe(true);
    expect(h.lobby.state.busy).toBeNull();
    expect(h.calls.map((c) => c.fn)).toEqual(['list_my_rooms', 'create_room', 'list_my_rooms']);
    expect(h.lobby.state.rooms[0]!.name).toBe('Partida');
  });

  it('entrada inválida: nenhuma chamada ao servidor, mensagem do campo', async () => {
    const h = harness([]);
    expect(await h.lobby.create('', 'Ana')).toBeNull();
    expect(h.calls).toEqual([]);
    expect(h.lobby.state.actionError).toMatch(/Nome da sala/);
  });

  it.each([
    ['unauthorized', /não tem permissão para criar salas/],
    ['limit-reached', /Limite de salas abertas/],
    ['invalid-argument', /inválido/],
    ['throw', new RegExp(CREATE_FAILED.replace(/[().]/g, '\\$&'))],
    ['relation "oryn.rooms" does not exist', new RegExp(CREATE_FAILED.replace(/[().]/g, '\\$&'))],
  ])('erro %s → mensagem fixa, sem texto do servidor', async (fault, message) => {
    const h = harness([]);
    h.server.fail.set('create_room', fault);
    expect(await h.lobby.create('Sala', 'Ana')).toBeNull();
    expect(h.lobby.state.actionError).toMatch(message);
    expect(h.lobby.state.actionError).not.toMatch(/oryn|relation/);
    expect(h.lobby.state.busy).toBeNull();
  });

  it('não dispara duas criações ao mesmo tempo', async () => {
    const h = harness([]);
    const a = h.lobby.create('A', 'Ana');
    const b = h.lobby.create('B', 'Ana');
    expect(await b).toBeNull();
    await a;
    expect(h.calls.filter((c) => c.fn === 'create_room')).toHaveLength(1);
  });
});

describe('LobbyController: encerramento', () => {
  it('só com confirmação explícita; recusada → nada acontece', async () => {
    const h = harness([room(1)]);
    await h.lobby.refresh();
    h.confirm.mockReturnValueOnce(false);
    expect(await h.lobby.close(id(1))).toBe(false);
    expect(h.calls.filter((c) => c.fn === 'close_room')).toEqual([]);
    expect(h.confirm.mock.calls[0]![0]).toMatch(/Encerrar a sala "Sala 1"\?.*não pode ser reaberta/);
  });

  it('confirmado: close_room, depois onClosed (a página sai da chamada daquela sala), depois a lista recarrega', async () => {
    const h = harness([room(1)]);
    await h.lobby.refresh();
    expect(await h.lobby.close(id(1))).toBe(true);
    expect(h.calls.map((c) => c.fn)).toEqual(['list_my_rooms', 'close_room', 'list_my_rooms']);
    expect(h.calls[1]!.args).toEqual({ p_room_id: id(1) });
    expect(h.closed).toEqual([id(1)]);
    expect(h.states.some((s) => s.busy?.kind === 'close')).toBe(true);
    expect(h.lobby.state.rooms[0]).toMatchObject({ is_open: false });
  });

  it('membro, sala encerrada ou desconhecida: nem pergunta, nem chama o servidor', async () => {
    const h = harness([room(1, { role: 'member' }), closedRoom(2)]);
    await h.lobby.refresh();
    for (const r of [id(1), id(2), id(3)]) expect(await h.lobby.close(r)).toBe(false);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.calls.filter((c) => c.fn === 'close_room')).toEqual([]);
  });

  it.each([
    ['unauthorized', /Só o dono/],
    ['throw', /Não foi possível encerrar/],
    ['permission denied for function close_room', /Não foi possível encerrar/],
  ])('erro %s: mensagem fixa, a chamada local não é encerrada', async (fault, message) => {
    const h = harness([room(1)]);
    await h.lobby.refresh();
    h.server.fail.set('close_room', fault);
    expect(await h.lobby.close(id(1))).toBe(false);
    expect(h.lobby.state.actionError).toMatch(message);
    expect(h.lobby.state.actionError).not.toMatch(/permission|function/);
    expect(h.closed).toEqual([]);
    expect(CLOSE_FAILED).toMatch(/Tente de novo/);
  });
});

// ---------- renderização ----------

/** Documento falso: só createElement/textContent/append. HTML dinâmico faz o teste falhar. */
class FakeEl {
  readonly tagName: string;
  children: FakeEl[] = [];
  private text = '';
  className = '';
  type = '';
  disabled = false;
  readonly attrs: Record<string, string> = {};
  private readonly listeners: Record<string, (() => void)[]> = {};
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.text = v;
    this.children = [];
  }
  set innerHTML(_v: string) {
    throw new Error('innerHTML proibido');
  }
  set outerHTML(_v: string) {
    throw new Error('outerHTML proibido');
  }
  insertAdjacentHTML(): void {
    throw new Error('insertAdjacentHTML proibido');
  }
  append(...nodes: FakeEl[]): void {
    for (const n of nodes) {
      if (!(n instanceof FakeEl)) throw new Error('só elementos');
      this.children.push(n);
    }
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  addEventListener(type: string, fn: () => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  click(): void {
    for (const fn of this.listeners['click'] ?? []) fn();
  }
  all(): FakeEl[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
  find(tag: string): FakeEl[] {
    return this.all().filter((e) => e.tagName === tag.toUpperCase());
  }
}
const fakeDoc = { createElement: (tag: string) => new FakeEl(tag) as unknown as HTMLElement };

function view(state: Partial<LobbyState>, opts: Partial<LobbyViewOptions> = {}) {
  const s: LobbyState = { status: 'ready', rooms: [], skipped: 0, listError: null, actionError: null, busy: null, ...state };
  const joined: string[] = [];
  const closing: string[] = [];
  const root = renderLobby(fakeDoc, s, { callActive: false, activeRoomId: null, onJoin: (r) => joined.push(r), onClose: (r) => closing.push(r), ...opts }) as unknown as FakeEl;
  const buttons = (label: RegExp) => root.find('button').filter((b) => label.test(b.textContent));
  return { root, joined, closing, buttons };
}

describe('renderLobby: só texto, estados e ações', () => {
  it('estados de carregamento, erro e lista vazia', () => {
    expect(view({ status: 'loading' }).root.textContent).toMatch(/Carregando salas/);
    expect(view({ status: 'error', listError: LIST_FAILED }).root.textContent).toContain(LIST_FAILED);
    expect(view({ status: 'ready', rooms: [] }).root.textContent).toMatch(/Nenhuma sala ainda/);
    expect(view({ status: 'ready', rooms: [closedRoom(1)] }).root.textContent).toMatch(/Nenhuma sala aberta/);
  });

  it('abertas primeiro, com papel e membros/capacidade; encerradas recolhidas (details) e sem ação', () => {
    const { root } = view({ rooms: [closedRoom(1, { name: 'Velha' }), room(2, { name: 'Nova', role: 'member', member_count: 2 })] });
    const top = root.children.map((c) => c.tagName);
    expect(top).toEqual(['P', 'UL', 'DETAILS']);
    expect(root.children[1]!.textContent).toMatch(/^Nova membro · 2\/2 membros · aberta/);
    const details = root.find('details')[0]!;
    expect(details.attrs['open']).toBeUndefined();
    expect(details.textContent).toMatch(/Salas encerradas \(1\)Velha dono · encerrada em/);
    expect(details.find('button')).toEqual([]);
  });

  it('"Encerrar sala" só para o dono; cliques chamam onJoin/onClose com o id', () => {
    const v = view({ rooms: [room(1), room(2, { role: 'member' })] });
    expect(v.buttons(/Encerrar sala/)).toHaveLength(1);
    v.buttons(/Encerrar sala/)[0]!.click();
    v.buttons(/Entrar na chamada/)[1]!.click();
    expect(v.closing).toEqual([id(1)]);
    expect(v.joined).toEqual([id(2)]);
  });

  it('chamada em curso: nenhuma entrada possível; a sala da chamada aparece como "Na chamada"', () => {
    const v = view({ rooms: [room(1), room(2)] }, { callActive: true, activeRoomId: id(1) });
    const joins = v.root.find('button').filter((b) => /Entrar na chamada|Na chamada/.test(b.textContent));
    expect(joins.map((b) => [b.textContent, b.disabled])).toEqual([['Na chamada', true], ['Entrar na chamada', true]]);
    // Encerrar a sala da própria chamada continua possível (a página sai da chamada depois).
    expect(v.buttons(/Encerrar sala/).every((b) => !b.disabled)).toBe(true);
  });

  it('operação em curso: entrar e encerrar desativados; a sala sendo encerrada mostra "Encerrando…"', () => {
    const v = view({ rooms: [room(1), room(2)], busy: { kind: 'close', roomId: id(1) } });
    expect(v.root.find('button').every((b) => b.disabled)).toBe(true);
    expect(v.buttons(/Encerrando…/)).toHaveLength(1);
  });

  it('nomes maliciosos são só texto: nenhum elemento além dos da lista, nenhum HTML interpretado', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const v = view({ rooms: [room(1, { name: evil }), closedRoom(2, { name: '<script>alert(2)</script>' })] });
    expect(v.root.find('strong').map((s) => s.textContent)).toEqual([evil, '<script>alert(2)</script>']);
    expect(v.root.find('img')).toEqual([]);
    expect(v.root.find('script')).toEqual([]);
    expect(new Set(v.root.all().map((e) => e.tagName))).toEqual(new Set(['DIV', 'P', 'UL', 'LI', 'STRONG', 'SPAN', 'BUTTON', 'DETAILS', 'SUMMARY']));
  });
});

describe('estático: nenhum HTML dinâmico no cliente', () => {
  it('src/web/*.ts não usa innerHTML, outerHTML, insertAdjacentHTML nem document.write', () => {
    const dir = fileURLToPath(new URL('../src/web/', import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files).toEqual(expect.arrayContaining(['main.ts', 'rooms.ts', 'rooms-view.ts']));
    for (const f of files) {
      const code = readFileSync(`${dir}${f}`, 'utf8').replace(/\/\/.*$/gm, '');
      expect(code, f).not.toMatch(/\b(innerHTML|outerHTML|insertAdjacentHTML)\b|document\.write/);
    }
  });
});

describe('M1: comprimento em pontos de código, como o char_length do PostgreSQL', () => {
  const emoji = '🎮'; // fora do BMP: 2 unidades UTF-16, 1 ponto de código
  it('nome da sala: exatamente 40 pontos de código passa; 41 não', () => {
    expect(emoji.length).toBe(2);
    expect(codePointLength(emoji.repeat(40))).toBe(40);
    expect(isRoomName(emoji.repeat(40))).toBe(true);
    expect(isRoomName(emoji.repeat(41))).toBe(false);
    expect(isRoomName(`${'a'.repeat(39)}${emoji}`)).toBe(true);
    expect(isRoomName(`${'a'.repeat(40)}${emoji}`)).toBe(false);
  });

  it('nome de exibição: exatamente 32 pontos de código passa; 33 não', () => {
    expect(isDisplayName(emoji.repeat(32))).toBe(true);
    expect(isDisplayName(emoji.repeat(33))).toBe(false);
    expect(isDisplayName('é'.repeat(32))).toBe(true);
    expect(isDisplayName('')).toBe(false);
  });

  it('formulário: aceita os limites exatos com emojis e recusa acima deles (com mensagem)', () => {
    expect(validateNewRoom(emoji.repeat(40), emoji.repeat(32))).toEqual({ ok: true, name: emoji.repeat(40), displayName: emoji.repeat(32) });
    expect(validateNewRoom(emoji.repeat(41), 'Ana')).toMatchObject({ ok: false, message: expect.stringMatching(/Nome da sala/) });
    expect(validateNewRoom('Sala', emoji.repeat(33))).toMatchObject({ ok: false, message: expect.stringMatching(/Seu nome/) });
  });

  it('o maxlength do HTML (unidades UTF-16) não corta um valor válido no banco: comporta o pior caso (2 por ponto de código)', () => {
    const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
    const max = (input: string) => Number(new RegExp(`id="${input}"[^>]*maxlength="(\\d+)"`).exec(html)![1]);
    expect(max('create-name')).toBeGreaterThanOrEqual(emoji.repeat(40).length);
    expect(max('create-display')).toBeGreaterThanOrEqual(emoji.repeat(32).length);
  });

  it('parsing e listagem de salas com nomes Unicode válidos (o caso que antes derrubava a lista)', async () => {
    const unicode = room(1, { name: emoji.repeat(40) });
    expect(parseRoomSummary(unicode)).toEqual(unicode);
    const h = harness([unicode, room(2, { name: 'Café ☕ 日本語' })]);
    await h.lobby.refresh();
    expect(h.lobby.state).toMatchObject({ status: 'ready', skipped: 0 });
    expect(h.lobby.state.rooms.map((r) => r.name)).toEqual([emoji.repeat(40), 'Café ☕ 日本語']);
    expect(view(h.lobby.state).root.find('strong').map((s) => s.textContent)).toEqual([emoji.repeat(40), 'Café ☕ 日本語']);
    expect(classifyDisconnect(id(1), { data: [unicode], error: null })).toBe('expired');
  });

  it('classificação: a linha da própria sala fora da regra não gera veredito; linha alheia fora da regra não impede', () => {
    const ok = (data: unknown[]): RpcResult<unknown[]> => ({ data, error: null });
    expect(classifyDisconnect(id(1), ok([{ ...closedRoom(1), name: 'a\u0000b' }]))).toBe('unknown');
    expect(classifyDisconnect(id(1), ok([closedRoom(1), { ...room(2), role: 'root' }]))).toBe('closed');
    expect(classifyDisconnect(id(1), ok([closedRoom(1), { room_id: id(2) }]))).toBe('unknown'); // estrutural
  });
});

describe('L1: operação da sessão anterior não mexe na sessão nova (logout no meio)', () => {
  /** Controlador com respostas liberadas à mão. */
  function gated() {
    const pending: { fn: string; resolve: (r: RpcResult<unknown>) => void }[] = [];
    const calls: string[] = [];
    const states: LobbyState[] = [];
    const closed: string[] = [];
    const lobby = new LobbyController({
      rpc: <T>(fn: string) => {
        calls.push(fn);
        return new Promise<RpcResult<T>>((resolve) => pending.push({ fn, resolve: resolve as (r: RpcResult<unknown>) => void }));
      },
      confirm: () => true,
      onChange: (s) => states.push(s),
      onClosed: (r) => void closed.push(r),
    });
    const release = async (fn: string, r: RpcResult<unknown>) => {
      const i = pending.findIndex((p) => p.fn === fn);
      expect(i, `${fn} pendente`).toBeGreaterThanOrEqual(0);
      pending.splice(i, 1)[0]!.resolve(r);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { lobby, calls, states, closed, release };
  }

  it('criação respondida depois do logout: nada de estado, mensagem, recarga; o próximo login começa limpo', async () => {
    const g = gated();
    const creating = g.lobby.create('Sala', 'Ana');
    expect(g.lobby.state.busy).toEqual({ kind: 'create' });
    g.lobby.reset(); // logout
    const after = g.states.length;
    await g.release('create_room', { data: null, error: 'limit-reached' });
    expect(await creating).toBeNull();
    expect(g.states.length).toBe(after); // nenhuma mudança de estado depois do reset
    expect(g.lobby.state).toMatchObject({ status: 'idle', busy: null, actionError: null, rooms: [] });
    expect(g.calls).toEqual(['create_room']); // nenhuma recarga disparada
    // Próximo login: carga normal, sem resíduo da sessão anterior.
    const loading = g.lobby.refresh();
    await g.release('list_my_rooms', { data: [room(5)], error: null });
    await loading;
    expect(g.lobby.state).toMatchObject({ status: 'ready', actionError: null, busy: null });
    expect(g.lobby.state.rooms.map((r) => r.room_id)).toEqual([id(5)]);
  });

  it('criação bem-sucedida respondida depois do logout também é ignorada', async () => {
    const g = gated();
    const creating = g.lobby.create('Sala', 'Ana');
    g.lobby.reset();
    await g.release('create_room', { data: id(8), error: null });
    expect(await creating).toBeNull();
    expect(g.calls).toEqual(['create_room']);
    expect(g.lobby.state.status).toBe('idle');
  });

  it('encerramento respondido depois do logout: sem onClosed, sem mensagem, sem recarga; novo login pode agir', async () => {
    const g = gated();
    const loading = g.lobby.refresh();
    await g.release('list_my_rooms', { data: [room(1)], error: null });
    await loading;
    const closing = g.lobby.close(id(1));
    expect(g.lobby.state.busy).toEqual({ kind: 'close', roomId: id(1) });
    g.lobby.reset();
    const after = g.states.length;
    await g.release('close_room', { data: null, error: 'unauthorized' });
    expect(await closing).toBe(false);
    expect(g.closed).toEqual([]);
    expect(g.states.length).toBe(after);
    expect(g.calls).toEqual(['list_my_rooms', 'close_room']);
    // Na sessão nova, nada fica "ocupado": criar funciona.
    const creating = g.lobby.create('Outra', 'Bia');
    expect(g.lobby.state.busy).toEqual({ kind: 'create' });
    await g.release('create_room', { data: id(9), error: null });
    await g.release('list_my_rooms', { data: [room(9)], error: null });
    expect(await creating).toBe(id(9));
  });

  it('encerramento aceito, logout durante o onClosed: nada é gravado depois', async () => {
    let finishClosed!: () => void;
    const states: LobbyState[] = [];
    const calls: string[] = [];
    const lobby = new LobbyController({
      rpc: async <T>(fn: string): Promise<RpcResult<T>> => {
        calls.push(fn);
        return { data: (fn === 'list_my_rooms' ? [room(1)] : '2026-10-28T14:00:00Z') as T, error: null };
      },
      confirm: () => true,
      onChange: (s) => states.push(s),
      onClosed: () => new Promise<void>((resolve) => (finishClosed = resolve)),
    });
    await lobby.refresh();
    const closing = lobby.close(id(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    lobby.reset();
    const after = states.length;
    finishClosed();
    expect(await closing).toBe(false);
    expect(states.length).toBe(after);
    expect(calls).toEqual(['list_my_rooms', 'close_room']);
  });
});

describe('Frente A: apresentação das desconexões', () => {
  const tech4403 = formatCallError('Conexão com a sinalização perdida (código 4403).', 'a sessão na sala deixou de valer');

  it('formatCallError: sem pontuação dupla; sem detalhe, a mensagem fica como está', () => {
    expect(tech4403).toBe('Conexão com a sinalização perdida (código 4403): a sessão na sala deixou de valer.');
    expect(tech4403).not.toMatch(/\)\.\s*—/);
    expect(formatCallError('Permissão do microfone negada.')).toBe('Permissão do microfone negada.');
  });

  it('matriz do 4403: encerrada e expirada viram informação sem código; sem participação e desconhecido são erro', () => {
    expect(describeDisconnect(SESSION_GONE_CODE, 'closed', tech4403)).toEqual({ tone: 'info', text: 'A sala foi encerrada pelo dono.' });
    expect(describeDisconnect(SESSION_GONE_CODE, 'expired', tech4403)).toEqual({ tone: 'info', text: 'Sua sessão na sala expirou. Entre de novo.' });
    expect(describeDisconnect(SESSION_GONE_CODE, 'not-member', tech4403)).toEqual({ tone: 'error', text: 'Esta conta não participa mais desta sala.' });
    const unknown = describeDisconnect(SESSION_GONE_CODE, 'unknown', tech4403);
    expect(unknown.tone).toBe('error');
    expect(unknown.text).toContain('código 4403');
    expect(unknown.text).toContain('Não foi possível confirmar o motivo agora.');
    for (const kind of ['closed', 'expired'] as const) expect(describeDisconnect(SESSION_GONE_CODE, kind, tech4403).text).not.toMatch(/4403|código/);
  });

  it('4401, 4408 e 4500: erro com o texto técnico de sempre, qualquer que seja a classificação', () => {
    for (const [code, detail] of [
      [4401, 'autenticação recusada pelo servidor (faça login de novo)'],
      [4408, 'o batimento da sessão falhou repetidamente'],
      [4500, 'o canal privado foi fechado pelo servidor'],
    ] as const) {
      const technical = formatCallError(`Conexão com a sinalização perdida (código ${code}).`, detail);
      for (const kind of ['closed', 'expired', 'not-member', 'unknown'] as const) {
        expect(describeDisconnect(code, kind, technical), `${code} ${kind}`).toEqual({ tone: 'error', text: technical });
      }
    }
  });

  it('supressão: só quando ESTA aba está encerrando a sala da chamada (mesma semântica de antes)', () => {
    expect(isClosingOwnCall({ kind: 'close', roomId: id(1) }, id(1))).toBe(true);
    expect(isClosingOwnCall({ kind: 'close', roomId: id(2) }, id(1))).toBe(false);
    expect(isClosingOwnCall({ kind: 'create' }, id(1))).toBe(false);
    expect(isClosingOwnCall({ kind: 'refresh' }, id(1))).toBe(false);
    expect(isClosingOwnCall(null, id(1))).toBe(false);
    expect(isClosingOwnCall({ kind: 'close', roomId: id(1) }, null)).toBe(false);
  });

  it('explainDisconnect: classifica pela lista e mostra; consulta com falha não dá veredito (erro técnico)', async () => {
    const shown: Notice[] = [];
    const run = (res: RpcResult<unknown[]> | 'throw') =>
      explainDisconnect(id(1), tech4403, {
        listRooms: async () => {
          if (res === 'throw') throw new Error('rede');
          return res;
        },
        isCurrent: () => true,
        show: (n) => shown.push(n),
      });
    expect(await run({ data: [closedRoom(1)], error: null })).toEqual({ tone: 'info', text: 'A sala foi encerrada pelo dono.' });
    expect(await run({ data: [room(1)], error: null })).toMatchObject({ tone: 'info' });
    expect(await run({ data: [], error: null })).toMatchObject({ tone: 'error', text: 'Esta conta não participa mais desta sala.' });
    expect((await run({ data: null, error: 'erro' }))!.text).toContain('código 4403');
    expect((await run('throw'))!.text).toContain('código 4403');
    expect(shown).toHaveLength(5);
  });

  it('resultado obsoleto: se a chamada mudou durante a consulta, nada é mostrado', async () => {
    let current = true;
    let release!: (r: RpcResult<unknown[]>) => void;
    const shown: Notice[] = [];
    const pending = explainDisconnect(id(1), tech4403, {
      listRooms: () => new Promise((resolve) => (release = resolve)),
      isCurrent: () => current,
      show: (n) => shown.push(n),
    });
    current = false; // nova chamada, logout ou outra desconexão explicada no meio
    release({ data: [closedRoom(1)], error: null });
    expect(await pending).toBeNull();
    expect(shown).toEqual([]);
  });

  it('o aviso pendente é informação, não erro', () => {
    expect(DISCONNECT_CHECKING).toEqual({ tone: 'info', text: 'Verificando o motivo…' });
  });
});
