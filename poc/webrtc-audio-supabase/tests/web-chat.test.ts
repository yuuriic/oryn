// Chat por sala no cliente: contrato, controlador (ChatController) e renderização. O controlador roda contra um
// servidor falso nos cenários de falha e contra o Postgres real em memória no fluxo de ponta a ponta.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hasChatMessageShape, isChatBody, parseChatMessage, type ChatMessage, type RoomSummary } from '../src/contracts.ts';
import { CHAT_CATCH_UP, CHAT_INVALID_BODY, CHAT_OLDER_FAILED, CHAT_PAGE_SIZE, CHAT_POLL_MAX_MS, CHAT_POLL_MS, CHAT_RPC_TIMEOUT_MS, ChatController, parseChatRows, type ChatDeps, type ChatState } from '../src/web/chat.ts';
import { chatStatusText, renderChatMessages } from '../src/web/chat-view.ts';
import { renderLobby } from '../src/web/rooms-view.ts';
import type { LobbyState } from '../src/web/rooms.ts';
import type { RpcResult } from '../src/web/supabase-signaling.ts';
import { TestDb, type Actor } from './helpers/db.ts';
import { scenario } from './helpers/fixtures.ts';

const ROOM = '11111111-1111-4111-8111-111111111111';
const OTHER_ROOM = '22222222-2222-4222-8222-222222222222';
const nonce = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const row = (seq: number, over: Partial<ChatMessage> = {}): ChatMessage => ({ seq, display_name: 'Amigo', is_mine: false, client_nonce: null, body: `m${seq}`, created_at: '2026-11-06T12:00:00+00:00', ...over });
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

type Handler = (args: Record<string, unknown>) => RpcResult<unknown[]> | Promise<RpcResult<unknown[]>> | 'hang' | 'reject';

function harness(handlers: Partial<Record<string, Handler>> = {}, hidden = { value: false }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 1;
  let nextNonce = 1;
  const states: ChatState[] = [];
  const closed: string[] = [];
  const h = { ...handlers } as Record<string, Handler | undefined>;
  const deps: ChatDeps = {
    rpc: async <T,>(fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      const result = (h[fn] ?? (() => ({ data: [], error: null })))(args);
      if (result === 'hang') return new Promise<RpcResult<T>>(() => undefined);
      if (result === 'reject') throw new Error('rede');
      return result as RpcResult<T>;
    },
    newNonce: () => nonce(nextNonce++),
    isHidden: () => hidden.value,
    setTimer: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id) => void timers.delete(id as number),
    onChange: (s) => states.push(s),
    onRoomClosed: (id) => closed.push(id),
  };
  const chat = new ChatController(deps);
  /** Dispara os temporizadores do intervalo de `ms`, deixando em paz os prazos de RPC. */
  const fire = async (ms: number) => {
    for (const [id, t] of [...timers]) {
      if (t.ms === ms) {
        timers.delete(id);
        t.fn();
      }
    }
    await flush();
  };
  const delays = () => [...timers.values()].map((t) => t.ms).filter((ms) => ms !== CHAT_RPC_TIMEOUT_MS);
  const listCalls = () => calls.filter((c) => c.fn === 'list_room_messages');
  const sendCalls = () => calls.filter((c) => c.fn === 'send_room_message');
  return { chat, calls, h, states, closed, fire, delays, listCalls, sendCalls, timers };
}

const opened = async (handlers: Partial<Record<string, Handler>> = {}, readOnly = false, hidden = { value: false }) => {
  const t = harness(handlers, hidden);
  t.chat.open(ROOM, readOnly);
  await flush();
  return t;
};
const list = (rows: ChatMessage[]): RpcResult<unknown[]> => ({ data: rows, error: null });
const fail = (error: string): RpcResult<unknown[]> => ({ data: null, error });
const seqs = (s: ChatState) => s.messages.map((m) => m.seq);

describe('renomeação com o chat aberto', () => {
  it('atualiza o histórico sem perder envio pendente, nonce ou cursor de novidades', async () => {
    const t = await opened({ list_room_messages: () => list([row(1)]) });
    t.h['send_room_message'] = () => 'hang';
    t.chat.send('Pendente'); await flush();
    const pending = t.chat.state.pending;
    t.h['list_room_messages'] = () => list([row(1, { display_name: 'Novo nome' })]);
    await t.chat.refreshNames();
    expect(t.chat.state.messages[0]!.display_name).toBe('Novo nome');
    expect(t.chat.state.pending).toEqual(pending);
    t.h['list_room_messages'] = () => list([]);
    await t.fire(CHAT_POLL_MS);
    expect(t.listCalls().at(-1)!.args['p_after_seq']).toBe(1);
  });
  it('resposta de nomes da conta anterior não reaparece depois do logout', async () => {
    const t = await opened({ list_room_messages: () => list([row(1)]) });
    let finish!: (r: RpcResult<unknown[]>) => void;
    t.h['list_room_messages'] = () => new Promise((resolve) => { finish = resolve; });
    const refresh = t.chat.refreshNames();
    t.chat.close(); finish(list([row(1, { display_name: 'Nome antigo' })]));
    await refresh;
    expect(t.chat.state.messages).toEqual([]);
    expect(t.chat.state.status).toBe('closed');
  });
});

describe('contrato', () => {
  it('isChatBody segue as regras da migração', () => {
    for (const ok of ['a', 'linha 1\nlinha 2', '\ttab', '😀'.repeat(4000), 'x'.repeat(4000)]) expect(isChatBody(ok), ok.slice(0, 8)).toBe(true);
    for (const bad of ['', ' ', ' \n\t ', 'a\u0007', 'a\r\nb', 'a\u007f', 'x'.repeat(4001), '😀'.repeat(4001), 1, null]) expect(isChatBody(bad)).toBe(false);
  });

  it('parseChatMessage: exatamente as colunas; o identificador da tentativa só nas próprias', () => {
    const mine = row(1, { is_mine: true, client_nonce: nonce(1) });
    expect(parseChatMessage(mine)).toEqual(mine);
    expect(parseChatMessage(row(2))).toEqual(row(2));
    expect(parseChatMessage({ ...row(1), client_nonce: nonce(1) })).toBeNull(); // de outra pessoa, com identificador
    expect(parseChatMessage({ ...row(1), is_mine: true })).toBeNull(); // própria, sem identificador
    expect(parseChatMessage({ ...row(1), user_id: ROOM })).toBeNull(); // coluna a mais
    expect(parseChatMessage({ ...row(1), body: 'a\u0007' })).toBeNull();
    expect(hasChatMessageShape({ ...row(1), body: 'a\u0007' })).toBe(true); // fora da regra, mas com a estrutura certa
    expect(hasChatMessageShape({ ...row(1), seq: 0 })).toBe(false);
    expect(hasChatMessageShape({ ...row(1), seq: '1' })).toBe(false);
  });

  it('parseChatRows: fora do contrato é erro; valor fora da regra é ignorado e o cursor avança', () => {
    expect(parseChatRows(null)).toBeNull();
    expect(parseChatRows({})).toBeNull();
    expect(parseChatRows([{ seq: 1 }])).toBeNull();
    expect(parseChatRows([row(1), { ...row(2), body: '' }])).toMatchObject({ rows: [row(1)], skipped: 1, lastSeq: 2, count: 2 });
  });
});

describe('carga e atualização periódica', () => {
  it('abre com as mais recentes e consulta a cada 3 s só o que veio depois', async () => {
    const t = await opened({ list_room_messages: () => list([row(1), row(2)]) });
    expect(t.chat.state).toMatchObject({ roomId: ROOM, status: 'ready', hasOlder: false });
    expect(seqs(t.chat.state)).toEqual([1, 2]);
    expect(t.listCalls()[0]!.args).toEqual({ p_room_id: ROOM, p_limit: CHAT_PAGE_SIZE });
    expect(t.delays()).toEqual([CHAT_POLL_MS]);
    expect(CHAT_POLL_MS).toBe(3000);
    t.h['list_room_messages'] = () => list([row(3)]);
    await t.fire(CHAT_POLL_MS);
    expect(t.listCalls()[1]!.args).toEqual({ p_room_id: ROOM, p_after_seq: 2, p_limit: CHAT_CATCH_UP });
    expect(seqs(t.chat.state)).toEqual([1, 2, 3]);
    expect(t.delays()).toEqual([CHAT_POLL_MS]);
  });

  it('consulta sem novidade não redesenha', async () => {
    const t = await opened({ list_room_messages: () => list([row(1)]) });
    t.h['list_room_messages'] = () => list([]);
    const before = t.states.length;
    await t.fire(CHAT_POLL_MS);
    expect(t.states.length).toBe(before);
  });

  it('uma página cheia indica que há anteriores', async () => {
    const t = await opened({ list_room_messages: () => list(Array.from({ length: CHAT_PAGE_SIZE }, (_, i) => row(i + 11))) });
    expect(t.chat.state.hasOlder).toBe(true);
  });

  it('resposta cheia na consulta: a próxima sai sem esperar o intervalo', async () => {
    const t = await opened({ list_room_messages: () => list([row(1)]) });
    t.h['list_room_messages'] = () => list(Array.from({ length: CHAT_CATCH_UP }, (_, i) => row(i + 2)));
    await t.fire(CHAT_POLL_MS);
    expect(t.delays()).toEqual([0]);
  });

  it('página em segundo plano: não consulta, e retoma sozinha ao voltar', async () => {
    const hidden = { value: false };
    const t = await opened({ list_room_messages: () => list([row(1)]) }, false, hidden);
    hidden.value = true;
    await t.fire(CHAT_POLL_MS);
    expect(t.listCalls()).toHaveLength(1);
    expect(t.delays()).toEqual([CHAT_POLL_MS]);
    hidden.value = false;
    await t.fire(CHAT_POLL_MS);
    expect(t.listCalls()).toHaveLength(2);
  });

  it('falha na consulta: mantém as mensagens, avisa, espaça as tentativas e recupera', async () => {
    const t = await opened({ list_room_messages: () => list([row(1)]) });
    t.h['list_room_messages'] = () => 'reject';
    await t.fire(CHAT_POLL_MS);
    expect(t.chat.state.stale).toBe(true);
    expect(seqs(t.chat.state)).toEqual([1]);
    expect(t.delays()).toEqual([CHAT_POLL_MS * 2]);
    await t.fire(CHAT_POLL_MS * 2);
    expect(t.delays()).toEqual([CHAT_POLL_MS * 4]);
    for (const ms of [12_000, 24_000]) await t.fire(ms);
    expect(t.delays()).toEqual([CHAT_POLL_MAX_MS]);
    t.h['list_room_messages'] = () => list([]);
    await t.fire(CHAT_POLL_MAX_MS);
    expect(t.chat.state.stale).toBe(false);
    expect(t.delays()).toEqual([CHAT_POLL_MS]);
  });

  it('falha na primeira carga: erro, sem lista vazia enganosa, e tenta de novo a primeira carga', async () => {
    const t = await opened({ list_room_messages: () => fail('erro de rede') });
    expect(t.chat.state.status).toBe('error');
    t.h['list_room_messages'] = () => list([row(1)]);
    await t.fire(CHAT_POLL_MS * 2);
    expect(t.chat.state.status).toBe('ready');
    expect(t.listCalls()[1]!.args).toEqual({ p_room_id: ROOM, p_limit: CHAT_PAGE_SIZE });
  });

  it('resposta fora do contrato é falha, não lista vazia', async () => {
    const t = await opened({ list_room_messages: () => ({ data: [{ seq: 1 }], error: null }) });
    expect(t.chat.state.status).toBe('error');
  });

  it('consulta travada: o prazo a encerra e a atualização continua', async () => {
    const t = await opened({ list_room_messages: () => list([row(1)]) });
    t.h['list_room_messages'] = () => 'hang';
    await t.fire(CHAT_POLL_MS);
    await t.fire(CHAT_RPC_TIMEOUT_MS);
    expect(t.chat.state.stale).toBe(true);
    t.h['list_room_messages'] = () => list([row(2)]);
    await t.fire(CHAT_POLL_MS * 2);
    expect(seqs(t.chat.state)).toEqual([1, 2]);
  });

  it('sem acesso: limpa a tela e para de consultar', async () => {
    const t = await opened({ list_room_messages: () => list([row(1)]) });
    t.chat.send('oi');
    t.h['list_room_messages'] = () => fail('unauthorized');
    t.h['send_room_message'] = () => 'hang';
    await t.fire(CHAT_POLL_MS);
    expect(t.chat.state).toMatchObject({ status: 'denied', messages: [], pending: [] });
    expect(t.delays()).toEqual([]);
    expect(t.chat.send('outra')).toBe(false);
  });
});

describe('páginas anteriores', () => {
  const full = () => Array.from({ length: CHAT_PAGE_SIZE }, (_, i) => row(i + 51));

  it('busca antes da primeira mensagem e junta em ordem', async () => {
    const t = await opened({ list_room_messages: () => list(full()) });
    t.h['list_room_messages'] = () => list(Array.from({ length: CHAT_PAGE_SIZE }, (_, i) => row(i + 1)));
    await t.chat.loadOlder();
    expect(t.listCalls().at(-1)!.args).toEqual({ p_room_id: ROOM, p_before_seq: 51, p_limit: CHAT_PAGE_SIZE });
    expect(t.chat.state.messages).toHaveLength(100);
    expect(seqs(t.chat.state)[0]).toBe(1);
    expect(t.chat.state.hasOlder).toBe(true);
    t.h['list_room_messages'] = () => list([]);
    await t.chat.loadOlder();
    expect(t.chat.state.hasOlder).toBe(false);
  });

  it('falha: avisa, mantém as carregadas e permite repetir; a consulta periódica segue pelo cursor', async () => {
    const t = await opened({ list_room_messages: () => list(full()) });
    t.h['list_room_messages'] = () => 'reject';
    await t.chat.loadOlder();
    expect(t.chat.state).toMatchObject({ notice: CHAT_OLDER_FAILED, loadingOlder: false, hasOlder: true });
    expect(t.chat.state.messages).toHaveLength(CHAT_PAGE_SIZE);
    t.h['list_room_messages'] = () => list([]);
    await t.fire(CHAT_POLL_MS);
    expect(t.listCalls().at(-1)!.args).toMatchObject({ p_after_seq: 100 });
  });
});

describe('envio', () => {
  const echo: Handler = (args) => list([row(1, { is_mine: true, client_nonce: args['p_client_nonce'] as string, body: args['p_body'] as string })]);

  it('mostra "enviando" e passa a confirmada, sem texto em nenhum outro campo', async () => {
    let release!: (r: RpcResult<unknown[]>) => void;
    const t = await opened({ send_room_message: () => new Promise<RpcResult<unknown[]>>((r) => (release = r)) });
    expect(t.chat.send('olá')).toBe(true);
    await flush();
    expect(t.chat.state.pending).toEqual([{ nonce: nonce(1), body: 'olá', state: 'sending', error: null }]);
    expect(t.sendCalls()[0]!.args).toEqual({ p_room_id: ROOM, p_client_nonce: nonce(1), p_body: 'olá' });
    release(list([row(1, { is_mine: true, client_nonce: nonce(1), body: 'olá' })]));
    await flush();
    expect(t.chat.state.pending).toEqual([]);
    expect(t.chat.state.messages.map((m) => m.body)).toEqual(['olá']);
  });

  it('texto inválido não sai para o servidor', async () => {
    const t = await opened();
    expect(t.chat.send('   ')).toBe(false);
    expect(t.chat.state.notice).toBe(CHAT_INVALID_BODY);
    expect(t.sendCalls()).toEqual([]);
  });

  it('a ordem digitada é a ordem de envio', async () => {
    const order: unknown[] = [];
    const t = await opened({ send_room_message: async (args) => {
      order.push(args['p_body']);
      await flush();
      return list([row(order.length, { is_mine: true, client_nonce: args['p_client_nonce'] as string, body: args['p_body'] as string })]);
    } });
    for (const text of ['um', 'dois', 'três']) t.chat.send(text);
    for (let i = 0; i < 10; i++) await flush();
    expect(order).toEqual(['um', 'dois', 'três']);
    expect(t.chat.state.pending).toEqual([]);
  });

  it.each([
    ['rate-limited', 'Muitas mensagens'],
    ['invalid-argument', 'recusou'],
    ['unauthorized', 'Sem permissão'],
    ['erro de rede qualquer', 'falha de rede'],
  ])('erro %s: falha visível, com texto fixo, sem repassar o que veio do servidor', async (code, text) => {
    const t = await opened({ send_room_message: () => fail(code) });
    t.chat.send('oi');
    await flush();
    expect(t.chat.state.pending[0]).toMatchObject({ state: 'failed', body: 'oi' });
    expect(t.chat.state.pending[0]!.error).toContain(text);
    expect(t.chat.state.pending[0]!.error).not.toContain('qualquer');
  });

  it('repetir usa o MESMO identificador; falha repetida não cria outra entrada', async () => {
    const t = await opened({ send_room_message: () => 'reject' });
    t.chat.send('oi');
    await flush();
    t.chat.retry(nonce(1));
    await flush();
    expect(t.chat.state.pending).toHaveLength(1);
    t.h['send_room_message'] = echo;
    t.chat.retry(nonce(1));
    await flush();
    expect(t.sendCalls().map((c) => c.args['p_client_nonce'])).toEqual([nonce(1), nonce(1), nonce(1)]);
    expect(t.chat.state.pending).toEqual([]);
    expect(t.chat.state.messages).toHaveLength(1);
  });

  it('resposta perdida: a consulta traz a mensagem e encerra a tentativa falha, sem repetição', async () => {
    const t = await opened({ send_room_message: () => 'reject' });
    t.chat.send('oi');
    await flush();
    expect(t.chat.state.pending[0]!.state).toBe('failed');
    t.h['list_room_messages'] = () => list([row(1, { is_mine: true, client_nonce: nonce(1), body: 'oi' })]);
    await t.fire(CHAT_POLL_MS);
    expect(t.chat.state.pending).toEqual([]);
    expect(t.chat.state.messages).toHaveLength(1);
  });

  it('envio travado: o prazo marca a falha e a fila segue', async () => {
    const t = await opened({ send_room_message: () => 'hang' });
    t.chat.send('primeira');
    t.chat.send('segunda');
    await flush();
    await t.fire(CHAT_RPC_TIMEOUT_MS);
    expect(t.chat.state.pending[0]).toMatchObject({ body: 'primeira', state: 'failed' });
    expect(t.sendCalls().map((c) => c.args['p_body'])).toEqual(['primeira', 'segunda']);
  });

  it('descartar some com a tentativa falha, e não com uma em andamento', async () => {
    const t = await opened({ send_room_message: () => 'reject' });
    t.chat.send('oi');
    t.chat.discard(nonce(1)); // ainda em andamento
    expect(t.chat.state.pending).toHaveLength(1);
    await flush();
    t.chat.discard(nonce(1));
    expect(t.chat.state.pending).toEqual([]);
  });
});

describe('sala encerrada', () => {
  it('modo leitura: mostra o histórico e não envia', async () => {
    const t = await opened({ list_room_messages: () => list([row(1)]) }, true);
    expect(t.chat.state).toMatchObject({ readOnly: true, status: 'ready' });
    expect(t.chat.send('oi')).toBe(false);
    expect(t.sendCalls()).toEqual([]);
    expect(chatStatusText(t.chat.state)?.text).toMatch(/somente para leitura/);
  });

  it('encerrada durante o uso: o servidor recusa, o painel vira leitura e a lista de salas é atualizada', async () => {
    const t = await opened({ send_room_message: () => fail('room-closed') });
    t.chat.send('tarde');
    await flush();
    expect(t.chat.state.readOnly).toBe(true);
    expect(t.closed).toEqual([ROOM]);
    expect(t.chat.state.pending[0]).toMatchObject({ state: 'failed' });
    t.chat.retry(nonce(1));
    await flush();
    expect(t.sendCalls()).toHaveLength(1); // não repete em sala encerrada
  });

  it('syncRooms acompanha a lista de salas e ignora as demais', async () => {
    const t = await opened();
    const summary = (id: string, isOpen: boolean) => ({ room_id: id, is_open: isOpen }) as RoomSummary;
    t.chat.syncRooms([summary(OTHER_ROOM, false)]);
    expect(t.chat.state.readOnly).toBe(false);
    t.chat.syncRooms([summary(ROOM, false)]);
    expect(t.chat.state.readOnly).toBe(true);
  });
});

describe('ciclo de vida', () => {
  it('fechar para a consulta e descarta respostas em curso', async () => {
    let release!: (r: RpcResult<unknown[]>) => void;
    const t = await opened({ list_room_messages: () => list([row(1)]) });
    t.h['list_room_messages'] = () => new Promise<RpcResult<unknown[]>>((r) => (release = r));
    await t.fire(CHAT_POLL_MS);
    t.chat.close();
    release(list([row(2)]));
    await flush();
    expect(t.chat.state).toMatchObject({ status: 'closed', roomId: null, messages: [] });
    expect(t.delays()).toEqual([]);
  });

  it('trocar de sala não mistura mensagens: a resposta da sala anterior é descartada', async () => {
    let release!: (r: RpcResult<unknown[]>) => void;
    const t = harness({ list_room_messages: () => new Promise<RpcResult<unknown[]>>((r) => (release = r)) });
    t.chat.open(ROOM, false);
    await flush();
    const firstRelease = release;
    t.h['list_room_messages'] = () => list([row(7)]);
    t.chat.open(OTHER_ROOM, false);
    await flush();
    firstRelease(list([row(1)]));
    await flush();
    expect(t.chat.state.roomId).toBe(OTHER_ROOM);
    expect(seqs(t.chat.state)).toEqual([7]);
  });

  it('abrir a sala já aberta não recomeça a carga nem cria outra consulta', async () => {
    const t = await opened({ list_room_messages: () => list([row(1)]) });
    t.chat.open(ROOM, false);
    await flush();
    expect(t.listCalls()).toHaveLength(1);
    expect(t.delays()).toHaveLength(1);
  });

  it('envio em curso ao fechar: a resposta não altera o estado', async () => {
    let release!: (r: RpcResult<unknown[]>) => void;
    const t = await opened({ send_room_message: () => new Promise<RpcResult<unknown[]>>((r) => (release = r)) });
    t.chat.send('oi');
    await flush();
    t.chat.close();
    release(list([row(1, { is_mine: true, client_nonce: nonce(1), body: 'oi' })]));
    await flush();
    expect(t.chat.state).toMatchObject({ status: 'closed', messages: [], pending: [] });
  });
});

/** Documento falso: só createElement/textContent/append. HTML dinâmico faz o teste falhar. */
class FakeEl {
  textContent: string | null = null;
  className = '';
  type = '';
  disabled = false;
  readonly children: FakeEl[] = [];
  readonly attrs = new Map<string, string>();
  readonly clicks: (() => void)[] = [];
  readonly tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  append(...nodes: FakeEl[]): void {
    this.children.push(...nodes);
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  addEventListener(_event: string, fn: () => void): void {
    this.clicks.push(fn);
  }
  set innerHTML(_v: string) {
    throw new Error('innerHTML proibido');
  }
  get allText(): string {
    return [this.textContent ?? '', ...this.children.map((c) => c.allText)].join(' ');
  }
  find(pred: (e: FakeEl) => boolean): FakeEl[] {
    return [...(pred(this) ? [this] : []), ...this.children.flatMap((c) => c.find(pred))];
  }
}
const fakeDoc = { createElement: (tag: string) => new FakeEl(tag) as unknown as HTMLElement };
const baseState = (over: Partial<ChatState> = {}): ChatState => ({ roomId: ROOM, channelId: null, archived: false, status: 'ready', messages: [], pending: [], hasOlder: false, loadingOlder: false, readOnly: false, stale: false, skipped: 0, notice: null, ...over });
const render = (state: ChatState, on: { retry?: string[]; discard?: string[]; older?: number[] } = {}) =>
  renderChatMessages(fakeDoc, state, {
    onRetry: (n) => on.retry?.push(n),
    onDiscard: (n) => on.discard?.push(n),
    onLoadOlder: () => on.older?.push(1),
  }) as unknown as FakeEl;

describe('renderização', () => {
  it('HTML de uma mensagem vira texto: nenhum elemento é criado a partir dele', () => {
    const html = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const root = render(baseState({ messages: [row(1, { body: html, display_name: '<b>Nome</b>' })] }));
    expect(root.find((e) => ['img', 'script', 'b'].includes(e.tag))).toEqual([]);
    expect(root.find((e) => e.textContent === html)).toHaveLength(1);
    expect(root.allText).toContain('<b>Nome</b>');
  });

  it('os módulos do chat não usam nenhuma API de HTML', () => {
    for (const file of ['chat.ts', 'chat-view.ts']) {
      const source = readFileSync(new URL(`../src/web/${file}`, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
      expect(source, file).not.toMatch(/\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write|\beval\(/);
    }
  });

  it('o chat não registra o texto das mensagens nem usa evento de visibilidade', () => {
    const source = readFileSync(new URL('../src/web/chat.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/console\.|addEventListener/);
    expect(readFileSync(new URL('../src/web/main.ts', import.meta.url), 'utf8')).not.toMatch(/visibilitychange|beforeunload/);
  });

  it('distingue enviada, em andamento e com falha; a falha oferece repetir e descartar', () => {
    const on = { retry: [] as string[], discard: [] as string[] };
    const root = render(baseState({
      messages: [row(1, { is_mine: true, client_nonce: nonce(9), display_name: 'Eu' }), row(2)],
      pending: [{ nonce: nonce(1), body: 'indo', state: 'sending', error: null }, { nonce: nonce(2), body: 'caiu', state: 'failed', error: 'Não enviada.' }],
    }), on);
    expect(root.allText).toContain('Eu (você)');
    expect(root.allText).toContain('Enviando…');
    expect(root.find((e) => e.attrs.get('role') === 'alert').map((e) => e.textContent)).toEqual(['Não enviada.']);
    const buttons = root.find((e) => e.tag === 'button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Repetir', 'Descartar']);
    buttons[0]!.clicks[0]!();
    buttons[1]!.clicks[0]!();
    expect(on).toEqual({ retry: [nonce(2)], discard: [nonce(2)] });
  });

  it('"Carregar anteriores" só com histórico a buscar, e desativado durante a carga', () => {
    const on = { older: [] as number[] };
    expect(render(baseState()).find((e) => e.tag === 'button')).toEqual([]);
    const [button] = render(baseState({ hasOlder: true }), on).find((e) => e.tag === 'button');
    button!.clicks[0]!();
    expect(on.older).toEqual([1]);
    expect(render(baseState({ hasOlder: true, loadingOlder: true })).find((e) => e.tag === 'button')[0]!.disabled).toBe(true);
  });

  it('estados vazios e avisos', () => {
    expect(render(baseState()).allText).toContain('Nenhuma mensagem ainda.');
    expect(render(baseState({ status: 'loading' })).allText).not.toContain('Nenhuma mensagem');
    expect(render(baseState({ skipped: 2 })).allText).toContain('2 mensagem(ns) fora do padrão');
    expect(chatStatusText(baseState())).toBeNull();
    expect(chatStatusText(baseState({ status: 'denied', readOnly: true }))?.tone).toBe('error');
    expect(chatStatusText(baseState({ status: 'loading' }))?.tone).toBe('info');
    expect(chatStatusText(baseState({ status: 'error' }))?.tone).toBe('error');
    expect(chatStatusText(baseState({ stale: true }))?.tone).toBe('error');
    expect(chatStatusText(baseState({ notice: 'x' }))?.text).toBe('x');
  });
});

describe('lobby: acesso ao chat', () => {
  const room = (id: string, isOpen: boolean): RoomSummary => ({ room_id: id, name: 'Sala', role: 'member', is_open: isOpen, closed_at: isOpen ? null : '2026-11-06T12:00:00+00:00', member_count: 2, max_members: 2, created_at: '2026-11-06T12:00:00+00:00' });
  const lobbyState = (rooms: RoomSummary[]): LobbyState => ({ status: 'ready', rooms, skipped: 0, listError: null, actionError: null, busy: null });
  const base = { activeRoomId: null, onJoin: () => undefined, onClose: () => undefined };
  const buttons = (root: FakeEl) => root.find((e) => e.tag === 'button');

  it('disponível com ou sem chamada, enquanto "Entrar na chamada" fica desativado na chamada', () => {
    const opened: string[] = [];
    const inCall = renderLobby(fakeDoc, lobbyState([room(ROOM, true)]), { ...base, callActive: true, activeRoomId: ROOM, onChat: (r) => opened.push(r) }) as unknown as FakeEl;
    const chat = buttons(inCall).find((b) => b.textContent === 'Abrir chat')!;
    expect(chat.disabled).toBe(false);
    expect(buttons(inCall).find((b) => b.textContent === 'Na chamada')!.disabled).toBe(true);
    chat.clicks[0]!();
    expect(opened).toEqual([ROOM]);
  });

  it('sala encerrada: fora da lista, sem "Ver mensagens"', () => {
    const root = renderLobby(fakeDoc, lobbyState([room(ROOM, false)]), { ...base, callActive: false, onChat: () => undefined }) as unknown as FakeEl;
    expect(buttons(root)).toEqual([]);
  });

  it('chat já aberto: o botão indica e fica desativado', () => {
    const root = renderLobby(fakeDoc, lobbyState([room(ROOM, true)]), { ...base, callActive: false, chatRoomId: ROOM, onChat: () => undefined }) as unknown as FakeEl;
    expect(buttons(root).find((b) => b.textContent === 'Chat aberto')!.disabled).toBe(true);
  });

  it('sem o botão se a página não oferecer chat: o contrato anterior do lobby continua igual', () => {
    const root = renderLobby(fakeDoc, lobbyState([room(ROOM, false)]), { ...base, callActive: false }) as unknown as FakeEl;
    expect(buttons(root)).toEqual([]);
  });
});

describe('ponta a ponta com o banco real em memória', () => {
  /** A resposta do PostgREST para bigint é número; a do driver de teste pode não ser. */
  const adapter = (db: TestDb, actor: Actor) => async <T,>(fn: string, args: Record<string, unknown>): Promise<RpcResult<T>> => {
    try {
      const rows = await db.rpc<Record<string, unknown>>(actor, `public.${fn}`, args);
      return { data: rows.map((r) => ({ ...r, seq: Number(r['seq']), created_at: String(r['created_at']) })) as T, error: null };
    } catch (error) {
      return { data: null, error: (error as Error).message };
    }
  };
  const client = (db: TestDb, actor: Actor) => {
    const timers: (() => void)[] = [];
    const chat = new ChatController({
      rpc: adapter(db, actor),
      newNonce: () => randomUUID(),
      isHidden: () => false,
      setTimer: (fn, ms) => {
        if (ms !== CHAT_RPC_TIMEOUT_MS) timers.push(fn);
        return 0;
      },
      clearTimer: () => undefined,
      onChange: () => undefined,
    });
    const settle = async (done: () => boolean) => {
      for (let i = 0; i < 400 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
      expect(done()).toBe(true);
    };
    const poll = async () => {
      const before = timers.splice(0);
      const calls = before.length;
      for (const t of before) t();
      await settle(() => timers.length >= calls);
    };
    return { chat, settle, poll };
  };

  it('dois membros conversam; o histórico persiste; repetir não duplica; a sala encerrada vira leitura; estranho é negado', async () => {
    const db = await TestDb.create();
    try {
      const s = await scenario(db);
      const a = client(db, s.owner);
      const b = client(db, s.member);
      a.chat.open(s.room, false);
      b.chat.open(s.room, false);
      await a.settle(() => a.chat.state.status === 'ready');
      await b.settle(() => b.chat.state.status === 'ready');

      a.chat.send('<b>oi</b>\nsegunda linha');
      await a.settle(() => a.chat.state.pending.length === 0);
      await b.poll();
      expect(b.chat.state.messages.map((m) => [m.display_name, m.is_mine, m.client_nonce, m.body])).toEqual([['Dono', false, null, '<b>oi</b>\nsegunda linha']]);

      b.chat.send('olá');
      await b.settle(() => b.chat.state.pending.length === 0);
      await a.poll();
      expect(a.chat.state.messages.map((m) => m.seq)).toEqual([1, 2]);

      // Repetição direta do mesmo identificador: nada novo no servidor.
      const mine = a.chat.state.messages[0]!;
      const again = await adapter(db, s.owner)<unknown[]>('send_room_message', { p_room_id: s.room, p_client_nonce: mine.client_nonce, p_body: mine.body });
      expect(again.error).toBeNull();
      expect((await db.admin<{ n: number }>('select count(*)::int as n from oryn.room_messages'))[0]!.n).toBe(2);

      // Outro cliente, depois: o histórico está lá.
      const fresh = client(db, s.member);
      fresh.chat.open(s.room, false);
      await fresh.settle(() => fresh.chat.state.status === 'ready');
      expect(fresh.chat.state.messages.map((m) => m.body)).toEqual(['<b>oi</b>\nsegunda linha', 'olá']);

      // Sala encerrada: quem tenta enviar descobre pelo servidor; a leitura continua.
      await db.rpc(s.owner, 'public.close_room', { p_room_id: s.room });
      b.chat.send('tarde');
      await b.settle(() => b.chat.state.readOnly);
      expect(b.chat.state.pending[0]).toMatchObject({ state: 'failed' });
      await b.poll();
      expect(b.chat.state.status).toBe('ready');
      expect(b.chat.state.messages).toHaveLength(2);

      const stranger = client(db, await db.newUser());
      stranger.chat.open(s.room, false);
      await stranger.settle(() => stranger.chat.state.status === 'denied');
      expect(stranger.chat.state.messages).toEqual([]);
    } finally {
      await db.close();
    }
  }, 120_000);
});

describe('chat por canal de texto (0900)', () => {
  const CHANNEL = '33333333-3333-4333-8333-333333333333';
  const CHANNEL_2 = '44444444-4444-4444-8444-444444444444';

  it('com canal, lista, pagina, consulta e envia pelas RPCs de canal (p_channel_id); sem canal, segue nas da sala', async () => {
    const t = harness({ list_channel_messages: () => ({ data: [row(4), row(7)], error: null }), send_channel_message: (a) => ({ data: [row(9, { is_mine: true, client_nonce: String(a['p_client_nonce']) })], error: null }) });
    t.chat.open(ROOM, false, CHANNEL);
    await flush();
    expect(t.chat.state).toMatchObject({ roomId: ROOM, channelId: CHANNEL, status: 'ready' });
    expect(t.calls[0]).toEqual({ fn: 'list_channel_messages', args: { p_channel_id: CHANNEL, p_limit: CHAT_PAGE_SIZE } });
    await t.fire(CHAT_POLL_MS);
    expect(t.calls.at(-1)).toEqual({ fn: 'list_channel_messages', args: { p_channel_id: CHANNEL, p_after_seq: 7, p_limit: CHAT_CATCH_UP } });
    expect(t.chat.send('oi')).toBe(true);
    await flush();
    const send = t.calls.find((c) => c.fn === 'send_channel_message')!;
    expect(send.args).toEqual({ p_channel_id: CHANNEL, p_client_nonce: nonce(1), p_body: 'oi' });
    expect(t.calls.some((c) => c.fn === 'list_room_messages' || c.fn === 'send_room_message' || 'p_room_id' in c.args)).toBe(false);
    // Sem canal: exatamente o caminho antigo.
    const old = await opened();
    expect(old.calls[0]).toEqual({ fn: 'list_room_messages', args: { p_room_id: ROOM, p_limit: CHAT_PAGE_SIZE } });
    expect(old.chat.state.channelId).toBeNull();
  });

  it('trocar de canal no mesmo espaço recarrega e descarta respostas do canal anterior', async () => {
    let release: ((r: RpcResult<unknown[]>) => void) | null = null;
    const t = harness({
      list_channel_messages: (a) => (a['p_channel_id'] === CHANNEL ? new Promise((r) => { release = r; }) : { data: [row(2, { body: 'do canal 2' })], error: null }),
    });
    t.chat.open(ROOM, false, CHANNEL);
    await flush();
    t.chat.open(ROOM, false, CHANNEL_2);
    await flush();
    release!({ data: [row(1, { body: 'do canal 1' })], error: null }); // resposta atrasada do canal anterior
    await flush();
    expect(t.chat.state.channelId).toBe(CHANNEL_2);
    expect(t.chat.state.messages.map((m) => m.body)).toEqual(['do canal 2']);
  });

  it('canal arquivado ao enviar: a mensagem falha com aviso próprio e o chat fica só para leitura', async () => {
    const t = harness({ list_channel_messages: () => ({ data: [], error: null }), send_channel_message: () => ({ data: null, error: 'channel-archived' }) });
    t.chat.open(ROOM, false, CHANNEL);
    await flush();
    expect(t.chat.send('tarde demais')).toBe(true);
    await flush();
    expect(t.chat.state.pending[0]).toMatchObject({ state: 'failed', error: 'O canal foi arquivado: a mensagem não foi enviada.' });
    expect(t.chat.state).toMatchObject({ readOnly: true, archived: true });
    expect(chatStatusText(t.chat.state)).toEqual({ tone: 'info', text: 'Canal arquivado: as mensagens ficam somente para leitura.' });
    expect(t.chat.send('de novo')).toBe(false);
    // A atualização da lista de salas não desfaz o arquivamento.
    t.chat.syncRooms([{ room_id: ROOM, name: 'Sala', role: 'member', is_open: true, closed_at: null, member_count: 2, max_members: 4, created_at: '2026-11-06T12:00:00+00:00' } as RoomSummary]);
    expect(t.chat.state.readOnly).toBe(true);
    expect(t.closed).toEqual([]); // não é sala encerrada
  });

  it('sem acesso ao canal (unauthorized): negado, sem insistir', async () => {
    const t = harness({ list_channel_messages: () => ({ data: null, error: 'unauthorized' }) });
    t.chat.open(ROOM, false, CHANNEL);
    await flush();
    expect(t.chat.state.status).toBe('denied');
    expect(t.delays()).toEqual([]);
  });
});
