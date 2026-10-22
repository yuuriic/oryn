// Protocolo de sinalização da POC-02B (baseline copiado da POC-02A, f068509), compartilhado entre o
// navegador e o servidor Node.
// Sem dependências de DOM ou Node: roda nos dois lados e é testado isoladamente.
// Somente sintaxe "apagável" (sem enums/parameter properties): o Node executa este arquivo
// com type stripping nativo.

export const PROTOCOL_VERSION = 1;
/** Tamanho máximo de uma mensagem WebSocket (bytes UTF-8). */
export const MAX_MESSAGE_BYTES = 16 * 1024;
export const MAX_SDP_LENGTH = 12_000;
export const MAX_CANDIDATE_LENGTH = 1_024;
export const MAX_MID_LENGTH = 32;
export const MAX_UFRAG_LENGTH = 256;
/** 128 bits aleatórios em base64url sem padding = 22 caracteres. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** Segredos de admissão (chave do operador e convites): 256 bits em base64url sem padding = 43 caracteres. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Origem pública informada ao operador para montar o link do convite. */
const PUBLIC_ORIGIN_PATTERN = /^https:\/\/[a-z0-9.-]{1,253}$/;

export type Role = 'host' | 'guest';

export interface CandidatePayload {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment?: string | null;
}

export type SignalPayload =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | { kind: 'candidate'; candidate: CandidatePayload | null };

export type ClientMessage =
  /** Operador: cria sessão (exige a chave do operador e Host local). */
  | { type: 'create'; operatorKey: string }
  /** Operador: volta à própria sessão (vaga de host). */
  | { type: 'rejoin'; sessionId: string; operatorKey: string }
  /** Operador já na sessão: emite um novo convite (revoga o anterior). */
  | { type: 'invite' }
  /** Convidado: entra com um convite de uso único. */
  | { type: 'join'; invite: string }
  | { type: 'signal'; epoch: number; payload: SignalPayload }
  | { type: 'leave' };

export type ErrorCode =
  | 'invalid-message'
  | 'too-large'
  | 'not-found'
  | 'session-full'
  | 'already-in-session'
  | 'not-in-session'
  | 'no-peer'
  | 'stale-epoch'
  | 'unexpected-signal'
  | 'rate-limited'
  | 'server-busy'
  | 'unauthorized'
  | 'invite-invalid'
  | 'locked';

export type ServerMessage =
  | { type: 'session'; sessionId: string; role: Role; epoch: number; peerPresent: boolean }
  | { type: 'peer-joined'; epoch: number }
  | { type: 'peer-left'; epoch: number }
  | { type: 'signal'; epoch: number; payload: SignalPayload }
  | { type: 'session-closed'; reason: 'expired' | 'server-shutdown' }
  /** Somente ao operador: convite de uso único e a origem pública configurada (ou null). */
  | { type: 'invite'; token: string; expiresAt: number; publicOrigin: string | null }
  | { type: 'error'; code: ErrorCode };

export type ParseResult<T> = { ok: true; value: T } | { ok: false; code: ErrorCode };

// ---------- validação estrutural ----------

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Exige exatamente as chaves obrigatórias, mais opcionais conhecidas; nenhuma chave extra. */
function hasOnlyKeys(o: Obj, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(o);
  return required.every((k) => k in o) && keys.every((k) => required.includes(k) || optional.includes(k));
}

const isEpoch = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

export function isSessionId(v: unknown): v is string {
  return typeof v === 'string' && SESSION_ID_PATTERN.test(v);
}

export function isToken(v: unknown): v is string {
  return typeof v === 'string' && TOKEN_PATTERN.test(v);
}

function isSdp(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_SDP_LENGTH && v.startsWith('v=0');
}

function isCandidate(v: unknown): v is CandidatePayload | null {
  if (v === null) return true;
  if (!isObj(v) || !hasOnlyKeys(v, ['candidate', 'sdpMid', 'sdpMLineIndex'], ['usernameFragment'])) return false;
  const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = v;
  // String vazia = fim dos candidatos para aquela geração (forma usada pelo próprio WebRTC).
  const candidateOk =
    typeof candidate === 'string' &&
    candidate.length <= MAX_CANDIDATE_LENGTH &&
    (candidate === '' || candidate.startsWith('candidate:'));
  const midOk = sdpMid === null || (typeof sdpMid === 'string' && sdpMid.length <= MAX_MID_LENGTH);
  const indexOk = sdpMLineIndex === null || (Number.isInteger(sdpMLineIndex) && (sdpMLineIndex as number) >= 0 && (sdpMLineIndex as number) < 16);
  const ufragOk =
    usernameFragment === undefined ||
    usernameFragment === null ||
    (typeof usernameFragment === 'string' && usernameFragment.length <= MAX_UFRAG_LENGTH);
  return candidateOk && midOk && indexOk && ufragOk && (sdpMid !== null || sdpMLineIndex !== null);
}

export function isSignalPayload(v: unknown): v is SignalPayload {
  if (!isObj(v)) return false;
  switch (v['kind']) {
    case 'offer':
    case 'answer':
      return hasOnlyKeys(v, ['kind', 'sdp']) && isSdp(v['sdp']);
    case 'candidate':
      return hasOnlyKeys(v, ['kind', 'candidate']) && isCandidate(v['candidate']);
    default:
      return false;
  }
}

/** Tamanho em bytes UTF-8 sem depender de Buffer/TextEncoder específicos. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Valida uma mensagem recebida pelo servidor. Estrutura estrita: chaves extras são rejeitadas. */
export function parseClientMessage(raw: string): ParseResult<ClientMessage> {
  if (utf8Length(raw) > MAX_MESSAGE_BYTES) return { ok: false, code: 'too-large' };
  const v = parseJson(raw);
  if (!isObj(v)) return { ok: false, code: 'invalid-message' };
  switch (v['type']) {
    case 'invite':
    case 'leave':
      return hasOnlyKeys(v, ['type']) ? { ok: true, value: { type: v['type'] } } : { ok: false, code: 'invalid-message' };
    case 'create':
      return hasOnlyKeys(v, ['type', 'operatorKey']) && isToken(v['operatorKey'])
        ? { ok: true, value: { type: 'create', operatorKey: v['operatorKey'] } }
        : { ok: false, code: 'invalid-message' };
    case 'rejoin':
      return hasOnlyKeys(v, ['type', 'sessionId', 'operatorKey']) && isSessionId(v['sessionId']) && isToken(v['operatorKey'])
        ? { ok: true, value: { type: 'rejoin', sessionId: v['sessionId'], operatorKey: v['operatorKey'] } }
        : { ok: false, code: 'invalid-message' };
    case 'join':
      return hasOnlyKeys(v, ['type', 'invite']) && isToken(v['invite'])
        ? { ok: true, value: { type: 'join', invite: v['invite'] } }
        : { ok: false, code: 'invalid-message' };
    case 'signal':
      return hasOnlyKeys(v, ['type', 'epoch', 'payload']) && isEpoch(v['epoch']) && isSignalPayload(v['payload'])
        ? { ok: true, value: { type: 'signal', epoch: v['epoch'], payload: v['payload'] } }
        : { ok: false, code: 'invalid-message' };
    default:
      return { ok: false, code: 'invalid-message' };
  }
}

const ERROR_CODES: readonly ErrorCode[] = [
  'invalid-message',
  'too-large',
  'not-found',
  'session-full',
  'already-in-session',
  'not-in-session',
  'no-peer',
  'stale-epoch',
  'unexpected-signal',
  'rate-limited',
  'server-busy',
  'unauthorized',
  'invite-invalid',
  'locked',
];

/** Valida uma mensagem recebida pelo navegador (defesa em profundidade contra servidor/proxy). */
export function parseServerMessage(raw: string): ServerMessage | null {
  if (utf8Length(raw) > MAX_MESSAGE_BYTES) return null;
  const v = parseJson(raw);
  if (!isObj(v)) return null;
  switch (v['type']) {
    case 'session':
      return hasOnlyKeys(v, ['type', 'sessionId', 'role', 'epoch', 'peerPresent']) &&
        isSessionId(v['sessionId']) &&
        (v['role'] === 'host' || v['role'] === 'guest') &&
        isEpoch(v['epoch']) &&
        typeof v['peerPresent'] === 'boolean'
        ? (v as ServerMessage)
        : null;
    case 'peer-joined':
    case 'peer-left':
      return hasOnlyKeys(v, ['type', 'epoch']) && isEpoch(v['epoch']) ? (v as ServerMessage) : null;
    case 'signal':
      return hasOnlyKeys(v, ['type', 'epoch', 'payload']) && isEpoch(v['epoch']) && isSignalPayload(v['payload'])
        ? (v as ServerMessage)
        : null;
    case 'session-closed':
      return hasOnlyKeys(v, ['type', 'reason']) && (v['reason'] === 'expired' || v['reason'] === 'server-shutdown')
        ? (v as ServerMessage)
        : null;
    case 'invite':
      return hasOnlyKeys(v, ['type', 'token', 'expiresAt', 'publicOrigin']) &&
        isToken(v['token']) &&
        isEpoch(v['expiresAt']) &&
        (v['publicOrigin'] === null || (typeof v['publicOrigin'] === 'string' && PUBLIC_ORIGIN_PATTERN.test(v['publicOrigin'])))
        ? (v as ServerMessage)
        : null;
    case 'error':
      return hasOnlyKeys(v, ['type', 'code']) && ERROR_CODES.includes(v['code'] as ErrorCode) ? (v as ServerMessage) : null;
    default:
      return null;
  }
}

/** Mensagens exibíveis para os códigos de erro do servidor. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  'invalid-message': 'Mensagem de sinalização inválida.',
  'too-large': 'Mensagem de sinalização grande demais.',
  'not-found': 'Sessão não encontrada ou expirada. Confira o link ou crie uma nova sessão.',
  'session-full': 'A sessão já tem dois participantes.',
  'already-in-session': 'Esta conexão já participa de uma sessão.',
  'not-in-session': 'Esta conexão não participa de nenhuma sessão.',
  'no-peer': 'Ainda não há outro participante na sessão.',
  'stale-epoch': 'Sinal de uma negociação anterior foi descartado.',
  'unexpected-signal': 'Sinal fora da ordem esperada foi descartado.',
  'rate-limited': 'Muitas mensagens em pouco tempo; a conexão foi limitada.',
  'server-busy': 'O servidor atingiu o limite de sessões simultâneas.',
  unauthorized: 'Não autorizado.',
  'invite-invalid': 'Convite inválido, expirado ou já utilizado. Peça um novo convite ao anfitrião.',
  locked: 'Muitas tentativas de autorização. Aguarde e tente novamente.',
};
