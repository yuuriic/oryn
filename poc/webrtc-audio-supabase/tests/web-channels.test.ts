// Canais do espaço no cliente (I-2): contrato de list_channels, controlador (ChannelsController) e renderização da
// lista. Servidor falso: só o que as RPCs da 0900 devolvem. Nada aqui fala com produção.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHANNELS_DENIED, CHANNELS_LOAD_FAILED, CHANNELS_POLL_MS, CHANNEL_NAME_INVALID, ChannelsController, MAX_ACTIVE_CHANNELS,
  activeChannels, defaultChannel, parseChannel, parseChannelList, renderChannelNav, type ChannelNavOptions, type ChannelSummary,
  type ChannelsDeps, type ChannelsState,
} from '../src/web/channels.ts';
import type { RpcResult } from '../src/web/supabase-signaling.ts';

const ROOM = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const id = (n: number) => `cccccccc-cccc-4ccc-8ccc-${String(n).padStart(12, '0')}`;
const ch = (n: number, over: Partial<ChannelSummary> = {}): ChannelSummary => ({
  channel_id: id(n), kind: 'text', name: `canal ${n}`, position: n, is_default: false, archived_at: null, created_at: '2026-11-10T12:00:00+00:00', ...over,
});
const TEXT = ch(1, { name: 'conversa', is_default: true, position: 0 });
const VOICE = ch(2, { kind: 'voice', name: 'voz', is_default: true, position: 0 });
const EXTRA = ch(3, { name: 'estratégia' });
const VOICE_2 = ch(4, { kind: 'voice', name: 'sala 2' });
const ARCHIVED = ch(5, { name: 'antigo', archived_at: '2026-11-10T13:00:00+00:00' });
const person = (session: number, ref: string, name: string, self = false) => ({
  session_id: `dddddddd-dddd-4ddd-8ddd-${String(session).padStart(12, '0')}`, participant_ref: ref.padEnd(32, '0'), display_name: name, is_self: self, joined_at: '2026-11-10T12:00:00+00:00',
});
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

type Handler = (args: Record<string, unknown>) => RpcResult<unknown> | Promise<RpcResult<unknown>>;
function harness(handlers: Partial<Record<string, Handler>> = {}, opts: { confirm?: boolean; hidden?: boolean } = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const gone: string[] = [];
  const confirms: string[] = [];
  let next = 1;
  const h = { list_channels: () => ({ data: [TEXT, VOICE, EXTRA, VOICE_2, ARCHIVED], error: null }), get_channel_participants: () => ({ data: [], error: null }), ...handlers } as Record<string, Handler>;
  const deps: ChannelsDeps = {
    rpc: async <T,>(fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return (await (h[fn] ?? (() => ({ data: null, error: 'erro' })))(args)) as RpcResult<T>;
    },
    confirm: (m) => {
      confirms.push(m);
      return opts.confirm ?? true;
    },
    isHidden: () => opts.hidden ?? false,
    setTimer: (fn, ms) => {
      const n = next++;
      timers.set(n, { fn, ms });
      return n;
    },
    clearTimer: (n) => void timers.delete(n as number),
    onChange: () => undefined,
    onChannelGone: (c) => gone.push(c),
  };
  const c = new ChannelsController(deps);
  const fire = async (ms: number) => {
    for (const [n, t] of [...timers]) if (t.ms === ms) (timers.delete(n), t.fn());
    await flush();
  };
  return { c, calls, h, gone, confirms, fire, timers };
}

describe('contrato de list_channels', () => {
  it('aceita só linhas com exatamente as colunas e valores da regra; lista que não é lista é erro', () => {
    expect(parseChannel(TEXT)).toEqual(TEXT);
    expect(parseChannel({ ...TEXT, extra: 1 })).toBeNull();
    expect(parseChannel({ ...TEXT, kind: 'video' })).toBeNull();
    expect(parseChannel({ ...TEXT, name: '' })).toBeNull();
    expect(parseChannel({ ...TEXT, name: 'a'.repeat(41) })).toBeNull();
    expect(parseChannel({ ...TEXT, channel_id: 'x' })).toBeNull();
    expect(parseChannel({ ...TEXT, position: 1.5 })).toBeNull();
    expect(parseChannelList([TEXT, { ...TEXT, kind: 'x' }])).toEqual({ channels: [TEXT], skipped: 1 });
    expect(parseChannelList({})).toBeNull();
    expect(activeChannels([TEXT, VOICE, ARCHIVED], 'text')).toEqual([TEXT]);
    expect(defaultChannel([EXTRA, TEXT, VOICE], 'voice')).toEqual(VOICE);
  });
});

describe('ChannelsController', () => {
  it('abre: lista os canais e os participantes de cada voz ativa; consulta de novo no intervalo', async () => {
    const t = harness({ get_channel_participants: (a) => ({ data: a['p_channel_id'] === VOICE.channel_id ? [person(1, 'a', 'Ana')] : [], error: null }) });
    t.c.open(ROOM);
    await flush();
    expect(t.c.state.status).toBe('ready');
    expect(t.calls.map((x) => [x.fn, x.args])).toEqual([
      ['list_channels', { p_room_id: ROOM }],
      ['get_channel_participants', { p_channel_id: VOICE.channel_id }],
      ['get_channel_participants', { p_channel_id: VOICE_2.channel_id }],
    ]);
    expect(t.c.state.participants[VOICE.channel_id]!.map((p) => p.display_name)).toEqual(['Ana']);
    expect(t.c.state.participants[ARCHIVED.channel_id]).toBeUndefined(); // arquivado não é consultado
    await t.fire(CHANNELS_POLL_MS);
    expect(t.calls.filter((x) => x.fn === 'list_channels')).toHaveLength(2);
  });

  it('o mesmo espaço já aberto não recarrega; outro espaço descarta a resposta atrasada do anterior', async () => {
    let release: ((r: RpcResult<unknown>) => void) | null = null;
    const t = harness({ list_channels: (a) => (a['p_room_id'] === ROOM ? new Promise((r) => { release = r; }) : { data: [ch(9, { name: 'outro' })], error: null }) });
    t.c.open(ROOM);
    t.c.open(ROOM);
    await flush();
    expect(t.calls.filter((x) => x.fn === 'list_channels')).toHaveLength(1);
    t.c.open(OTHER);
    await flush();
    release!({ data: [TEXT], error: null });
    await flush();
    expect(t.c.state.roomId).toBe(OTHER);
    expect(t.c.state.channels.map((x) => x.name)).toEqual(['outro']);
  });

  it('sem acesso (unauthorized): negado e para; falha de rede: erro e nova tentativa', async () => {
    const denied = harness({ list_channels: () => ({ data: null, error: 'unauthorized' }) });
    denied.c.open(ROOM);
    await flush();
    expect(denied.c.state).toMatchObject({ status: 'denied', message: { tone: 'error', text: CHANNELS_DENIED } });
    expect(denied.timers.size).toBe(0);
    const failing = harness({ list_channels: () => ({ data: null, error: 'erro' }) });
    failing.c.open(ROOM);
    await flush();
    expect(failing.c.state).toMatchObject({ status: 'error', message: { text: CHANNELS_LOAD_FAILED } });
    expect([...failing.timers.values()].some((x) => x.ms === CHANNELS_POLL_MS)).toBe(true);
  });

  it('criar: nome inválido não chama o servidor; sucesso recarrega; cada erro do servidor tem mensagem própria', async () => {
    const t = harness({ create_channel: () => ({ data: id(7), error: null }) });
    t.c.open(ROOM);
    await flush();
    expect(await t.c.create('   ', 'text')).toBeNull();
    expect(t.c.state.message).toEqual({ tone: 'error', text: CHANNEL_NAME_INVALID });
    expect(t.calls.some((x) => x.fn === 'create_channel')).toBe(false);
    const before = t.calls.filter((x) => x.fn === 'list_channels').length;
    expect(await t.c.create('  tática  ', 'voice')).toBe(id(7));
    expect(t.calls.find((x) => x.fn === 'create_channel')!.args).toEqual({ p_room_id: ROOM, p_name: 'tática', p_kind: 'voice' });
    expect(t.calls.filter((x) => x.fn === 'list_channels').length).toBe(before + 1);
    expect(t.c.state.message).toEqual({ tone: 'info', text: 'Canal "tática" criado.' });
    for (const [code, text] of [
      ['name-taken', /Já existe um canal ativo desse tipo/],
      ['limit-reached', new RegExp(`Limite de ${MAX_ACTIVE_CHANNELS} canais ativos`)],
      ['unauthorized', /Só o dono do espaço cria canais/],
      ['room-closed', /espaço foi encerrado/],
      ['relation "oryn.channels" does not exist', /Não foi possível criar o canal \(falha de rede/],
    ] as const) {
      t.h['create_channel'] = () => ({ data: null, error: code });
      expect(await t.c.create('x', 'text')).toBeNull();
      expect(t.c.state.message?.text).toMatch(text);
      expect(t.c.state.message?.text).not.toMatch(/oryn|relation/);
      expect(t.c.state.busy).toBeNull();
    }
  });

  it('arquivar: pede confirmação; desistir não chama; padrões e já arquivados não são oferecidos; sucesso avisa o canal sumido', async () => {
    const no = harness({}, { confirm: false });
    no.c.open(ROOM);
    await flush();
    expect(await no.c.archive(EXTRA.channel_id)).toBe(false);
    expect(no.confirms[0]).toMatch(/Arquivar o canal "estratégia"\? As mensagens continuam legíveis/);
    expect(no.calls.some((x) => x.fn === 'archive_channel')).toBe(false);

    let list = [TEXT, VOICE, EXTRA, VOICE_2];
    const t = harness({ list_channels: () => ({ data: list, error: null }), archive_channel: () => ((list = [TEXT, VOICE, VOICE_2, { ...EXTRA, archived_at: '2026-11-10T14:00:00+00:00' }]), { data: '2026-11-10T14:00:00+00:00', error: null }) });
    t.c.open(ROOM);
    await flush();
    expect(await t.c.archive(TEXT.channel_id)).toBe(false); // padrão
    expect(await t.c.archive(id(99))).toBe(false); // desconhecido
    expect(t.confirms).toEqual([]);
    expect(await t.c.archive(EXTRA.channel_id)).toBe(true);
    expect(t.calls.find((x) => x.fn === 'archive_channel')!.args).toEqual({ p_channel_id: EXTRA.channel_id });
    expect(t.gone).toEqual([EXTRA.channel_id]);
    expect(t.c.state.message).toEqual({ tone: 'info', text: 'Canal "estratégia" arquivado.' });
    // Voz: o aviso diz que quem estiver nela sai.
    t.h['archive_channel'] = () => ({ data: null, error: 'unauthorized' });
    expect(await t.c.archive(VOICE_2.channel_id)).toBe(false);
    expect(t.confirms.at(-1)).toMatch(/Quem estiver na voz deste canal será desconectado/);
    expect(t.c.state.message?.text).toMatch(/Só o dono do espaço arquiva canais/);
  });

  it('fechar descarta tudo, inclusive a consulta agendada', async () => {
    const t = harness();
    t.c.open(ROOM);
    await flush();
    t.c.close();
    expect(t.c.state.status).toBe('closed');
    await t.fire(CHANNELS_POLL_MS);
    expect(t.calls.filter((x) => x.fn === 'list_channels')).toHaveLength(1);
  });
});

// ---------- renderização ----------

class FakeEl {
  tag: string;
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  textContent: string | null = null;
  className = '';
  type = '';
  disabled = false;
  attrs = new Map<string, string>();
  listeners = new Map<string, (() => void)[]>();
  constructor(tag: string) {
    this.tag = tag;
  }
  append(...nodes: FakeEl[]): void {
    for (const n of nodes) (n.parent = this), this.children.push(n);
  }
  prepend(...nodes: FakeEl[]): void {
    for (const n of nodes) n.parent = this;
    this.children.unshift(...nodes);
  }
  contains(n: FakeEl): boolean {
    return n === this || this.children.some((c) => c.contains(n));
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  addEventListener(ev: string, fn: () => void): void {
    this.listeners.set(ev, [...(this.listeners.get(ev) ?? []), fn]);
  }
  click(): void {
    for (const fn of this.listeners.get('click') ?? []) fn();
  }
  get allText(): string {
    return [this.textContent ?? '', ...this.children.map((c) => c.allText)].join(' ');
  }
  find(pred: (e: FakeEl) => boolean): FakeEl[] {
    return [...(pred(this) ? [this] : []), ...this.children.flatMap((c) => c.find(pred))];
  }
}
const doc = { createElement: (tag: string) => new FakeEl(tag) as unknown as HTMLElement };
const ready = (over: Partial<ChannelsState> = {}): ChannelsState => ({
  roomId: ROOM, status: 'ready', channels: [TEXT, VOICE, EXTRA, VOICE_2, ARCHIVED], participants: {}, busy: null, message: null, ...over,
});
const nav = (state: ChannelsState, over: Partial<ChannelNavOptions> = {}) => {
  const events: string[] = [];
  const opts: ChannelNavOptions = {
    canManage: false, closed: false, openTextId: null, activeVoiceId: null, callBusy: false,
    onOpenText: (c) => events.push(`text:${c}`), onJoinVoice: (c) => events.push(`voice:${c}`), onArchive: (c) => events.push(`archive:${c}`), ...over,
  };
  return { root: renderChannelNav(doc, state, opts) as unknown as FakeEl, events };
};
const buttons = (root: FakeEl, cls: string) => root.find((e) => e.tag === 'button' && e.className.split(' ').includes(cls));

describe('renderChannelNav', () => {
  it('texto e voz em grupos, sem os arquivados; clique abre o chat do canal ou entra na voz', () => {
    const { root, events } = nav(ready());
    const links = buttons(root, 'channel-link');
    expect(links.map((b) => b.allText.trim())).toEqual(['# conversa', '# estratégia', '🔊 voz', '🔊 sala 2']);
    expect(root.allText).not.toContain('antigo');
    links[1]!.click();
    links[3]!.click();
    expect(events).toEqual([`text:${EXTRA.channel_id}`, `voice:${VOICE_2.channel_id}`]);
  });

  it('membro não vê ações de gerenciamento; o dono vê "Arquivar" só nos canais que não são padrão', () => {
    expect(buttons(nav(ready()).root, 'channel-archive')).toEqual([]);
    const { root, events } = nav(ready(), { canManage: true });
    const archive = buttons(root, 'channel-archive');
    expect(archive.map((b) => b.attrs.get('aria-label'))).toEqual(['Arquivar o canal estratégia', 'Arquivar o canal sala 2']);
    archive[0]!.click();
    expect(events).toEqual([`archive:${EXTRA.channel_id}`]);
    const busy = nav(ready({ busy: { archiving: EXTRA.channel_id } }), { canManage: true });
    expect(buttons(busy.root, 'channel-archive').map((b) => [b.allText.trim(), b.disabled])).toEqual([['Arquivando…', true], ['Arquivar', true]]);
  });

  it('voz: participantes uma vez por conta, "(você)" para si; desabilitada na própria voz, durante outra chamada ou com o espaço encerrado', () => {
    const participants = { [VOICE.channel_id]: [person(1, 'a', 'Ana'), person(2, 'a', 'Ana'), person(3, 'b', 'Bia', true)] };
    const { root } = nav(ready({ participants }), { activeVoiceId: VOICE.channel_id });
    const people = root.find((e) => e.className === 'channel-people')[0]!;
    expect(people.children.map((li) => li.textContent)).toEqual(['Ana', 'Bia (você)']);
    const [voz, sala2] = buttons(root, 'channel-voice');
    expect(voz!.disabled).toBe(true);
    expect(voz!.attrs.get('aria-current')).toBe('true');
    expect(voz!.attrs.get('aria-label')).toBe('Canal de voz voz, 3 pessoas, você está nesta voz');
    expect(sala2!.disabled).toBe(false);
    expect(buttons(nav(ready(), { callBusy: true }).root, 'channel-voice').every((b) => b.disabled)).toBe(true);
    expect(buttons(nav(ready(), { closed: true }).root, 'channel-voice').every((b) => b.disabled)).toBe(true);
  });

  it('o canal de texto aberto fica marcado; mensagens e estados aparecem como texto', () => {
    const { root } = nav(ready({ message: { tone: 'error', text: 'Já existe um canal' } }), { openTextId: EXTRA.channel_id });
    const open = buttons(root, 'channel-link').find((b) => b.attrs.get('aria-current') === 'true')!;
    expect(open.allText.trim()).toBe('# estratégia');
    expect(root.find((e) => e.className.includes('channel-message'))[0]!.attrs.get('role')).toBe('alert');
    expect(nav({ ...ready(), status: 'loading', channels: [] }).root.allText).toContain('Carregando canais…');
  });

  it('nomes de canais e de pessoas nunca passam por HTML', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const { root } = nav(ready({ channels: [{ ...EXTRA, name: evil }], participants: {} }));
    expect(root.allText).toContain(evil); // como texto
    const src = readFileSync(new URL('../src/web/channels.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
  });
});
