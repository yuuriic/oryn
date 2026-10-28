// Lobby de salas (MVP 01): listar, criar e encerrar salas pelas RPCs list_my_rooms, create_room e close_room
// (migração 0400). Sem DOM: o estado e as regras ficam aqui, e a renderização em rooms-view.ts. A chamada em
// si continua com o PeerCall e o SupabaseSignaling, sem mudança de fluxo.
//
// Mensagens exibíveis: só textos fixos por código curto. Nada do servidor é repassado à tela além dos campos
// validados de cada sala (nomes passam por isRoomName e são renderizados como texto).

import { hasRoomSummaryShape, isDisplayName, isRoomName, parseRoomSummary, type RoomSummary } from '../contracts.ts';
import { shortCode, type RpcResult } from './supabase-signaling.ts';

/** O cliente de voz é 1:1: toda sala criada pela interface tem 2 lugares. */
export const ROOM_MAX_MEMBERS = 2;
/** list_my_rooms devolve no máximo 50 salas. */
export const ROOM_LIST_LIMIT = 50;

export const CREATE_ERRORS: Record<string, string> = {
  unauthorized: 'Esta conta não tem permissão para criar salas.',
  'limit-reached': 'Limite de salas abertas atingido: encerre uma sala antes de criar outra.',
  'invalid-argument': 'Nome da sala ou nome de exibição inválido.',
};
export const CREATE_FAILED = 'Não foi possível criar a sala (falha de rede ou do servidor). Tente de novo.';
export const CLOSE_ERRORS: Record<string, string> = {
  unauthorized: 'Só o dono pode encerrar esta sala.',
};
export const CLOSE_FAILED = 'Não foi possível encerrar a sala (falha de rede ou do servidor). Tente de novo.';
export const LIST_FAILED = 'Não foi possível carregar as salas (falha de rede ou do servidor).';

const messageFor = (table: Record<string, string>, fallback: string, error: string | null): string => table[shortCode(error)] ?? fallback;

export type NewRoom = { ok: true; name: string; displayName: string } | { ok: false; message: string };

/** Mesmas regras do banco (1–40 e 1–32 caracteres, sem controle), sobre o texto sem espaços nas pontas. */
export function validateNewRoom(name: string, displayName: string): NewRoom {
  const n = name.trim();
  const d = displayName.trim();
  if (!isRoomName(n)) return { ok: false, message: 'Nome da sala: de 1 a 40 caracteres, sem caracteres de controle.' };
  if (!isDisplayName(d)) return { ok: false, message: 'Seu nome na sala: de 1 a 32 caracteres, sem caracteres de controle.' };
  return { ok: true, name: n, displayName: d };
}

/**
 * Resposta de list_my_rooms. `null` = incompatível com o contrato (não é lista, ou alguma linha não tem
 * exatamente as colunas): é erro, não lista vazia. Linha com as colunas certas e valor fora da regra (ex.: nome
 * com caractere de controle gravado por outra via) é ignorada e contada em `skipped`, sem derrubar as demais.
 */
export function parseRoomList(data: unknown): { rooms: RoomSummary[]; skipped: number } | null {
  if (!Array.isArray(data) || !data.every(hasRoomSummaryShape)) return null;
  const parsed = data.map(parseRoomSummary);
  return { rooms: parsed.filter((r): r is RoomSummary => r !== null), skipped: parsed.filter((r) => r === null).length };
}

/** Abertas primeiro (na ordem do servidor: as mais recentes antes), depois as encerradas. */
export function splitRooms(rooms: readonly RoomSummary[]): { open: RoomSummary[]; closed: RoomSummary[] } {
  return { open: rooms.filter((r) => r.is_open), closed: rooms.filter((r) => !r.is_open) };
}

export type DisconnectKind = 'closed' | 'not-member' | 'expired' | 'unknown';

export const DISCONNECT_KIND_MESSAGES: Record<DisconnectKind, string> = {
  closed: 'A sala foi encerrada pelo dono.',
  'not-member': 'Esta conta não participa mais desta sala.',
  expired: 'A sessão na sala expirou ou deixou de valer. Entre de novo.',
  unknown: 'Não foi possível confirmar o motivo agora.',
};

/**
 * Motivo de uma desconexão 4403, pela lista de salas DEPOIS dela. Sem classificação definitiva se a consulta
 * falhar ou vier inválida, ou se a sala não aparecer numa lista cheia (pode estar além do limite de 50).
 */
export function classifyDisconnect(roomId: string, result: RpcResult<unknown[]>): DisconnectKind {
  if (result.error || !parseRoomList(result.data)) return 'unknown';
  const rows = result.data as Record<string, unknown>[];
  const row = rows.find((r) => r['room_id'] === roomId);
  if (row) {
    const room = parseRoomSummary(row);
    if (!room) return 'unknown'; // a linha da própria sala está fora da regra: sem veredito
    return room.is_open ? 'expired' : 'closed';
  }
  return rows.length >= ROOM_LIST_LIMIT ? 'unknown' : 'not-member';
}

// ---------- controlador do lobby ----------

export type LobbyStatus = 'idle' | 'loading' | 'ready' | 'error';
export type LobbyAction = { kind: 'refresh' } | { kind: 'create' } | { kind: 'close'; roomId: string };

export interface LobbyState {
  status: LobbyStatus;
  rooms: RoomSummary[];
  /** Linhas da última carga ignoradas por valor fora da regra (ver parseRoomList). */
  skipped: number;
  /** Erro da última carga da lista (status 'error'). */
  listError: string | null;
  /** Erro da última criação ou do último encerramento. */
  actionError: string | null;
  /** Operação em curso: enquanto houver uma, as ações que conflitam ficam desativadas. */
  busy: LobbyAction | null;
}

export interface LobbyDeps {
  rpc<T>(fn: string, args: Record<string, unknown>): Promise<RpcResult<T>>;
  /** Confirmação explícita do usuário (window.confirm na página). */
  confirm(message: string): boolean;
  onChange(state: LobbyState): void;
  /** Depois de um encerramento aceito pelo servidor (a página encerra a chamada local, se for desta sala). */
  onClosed?(roomId: string): Promise<void> | void;
}

export class LobbyController {
  private s: LobbyState = { status: 'idle', rooms: [], skipped: 0, listError: null, actionError: null, busy: null };
  /** Só a resposta da carga mais recente vale (uma carga antiga não sobrescreve a nova). */
  private generation = 0;
  /**
   * Sessão do lobby: muda a cada reset (logout). Uma criação ou um encerramento iniciado antes do reset não
   * mexe em nada depois dele: nem estado, nem mensagens, nem recarga, nem onClosed.
   */
  private epoch = 0;

  private readonly deps: LobbyDeps;

  constructor(deps: LobbyDeps) {
    this.deps = deps;
  }

  get state(): LobbyState {
    return this.s;
  }

  private set(patch: Partial<LobbyState>): void {
    this.s = { ...this.s, ...patch };
    this.deps.onChange(this.s);
  }

  /** Volta ao estado inicial (logout). Respostas em curso são descartadas. */
  reset(): void {
    this.generation += 1;
    this.epoch += 1;
    this.set({ status: 'idle', rooms: [], skipped: 0, listError: null, actionError: null, busy: null });
  }

  async refresh(): Promise<void> {
    const gen = ++this.generation;
    this.set({ status: 'loading', listError: null });
    const res = await this.deps.rpc<unknown[]>('list_my_rooms', {}).catch(() => ({ data: null, error: 'erro' }));
    if (gen !== this.generation) return;
    const list = res.error ? null : parseRoomList(res.data);
    if (!list) {
      this.set({ status: 'error', listError: LIST_FAILED });
      return;
    }
    this.set({ status: 'ready', rooms: list.rooms, skipped: list.skipped, listError: null });
  }

  /** Cria a sala (sempre com 2 lugares) e recarrega a lista. Devolve o id criado, ou null. */
  async create(name: string, displayName: string): Promise<string | null> {
    if (this.s.busy) return null;
    const v = validateNewRoom(name, displayName);
    if (!v.ok) {
      this.set({ actionError: v.message });
      return null;
    }
    const epoch = this.epoch;
    this.set({ busy: { kind: 'create' }, actionError: null });
    const res = await this.deps
      .rpc<string>('create_room', { p_name: v.name, p_display_name: v.displayName, p_max_members: ROOM_MAX_MEMBERS })
      .catch(() => ({ data: null, error: 'erro' }));
    if (epoch !== this.epoch) return null; // logout no meio: a resposta é da sessão anterior
    const id = typeof res.data === 'string' ? res.data : null;
    this.set({ busy: null, actionError: res.error || !id ? messageFor(CREATE_ERRORS, CREATE_FAILED, res.error) : null });
    await this.refresh();
    return res.error ? null : id;
  }

  /** Encerra a sala (só o dono vê a ação; o servidor confere de novo). Pede confirmação antes. */
  async close(roomId: string): Promise<boolean> {
    if (this.s.busy) return false;
    const room = this.s.rooms.find((r) => r.room_id === roomId);
    if (!room || !room.is_open || room.role !== 'owner') return false;
    if (!this.deps.confirm(`Encerrar a sala "${room.name}"? Quem estiver na chamada será desconectado, os convites deixam de valer e a sala não pode ser reaberta.`)) {
      return false;
    }
    const epoch = this.epoch;
    this.set({ busy: { kind: 'close', roomId }, actionError: null });
    const res = await this.deps.rpc<string>('close_room', { p_room_id: roomId }).catch(() => ({ data: null, error: 'erro' }));
    if (epoch !== this.epoch) return false; // logout no meio: o logout já encerrou a chamada local
    const ok = !res.error;
    if (ok) await this.deps.onClosed?.(roomId);
    if (epoch !== this.epoch) return false;
    this.set({ busy: null, actionError: ok ? null : messageFor(CLOSE_ERRORS, CLOSE_FAILED, res.error) });
    await this.refresh();
    return ok;
  }
}
