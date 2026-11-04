// Contratos de domínio da POC-02C (cliente): salas, convites, sessões, participantes e eventos de controle.
// A autorização é toda no banco (RPC SECURITY DEFINER + RLS); estes tipos e validadores servem para o
// cliente montar pedidos válidos e tratar respostas/eventos com estrutura estrita.

export {
  SIGNAL_KINDS,
  MAX_REQUEST_BYTES,
  isUuid,
  parseEnvelope,
  parseSignalRequest,
  sessionTopic,
  type PublishState,
  type SignalEnvelope,
  type SignalKind,
  type SignalPayload,
  type SignalRequest,
} from '../supabase/functions/_shared/signal-contract.ts';

import { isUuid } from '../supabase/functions/_shared/signal-contract.ts';

/** Convites (de criador e de sala): 256 bits nominais em base64url, 43 caracteres. Uso único. */
export const isInviteToken = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);

/**
 * Comprimento em PONTOS DE CÓDIGO, como o char_length do PostgreSQL (MVP 01). `.length` conta unidades UTF-16:
 * um emoji fora do BMP vale 2 ali e 1 no banco, e um nome válido no banco seria recusado aqui.
 */
export const codePointLength = (v: string): number => [...v].length;
const isLabel = (v: unknown, max: number): v is string =>
  typeof v === 'string' && !/[\u0000-\u001f\u007f]/.test(v) && codePointLength(v) >= 1 && codePointLength(v) <= max;

/** Nomes exibidos: 1–32 caracteres, sem caracteres de controle (mesma regra do banco). */
export const isDisplayName = (v: unknown): v is string => isLabel(v, 32);
/** Nomes de sala: 1–40 caracteres, sem caracteres de controle (mesma regra do banco). */
export const isRoomName = (v: unknown): v is string => isLabel(v, 40);

/** Códigos de erro devolvidos pelas RPCs (mensagem do erro do Postgres). */
export const RPC_ERROR_CODES = [
  'unauthorized',
  'invalid-argument',
  'invite-invalid',
  'already-member',
  'room-full',
  'limit-reached',
  'not-member',
  'session-invalid',
  'recipient-invalid',
  'idempotency-conflict',
  'rate-limited',
  'invalid-transition',
  'retry-limit',
  'not-found',
] as const;
export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number];
export const isRpcErrorCode = (v: unknown): v is RpcErrorCode => typeof v === 'string' && (RPC_ERROR_CODES as readonly string[]).includes(v);

export interface RosterEntry {
  session_id: string;
  display_name: string;
  is_self: boolean;
  joined_at: string;
}

export interface JoinResult {
  session_id: string;
  topic: string;
}

/** Eventos de CONTROLE publicados pelo banco (realtime.send): nunca contêm SDP/candidatos/IPs. */
export type ControlEvent = { event: 'hello'; session_id: string; label: string } | { event: 'bye'; session_id: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Valida um evento de controle. O `realtime.send` do Supabase acrescenta `id` (UUID da mensagem) ao
 * payload (02C.2A): ele é aceito só como UUID e descartado do resultado. Qualquer outra chave invalida o evento.
 */
export function parseControlEvent(event: string, payload: unknown): ControlEvent | null {
  if (!isObj(payload)) return null;
  if ('id' in payload && !isUuid(payload['id'])) return null;
  const keys = Object.keys(payload).filter((k) => k !== 'id').sort().join(',');
  if (event === 'hello' && keys === 'label,session_id' && isUuid(payload['session_id']) && isDisplayName(payload['label'])) {
    return { event, session_id: payload['session_id'], label: payload['label'] };
  }
  if (event === 'bye' && keys === 'session_id' && isUuid(payload['session_id'])) return { event, session_id: payload['session_id'] };
  return null;
}

/** Linha de list_my_rooms (MVP 01, migração 0400). */
export interface RoomSummary {
  room_id: string;
  name: string;
  role: 'owner' | 'member';
  is_open: boolean;
  closed_at: string | null;
  member_count: number;
  max_members: number;
  created_at: string;
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

const ROOM_SUMMARY_KEYS = 'closed_at,created_at,is_open,max_members,member_count,name,role,room_id';

/**
 * A linha tem EXATAMENTE as colunas do contrato de list_my_rooms (sem olhar os valores). Linha sem essa forma é
 * incompatibilidade de contrato (outra versão da RPC, resposta truncada): não deve ser ignorada em silêncio.
 */
export const hasRoomSummaryShape = (v: unknown): boolean => isObj(v) && Object.keys(v).sort().join(',') === ROOM_SUMMARY_KEYS;

export function parseRoomSummary(v: unknown): RoomSummary | null {
  if (!isObj(v) || !isUuid(v['room_id']) || !isRoomName(v['name']) || (v['role'] !== 'owner' && v['role'] !== 'member')) return null;
  if (typeof v['is_open'] !== 'boolean' || !isCount(v['member_count']) || !isCount(v['max_members']) || typeof v['created_at'] !== 'string') return null;
  const closedAt = v['closed_at'];
  // Aberta ⇔ sem closed_at: qualquer combinação diferente é resposta inconsistente.
  if (v['is_open'] ? closedAt !== null : typeof closedAt !== 'string') return null;
  return {
    room_id: v['room_id'],
    name: v['name'],
    role: v['role'],
    is_open: v['is_open'],
    closed_at: closedAt as string | null,
    member_count: v['member_count'],
    max_members: v['max_members'],
    created_at: v['created_at'],
  };
}

export function parseRosterEntry(v: unknown): RosterEntry | null {
  if (!isObj(v) || !isUuid(v['session_id']) || !isDisplayName(v['display_name']) || typeof v['is_self'] !== 'boolean' || typeof v['joined_at'] !== 'string') return null;
  return { session_id: v['session_id'], display_name: v['display_name'], is_self: v['is_self'], joined_at: v['joined_at'] };
}
