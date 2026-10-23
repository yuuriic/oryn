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

/** Nomes exibidos: 1–32 caracteres, sem caracteres de controle (mesma regra do banco). */
export const isDisplayName = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 32 && !/[\u0000-\u001f\u007f]/.test(v);
export const isRoomName = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 40 && !/[\u0000-\u001f\u007f]/.test(v);

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

export function parseControlEvent(event: string, payload: unknown): ControlEvent | null {
  if (!isObj(payload)) return null;
  const keys = Object.keys(payload).sort().join(',');
  if (event === 'hello' && keys === 'label,session_id' && isUuid(payload['session_id']) && isDisplayName(payload['label'])) {
    return { event, session_id: payload['session_id'], label: payload['label'] };
  }
  if (event === 'bye' && keys === 'session_id' && isUuid(payload['session_id'])) return { event, session_id: payload['session_id'] };
  return null;
}

export function parseRosterEntry(v: unknown): RosterEntry | null {
  if (!isObj(v) || !isUuid(v['session_id']) || !isDisplayName(v['display_name']) || typeof v['is_self'] !== 'boolean' || typeof v['joined_at'] !== 'string') return null;
  return { session_id: v['session_id'], display_name: v['display_name'], is_self: v['is_self'], joined_at: v['joined_at'] };
}
