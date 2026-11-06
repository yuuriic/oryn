// Chat persistente por sala, pelas RPCs send_room_message e list_room_messages (migração 0500). Sem DOM: o
// estado e as regras ficam aqui, e a renderização em chat-view.ts. Não usa a sinalização nem o Realtime, e nada aqui
// fala com o PeerCall: o chat funciona dentro ou fora de uma chamada, e uma falha dele nunca alcança a chamada.
//
// O servidor decide: autorização, sala encerrada, limite de taxa e idempotência. Mensagens exibíveis: só textos fixos
// por código curto. O texto das mensagens nunca vai para registro nenhum.
//
// Atualização: consulta periódica a cada 3 s, com o painel aberto e a página visível, pedindo só o que veio depois do
// último `seq`. O servidor atribui `seq` sob a trava da sala, sem lacunas, então esse cursor não perde mensagem.
// Reconciliação: uma mensagem própria que volta na consulta encerra a tentativa de mesmo identificador, inclusive
// a que parecia ter falhado porque a resposta se perdeu.

import { hasChatMessageShape, isChatBody, parseChatMessage, MAX_CHAT_BODY, type ChatMessage, type RoomSummary } from '../contracts.ts';
import { shortCode, type RpcResult } from './supabase-signaling.ts';

export const CHAT_POLL_MS = 3_000;
/** Depois de falhas seguidas, a consulta vai se espaçando até este limite. */
export const CHAT_POLL_MAX_MS = 30_000;
export const CHAT_PAGE_SIZE = 50;
/** Máximo que a RPC devolve: uma resposta cheia indica que há mais, e a próxima consulta sai logo. */
export const CHAT_CATCH_UP = 100;
/** Prazo de cada RPC: uma requisição travada não pode segurar a fila de envio nem a consulta periódica. */
export const CHAT_RPC_TIMEOUT_MS = 15_000;

export const CHAT_LOAD_FAILED = 'Não foi possível carregar as mensagens (falha de rede ou do servidor). Tentando de novo…';
export const CHAT_STALE = 'Sem conexão com o servidor: as mensagens podem estar desatualizadas. Tentando de novo…';
export const CHAT_DENIED = 'Esta conta não tem acesso às mensagens desta sala.';
export const CHAT_READ_ONLY = 'Sala encerrada: as mensagens ficam somente para leitura.';
export const CHAT_OLDER_FAILED = 'Não foi possível carregar as mensagens anteriores. Tente de novo.';
export const CHAT_INVALID_BODY = `Mensagem vazia, longa demais (limite de ${MAX_CHAT_BODY} caracteres) ou com caracteres não permitidos.`;

const SEND_ERRORS: Record<string, string> = {
  unauthorized: 'Sem permissão para enviar nesta sala.',
  'room-closed': 'A sala foi encerrada: a mensagem não foi enviada.',
  'rate-limited': 'Muitas mensagens em pouco tempo. Aguarde um pouco e repita.',
  'invalid-argument': 'O servidor recusou esta mensagem.',
};
const SEND_FAILED = 'Não enviada (falha de rede ou do servidor).';

export type ChatStatus = 'closed' | 'loading' | 'ready' | 'error' | 'denied';

export interface PendingMessage {
  /** Identificador da tentativa: é o mesmo em toda repetição, e o servidor não duplica. */
  nonce: string;
  body: string;
  state: 'sending' | 'failed';
  error: string | null;
}

export interface ChatState {
  roomId: string | null;
  status: ChatStatus;
  /** Confirmadas pelo servidor, em ordem crescente de seq. */
  messages: ChatMessage[];
  /** Ainda sem confirmação, na ordem de envio. */
  pending: PendingMessage[];
  hasOlder: boolean;
  loadingOlder: boolean;
  readOnly: boolean;
  /** A última consulta periódica falhou: o que está na tela pode estar desatualizado. */
  stale: boolean;
  /** Linhas com as colunas certas e valor fora da regra: ignoradas, sem derrubar as demais. */
  skipped: number;
  /** Aviso avulso (mensagem recusada no cliente, página anterior que falhou). */
  notice: string | null;
}

export interface ChatDeps {
  rpc<T>(fn: string, args: Record<string, unknown>): Promise<RpcResult<T>>;
  /** Identificador novo para cada mensagem (crypto.randomUUID na página). */
  newNonce(): string;
  /** Página em segundo plano: a consulta periódica é adiada. Só leitura: nenhum evento de visibilidade é usado. */
  isHidden(): boolean;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  onChange(state: ChatState): void;
  /** O servidor informou que a sala foi encerrada: a página atualiza a lista de salas. */
  onRoomClosed?(roomId: string): void;
}

const CLOSED: ChatState = { roomId: null, status: 'closed', messages: [], pending: [], hasOlder: false, loadingOlder: false, readOnly: false, stale: false, skipped: 0, notice: null };

/** Resposta das RPCs. `null` = fora do contrato (não é lista, ou alguma linha sem exatamente as colunas): é erro. */
export function parseChatRows(data: unknown): { rows: ChatMessage[]; skipped: number; lastSeq: number; count: number } | null {
  if (!Array.isArray(data) || !data.every(hasChatMessageShape)) return null;
  const parsed = data.map(parseChatMessage);
  const lastSeq = data.reduce<number>((max, row) => Math.max(max, Number((row as Record<string, unknown>)['seq'])), 0);
  return { rows: parsed.filter((m): m is ChatMessage => m !== null), skipped: parsed.filter((m) => m === null).length, lastSeq, count: data.length };
}

export class ChatController {
  private s: ChatState = CLOSED;
  /** Muda ao abrir, fechar e sair da conta: uma resposta da sala ou da conta anterior é descartada. */
  private generation = 0;
  private timer: unknown = null;
  private failures = 0;
  private polling = false;
  /** Último seq visto, mesmo de linha ignorada: o cursor sempre avança. */
  private cursor = 0;
  private loaded = false;
  /** Fila de envio: a ordem digitada é a ordem no servidor. */
  private queue: Promise<void> = Promise.resolve();

  private readonly deps: ChatDeps;

  constructor(deps: ChatDeps) {
    this.deps = deps;
  }

  get state(): ChatState {
    return this.s;
  }

  /** RPC com prazo. Vencido o prazo, vale como falha; a resposta tardia é ignorada, e a consulta reconcilia. */
  private call(fn: string, args: Record<string, unknown>): Promise<RpcResult<unknown[]>> {
    const failed: RpcResult<unknown[]> = { data: null, error: 'erro' };
    return new Promise((resolve) => {
      const timer = this.deps.setTimer(() => resolve(failed), CHAT_RPC_TIMEOUT_MS);
      const finish = (result: RpcResult<unknown[]>): void => {
        this.deps.clearTimer(timer);
        resolve(result);
      };
      this.deps.rpc<unknown[]>(fn, args).then(finish, () => finish(failed));
    });
  }

  private set(patch: Partial<ChatState>): void {
    this.s = { ...this.s, ...patch };
    this.deps.onChange(this.s);
  }

  /** Abre o chat de uma sala. A mesma sala, já aberta, só atualiza o modo de leitura. */
  open(roomId: string, readOnly: boolean): void {
    if (this.s.roomId === roomId && this.s.status !== 'closed') {
      if (this.s.readOnly !== readOnly) this.set({ readOnly });
      return;
    }
    this.stop();
    this.set({ ...CLOSED, roomId, status: 'loading', readOnly });
    void this.tick();
  }

  /** Fecha o painel. Em logout, descarta tudo o que estiver em curso. */
  close(): void {
    this.stop();
    this.set(CLOSED);
  }

  private stop(): void {
    this.generation += 1;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    this.failures = 0;
    this.polling = false;
    this.cursor = 0;
    this.loaded = false;
    this.queue = Promise.resolve();
  }

  /** A lista de salas foi atualizada: a sala aberta pode ter sido encerrada. */
  syncRooms(rooms: readonly RoomSummary[]): void {
    const room = rooms.find((r) => r.room_id === this.s.roomId);
    if (room && this.s.readOnly === room.is_open) this.set({ readOnly: !room.is_open });
  }

  private schedule(ms: number): void {
    const gen = this.generation;
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      if (gen === this.generation) void this.tick();
    }, ms);
  }

  private retryDelay(): number {
    return Math.min(CHAT_POLL_MS * 2 ** this.failures, CHAT_POLL_MAX_MS);
  }

  private merge(rows: readonly ChatMessage[]): { messages: ChatMessage[]; pending: PendingMessage[] } {
    const bySeq = new Map(this.s.messages.map((m) => [m.seq, m]));
    for (const row of rows) bySeq.set(row.seq, row);
    const confirmed = new Set(rows.map((r) => r.client_nonce).filter((n) => n !== null));
    return {
      messages: [...bySeq.values()].sort((a, b) => a.seq - b.seq),
      pending: this.s.pending.filter((p) => !confirmed.has(p.nonce)),
    };
  }

  /** Primeira carga ou consulta periódica. Só uma por vez. */
  private async tick(): Promise<void> {
    if (this.polling) return;
    if (this.deps.isHidden() && this.loaded) {
      this.schedule(CHAT_POLL_MS);
      return;
    }
    const gen = this.generation;
    const roomId = this.s.roomId;
    if (roomId === null) return;
    this.polling = true;
    const first = !this.loaded;
    const args = first ? { p_room_id: roomId, p_limit: CHAT_PAGE_SIZE } : { p_room_id: roomId, p_after_seq: this.cursor, p_limit: CHAT_CATCH_UP };
    const res = await this.call('list_room_messages', args);
    if (gen !== this.generation) return;
    this.polling = false;

    if (res.error && shortCode(res.error) === 'unauthorized') {
      this.set({ status: 'denied', messages: [], pending: [], hasOlder: false, stale: false, notice: null });
      return; // sem acesso: não insiste
    }
    const parsed = res.error ? null : parseChatRows(res.data);
    if (!parsed) {
      if (first) {
        if (this.s.status !== 'error') this.set({ status: 'error' });
      } else if (!this.s.stale) {
        this.set({ stale: true });
      }
      this.failures += 1;
      this.schedule(this.retryDelay());
      return;
    }

    this.failures = 0;
    this.cursor = Math.max(this.cursor, parsed.lastSeq);
    if (first) {
      this.loaded = true;
      this.set({ ...this.merge(parsed.rows), status: 'ready', stale: false, skipped: parsed.skipped, hasOlder: parsed.count === CHAT_PAGE_SIZE });
    } else if (parsed.count > 0 || this.s.stale) {
      this.set({ ...this.merge(parsed.rows), stale: false, skipped: this.s.skipped + parsed.skipped });
    }
    // Resposta cheia: há mais a buscar, sem esperar o intervalo.
    this.schedule(!first && parsed.count === CHAT_CATCH_UP ? 0 : CHAT_POLL_MS);
  }

  /** Busca a página anterior à primeira mensagem carregada. */
  async loadOlder(): Promise<void> {
    if (this.s.status !== 'ready' || !this.s.hasOlder || this.s.loadingOlder) return;
    const gen = this.generation;
    const roomId = this.s.roomId;
    const before = this.s.messages[0]?.seq;
    if (roomId === null || before === undefined) return;
    this.set({ loadingOlder: true, notice: null });
    const res = await this.call('list_room_messages', { p_room_id: roomId, p_before_seq: before, p_limit: CHAT_PAGE_SIZE });
    if (gen !== this.generation) return;
    const parsed = res.error ? null : parseChatRows(res.data);
    if (!parsed) {
      this.set({ loadingOlder: false, notice: CHAT_OLDER_FAILED });
      return;
    }
    this.set({ ...this.merge(parsed.rows), loadingOlder: false, hasOlder: parsed.count === CHAT_PAGE_SIZE, skipped: this.s.skipped + parsed.skipped });
  }

  /** Envia uma mensagem nova. `true` = aceita para envio: a página pode limpar o campo. */
  send(body: string): boolean {
    if (this.s.roomId === null || this.s.status === 'closed' || this.s.status === 'denied' || this.s.readOnly) return false;
    if (!isChatBody(body)) {
      this.set({ notice: CHAT_INVALID_BODY });
      return false;
    }
    const message: PendingMessage = { nonce: this.deps.newNonce(), body, state: 'sending', error: null };
    this.set({ pending: [...this.s.pending, message], notice: null });
    this.enqueue(message.nonce);
    return true;
  }

  /** Repete uma mensagem que falhou, com o mesmo identificador: o servidor não duplica. */
  retry(nonce: string): void {
    const message = this.s.pending.find((p) => p.nonce === nonce && p.state === 'failed');
    if (!message || this.s.status === 'denied' || this.s.readOnly) return;
    this.patchPending(nonce, { state: 'sending', error: null });
    this.enqueue(nonce);
  }

  /** Desiste de uma mensagem que falhou. Só some da tela: pode ter chegado ao servidor, e aí a consulta a traz. */
  discard(nonce: string): void {
    const message = this.s.pending.find((p) => p.nonce === nonce && p.state === 'failed');
    if (message) this.set({ pending: this.s.pending.filter((p) => p !== message) });
  }

  private patchPending(nonce: string, patch: Partial<PendingMessage>): void {
    this.set({ pending: this.s.pending.map((p) => (p.nonce === nonce ? { ...p, ...patch } : p)) });
  }

  private enqueue(nonce: string): void {
    this.queue = this.queue.then(() => this.deliver(nonce));
  }

  private async deliver(nonce: string): Promise<void> {
    const gen = this.generation;
    const roomId = this.s.roomId;
    const message = this.s.pending.find((p) => p.nonce === nonce);
    if (roomId === null || !message) return; // já confirmada pela consulta periódica, ou descartada
    const res = await this.call('send_room_message', { p_room_id: roomId, p_client_nonce: nonce, p_body: message.body });
    if (gen !== this.generation) return;
    const parsed = res.error ? null : parseChatRows(res.data);
    if (parsed && parsed.rows[0]?.client_nonce === nonce) {
      this.set(this.merge(parsed.rows));
      return;
    }
    const code = shortCode(res.error);
    if (code === 'room-closed') {
      this.deps.onRoomClosed?.(roomId);
      this.set({ readOnly: true });
    }
    if (this.s.pending.some((p) => p.nonce === nonce)) this.patchPending(nonce, { state: 'failed', error: SEND_ERRORS[code] ?? SEND_FAILED });
  }
}
