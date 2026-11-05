// "Voltar para a chamada" depois de recarregar a aba.
//
// O login continua só em memória: depois do F5 a pessoa entra de novo. No navegador fica apenas o ID da sala, um
// UUID sem valor sem o login, no armazenamento da própria aba. Este é o único módulo do cliente que usa esse
// armazenamento (tests/web-config.test.ts confere).
//
// O servidor decide: a oferta e o aceite consultam list_my_rooms, e o join_room ainda valida a entrada. Nada aqui
// inicia chamada ou microfone sem o clique em "Voltar para a chamada".

import { isUuid } from '../../supabase/functions/_shared/signal-contract.ts';
import type { RoomSummary } from '../contracts.ts';
import { classifyDisconnect, parseRoomList, type Notice } from './rooms.ts';
import type { RpcResult } from './supabase-signaling.ts';

export const RETURN_ROOM_KEY = 'oryn.returnRoomId';

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const browserStore = (): KeyValueStore | null => window.sessionStorage;

/** Nunca lança: armazenamento negado, ausente ou cheio só faz o retorno deixar de ser oferecido. */
export class ReturnRoomStore {
  private readonly getStore: () => KeyValueStore | null;

  constructor(getStore: () => KeyValueStore | null = browserStore) {
    this.getStore = getStore;
  }

  save(roomId: string): boolean {
    if (!isUuid(roomId)) return false;
    try {
      const store = this.getStore();
      if (!store) return false;
      store.setItem(RETURN_ROOM_KEY, roomId);
      return true;
    } catch {
      return false;
    }
  }

  /** Valor fora do formato (adulterado) é descartado. */
  read(): string | null {
    try {
      const value = this.getStore()?.getItem(RETURN_ROOM_KEY) ?? null;
      if (value === null || isUuid(value)) return value;
    } catch {
      return null;
    }
    this.clear();
    return null;
  }

  clear(): void {
    try {
      this.getStore()?.removeItem(RETURN_ROOM_KEY);
    } catch {
      // nada a limpar: o armazenamento está indisponível
    }
  }
}

export type ReturnVerdict = { kind: 'offer'; room: RoomSummary } | { kind: 'gone' } | { kind: 'unavailable' };

/** `gone` só com certeza; sem resposta confiável, `unavailable` guarda o ID para outra tentativa. */
export function evaluateReturn(roomId: string, result: RpcResult<unknown[]>): ReturnVerdict {
  const kind = classifyDisconnect(roomId, result);
  if (kind === 'closed' || kind === 'not-member') return { kind: 'gone' };
  if (kind === 'unknown') return { kind: 'unavailable' };
  const room = parseRoomList(result.data)?.rooms.find((r) => r.room_id === roomId);
  return room ? { kind: 'offer', room } : { kind: 'unavailable' };
}

export type ReturnState = { status: 'none' } | { status: 'offer'; roomId: string; name: string; busy: boolean };

export const RETURN_GONE: Notice = { tone: 'info', text: 'Esta chamada não está mais disponível: a sala foi encerrada ou esta conta não participa mais dela.' };
export const RETURN_UNAVAILABLE: Notice = { tone: 'error', text: 'Não foi possível confirmar a sala agora. Tente de novo.' };

export interface CallReturnDeps {
  store: ReturnRoomStore;
  listRooms(): Promise<RpcResult<unknown[]>>;
  /** Inicia a chamada: chamado só depois do clique e da validação no servidor. */
  start(roomId: string): void;
  notify(notice: Notice): void;
  onChange(state: ReturnState): void;
}

const NONE: ReturnState = { status: 'none' };

export class CallReturnController {
  private s: ReturnState = NONE;
  /** Muda em logout, início de chamada e limpeza: uma resposta atrasada do servidor não vale mais. */
  private epoch = 0;
  private readonly deps: CallReturnDeps;

  constructor(deps: CallReturnDeps) {
    this.deps = deps;
  }

  get state(): ReturnState {
    return this.s;
  }

  /** A entrada na sala foi aceita. */
  remember(roomId: string): void {
    this.deps.store.save(roomId);
  }

  /** Saída voluntária, remoção ou sala encerrada. Com `roomId`, só limpa se for a sala guardada. */
  forget(roomId?: string): void {
    if (roomId !== undefined && this.deps.store.read() !== roomId) return;
    this.deps.store.clear();
    this.hide();
  }

  /** Esconde a oferta e descarta validações em curso, sem apagar o ID (logout involuntário, outra chamada). */
  hide(): void {
    this.epoch += 1;
    this.set(NONE);
  }

  reset(): void {
    this.hide();
  }

  /** Depois do login: oferece só se o servidor confirmar a sala aberta e a participação. */
  async offer(): Promise<void> {
    const roomId = this.deps.store.read();
    if (!roomId) return this.set(NONE);
    const epoch = ++this.epoch;
    const verdict = evaluateReturn(roomId, await this.list());
    if (epoch !== this.epoch) return;
    if (verdict.kind === 'gone') this.deps.store.clear();
    this.set(verdict.kind === 'offer' ? { status: 'offer', roomId, name: verdict.room.name, busy: false } : NONE);
  }

  /** Clique em "Voltar para a chamada": confere de novo no servidor, porque a oferta pode ter envelhecido. */
  async accept(): Promise<void> {
    const offered = this.s;
    if (offered.status !== 'offer' || offered.busy) return;
    const epoch = ++this.epoch;
    this.set({ ...offered, busy: true });
    const verdict = evaluateReturn(offered.roomId, await this.list());
    if (epoch !== this.epoch) return;
    if (verdict.kind === 'unavailable') {
      this.set({ ...offered, busy: false });
      return this.deps.notify(RETURN_UNAVAILABLE);
    }
    this.set(NONE);
    if (verdict.kind === 'gone') {
      this.deps.store.clear();
      return this.deps.notify(RETURN_GONE);
    }
    this.deps.start(offered.roomId);
  }

  /** "Agora não": é uma saída voluntária. */
  dismiss(): void {
    this.forget();
  }

  private list(): Promise<RpcResult<unknown[]>> {
    return this.deps.listRooms().catch(() => ({ data: null, error: 'erro' }));
  }

  private set(next: ReturnState): void {
    if (next === this.s) return;
    this.s = next;
    this.deps.onChange(next);
  }
}
