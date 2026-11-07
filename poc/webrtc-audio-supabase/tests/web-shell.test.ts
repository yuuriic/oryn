// Navegação da interface: estado da barra lateral, salas na barra e filtro da área central.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { RoomSummary } from '../src/contracts.ts';
import type { LobbyState } from '../src/web/rooms.ts';
import { renderLobby, renderRoomNav, roomContext } from '../src/web/rooms-view.ts';
import { ShellController, roomInitials } from '../src/web/shell.ts';

const read = (path: string): string => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

const ROOM_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ROOM_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const CLOSED = 'cccccccc-0000-4000-8000-000000000003';

const room = (room_id: string, name: string, over: Partial<RoomSummary> = {}): RoomSummary => ({
  room_id,
  name,
  role: 'owner',
  is_open: true,
  closed_at: null,
  member_count: 1,
  max_members: 3,
  created_at: '2026-11-01T10:00:00+00:00',
  ...over,
});

const state = (over: Partial<LobbyState> = {}): LobbyState => ({
  status: 'ready',
  rooms: [room(ROOM_A, 'Sala Principal'), room(ROOM_B, 'Outra', { role: 'member' }), room(CLOSED, 'Antiga', { is_open: false, closed_at: '2026-11-02T10:00:00+00:00' })],
  skipped: 0,
  listError: null,
  actionError: null,
  busy: null,
  ...over,
});

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
  append(...nodes: FakeEl[]): void {
    this.children.push(...nodes);
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  addEventListener(type: string, fn: () => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  click(): void {
    this.dispatch('click');
  }
  /** Estado de um <details>, como o navegador o mantém. */
  open = false;
  dispatch(type: string): void {
    for (const fn of this.listeners[type] ?? []) fn();
  }
  all(): FakeEl[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
  find(tag: string): FakeEl[] {
    return this.all().filter((e) => e.tagName === tag.toUpperCase());
  }
}
const fakeDoc = { createElement: (tag: string) => new FakeEl(tag) as unknown as HTMLElement };

const nav = (s: LobbyState, over: Partial<Parameters<typeof renderRoomNav>[2]> = {}) => {
  const onSelect = vi.fn();
  const root = renderRoomNav(fakeDoc, s, { selectedRoomId: null, activeRoomId: null, onSelect, ...over }) as unknown as FakeEl;
  return { root, onSelect, links: root.find('button') };
};

const lobby = (s: LobbyState, selectedRoomId: string | null) => {
  const onJoin = vi.fn();
  const root = renderLobby(fakeDoc, s, { callActive: false, activeRoomId: null, onJoin, onClose: vi.fn(), selectedRoomId, onChat: vi.fn(), onMembers: vi.fn(), onInvite: vi.fn(), onRevokeInvites: vi.fn() }) as unknown as FakeEl;
  return { root, onJoin };
};

describe('ShellController', () => {
  it('começa expandida, na visão geral, com a navegação temporária fechada', () => {
    expect(new ShellController(() => {}).state).toEqual({ collapsed: false, drawerOpen: false, selectedRoomId: null });
  });

  it('recolhe e expande, avisando a cada mudança', () => {
    const onChange = vi.fn();
    const shell = new ShellController(onChange);
    shell.toggleCollapsed();
    expect(shell.state.collapsed).toBe(true);
    shell.toggleCollapsed();
    expect(shell.state.collapsed).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('selecionar uma sala preserva o estado da barra e fecha a navegação temporária', () => {
    const shell = new ShellController(() => {});
    shell.toggleCollapsed();
    shell.openDrawer();
    shell.select(ROOM_A);
    expect(shell.state).toEqual({ collapsed: true, drawerOpen: false, selectedRoomId: ROOM_A });
    shell.select(null);
    expect(shell.state.selectedRoomId).toBeNull();
  });

  it('fechar a navegação já fechada não redesenha', () => {
    const onChange = vi.fn();
    new ShellController(onChange).closeDrawer();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('sala que saiu da lista deixa de estar selecionada, sem avisar quem está desenhando', () => {
    const onChange = vi.fn();
    const shell = new ShellController(onChange);
    shell.select(ROOM_A);
    onChange.mockClear();
    shell.reconcile([ROOM_B]);
    expect(shell.state.selectedRoomId).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    shell.select(ROOM_B);
    shell.reconcile([ROOM_B]);
    expect(shell.state.selectedRoomId).toBe(ROOM_B);
  });

  it('sair da conta volta ao estado inicial', () => {
    const shell = new ShellController(() => {});
    shell.toggleCollapsed();
    shell.select(ROOM_A);
    shell.reset();
    expect(shell.state).toEqual({ collapsed: false, drawerOpen: false, selectedRoomId: null });
  });
});

describe('roomInitials', () => {
  it.each([
    ['Sala Principal', 'SP'],
    ['oryn', 'O'],
    ['  duas   palavras a mais ', 'DP'],
    ['água fria', 'ÁF'],
    ['🎮 jogo', '🎮J'],
    ['👨‍👩‍👧 casa', '👨‍👩‍👧C'],
    ['', ''],
  ])('%s vira %s', (name, expected) => {
    expect(roomInitials(name)).toBe(expected);
  });
});

describe('renderRoomNav', () => {
  it('abrir uma sala só avisa a seleção: nada de entrar na chamada', () => {
    const { links, onSelect } = nav(state());
    expect(links).toHaveLength(2);
    links[0]!.click();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(ROOM_A);
  });

  it('o nome completo fica acessível também com a barra recolhida', () => {
    const { links } = nav(state());
    expect(links[0]!.attrs).toMatchObject({ title: 'Sala Principal', 'data-name': 'Sala Principal' });
    expect(links[0]!.attrs['aria-label']).toBe('Sala Principal, dono, aberta');
    expect(links[0]!.find('span')[0]!.attrs['aria-hidden']).toBe('true');
    expect(links[0]!.textContent).toContain('SP');
  });

  it('marca a sala selecionada e a da chamada, sem depender de cor', () => {
    const { links } = nav(state(), { selectedRoomId: ROOM_B, activeRoomId: ROOM_A });
    expect(links[1]!.attrs['aria-current']).toBe('true');
    expect(links[0]!.attrs['aria-current']).toBeUndefined();
    expect(links[0]!.textContent).toContain('na chamada');
    expect(links[0]!.attrs['aria-label']).toContain('na chamada');
  });

  it('lista só as salas abertas: nenhuma encerrada na navegação', () => {
    const { root, links } = nav(state());
    expect(links.map((l) => l.attrs['data-name'])).toEqual(['Sala Principal', 'Outra']);
    expect(root.textContent).not.toMatch(/Antiga|Encerradas/);
    expect(links.every((l) => !l.className.includes('room-closed'))).toBe(true);
  });

  it('sem sala aberta, diz isso em vez de ficar vazia', () => {
    const closedOnly = state({ rooms: state().rooms.filter((r) => !r.is_open) });
    expect(nav(closedOnly).links).toHaveLength(0);
    expect(nav(closedOnly).root.textContent).toContain('Nenhuma sala aberta');
  });

  it('mostra carregamento e erro, e nome de sala nunca vira HTML', () => {
    expect(nav(state({ status: 'loading', rooms: [] })).root.textContent).toContain('Carregando');
    expect(nav(state({ status: 'error', rooms: [] })).root.textContent).toContain('indisponível');
    const hostile = '<img src=x onerror=alert(1)>';
    expect(nav(state({ rooms: [room(ROOM_A, hostile)] })).links[0]!.textContent).toContain(hostile);
  });
});

describe('área central', () => {
  it('sem seleção, todas as salas; com seleção, só a escolhida e com as mesmas ações', () => {
    const texts = (r: FakeEl) => r.find('button').map((b) => b.textContent);
    const all = lobby(state(), null);
    expect(all.root.find('strong').map((s) => s.textContent)).toEqual(['Sala Principal', 'Outra', 'Antiga']);
    const one = lobby(state(), ROOM_A);
    expect(one.root.find('strong').map((s) => s.textContent)).toEqual(['Sala Principal']);
    expect(texts(one.root)).toEqual(['Entrar na chamada', 'Abrir chat', 'Membros', 'Convidar', 'Revogar convites pendentes desta sala', 'Encerrar sala']);
    expect(one.onJoin).not.toHaveBeenCalled();
  });

  it('a administração do dono fica recolhida em "Gerenciar sala", depois das ações principais', () => {
    const one = lobby(state(), ROOM_A);
    const [admin, ...others] = one.root.find('details');
    expect(others).toHaveLength(0);
    expect(admin!.className).toBe('room-admin');
    expect(admin!.find('summary')[0]!.textContent).toBe('Gerenciar sala');
    expect(admin!.find('button').map((b) => b.textContent)).toEqual(['Convidar', 'Revogar convites pendentes desta sala', 'Encerrar sala']);
    expect(admin!.attrs['open']).toBeUndefined();
  });

  it('o redesenho mantém "Gerenciar sala" aberto e avisa quem o abriu ou fechou', () => {
    const onAdminToggle = vi.fn();
    const root = renderLobby(fakeDoc, state(), { selectedRoomId: ROOM_A, callActive: false, activeRoomId: null, onJoin: vi.fn(), onClose: vi.fn(), onInvite: vi.fn(), onRevokeInvites: vi.fn(), onChat: vi.fn(), onMembers: vi.fn(), adminOpenRoomIds: new Set([ROOM_A]), onAdminToggle }) as unknown as FakeEl;
    const admin = root.find('details')[0]!;
    expect(admin.attrs['open']).toBe('');
    admin.open = false;
    admin.dispatch('toggle');
    admin.open = true;
    admin.dispatch('toggle');
    expect(onAdminToggle.mock.calls).toEqual([[ROOM_A, false], [ROOM_A, true]]);
  });

  it('membro não vê "Gerenciar sala"', () => {
    const one = lobby(state(), ROOM_B);
    expect(one.root.find('details')).toHaveLength(0);
  });

  it('sala encerrada selecionada aparece sem precisar abrir nada, e sem ação de chamada', () => {
    const { root } = lobby(state(), CLOSED);
    expect(root.find('details')).toHaveLength(0);
    expect(root.find('strong').map((s) => s.textContent)).toEqual(['Antiga']);
    expect(root.find('button').map((b) => b.textContent)).toEqual(['Ver mensagens', 'Membros']);
  });

  it('o cabeçalho acompanha a seleção', () => {
    expect(roomContext(state(), null)).toEqual({ title: 'Minhas salas', detail: null });
    expect(roomContext(state(), ROOM_A)).toEqual({ title: 'Sala Principal', detail: 'dono · 1/3 membros · aberta' });
    expect(roomContext(state(), CLOSED).detail).toMatch(/^dono · encerrada em /);
    expect(roomContext(state(), 'sumiu')).toEqual({ title: 'Minhas salas', detail: null });
    // Sala da chamada: o cabeçalho diz "Em chamada"; outra sala selecionada segue com o papel.
    expect(roomContext(state(), ROOM_A, ROOM_A)).toEqual({ title: 'Sala Principal', detail: 'Em chamada · 1/3 membros' });
    expect(roomContext(state(), ROOM_A, 'outra')).toEqual({ title: 'Sala Principal', detail: 'dono · 1/3 membros · aberta' });
    expect(roomContext(state(), CLOSED, CLOSED).detail).toMatch(/^dono · encerrada em /);
  });
});

describe('limites do módulo de navegação', () => {
  const shellCode = read('src/web/shell.ts');

  it('o estado fica só em memória', () => {
    expect(shellCode).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
  });

  it('não conhece voz, microfone nem backend', () => {
    expect(shellCode).not.toMatch(/^import /m);
    expect(shellCode).not.toMatch(/getUserMedia|\.rpc\(|createClient|supabase/);
  });

  it('a página não usa biblioteca de ícones nem imagem externa', () => {
    const html = read('index.html');
    expect(html).not.toMatch(/<img\b|<link\b(?![^>]*\/src\/web\/style\.css)/);
  });
});

describe('Hybrid Midnight Gold: criação sob demanda e chat contextual', () => {
  const html = read('index.html');
  const main = read('src/web/main.ts');
  const fn = (name: string): string => new RegExp(`function ${name}[^]*?\n}\n`).exec(main)![0];

  it('criar sala começa oculto, com Cancelar, e só abre por "Criar sala" ou sem nenhuma sala', () => {
    expect(html).toMatch(/<section id="create-room" hidden>/);
    expect(html).toMatch(/id="create-cancel-btn"/);
    const render = fn('renderRooms');
    expect(render).toContain("const noRooms = s.status === 'ready' && s.rooms.length === 0");
    expect(render).toContain('ui.createRoom.hidden = selectedRoomId !== null || !(createOpen || noRooms)');
    expect(main).toMatch(/ui\.createOpenBtn\.addEventListener\('click', \(\) => \{\n  createOpen = true;/);
  });

  it('o chat aberto acompanha a sala escolhida, sem trocar com mensagem pendente e sem abrir sozinho', () => {
    const nav = fn('navigate');
    expect(nav).toContain("chat.state.status !== 'closed'");
    expect(nav).toContain('chat.state.pending.length === 0');
    expect(nav).toContain('chat.open(room.room_id, !room.is_open)');
  });

  it('logout esquece criação e administração abertas', () => {
    expect(main).toMatch(/createOpen = false;\n  adminOpen\.clear\(\);\n  shell\.reset\(\);/);
  });
});
