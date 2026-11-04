// Contrato da sinalização Oryn (POC-02C.1A), compartilhado pela Edge Function `signal` (Deno) e pelo
// cliente (navegador/Tauri). Puro: sem dependências de Deno, Node ou DOM.
//
// Regras de validação copiadas da POC-02B (poc/webrtc-audio-wan/src/protocol.ts, b4101de); POCs isoladas,
// sem import cruzado.

export const SIGNAL_KINDS = ['offer', 'answer', 'candidate', 'end-of-candidates', 'restart-request'] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];
export const RESTART_REASONS = ['gap', 'ice-failed', 'renegotiate'] as const;

/** Tamanho máximo do corpo do pedido (bytes UTF-8). */
export const MAX_REQUEST_BYTES = 16 * 1024;
export const MAX_SDP_LENGTH = 12_000;
export const MAX_CANDIDATE_LENGTH = 1_024;
export const MAX_MID_LENGTH = 32;
export const MAX_UFRAG_LENGTH = 256;
export const MAX_EPOCH = 2_147_483_647;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

export interface CandidatePayload {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment?: string | null;
}

export type SignalPayload =
  | { sdp: string }
  | { candidate: CandidatePayload }
  | Record<string, never>
  | { reason: (typeof RESTART_REASONS)[number] };

/** Pedido do cliente à Edge Function. NÃO contém remetente: ele é sempre derivado do JWT no servidor. */
export interface SignalRequest {
  session_id: string;
  to_session_id: string;
  client_msg_id: string;
  kind: SignalKind;
  pair_epoch: number;
  payload: SignalPayload;
}

/** Estados de publicação de uma mensagem (registrados no banco, sem o payload). */
export type PublishState = 'accepted' | 'publishing' | 'published' | 'failed' | 'acknowledged';

/** Envelope entregue ao destinatário, montado SÓ pelo servidor. */
export interface SignalEnvelope {
  v: 1;
  msg_id: string;
  seq: number;
  from_session: string;
  from_user: string;
  to_session: string;
  sent_at: string;
  kind: SignalKind;
  pair_epoch: number;
  payload: SignalPayload;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (o: Obj, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every((k) => k in o) && Object.keys(o).every((k) => required.includes(k) || optional.includes(k));

export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

export function isSignalKind(v: unknown): v is SignalKind {
  return typeof v === 'string' && (SIGNAL_KINDS as readonly string[]).includes(v);
}

function isCandidate(v: unknown): v is CandidatePayload {
  if (!isObj(v) || !onlyKeys(v, ['candidate', 'sdpMid', 'sdpMLineIndex'], ['usernameFragment'])) return false;
  const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = v;
  const candidateOk = typeof candidate === 'string' && candidate.length <= MAX_CANDIDATE_LENGTH && (candidate === '' || candidate.startsWith('candidate:'));
  const midOk = sdpMid === null || (typeof sdpMid === 'string' && sdpMid.length <= MAX_MID_LENGTH);
  const indexOk = sdpMLineIndex === null || (Number.isInteger(sdpMLineIndex) && (sdpMLineIndex as number) >= 0 && (sdpMLineIndex as number) < 16);
  const ufragOk = usernameFragment === undefined || usernameFragment === null || (typeof usernameFragment === 'string' && usernameFragment.length <= MAX_UFRAG_LENGTH);
  return candidateOk && midOk && indexOk && ufragOk && (sdpMid !== null || sdpMLineIndex !== null);
}

/** Payload estrito por tipo de mensagem (chaves extras são recusadas). */
export function isPayloadFor(kind: SignalKind, payload: unknown): payload is SignalPayload {
  if (!isObj(payload)) return false;
  switch (kind) {
    case 'offer':
    case 'answer':
      return onlyKeys(payload, ['sdp']) && typeof payload['sdp'] === 'string' && payload['sdp'].length > 0 && payload['sdp'].length <= MAX_SDP_LENGTH && payload['sdp'].startsWith('v=0');
    case 'candidate':
      return onlyKeys(payload, ['candidate']) && isCandidate(payload['candidate']);
    case 'end-of-candidates':
      return Object.keys(payload).length === 0;
    case 'restart-request':
      return onlyKeys(payload, ['reason']) && (RESTART_REASONS as readonly unknown[]).includes(payload['reason']);
  }
}

const isEpoch = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_EPOCH;

export type ParseRequest = { ok: true; value: SignalRequest; bytes: number } | { ok: false; code: 'too-large' | 'invalid-request' };

/**
 * Valida o corpo do pedido. Estrutura ESTRITA: qualquer chave extra — inclusive tentativas de informar
 * remetente (`from_session`, `from_user`) — torna o pedido inválido.
 */
export function parseSignalRequest(raw: string): ParseRequest {
  const bytes = utf8Bytes(raw);
  if (bytes > MAX_REQUEST_BYTES) return { ok: false, code: 'too-large' };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'invalid-request' };
  }
  if (!isObj(v) || !onlyKeys(v, ['session_id', 'to_session_id', 'client_msg_id', 'kind', 'pair_epoch', 'payload'])) {
    return { ok: false, code: 'invalid-request' };
  }
  const { session_id, to_session_id, client_msg_id, kind, pair_epoch, payload } = v;
  if (!isUuid(session_id) || !isUuid(to_session_id) || !isUuid(client_msg_id) || session_id === to_session_id) return { ok: false, code: 'invalid-request' };
  if (!isSignalKind(kind) || !isEpoch(pair_epoch) || !isPayloadFor(kind, payload)) return { ok: false, code: 'invalid-request' };
  return { ok: true, value: { session_id, to_session_id, client_msg_id, kind, pair_epoch, payload }, bytes };
}

/** Valida um envelope recebido pelo cliente (defesa em profundidade). Devolve null se inválido. */
export function parseEnvelope(v: unknown): SignalEnvelope | null {
  if (!isObj(v) || !onlyKeys(v, ['v', 'msg_id', 'seq', 'from_session', 'from_user', 'to_session', 'sent_at', 'kind', 'pair_epoch', 'payload'])) return null;
  if (v['v'] !== 1 || !isUuid(v['msg_id']) || !isUuid(v['from_session']) || !isUuid(v['from_user']) || !isUuid(v['to_session'])) return null;
  if (!Number.isSafeInteger(v['seq']) || (v['seq'] as number) < 1) return null;
  if (typeof v['sent_at'] !== 'string' || Number.isNaN(Date.parse(v['sent_at']))) return null;
  if (!isSignalKind(v['kind']) || !isEpoch(v['pair_epoch']) || !isPayloadFor(v['kind'], v['payload'])) return null;
  return v as unknown as SignalEnvelope;
}

/** Tópico privado de uma sessão. */
export const sessionTopic = (sessionId: string): string => `oryn:s:${sessionId}`;
