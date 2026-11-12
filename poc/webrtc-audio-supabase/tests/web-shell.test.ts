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

  it('criar sala é um modal: sem nome por sala, sem "Você entra como", com X, Cancelar e Criar sala', () => {
    expect(html).not.toMatch(/<section id="create-room"/); // nada fixo em "Minhas salas"
    const dialog = /<dialog id="create-dialog"[^]*?<\/dialog>/.exec(html)![0];
    expect(dialog).toMatch(/<dialog id="create-dialog" class="identity-panel create-dialog" aria-labelledby="create-room-title"[^>]*hidden>/);
    expect(dialog).not.toMatch(/create-display|Seu nome na sala|create-identity|Você entra como|Alterar no perfil/);
    expect(dialog).toMatch(/id="create-name"/);
    expect(dialog).toMatch(/<select id="create-capacity">\s*<option value="2" selected>2<\/option>\s*<option value="3">3<\/option>\s*<option value="4">4<\/option>\s*<\/select>/);
    expect(dialog).toMatch(/<button id="create-close-btn"[^>]*type="button" aria-label="Fechar">/);
    expect(dialog).toMatch(/<button id="create-cancel-btn"[^>]*type="button">Cancelar<\/button>\s*<button id="create-btn" type="submit">Criar sala<\/button>/);
    expect(dialog).toMatch(/id="create-error" class="error" role="alert"/);
    expect(main).not.toMatch(/createDisplay|create-display|createIdentityText|ui\.createRoom\b/);
    // Envio: sempre o nome global; nada sem ele nem em duplicidade (o contrato p_display_name do create_room não muda).
    expect(main).toMatch(/if \(globalName === null \|\| creating\(\)\) return;[^\n]*\n[^\n]*\n\s*void lobby\.create\(ui\.createName\.value, globalName, Number\(ui\.createCapacity\.value\)\)/);
    expect(fn('renderCreateIdentity')).toContain('ui.createBtn.disabled = busy || globalName === null');
    expect(fn('renderCreateIdentity')).toContain('ui.createMissingName.hidden = globalName !== null');
    // Sem nome global: orienta e leva ao Perfil existente, fora do modal (nenhum editor novo).
    expect(dialog).toMatch(/<div id="create-missing-name"[^>]*hidden>[^]*Defina seu nome de exibição no Perfil[^]*<button id="create-profile-btn"[^>]*type="button">Abrir Perfil<\/button>/);
    expect(main).toContain("ui.createProfileBtn.addEventListener('click', () => { closeCreate(false); ui.profileOpen.click(); })");
    expect(fn('applyIdentity')).toContain('renderCreateIdentity()');
    expect(fn('showLoggedOut')).toContain('renderCreateIdentity()');
    expect(fn('renderRooms')).toContain('renderCreateIdentity()');
    expect(fn('identityNote')).not.toMatch(/innerHTML/); // o convite segue com a linha de identidade, em texto
  });

  it('modal de criação: abre por qualquer "Criar sala", fecha por X/Cancelar/Escape/fora, sem fechar durante o envio', () => {
    expect(main).toContain("ui.createOpenBtn.addEventListener('click', () => openCreate(ui.createOpenBtn))");
    expect(main).toContain("ui.createEmptyBtn.addEventListener('click', () => openCreate(ui.createEmptyBtn))");
    const open = fn('openCreate');
    expect(open).toContain('createOpener = opener');
    expect(open).toContain('ui.createDialog.showModal()');
    expect(open).toContain('ui.createName.focus()');
    // Gaveta aberta deixa o conteúdo (onde o modal mora) inerte: fecha antes e devolve o foco ao "Menu".
    expect(open).toMatch(/if \(shell\.state\.drawerOpen\) \{\n\s*shell\.closeDrawer\(\);\n\s*opener = ui\.shellMenuBtn;/);
    expect(open.indexOf('shell.closeDrawer()')).toBeLessThan(open.indexOf('ui.createDialog.showModal()'));
    const close = fn('closeCreate');
    expect(close).toContain('if (!ui.createDialog.open || creating()) return;');
    expect(close).toContain('lobby.clearActionError()');
    expect(close).toContain('opener.focus()');
    expect(close).toContain('ui.contextTitle.focus()');
    expect(main).toContain("ui.createCancelBtn.addEventListener('click', () => closeCreate())");
    expect(main).toContain("ui.createCloseBtn.addEventListener('click', () => closeCreate())");
    expect(main).toContain("ui.createDialog.addEventListener('cancel', (event) => { event.preventDefault(); closeCreate(); })");
    expect(main).toMatch(/ui\.createDialog\.addEventListener\('click', \(event\) => \{\n  if \(event\.target !== ui\.createDialog\) return;[^]*?if \(outside\) closeCreate\(\);/);
    // Tab preso ao modal; Escape global não age nos painéis de fundo com o modal aberto.
    expect(main).toMatch(/ui\.createDialog\.addEventListener\('keydown', \(event\) => \{\n  if \(event\.key !== 'Tab'\) return;/);
    expect(main).toContain('if (ui.profilePanel.open || ui.createDialog.open || ui.channelDialog.open || ui.inviteShare.open) return;');
    // Durante o envio: botões de fechar desabilitados; erros do create_room aparecem no modal, não atrás dele.
    const render = fn('renderRooms');
    expect(render).toContain('ui.createCancelBtn.disabled = busy');
    expect(render).toContain('ui.createCloseBtn.disabled = busy');
    expect(render).toContain("ui.createError.textContent = inDialog ? s.actionError ?? '' : ''");
    expect(render).toContain('ui.roomsError.hidden = inDialog || s.actionError === null');
    // Sucesso: fecha e segue a navegação atual (sala nova em destaque).
    expect(main).toMatch(/closeCreate\(false\);\n\s*navigate\(id\);/);
  });

  it('aceitar convite não pede nome por sala: usa o nome global e, sem ele, o convite espera nesta aba', () => {
    const section = /<section id="invite-accept"[^]*?<\/section>/.exec(html)![0];
    expect(section).not.toMatch(/invite-display|Seu nome na sala|<input/);
    expect(section).toMatch(/id="invite-identity-text"/);
    expect(section).toMatch(/<button id="invite-profile-btn"[^>]*type="button"/);
    expect(main).not.toMatch(/inviteDisplay|invite-display/);
    expect(main).toMatch(/if \(globalName === null\) return;[^\n]*\n\s*void inviteAccept\.accept\(globalName\);/);
    const render = fn('renderInviteAccept');
    expect(render).toContain('ui.inviteAcceptBtn.disabled = busy || globalName === null');
    expect(render).toContain('ui.inviteDeclineBtn.disabled = busy'); // recusar continua possível sem nome
    expect(render).toContain('identityNote(ui.inviteIdentityText, ui.inviteProfileBtn,');
    expect(render).toContain('O convite continua nesta aba.');
    expect(main).toContain("ui.inviteProfileBtn.addEventListener('click', () => ui.profileOpen.click())");
    // Salvar o nome no Perfil libera o convite pendente sem recarregar.
    expect(fn('applyIdentity')).toContain('renderInviteAccept(inviteAccept.state)');
  });

  it('sem nenhuma sala, "Minhas salas" mostra só um botão "Criar sala" (o formulário fica no modal)', () => {
    expect(html).toMatch(/<div id="rooms"><\/div>\s*<button id="create-empty-btn" type="button" hidden>Criar sala<\/button>/);
    const render = fn('renderRooms');
    expect(render).toContain("const noRooms = s.status === 'ready' && s.rooms.length === 0");
    expect(render).toContain('ui.createEmptyBtn.hidden = selectedRoomId !== null || !noRooms');
  });

  it('abrir uma sala mostra o texto padrão dela (Midnight), sem trocar o chat com mensagem pendente', () => {
    const nav = fn('navigate');
    expect(nav).toContain('const changed = roomId !== shell.state.selectedRoomId;');
    expect(nav).toMatch(/if \(room && changed\) \{\n\s*selectedVoiceId = null;\n\s*showText\(room\.room_id\);/);
    expect(nav).not.toMatch(/startCall|endCall|beginCall|setMuted/);
    const text = fn('showText');
    expect(text).toContain("centerKind = 'text';");
    expect(text).toContain('chat.state.pending.length === 0');
    expect(text).toContain('chat.open(roomId, !room.is_open, channelId)');
    expect(text).toContain('members.open(roomId, room.name, !room.is_open)');
  });

  it('logout esquece criação e administração abertas', () => {
    expect(main).toMatch(/if \(ui\.createDialog\.open\) ui\.createDialog\.close\(\);[^\n]*\n  ui\.createDialog\.hidden = true;\n  createOpener = null;\n  adminOpen\.clear\(\);\n  shell\.reset\(\);/);
  });
});

describe('I-2: canais do espaço na navegação', () => {
  const html = read('index.html');
  const main = read('src/web/main.ts');
  const fn = (name: string): string => new RegExp(`function ${name}[^]*?\n}\n`).exec(main)![0];

  it('a barra lateral tem só a lista de canais; criar canal é um modal fora da lista redesenhada, oculto no início', () => {
    const nav = /<section id="channel-nav"[^]*?<\/section>/.exec(html)![0];
    expect(nav).toMatch(/<section id="channel-nav" class="channel-nav label-full" aria-label="Canais do espaço" hidden>/);
    expect(nav).toMatch(/<div id="channel-list"><\/div>\s*<\/section>/);
    expect(nav).not.toContain('channel-create-form');
    expect(html.indexOf('id="room-nav"')).toBeLessThan(html.indexOf('id="channel-nav"'));
    const dialog = /<dialog id="channel-dialog"[^]*?<\/dialog>/.exec(html)![0];
    expect(dialog).toMatch(/^<dialog id="channel-dialog" class="[^"]*" aria-labelledby="channel-dialog-title"[^>]*hidden>/);
    expect(dialog).toMatch(/<legend>Tipo do canal<\/legend>/);
    expect(dialog).toMatch(/<input id="channel-kind-text" type="radio" name="channel-kind" value="text" checked \/>/);
    expect(dialog).toMatch(/<input id="channel-kind-voice" type="radio" name="channel-kind" value="voice" \/>/);
    expect(dialog).toMatch(/<input id="channel-create-name" type="text" maxlength="80"[^>]*required/);
    expect(dialog).toMatch(/<p id="channel-create-error" class="error" role="alert" hidden><\/p>/);
    expect(dialog).toMatch(/<button id="channel-cancel-btn" class="ghost-btn" type="button">Cancelar<\/button>\s*<button id="channel-create-btn" type="submit" disabled>Criar canal<\/button>/);
    expect(html.indexOf('id="channel-dialog"')).toBeGreaterThan(html.indexOf('id="shell-main"')); // no conteúdo, como o "Criar sala"
  });

  it('modal de canal: tipo da seção, foco no nome, nome válido para enviar, Esc/×/Cancelar devolvem o foco ao "+"', () => {
    const open = fn('openChannelCreate');
    expect(open).toContain("ui.channelKindText.checked = kind === 'text';");
    expect(open).toContain("ui.channelKindVoice.checked = kind === 'voice';");
    expect(open).toContain('ui.channelDialog.showModal();');
    expect(open.indexOf('ui.channelDialog.showModal();')).toBeLessThan(open.indexOf('ui.channelCreateName.focus();'));
    const render = fn('renderChannelDialog');
    expect(render).toContain('ui.channelCreateBtn.disabled = busy || !isChannelName(ui.channelCreateName.value);');
    expect(render).toContain('ui.channelCancelBtn.disabled = busy;');
    expect(render).toContain("setMessage(ui.channelCreateError, message?.tone === 'error' ? message : null);");
    const close = fn('closeChannelCreate');
    expect(close).toContain('if (!ui.channelDialog.open || channelCreating()) return;');
    expect(close).toContain('[data-create-kind="${kind}"]');
    expect(main).toContain("ui.channelCancelBtn.addEventListener('click', () => closeChannelCreate())");
    expect(main).toContain("ui.channelCloseBtn.addEventListener('click', () => closeChannelCreate())");
    expect(main).toContain("ui.channelDialog.addEventListener('cancel', (event) => { event.preventDefault(); closeChannelCreate(); })");
    // Erro: o modal segue aberto com o nome e o tipo; sucesso: fecha e o texto novo abre no centro.
    expect(main).toMatch(/if \(id === null\) \{\n\s*\/\/ Erro[^\n]*\n\s*renderChannelDialog\(\);\n\s*ui\.channelCreateName\.focus\(\);\n\s*return;/);
    expect(main).toMatch(/closeChannelCreate\(false\);\n[^\n]*\n\s*if \(kind === 'text' && roomId !== null && channels\.state\.roomId === roomId\) openChannelChat\(roomId, id\);/);
  });

  it('selecionar um espaço abre os canais dele; voltar à visão geral fecha', () => {
    const nav = fn('navigate');
    expect(nav).toContain('if (roomId === null) channels?.close();');
    expect(nav).toContain('else channels?.open(roomId);');
    expect(fn('renderRooms')).toContain('renderChannels();');
  });

  it('só o dono de um espaço aberto vê criar e arquivar; o servidor confere de novo', () => {
    const render = fn('renderChannels');
    expect(render).toContain("const canManage = room.role === 'owner' && room.is_open;");
    expect(render).toContain('if (ui.channelDialog.open && !canManage && !channelCreating()) closeChannelCreate(false);');
    expect(render).toContain('canManage,');
    expect(render).toContain('onCreate: (kind) => openChannelCreate(kind),');
    expect(main).toContain('if (!ui.channelDialog.open || ui.channelCreateBtn.disabled || channelCreating()) return;');
  });

  it('voz por canal: o canal escolhido chega ao MeshSignaling; as repetições da entrada mantêm o canal', () => {
    expect(fn('renderChannels')).toMatch(/onJoinVoice: \(channelId\) => \{\n\s*closeDrawer\(\);[^\n]*\n\s*startCall\(room\.room_id, channelId\);/);
    expect(main).toMatch(/function startCall\(roomInput: string, channelId: string \| null = null\): void/);
    expect(fn('startCall')).toContain('beginCall(roomId, userId, channelId)');
    expect(fn('beginCall')).toContain('callChannelId = channelId;');
    expect(main).toContain('signaling = new MeshSignaling({ backend, roomId, channelId, selfUserId: userId, events,');
    expect(main).toContain('if (roomId) startCall(roomId, entryChannelId);');
  });

  it('texto por canal: o canal padrão segue pelo caminho antigo; os outros pelas RPCs de canal', () => {
    const open = fn('openChannelChat');
    expect(open).toContain("const target = defaultChannel(channels.state.channels, 'text')?.channel_id === channelId ? null : channelId;");
    expect(open).toContain('showText(roomId, target);');
    expect(fn('showText')).toContain('chat.open(roomId, !room.is_open, channelId);');
    expect(fn('renderChat')).toContain('ui.chatRoom.textContent = chatChannel ? `#${chatChannel.name}` : chatRoomName;');
  });

  it('logout fecha os canais e esquece o canal da chamada e da entrada', () => {
    const out = fn('showLoggedOut');
    expect(out).toContain('channels.close();');
    expect(out).toContain('callChannelId = null;');
    expect(out).toContain('entryChannelId = null;');
  });
});
