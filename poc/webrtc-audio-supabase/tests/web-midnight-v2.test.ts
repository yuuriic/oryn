// Midnight V2: barra global de salas + lateral contextual de canais, responsividade e acabamento. A navegação reaproveita
// os mesmos ids e controladores; aqui se confere a estrutura, as regras de layout e as decisões da página.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderChannelNav, type ChannelNavOptions, type ChannelsState, type ChannelSummary } from '../src/web/channels.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const html = read('index.html');
const main = read('src/web/main.ts');
const css = read('src/web/styles/midnight-v2.css');
const fn = (name: string): string => new RegExp(`function ${name}[^]*?\n}\n`).exec(main)![0];
const block = (open: string): string => {
  const start = html.indexOf(open);
  const tag = /^<([a-z]+)/.exec(open)![1]!;
  const re = new RegExp(`<${tag}\\b|</${tag}>`, 'g');
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  throw new Error(`${open} sem fechamento`);
};

describe('duas barras laterais', () => {
  const rail = block('<nav id="rail"');
  const sidebar = block('<nav id="sidebar"');

  it('barra global: só a navegação entre salas (Início, salas, Criar sala), com nomes acessíveis', () => {
    expect(rail).toMatch(/^<nav id="rail" class="rail" aria-label="Salas">/);
    expect(rail).toMatch(/<button id="rooms-home-btn" class="rail-btn rail-home" type="button" aria-label="Início: minhas salas" title="Início"><\/button>/);
    expect(rail).toMatch(/<div id="room-nav" class="room-nav rail-rooms"><\/div>/);
    expect(rail).toMatch(/<button id="create-open-btn" class="rail-btn rail-create" type="button" aria-label="Criar sala" title="Criar sala"><\/button>/);
    expect(rail.indexOf('rooms-home-btn')).toBeLessThan(rail.indexOf('room-nav'));
    expect(rail.indexOf('room-nav')).toBeLessThan(rail.indexOf('create-open-btn')); // Início e Criar fora da lista que rola
    expect(rail).not.toMatch(/channel|account|profile|logout/);
  });

  it('lateral contextual: a sala, os canais e a conta; nada de lista de salas', () => {
    expect(sidebar).toMatch(/^<nav id="sidebar" class="sidebar" aria-label="Canais da sala">/);
    for (const id of ['sidebar-room', 'sidebar-room-detail', 'sidebar-hint', 'channel-nav', 'channel-list', 'account-box', 'profile-open-btn', 'logout-btn', 'sidebar-close']) {
      expect(sidebar, id).toContain(`id="${id}"`);
    }
    expect(sidebar).not.toMatch(/id="room-nav"|id="rooms-home-btn"|id="create-open-btn"/);
    expect(html.indexOf('<nav id="rail"')).toBeLessThan(html.indexOf('<nav id="sidebar"')); // ordem do teclado: salas, canais
  });

  it('recolher fica no cabeçalho (a lateral recolhida não pode conter o botão que a reabre)', () => {
    const header = /<header class="context-header">[^]*?<\/header>/.exec(html)![0];
    expect(header).toMatch(/<button id="sidebar-toggle" class="icon-btn header-icon-btn" type="button" aria-controls="sidebar" aria-expanded="true" aria-label="Recolher canais"/);
    expect(header).toMatch(/<button id="shell-menu-btn" class="icon-btn header-icon-btn" type="button" aria-controls="sidebar" aria-expanded="false" aria-label="Abrir canais"/);
    expect(fn('renderShell')).toContain("const label = state.collapsed ? 'Mostrar canais' : 'Recolher canais';");
  });

  it('a lateral mostra a sala selecionada (nome, papel e lotação) ou a marca na visão geral', () => {
    const render = fn('renderRooms');
    expect(render).toContain("ui.sidebarRoom.textContent = selectedRoom?.name ?? 'Oryn';");
    expect(render).toContain('ui.sidebarHint.hidden = selectedRoom !== undefined;');
  });
});

describe('responsividade', () => {
  it('grade: barra global, lateral contextual e conteúdo; recolhida, a lateral some e a barra da chamada acompanha', () => {
    expect(css).toMatch(/--rail-width: 72px;\n\s*--context-width: 248px;\n\s*--sidebar-width: calc\(var\(--rail-width\) \+ var\(--context-width\)\);/);
    expect(css).toMatch(/grid-template-columns: var\(--rail-width\) var\(--context-width\) minmax\(0, 1fr\);/);
    expect(css).toMatch(/main\[data-sidebar='collapsed'\]:has\(> #account:not\(\[hidden\]\)\) \{\n\s*--context-width: 0px;/);
  });

  it('celular: barra global compacta e sempre visível; a gaveta de canais abre ao lado dela, nunca por cima', () => {
    const mobile = css.slice(css.indexOf('@media (max-width: 768px) {\n  main:has(> #account:not([hidden])) {\n    --rail-width: 56px;'));
    expect(mobile).toMatch(/--rail-width: 56px;/);
    expect(mobile).toMatch(/\.sidebar \{\n\s*inset: 0 auto 0 var\(--rail-width\);/);
    expect(mobile).toMatch(/\.shell-backdrop \{\n\s*left: var\(--rail-width\);/);
    expect(mobile).toMatch(/\.call-bar \{\n\s*left: calc\(var\(--rail-width\) \+ var\(--space-2\)\);/);
    // A barra global fica acima da gaveta (30) e da camada escura (25) do shell.css.
    expect(/\.rail \{[^}]*z-index: (\d+)/.exec(css)![1]).toBe('32');
  });

  it('escolher uma sala no celular abre a gaveta de canais; escolher um canal a fecha', () => {
    expect(fn('navigate')).toMatch(/if \(room && drawerLayout\(\)\) \{\n\s*shell\.openDrawer\(\);\n\s*return;/);
    expect(fn('openChannelChat')).toContain('closeDrawer();');
    expect(main).toMatch(/onJoinVoice: \(channelId\) => \{\n\s*closeDrawer\(\);/);
  });

  it('abaixo de 1200 px, Membros (Texto) e Chat (Voz) abrem sob demanda; voltam ao lado quando a coluna existe', () => {
    expect(fn('showText')).toMatch(/if \(sidePanelFits\(\)\) \{\n\s*if \(members\.state\.status === 'closed'/);
    expect(fn('showVoice')).toMatch(/if \(sidePanelFits\(\)\) \{[^]*?\} else if \(chat\.state\.status !== 'closed' && chat\.state\.pending\.length === 0\) \{\n\s*chat\.close\(\);/);
    expect(main).toContain("const sidePanelFits = (): boolean => window.matchMedia('(min-width: 1200px)').matches;");
    expect(main).toMatch(/window\.matchMedia\('\(min-width: 1200px\)'\)\.addEventListener\('change'/);
    // Em Voz, a pílula "Chat" volta, para abrir o chat sob demanda.
    expect(fn('renderRooms')).toContain("...(selectedRoomId === null || centerKind === 'voice' ? { onChat: openChat } : {}),");
  });
});

describe('acabamento', () => {
  it('uma geometria só para os botões de ícone: centro exato, sem o texto invisível empurrar o ícone', () => {
    const rule = /\.call-bar-actions \.round-btn,\n#rooms-refresh-btn,[^{]*\{([^}]*)\}/.exec(css)![1]!;
    expect(rule).toMatch(/place-content: center;/);
    expect(rule).toMatch(/gap: 0;/);
    expect(rule).toMatch(/line-height: 0;/);
    expect(css).toMatch(/@media \(max-width: 480px\) \{\n\s*\/\*[^*]*\*\/\n\s*#leave-btn \{\n\s*gap: 0;/);
  });

  it('chat sem título repetido: só "#canal" no painel; em Texto o cabeçalho do painel sai', () => {
    expect(fn('renderChat')).toContain('ui.chatRoom.textContent = chatChannel ? `#${chatChannel.name}` : chatRoomName;');
    expect(html).toMatch(/<h3><span class="visually-hidden">Chat do canal <\/span><span id="chat-room"><\/span><\/h3>/);
    expect(html).toMatch(/<h3>Membros<span class="visually-hidden"> da sala <span id="members-room"><\/span><\/span><\/h3>/);
    expect(css).toMatch(/main\[data-view='room'\]\[data-channel='text'\] #chat > \.panel-head \{\n\s*display: none;/);
  });

  it('regressão: nenhuma regra da área central usa o atalho padding, que zeraria a folga da barra da chamada', () => {
    // A folga embaixo (gold.css, voice.css) é o que deixa volume e "desativar sons" acima da barra ao rolar.
    const rules = [...css.matchAll(/([^{}]*\.shell-main[^{}]*)\{([^}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(0);
    for (const [, selector, body] of rules) expect(body, selector!.trim()).not.toMatch(/(^|[\s;])padding\s*:/);
    expect(read('src/web/styles/gold.css')).toMatch(/main:has\(#call-bar:not\(\[hidden\]\)\) \.shell-main \{\n\s*padding-bottom: 176px;/);
  });

  it('sem reordenação por CSS, sem ativos externos', () => {
    expect(css).not.toMatch(/(^|[\s;{])order\s*:/);
    expect(css).not.toMatch(/url\(|@import|@font-face/);
  });
});

describe('convite: um único modal centralizado', () => {
  it('é um <dialog> (não uma seção no fluxo), com os mesmos ids do controlador', () => {
    expect(html).toMatch(/<dialog id="invite-share" class="identity-panel invite-dialog" aria-labelledby="invite-share-title" hidden>/);
    expect(html).not.toMatch(/<section id="invite-share"/);
    for (const id of ['invite-share-room', 'invite-share-box', 'invite-link', 'invite-copy-btn', 'invite-share-status', 'invite-share-message', 'invite-new-btn', 'invite-close-btn']) {
      expect(html, id).toContain(`id="${id}"`);
    }
  });

  it('abre como modal, fecha o menu "⋮" de origem e não rola nem insere nada na página', () => {
    const render = fn('renderInviteShare');
    expect(render).toContain('adminOpen.delete(s.roomId);');
    expect(render).toContain('ui.inviteShare.showModal();');
    expect(render).toContain("document.getElementById('invite-share-title')?.focus();");
    expect(render).not.toMatch(/scrollIntoView/);
  });

  it('Escape fecha pelo controlador (que não fecha durante a geração); o foco volta ao "⋮"', () => {
    expect(main).toContain("ui.inviteShare.addEventListener('cancel', (event) => { event.preventDefault(); inviteShare.close(); });");
    expect(main).toMatch(/ui\.inviteShare\.addEventListener\('close', \(\) => \{[^]*?menu\.focus\(\);/);
    expect(main).toContain('|| ui.inviteShare.open) return;');
    // A margem de seção do rooms.css tiraria o modal do centro.
    expect(css).toMatch(/#invite-share\.invite-dialog \{\n\s*margin: auto;/);
  });
});

describe('ícones dos cartões de sala (tela inicial e cabeçalho)', () => {
  it('Chat, Membros e "⋮" só com ícone: sem o espaço e a margem herdados do botão com texto', () => {
    expect(css).toMatch(/main\[data-view='all'\] #account #rooms \.buttons button\.room-chat,\nmain\[data-view='all'\] #account #rooms \.buttons button\.room-members \{\n\s*justify-content: center;\n\s*gap: 0;\n\s*padding: 0;/);
    expect(css).toMatch(/@media \(max-width: 1199px\) \{\n\s*#account #rooms \.buttons button\.room-chat,\n\s*#account #rooms \.buttons button\.room-members \{\n\s*justify-content: center;\n\s*gap: 0;\n\s*padding: 0;/);
    expect(css).toMatch(/#account #rooms \.room-admin > summary::before \{\n\s*margin: 0;/);
  });

  it('tamanhos iguais aos vizinhos: o "⋮" (<summary>) em border-box e Chat/Membros quadrados no celular', () => {
    expect(css).toMatch(/#account #rooms \.room-admin > summary \{\n\s*box-sizing: border-box;/);
    expect(css).toMatch(/@media \(max-width: 768px\) \{\n\s*#account #rooms \.buttons button\.room-chat,\n\s*#account #rooms \.buttons button\.room-members \{\n\s*width: 44px;\n\s*min-height: 44px;/);
  });
});

// ---------- menu do canal ----------
class FakeEl {
  children: FakeEl[] = [];
  attrs = new Map<string, string>();
  className = '';
  textContent: string | null = null;
  disabled = false;
  type = '';
  readonly tag: string;
  private handlers = new Map<string, (() => void)[]>();
  constructor(tag: string) {
    this.tag = tag;
  }
  append(...n: FakeEl[]) { this.children.push(...n); }
  prepend(...n: FakeEl[]) { this.children.unshift(...n); }
  contains(n: FakeEl): boolean { return n === this || this.children.some((c) => c.contains(n)); }
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  addEventListener(ev: string, h: () => void) { this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), h]); }
  fire(ev: string) { (this.handlers.get(ev) ?? []).forEach((h) => h()); }
  find(p: (e: FakeEl) => boolean): FakeEl[] { return [...(p(this) ? [this] : []), ...this.children.flatMap((c) => c.find(p))]; }
}
const doc = { createElement: (t: string) => new FakeEl(t) as unknown as HTMLElement };
const ch = (id: string, kind: 'text' | 'voice', name: string, isDefault = false): ChannelSummary =>
  ({ channel_id: id, kind, name, position: 0, is_default: isDefault, archived_at: null, created_at: '2026-11-11T00:00:00Z' });
const state: ChannelsState = { roomId: 'r', status: 'ready', channels: [ch('t1', 'text', 'conversa', true), ch('t2', 'text', 'estratégia')], participants: {}, busy: null, message: null };
const nav = (over: Partial<ChannelNavOptions>) => renderChannelNav(doc, state, {
  canManage: true, closed: false, openTextId: null, activeVoiceId: null, callBusy: false,
  onOpenText() {}, onJoinVoice() {}, onArchive() {}, ...over,
}) as unknown as FakeEl;

describe('menu do canal ("⋯")', () => {
  it('Arquivar sai da linha e vai para o menu, com nome acessível; só para o dono e fora dos padrões', () => {
    const root = nav({});
    const menus = root.find((e) => e.className === 'channel-menu');
    expect(menus).toHaveLength(1); // só "estratégia": o canal padrão não é arquivável
    expect(menus[0]!.find((e) => e.tag === 'summary')[0]!.attrs.get('aria-label')).toBe('Opções do canal estratégia');
    expect(menus[0]!.find((e) => e.className.includes('channel-archive'))[0]!.attrs.get('aria-label')).toBe('Arquivar o canal estratégia');
    expect(nav({ canManage: false }).find((e) => e.className === 'channel-menu')).toEqual([]);
  });

  it('o redesenho periódico mantém aberto o menu que a pessoa abriu', () => {
    const toggles: [string, boolean][] = [];
    const open = nav({ openMenuId: 't2', onMenuToggle: (id, o) => toggles.push([id, o]) }).find((e) => e.className === 'channel-menu')[0]!;
    expect(open.attrs.has('open')).toBe(true);
    expect(nav({}).find((e) => e.className === 'channel-menu')[0]!.attrs.has('open')).toBe(false);
    expect(main).toContain('openMenuId: channelMenuOpen,');
  });
});
