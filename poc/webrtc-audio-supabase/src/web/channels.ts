// Canais do espaço (I-2), pelas RPCs da migração 0900: list_channels, create_channel, archive_channel e
// get_channel_participants. Sem DOM nas regras; a renderização da lista fica em renderChannelNav, só com
// createElement + textContent (nomes de canais e de pessoas vêm de outros usuários e nunca passam por HTML).
//
// O servidor decide tudo: pertença, dono, sala encerrada, tipo e arquivamento. Aqui só se esconde o que não faz sentido
// oferecer. Mensagens exibíveis: só textos fixos por código curto.
//
// Atualização: consulta periódica com o espaço aberto e a página visível (lista e participantes das vozes ativas).
import { isRoomName, isUuid, parseVoiceParticipant, type VoiceParticipant } from '../contracts.ts';
import { shortCode, type RpcResult } from './supabase-signaling.ts';

export const CHANNELS_POLL_MS = 10_000;
export const CHANNELS_RPC_TIMEOUT_MS = 15_000;
/** Limite do servidor (create_channel): canais ativos por espaço. */
export const MAX_ACTIVE_CHANNELS = 20;

export const CHANNELS_LOAD_FAILED = 'Não foi possível carregar os canais (falha de rede ou do servidor). Tentando de novo…';
export const CHANNELS_DENIED = 'Esta conta não participa mais deste espaço.';
export const CHANNEL_NAME_INVALID = 'Nome do canal: de 1 a 40 caracteres, sem caracteres de controle.';
const CREATE_ERRORS: Record<string, string> = {
  unauthorized: 'Só o dono do espaço cria canais.',
  'room-closed': 'O espaço foi encerrado: não é possível criar canais.',
  'name-taken': 'Já existe um canal ativo desse tipo com esse nome. Escolha outro.',
  'limit-reached': `Limite de ${MAX_ACTIVE_CHANNELS} canais ativos neste espaço: arquive um antes de criar outro.`,
  'invalid-argument': CHANNEL_NAME_INVALID,
};
const CREATE_FAILED = 'Não foi possível criar o canal (falha de rede ou do servidor). Tente de novo.';
const ARCHIVE_ERRORS: Record<string, string> = {
  unauthorized: 'Só o dono do espaço arquiva canais.',
  'room-closed': 'O espaço foi encerrado: os canais ficam como estão.',
  'invalid-argument': 'Os canais padrão não podem ser arquivados.',
};
const ARCHIVE_FAILED = 'Não foi possível arquivar o canal (falha de rede ou do servidor). Tente de novo.';

export type ChannelKind = 'text' | 'voice';
export interface ChannelSummary {
  channel_id: string;
  kind: ChannelKind;
  name: string;
  position: number;
  is_default: boolean;
  archived_at: string | null;
  created_at: string;
}
const CHANNEL_KEYS = 'archived_at,channel_id,created_at,is_default,kind,name,position';

/** Linha de list_channels. `null` = fora do contrato ou com valor fora da regra. */
export function parseChannel(v: unknown): ChannelSummary | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).sort().join(',') !== CHANNEL_KEYS) return null;
  if (!isUuid(o['channel_id']) || (o['kind'] !== 'text' && o['kind'] !== 'voice') || !isRoomName(o['name'])) return null;
  if (typeof o['position'] !== 'number' || !Number.isInteger(o['position']) || typeof o['is_default'] !== 'boolean') return null;
  if ((o['archived_at'] !== null && typeof o['archived_at'] !== 'string') || typeof o['created_at'] !== 'string') return null;
  return { channel_id: o['channel_id'], kind: o['kind'], name: o['name'], position: o['position'], is_default: o['is_default'], archived_at: o['archived_at'] as string | null, created_at: o['created_at'] };
}

/** Lista inteira. `null` = não é lista: erro, e não lista vazia. Linhas fora da regra são ignoradas e contadas. */
export function parseChannelList(data: unknown): { channels: ChannelSummary[]; skipped: number } | null {
  if (!Array.isArray(data)) return null;
  const parsed = data.map(parseChannel);
  return { channels: parsed.filter((c): c is ChannelSummary => c !== null), skipped: parsed.filter((c) => c === null).length };
}

export const activeChannels = (channels: readonly ChannelSummary[], kind?: ChannelKind): ChannelSummary[] =>
  channels.filter((c) => c.archived_at === null && (kind === undefined || c.kind === kind));

/** Canal padrão de um tipo (sempre existe e nunca é arquivado, pela regra do servidor). */
export const defaultChannel = (channels: readonly ChannelSummary[], kind: ChannelKind): ChannelSummary | undefined =>
  channels.find((c) => c.kind === kind && c.is_default);

export type ChannelsStatus = 'closed' | 'loading' | 'ready' | 'error' | 'denied';

export interface ChannelsState {
  roomId: string | null;
  status: ChannelsStatus;
  channels: ChannelSummary[];
  /** Participantes vivos de cada canal de voz ativo, pela última consulta. */
  participants: Record<string, VoiceParticipant[]>;
  /** Operação em curso: criação, ou o canal que está sendo arquivado. */
  busy: 'create' | { archiving: string } | null;
  message: { tone: 'info' | 'error'; text: string } | null;
}

export interface ChannelsDeps {
  rpc<T>(fn: string, args: Record<string, unknown>): Promise<RpcResult<T>>;
  confirm(message: string): boolean;
  isHidden(): boolean;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  onChange(state: ChannelsState): void;
  /** Um canal deixou de existir para a lista (arquivado ou perdido): a página fecha o que dependia dele. */
  onChannelGone?(channelId: string): void;
}

const CLOSED: ChannelsState = { roomId: null, status: 'closed', channels: [], participants: {}, busy: null, message: null };

export class ChannelsController {
  private s: ChannelsState = CLOSED;
  /** Muda ao abrir, fechar e sair da conta: respostas do espaço anterior são descartadas. */
  private generation = 0;
  private timer: unknown = null;
  private loading = false;
  private readonly deps: ChannelsDeps;

  constructor(deps: ChannelsDeps) {
    this.deps = deps;
  }

  get state(): ChannelsState {
    return this.s;
  }

  private set(patch: Partial<ChannelsState>): void {
    this.s = { ...this.s, ...patch };
    this.deps.onChange(this.s);
  }

  private call<T>(fn: string, args: Record<string, unknown>): Promise<RpcResult<T>> {
    const failed: RpcResult<T> = { data: null, error: 'erro' };
    return new Promise((resolve) => {
      const timer = this.deps.setTimer(() => resolve(failed), CHANNELS_RPC_TIMEOUT_MS);
      const finish = (r: RpcResult<T>): void => {
        this.deps.clearTimer(timer);
        resolve(r);
      };
      this.deps.rpc<T>(fn, args).then(finish, () => finish(failed));
    });
  }

  /** Abre os canais de um espaço. O mesmo espaço, já aberto, não recarrega. */
  open(roomId: string): void {
    if (this.s.roomId === roomId && this.s.status !== 'closed') return;
    this.stop();
    this.set({ ...CLOSED, roomId, status: 'loading' });
    void this.refresh();
  }

  close(): void {
    this.stop();
    this.set(CLOSED);
  }

  private stop(): void {
    this.generation += 1;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    this.loading = false;
  }

  private schedule(): void {
    const gen = this.generation;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      if (gen === this.generation) void this.refresh();
    }, CHANNELS_POLL_MS);
  }

  /** Lista e participantes das vozes ativas. Só uma por vez; em segundo plano, adia. */
  async refresh(): Promise<void> {
    const roomId = this.s.roomId;
    if (roomId === null || this.loading) return;
    if (this.deps.isHidden() && this.s.status === 'ready') return this.schedule();
    const gen = this.generation;
    this.loading = true;
    const res = await this.call<unknown[]>('list_channels', { p_room_id: roomId });
    if (gen !== this.generation) return;
    this.loading = false;
    if (res.error && shortCode(res.error) === 'unauthorized') {
      this.set({ status: 'denied', channels: [], participants: {}, message: { tone: 'error', text: CHANNELS_DENIED } });
      return; // sem acesso: não insiste
    }
    const parsed = res.error ? null : parseChannelList(res.data);
    if (!parsed) {
      this.set(this.s.status === 'ready' ? {} : { status: 'error', message: { tone: 'error', text: CHANNELS_LOAD_FAILED } });
      return this.schedule();
    }
    const before = new Set(activeChannels(this.s.channels).map((c) => c.channel_id));
    const now = new Set(activeChannels(parsed.channels).map((c) => c.channel_id));
    const participants: Record<string, VoiceParticipant[]> = {};
    for (const voice of activeChannels(parsed.channels, 'voice')) {
      const p = await this.call<unknown[]>('get_channel_participants', { p_channel_id: voice.channel_id });
      if (gen !== this.generation) return;
      participants[voice.channel_id] = p.error ? (this.s.participants[voice.channel_id] ?? [])
        : (p.data ?? []).map(parseVoiceParticipant).filter((x): x is VoiceParticipant => x !== null);
    }
    const keepMessage = this.s.status === 'ready' ? this.s.message : null;
    this.set({ status: 'ready', channels: parsed.channels, participants, message: keepMessage });
    for (const id of before) if (!now.has(id)) this.deps.onChannelGone?.(id);
    this.schedule();
  }

  /** Cria um canal (o servidor só aceita do dono). Devolve o id criado (a página limpa o formulário), ou null. */
  async create(name: string, kind: ChannelKind): Promise<string | null> {
    const roomId = this.s.roomId;
    if (roomId === null || this.s.busy !== null) return null;
    const trimmed = name.trim();
    if (!isRoomName(trimmed)) {
      this.set({ message: { tone: 'error', text: CHANNEL_NAME_INVALID } });
      return null;
    }
    const gen = this.generation;
    this.set({ busy: 'create', message: null });
    const res = await this.call<string>('create_channel', { p_room_id: roomId, p_name: trimmed, p_kind: kind });
    if (gen !== this.generation) return null;
    const id = typeof res.data === 'string' && isUuid(res.data) ? res.data : null;
    if (res.error || id === null) {
      this.set({ busy: null, message: { tone: 'error', text: CREATE_ERRORS[shortCode(res.error)] ?? CREATE_FAILED } });
      return null;
    }
    this.set({ busy: null, message: { tone: 'info', text: `Canal "${trimmed}" criado.` } });
    await this.refresh();
    return id;
  }

  /** Arquiva um canal, com confirmação. Na voz, quem estiver nele sai da chamada. */
  async archive(channelId: string): Promise<boolean> {
    const channel = this.s.channels.find((c) => c.channel_id === channelId);
    if (!channel || channel.is_default || channel.archived_at !== null || this.s.busy !== null) return false;
    const detail = channel.kind === 'voice'
      ? 'Quem estiver na voz deste canal será desconectado.'
      : 'As mensagens continuam legíveis, mas ninguém poderá enviar novas.';
    if (!this.deps.confirm(`Arquivar o canal "${channel.name}"? ${detail} Não é possível desarquivar.`)) return false;
    const gen = this.generation;
    this.set({ busy: { archiving: channelId }, message: null });
    const res = await this.call<string>('archive_channel', { p_channel_id: channelId });
    if (gen !== this.generation) return false;
    if (res.error) {
      this.set({ busy: null, message: { tone: 'error', text: ARCHIVE_ERRORS[shortCode(res.error)] ?? ARCHIVE_FAILED } });
      return false;
    }
    this.set({ busy: null, message: { tone: 'info', text: `Canal "${channel.name}" arquivado.` } });
    await this.refresh();
    return true;
  }

  dismissMessage(): void {
    if (this.s.message !== null) this.set({ message: null });
  }
}

// ---------- renderização ----------

export interface ChannelDocument {
  createElement(tag: string): HTMLElement;
}

export interface ChannelNavOptions {
  /** Dono do espaço, com o espaço aberto: vê as ações de gerenciamento. O servidor confere de novo. */
  canManage: boolean;
  /** Espaço encerrado: só leitura (texto legível; voz indisponível). */
  closed: boolean;
  /** Canal de texto aberto no centro. */
  openTextId: string | null;
  /** Canal de voz da chamada em curso, se for deste espaço. */
  activeVoiceId: string | null;
  /** Canal de voz aberto no centro (o palco), com ou sem chamada. */
  selectedVoiceId?: string | null;
  /** Há uma chamada (ou verificação de entrada) em curso: nenhuma outra entrada é oferecida. */
  callBusy: boolean;
  onOpenText(channelId: string): void;
  onJoinVoice(channelId: string): void;
  /** A voz da própria chamada: só volta ao palco, sem nova entrada. */
  onOpenVoice?(channelId: string): void;
  onArchive(channelId: string): void;
  /** "+" de cada seção (só com `canManage`): abre a criação já com o tipo da seção. */
  onCreate?(kind: ChannelKind): void;
  /** Canal com o menu de opções aberto, para o redesenho não fechá-lo. */
  openMenuId?: string | null;
  onMenuToggle?(channelId: string, open: boolean): void;
}

/** Nome de canal aceito pelo servidor (create_channel): a mesma regra do nome de sala. */
export const isChannelName = (name: string): boolean => isRoomName(name.trim());

/** Lista de canais do espaço selecionado: texto primeiro, depois voz com os participantes. Arquivados não aparecem. */
export function renderChannelNav(doc: ChannelDocument, state: ChannelsState, opts: ChannelNavOptions): HTMLElement {
  const el = (tag: string, text?: string, className?: string): HTMLElement => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const root = el('div');
  if (state.status === 'loading') root.append(el('p', 'Carregando canais…', 'muted channel-status'));
  if (state.status === 'error' || state.status === 'denied') root.append(el('p', state.message?.text ?? CHANNELS_LOAD_FAILED, 'error channel-status'));
  if (state.status !== 'ready') return root;

  // Ações do dono num menu do canal ("⋯"), para não espremer o nome. Mesmas permissões: só com `canManage`.
  const archiveButton = (c: ChannelSummary): HTMLElement | null => {
    if (!opts.canManage || c.is_default) return null;
    const archiving = typeof state.busy === 'object' && state.busy !== null && state.busy.archiving === c.channel_id;
    const b = el('button', archiving ? 'Arquivando…' : 'Arquivar', 'channel-archive ghost-btn') as HTMLButtonElement;
    b.type = 'button';
    b.disabled = state.busy !== null;
    b.setAttribute('aria-label', `Arquivar o canal ${c.name}`);
    b.addEventListener('click', () => opts.onArchive(c.channel_id));
    const menu = el('details', undefined, 'channel-menu');
    // O redesenho periódico não pode fechar o menu que a pessoa abriu (nem durante o arquivamento).
    if (opts.openMenuId === c.channel_id || archiving) menu.setAttribute('open', '');
    menu.addEventListener('toggle', () => opts.onMenuToggle?.(c.channel_id, (menu as HTMLDetailsElement).open));
    const summary = el('summary', '⋯', 'channel-menu-btn');
    summary.setAttribute('aria-label', `Opções do canal ${c.name}`);
    summary.setAttribute('title', `Opções do canal ${c.name}`);
    const box = el('div', undefined, 'channel-menu-list');
    box.append(b);
    menu.append(summary, box);
    return menu;
  };

  const section = (title: string, kind: ChannelKind): HTMLElement | null => {
    const list = activeChannels(state.channels, kind);
    const creatable = opts.canManage && !opts.closed && opts.onCreate !== undefined;
    if (list.length === 0 && !creatable) return null;
    const box = el('div', undefined, `channel-group channel-group-${kind}`);
    const head = el('div', undefined, 'channel-heading-row');
    head.append(el('p', title, 'channel-heading'));
    if (creatable) {
      const { onCreate } = opts;
      const label = kind === 'text' ? 'Criar canal de texto' : 'Criar canal de voz';
      const add = el('button', '+', 'channel-add icon-btn') as HTMLButtonElement;
      add.type = 'button';
      add.setAttribute('aria-label', label);
      add.setAttribute('title', label);
      add.setAttribute('data-create-kind', kind);
      add.disabled = state.busy !== null;
      add.addEventListener('click', () => onCreate?.(kind));
      head.append(add);
    }
    box.append(head);
    const ul = el('ul', undefined, 'channel-list');
    for (const c of list) {
      const li = el('li', undefined, 'channel-item');
      const row = el('div', undefined, 'channel-row');
      if (kind === 'text') {
        const open = opts.openTextId === c.channel_id;
        const b = el('button', undefined, `channel-link${open ? ' channel-open' : ''}`) as HTMLButtonElement;
        b.type = 'button';
        b.append(el('span', '#', 'channel-icon'), el('span', c.name, 'channel-name'));
        b.setAttribute('aria-label', `Canal de texto ${c.name}${open ? ', aberto' : ''}`);
        if (open) b.setAttribute('aria-current', 'true');
        b.addEventListener('click', () => opts.onOpenText(c.channel_id));
        row.append(b);
      } else {
        const here = opts.activeVoiceId === c.channel_id;
        const shown = opts.selectedVoiceId === c.channel_id;
        const people = state.participants[c.channel_id] ?? [];
        const b = el('button', undefined, `channel-link channel-voice${here ? ' channel-in-call' : ''}${shown ? ' channel-open' : ''}`) as HTMLButtonElement;
        b.type = 'button';
        b.append(el('span', '🔊', 'channel-icon'), el('span', c.name, 'channel-name'));
        // A voz da própria chamada continua clicável, mas só para voltar ao palco: nunca uma segunda entrada.
        const canReturn = here && opts.onOpenVoice !== undefined;
        const action = here ? (canReturn ? 'você está nesta voz, abrir' : 'você está nesta voz') : opts.closed ? 'espaço encerrado' : 'entrar na voz';
        b.setAttribute('aria-label', `Canal de voz ${c.name}, ${people.length} ${people.length === 1 ? 'pessoa' : 'pessoas'}, ${action}`);
        b.disabled = here ? !canReturn : opts.closed || opts.callBusy;
        if (shown || (here && opts.selectedVoiceId === undefined)) b.setAttribute('aria-current', 'true');
        b.addEventListener('click', () => (here ? opts.onOpenVoice?.(c.channel_id) : opts.onJoinVoice(c.channel_id)));
        row.append(b);
        if (people.length > 0) {
          const who = el('ul', undefined, 'channel-people');
          who.setAttribute('aria-label', `Na voz ${c.name}`);
          // Uma linha por conta (duas abas da mesma pessoa contam uma vez).
          const seen = new Set<string>();
          for (const p of people) {
            if (seen.has(p.participant_ref)) continue;
            seen.add(p.participant_ref);
            who.append(el('li', p.is_self ? `${p.display_name} (você)` : p.display_name));
          }
          li.append(row, who);
        }
      }
      const archive = archiveButton(c);
      if (archive) row.append(archive);
      if (!li.contains(row)) li.prepend(row);
      ul.append(li);
    }
    box.append(ul);
    return box;
  };

  for (const s of [section('Texto', 'text'), section('Voz', 'voice')]) if (s) root.append(s);
  if (state.message) {
    const msg = el('p', state.message.text, state.message.tone === 'error' ? 'error channel-message' : 'notice channel-message');
    msg.setAttribute('role', state.message.tone === 'error' ? 'alert' : 'status');
    root.append(msg);
  }
  return root;
}
