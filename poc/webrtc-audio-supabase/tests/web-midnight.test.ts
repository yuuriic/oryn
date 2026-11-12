// Midnight (P0): canal selecionado define o centro, rascunhos por canal, cabeçalho e barra resumidos, "+" de criar canal
// e a composição por canal. Regras puras com testes de comportamento; a ligação com a página, por leitura do código.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderChannelNav, isChannelName, type ChannelNavOptions, type ChannelsState, type ChannelSummary } from '../src/web/channels.ts';
import { DraftBook, draftKey } from '../src/web/drafts.ts';
import type { LobbyState } from '../src/web/rooms.ts';
import { roomContext } from '../src/web/rooms-view.ts';
import { callBarStatus, callBarTitle } from '../src/web/voice-view.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const html = read('index.html');
const main = read('src/web/main.ts');
const css = read('src/web/styles/midnight.css');
const fn = (name: string): string => new RegExp(`function ${name}[^]*?\n}\n`).exec(main)![0];

describe('rascunhos por canal', () => {
  const A = draftKey('sala-1', null)!;
  const B = draftKey('sala-1', 'canal-b')!;
  const C = draftKey('sala-2', null)!;

  it('chave por sala e canal; o texto padrão tem a sua; sem sala, nenhuma', () => {
    expect(A).toBe('sala-1:default');
    expect(B).toBe('sala-1:canal-b');
    expect(draftKey(null, 'x')).toBeNull();
  });

  it('trocar de canal guarda o texto no de origem e devolve o do destino: nada passa de um canal para outro', () => {
    const book = new DraftBook();
    expect(book.switch(null, A, '')).toBe('');
    expect(book.switch(A, B, 'para A')).toBe(''); // B começa vazio: o texto de A não vai para B
    expect(book.switch(B, A, 'para B')).toBe('para A');
    expect(book.switch(A, C, 'para A, editado')).toBe('');
    expect(book.switch(C, B, '')).toBe('para B');
    expect(book.switch(B, A, 'para B')).toBe('para A, editado');
  });

  it('o mesmo canal não troca nada; texto em branco não ocupa espaço; enviar e sair da conta apagam', () => {
    const book = new DraftBook();
    expect(book.switch(A, A, 'igual')).toBe('igual');
    book.switch(A, B, '   ');
    expect(book.size).toBe(0);
    book.switch(B, A, 'rascunho');
    book.clear(B);
    expect(book.switch(A, B, 'outro')).toBe('');
    book.reset();
    expect(book.size).toBe(0);
    expect(book.switch(B, A, '')).toBe('');
  });

  it('a página troca o rascunho na mudança de canal e o apaga ao enviar e ao sair da conta', () => {
    const render = fn('renderChat');
    expect(render).toContain("const key = s.status === 'closed' ? null : draftKey(s.roomId, s.channelId);");
    expect(render).toContain('ui.chatInput.value = drafts.switch(draftAt, key, ui.chatInput.value);');
    // A troca acontece antes de qualquer envio possível no canal novo: é a primeira coisa do renderChat.
    expect(render.indexOf('drafts.switch')).toBeLessThan(render.indexOf('ui.chatForm.hidden'));
    expect(fn('submitChat')).toMatch(/if \(chat\.send\(ui\.chatInput\.value\)\) \{\n\s*ui\.chatInput\.value = '';\n\s*drafts\.clear\(draftAt\);/);
    expect(main).toMatch(/ui\.chatInput\.value = '';\n\s*drafts\.reset\(\);/);
    expect(read('src/web/drafts.ts')).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  });
});

describe('barra da chamada: estados resumidos e canal conectado', () => {
  it.each([
    ['requesting-mic', false, 'Aguardando o microfone…'],
    ['connecting-signaling', false, 'Entrando…'],
    ['negotiating', false, 'Conectando…'],
    ['waiting-peer', false, 'Em chamada'],
    ['connected', false, 'Em chamada'],
    ['connected', true, 'Reconectando…'],
    ['negotiating', true, 'Reconectando…'],
    ['ended', false, 'Chamada encerrada'],
    ['failed', false, 'Chamada encerrada'],
    ['idle', false, ''],
  ] as const)('%s (reconectando: %s) → "%s"', (phase, reconnecting, text) => {
    expect(callBarStatus(phase, reconnecting)).toBe(text);
  });

  it('nenhum termo técnico chega à barra', () => {
    for (const phase of ['requesting-mic', 'connecting-signaling', 'waiting-peer', 'negotiating', 'connected', 'ended', 'failed'] as const) {
      expect(callBarStatus(phase, false)).not.toMatch(/negoci|ICE|sinaliza|SDP|relay|codec/i);
    }
  });

  it('canal de voz e sala; sem canal conhecido, a sala', () => {
    expect(callBarTitle('Geral', 'Noite de jogos')).toBe('Geral · Noite de jogos');
    expect(callBarTitle(null, 'Noite de jogos')).toBe('Noite de jogos');
    expect(fn('callIdentity')).toContain("const voice = channelId === null ? defaultChannel(voices, 'voice') : voices.find((c) => c.channel_id === channelId);");
  });
});

describe('cabeçalho do canal aberto', () => {
  const room = { room_id: 'r1', name: 'Sala A', role: 'owner', is_open: true, member_count: 3, max_members: 4, closed_at: null } as const;
  const state = { status: 'ready', rooms: [room], busy: null, actionError: null, listError: null, skipped: 0 } as unknown as LobbyState;

  it('texto: "#nome", com a sala e os membros no resumo', () => {
    expect(roomContext(state, 'r1', null, { kind: 'text', name: 'conversa' })).toEqual({ title: '#conversa', detail: 'Sala A · 3/4 membros' });
  });

  it('voz: nome e ocupação da voz (não dos membros)', () => {
    expect(roomContext(state, 'r1', 'r1', { kind: 'voice', name: 'Geral', inVoice: 1 })).toEqual({ title: 'Geral', detail: 'Sala A · 1/4 na voz' });
  });

  it('sem canal (lista ainda carregando), o cabeçalho de sempre', () => {
    expect(roomContext(state, 'r1')).toEqual({ title: 'Sala A', detail: 'dono · 3/4 membros · aberta' });
    expect(roomContext(state, null, null, { kind: 'text', name: 'x' })).toEqual({ title: 'Minhas salas', detail: null });
  });
});

// ---------- navegação de canais: "+" e voz da própria chamada ----------

class FakeEl {
  children: FakeEl[] = [];
  attrs = new Map<string, string>();
  className = '';
  textContent: string | null = null;
  disabled = false;
  type = '';
  private handlers: (() => void)[] = [];
  readonly tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  append(...nodes: FakeEl[]) { this.children.push(...nodes); }
  prepend(...nodes: FakeEl[]) { this.children.unshift(...nodes); }
  contains(node: FakeEl): boolean { return node === this || this.children.some((c) => c.contains(node)); }
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  addEventListener(_: string, h: () => void) { this.handlers.push(h); }
  click() { if (!this.disabled) this.handlers.forEach((h) => h()); }
  find(pred: (e: FakeEl) => boolean): FakeEl[] { return [...(pred(this) ? [this] : []), ...this.children.flatMap((c) => c.find(pred))]; }
}
const doc = { createElement: (tag: string) => new FakeEl(tag) as unknown as HTMLElement };
const ch = (id: string, kind: 'text' | 'voice', name: string, isDefault = false): ChannelSummary =>
  ({ channel_id: id, kind, name, position: 0, is_default: isDefault, archived_at: null, created_at: '2026-11-11T00:00:00Z' });
const TEXT = ch('t1', 'text', 'conversa', true);
const VOICE = ch('v1', 'voice', 'Geral', true);
const VOICE_2 = ch('v2', 'voice', 'Sala 2');
const ready = (over: Partial<ChannelsState> = {}): ChannelsState =>
  ({ roomId: 'r1', status: 'ready', channels: [TEXT, VOICE, VOICE_2], participants: {}, busy: null, message: null, ...over });
const nav = (state: ChannelsState, over: Partial<ChannelNavOptions> = {}) => {
  const events: string[] = [];
  const opts: ChannelNavOptions = {
    canManage: false, closed: false, openTextId: null, activeVoiceId: null, callBusy: false,
    onOpenText: (c) => events.push(`text:${c}`), onJoinVoice: (c) => events.push(`join:${c}`), onArchive: (c) => events.push(`archive:${c}`),
    onOpenVoice: (c) => events.push(`stage:${c}`), onCreate: (k) => events.push(`create:${k}`), ...over,
  };
  return { root: renderChannelNav(doc, state, opts) as unknown as FakeEl, events };
};
const plus = (root: FakeEl) => root.find((e) => e.className.split(' ').includes('channel-add'));
const voices = (root: FakeEl) => root.find((e) => e.tag === 'button' && e.className.split(' ').includes('channel-voice'));

describe('"+" de criar canal nas seções', () => {
  it('só para o dono de um espaço aberto; cada "+" abre com o tipo da sua seção e tem nome acessível', () => {
    expect(plus(nav(ready()).root)).toEqual([]);
    expect(plus(nav(ready(), { canManage: true, closed: true }).root)).toEqual([]);
    const { root, events } = nav(ready(), { canManage: true });
    const [text, voice] = plus(root);
    expect(text!.attrs.get('aria-label')).toBe('Criar canal de texto');
    expect(voice!.attrs.get('aria-label')).toBe('Criar canal de voz');
    expect([text!.attrs.get('data-create-kind'), voice!.attrs.get('data-create-kind')]).toEqual(['text', 'voice']);
    text!.click();
    voice!.click();
    expect(events).toEqual(['create:text', 'create:voice']);
  });

  it('desabilitado durante outra operação (criação ou arquivamento): sem envio duplicado', () => {
    expect(plus(nav(ready({ busy: 'create' }), { canManage: true }).root).every((b) => b.disabled)).toBe(true);
  });

  it('nome do canal: a mesma regra do servidor (1 a 40 pontos de código, sem controle)', () => {
    expect(isChannelName('estratégia')).toBe(true);
    expect(isChannelName('  ')).toBe(false);
    expect(isChannelName('a'.repeat(41))).toBe(false);
    expect(isChannelName('x\u0007')).toBe(false);
  });
});

describe('voz da própria chamada: volta ao palco, nunca uma segunda entrada', () => {
  it('a voz conectada fica clicável e abre o palco; as outras seguem bloqueadas durante a chamada', () => {
    const { root, events } = nav(ready(), { activeVoiceId: 'v1', callBusy: true, selectedVoiceId: null });
    const [geral, sala2] = voices(root);
    expect(geral!.disabled).toBe(false);
    expect(geral!.attrs.get('aria-label')).toContain('você está nesta voz, abrir');
    expect(sala2!.disabled).toBe(true); // sem troca automática entre vozes
    geral!.click();
    sala2!.click();
    expect(events).toEqual(['stage:v1']);
  });

  it('o canal no centro fica marcado (aria-current); sem chamada, clicar numa voz é entrar', () => {
    const { root, events } = nav(ready(), { selectedVoiceId: 'v2' });
    const [geral, sala2] = voices(root);
    expect(sala2!.attrs.get('aria-current')).toBe('true');
    expect(geral!.attrs.has('aria-current')).toBe(false);
    geral!.click();
    expect(events).toEqual(['join:v1']);
  });
});

describe('composição por canal (centro e painel contextual)', () => {
  it('o chat vem antes dos membros no DOM: em Texto, a ordem do teclado é centro e depois o painel', () => {
    expect(html.indexOf('<section id="chat"')).toBeGreaterThan(-1);
    expect(html.indexOf('<section id="chat"')).toBeLessThan(html.indexOf('<section id="members"'));
  });

  it('a página marca o canal do centro, e o CSS posiciona por grid-column, sem order', () => {
    expect(fn('renderRooms')).toContain("ui.app.dataset['channel'] = selectedRoomId === null ? 'none' : centerKind;");
    expect(css).toMatch(/main\[data-view='room'\]\[data-channel='text'\] #shell-main > #call-panel \{\n  display: none;/);
    // #shell-main: vence também a lista de shell.css que o minificador junta num :is() (que pesa como o mais forte).
    expect(css).toMatch(/main\[data-view='room'\]\[data-channel='text'\] #shell-main\.shell-main:has\(> #chat:not\(\[hidden\]\)\) > #chat \{\n    grid-column: 1;/);
    expect(css).toMatch(/> #members \{\n    grid-column: 2;/);
    expect(css).not.toMatch(/(^|[\s;{])order\s*:/);
    expect(css).not.toMatch(/url\(|@import|@font-face/);
  });

  it('Voz: palco no centro e chat ao lado; os membros fecham e a chamada não começa sozinha', () => {
    const voice = fn('showVoice');
    expect(voice).toContain("centerKind = 'voice';");
    expect(voice).toContain('members.close()');
    expect(voice).not.toMatch(/startCall|beginCall|endCall/);
    expect(fn('showText')).not.toMatch(/startCall|beginCall|endCall|leave/);
  });

  it('entrar numa voz da sala em tela abre o palco; "Entrar na chamada" usa a voz do palco', () => {
    expect(fn('startCall')).toContain('if (shell.state.selectedRoomId === roomId) showVoice(roomId, channelId);');
    expect(fn('renderRooms')).toContain("onJoin: (roomId) => startCall(roomId, roomId === selectedRoomId && centerKind === 'voice' ? selectedVoiceId : null),");
  });
});
