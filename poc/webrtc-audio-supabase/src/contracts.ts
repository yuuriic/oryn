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

/** Linha de list_sounds (migração 0700). */
export interface SoundAsset {
  asset_id: string;
  name: string;
  version: number;
  sha256: string | null;
  mime: string | null;
  size_bytes: number | null;
  duration_ms: number | null;
  state: 'available' | 'quarantine';
  created_at: string;
}

const isSha256 = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const isVersion = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1;
const SOUND_ASSET_KEYS = 'asset_id,created_at,duration_ms,mime,name,sha256,size_bytes,state,version';

export function parseSoundAsset(v: unknown): SoundAsset | null {
  if (!isObj(v) || Object.keys(v).sort().join(',') !== SOUND_ASSET_KEYS) return null;
  if (!isUuid(v['asset_id']) || !isRoomName(v['name']) || !isVersion(v['version']) || typeof v['created_at'] !== 'string') return null;
  if (v['state'] === 'available') {
    if (!isSha256(v['sha256']) || typeof v['mime'] !== 'string' || !Number.isSafeInteger(v['size_bytes']) || !Number.isSafeInteger(v['duration_ms'])) return null;
  } else if (v['state'] !== 'quarantine') {
    return null;
  }
  return {
    asset_id: v['asset_id'],
    name: v['name'],
    version: v['version'],
    sha256: (v['sha256'] as string | null) ?? null,
    mime: (v['mime'] as string | null) ?? null,
    size_bytes: (v['size_bytes'] as number | null) ?? null,
    duration_ms: (v['duration_ms'] as number | null) ?? null,
    state: v['state'],
    created_at: v['created_at'],
  };
}

/** Evento `sound`: só metadados. Nunca áudio, nome de arquivo ou chave de objeto. */
export interface SoundEvent {
  event_id: string;
  session_id: string;
  sender_ref: string;
  asset_id: string;
  version: number;
  sha256: string;
  issued_at: string;
  expires_at: string;
}

const SOUND_EVENT_KEYS = 'asset_id,event_id,expires_at,issued_at,sender_ref,session_id,sha256,version';
export const SOUND_EVENT_TTL_MS = 2_000;

/** Como nos eventos de controle, `id` é o UUID que o `realtime.send` acrescenta. Prazo diferente de 2 s invalida o evento. */
export function parseSoundEvent(v: unknown): SoundEvent | null {
  if (!isObj(v) || ('id' in v && !isUuid(v['id']))) return null;
  if (Object.keys(v).filter((k) => k !== 'id').sort().join(',') !== SOUND_EVENT_KEYS) return null;
  const { event_id, session_id, sender_ref, asset_id, version, sha256, issued_at, expires_at } = v;
  if (!isUuid(event_id) || !isUuid(session_id) || !isUuid(asset_id) || !isVersion(version) || !isSha256(sha256)) return null;
  if (typeof sender_ref !== 'string' || sender_ref.length > 64 || typeof issued_at !== 'string' || typeof expires_at !== 'string') return null;
  if (Date.parse(expires_at) - Date.parse(issued_at) !== SOUND_EVENT_TTL_MS) return null;
  return { event_id, session_id, sender_ref, asset_id, version, sha256, issued_at, expires_at };
}

/** Linha de list_my_rooms (MVP 01, migração 0400). */
/** Linha de get_voice_participants: a referência distingue contas, e duas sessões da mesma conta têm a mesma. */
export interface VoiceParticipant {
  session_id: string;
  participant_ref: string;
  display_name: string;
  is_self: boolean;
  joined_at: string;
}

const isMemberRef = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);

export function parseVoiceParticipant(v: unknown): VoiceParticipant | null {
  if (!isObj(v) || !isUuid(v['session_id']) || !isMemberRef(v['participant_ref']) || !isDisplayName(v['display_name'])) return null;
  if (typeof v['is_self'] !== 'boolean' || typeof v['joined_at'] !== 'string') return null;
  return { session_id: v['session_id'], participant_ref: v['participant_ref'], display_name: v['display_name'], is_self: v['is_self'], joined_at: v['joined_at'] };
}

/** Linha de list_room_members. A referência só serve para pedir a remoção; quem decide é o servidor. */
export interface RoomMember {
  member_ref: string;
  display_name: string;
  role: 'owner' | 'member';
  is_self: boolean;
  in_call: boolean;
  joined_at: string;
}

const ROOM_MEMBER_KEYS = 'display_name,in_call,is_self,joined_at,member_ref,role';

export const hasRoomMemberShape = (v: unknown): boolean => isObj(v) && Object.keys(v).sort().join(',') === ROOM_MEMBER_KEYS;

export function parseRoomMember(v: unknown): RoomMember | null {
  if (!isObj(v) || !hasRoomMemberShape(v) || !isMemberRef(v['member_ref']) || !isDisplayName(v['display_name'])) return null;
  if ((v['role'] !== 'owner' && v['role'] !== 'member') || typeof v['is_self'] !== 'boolean' || typeof v['in_call'] !== 'boolean' || typeof v['joined_at'] !== 'string') return null;
  return { member_ref: v['member_ref'], display_name: v['display_name'], role: v['role'], is_self: v['is_self'], in_call: v['in_call'], joined_at: v['joined_at'] };
}

/** Mesmas regras da migração 0500: 1–4000 pontos de código, com algo além de espaço, tabulação e quebra de linha. */
export const MAX_CHAT_BODY = 4000;
export const isChatBody = (v: unknown): v is string =>
  typeof v === 'string' && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(v) && /[^ \n\t]/.test(v) && codePointLength(v) <= MAX_CHAT_BODY;

/** Linha de send_room_message e list_room_messages. Sem conta de ninguém: só o nome na sala e `is_mine`. */
export interface ChatMessage {
  seq: number;
  display_name: string;
  is_mine: boolean;
  /** Só nas mensagens do próprio chamador. */
  client_nonce: string | null;
  body: string;
  created_at: string;
}

const CHAT_MESSAGE_KEYS = 'body,client_nonce,created_at,display_name,is_mine,seq';

/** Estrutura da linha: exatamente as colunas e um `seq` válido, que é o cursor. Valor fora da regra é outra coisa. */
export const hasChatMessageShape = (v: unknown): boolean =>
  isObj(v) && Object.keys(v).sort().join(',') === CHAT_MESSAGE_KEYS && Number.isSafeInteger(v['seq']) && (v['seq'] as number) >= 1;

export function parseChatMessage(v: unknown): ChatMessage | null {
  if (!hasChatMessageShape(v)) return null;
  const row = v as Record<string, unknown>;
  if (!isDisplayName(row['display_name']) || !isChatBody(row['body']) || typeof row['created_at'] !== 'string') return null;
  if (row['is_mine'] === true ? !isUuid(row['client_nonce']) : row['is_mine'] !== false || row['client_nonce'] !== null) return null;
  return { seq: row['seq'] as number, display_name: row['display_name'], is_mine: row['is_mine'] as boolean, client_nonce: row['client_nonce'] as string | null, body: row['body'], created_at: row['created_at'] };
}

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
