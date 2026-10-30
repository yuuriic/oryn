// Núcleo da Edge Function `signal` (POC-02C.1A). Puro e testável: toda E/S entra por `SignalDeps`.
//
// Fluxo (uma requisição HTTP):
//   1. JWT do usuário presente e válido (verifyUser) → senão 401.
//   2. Corpo pequeno e estrito (parseSignalRequest) → senão 413/400. Remetente NUNCA vem do corpo.
//   3. authorize_signal COM O JWT DO USUÁRIO: confere sessão própria, destino na mesma sala, limites, e
//      REGISTRA a mensagem (sem payload) → estado `accepted`; idempotente por (sessão, client_msg_id).
//   4. set_signal_state('publishing') com a chave do servidor.
//   5. publish no tópico privado do destinatário (Broadcast REST com a chave secreta, só no servidor).
//   6. set_signal_state('published') ou 'failed'.
//
// Semântica de entrega: PELO MENOS UMA VEZ (não exatamente uma vez). O cliente repete o MESMO
// client_msg_id até obter `published`; uma repetição de mensagem já publicada não é republicada; uma
// repetição de mensagem `accepted`/`failed`/`publishing` (falha entre registro e publicação) É republicada
// com o mesmo msg_id/seq. O destinatário descarta duplicatas por msg_id e ordena por seq.
// `acknowledged` é marcado pelo destinatário (ack_signals), nunca por este fluxo.

import { parseSignalRequest, sessionTopic, type PublishState, type SignalEnvelope, type SignalRequest } from './signal-contract.ts';

export interface AuthorizeResult {
  msg_id: string;
  seq: number;
  from_user: string;
  room_id: string;
  state: PublishState;
  duplicate: boolean;
  accepted_at: string;
}

/** Erro de RPC com o código curto devolvido pelo banco (ex.: "session-invalid"). */
export class RpcError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export interface SignalDeps {
  /** Valida o JWT do usuário e devolve o id dele, ou null. */
  verifyUser(jwt: string): Promise<string | null>;
  /** RPC authorize_signal executada COM O JWT DO USUÁRIO. Lança RpcError. */
  authorize(jwt: string, request: SignalRequest, payloadBytes: number): Promise<AuthorizeResult>;
  /** RPC set_signal_state com a chave do servidor (service_role). Lança RpcError. */
  setState(msgId: string, state: 'publishing' | 'published' | 'failed'): Promise<void>;
  /** Publica o envelope no tópico privado (Broadcast REST, chave secreta só no servidor). */
  publish(topic: string, envelope: SignalEnvelope): Promise<void>;
  /** Log SANITIZADO: só campos curtos e não sensíveis. */
  log(event: Record<string, string | number | boolean>): void;
}

export interface SignalResponse {
  status: number;
  body: Record<string, unknown>;
}

/** Mapeamento dos códigos do banco para HTTP (erros genéricos; não revelam detalhes). */
const RPC_STATUS: Record<string, number> = {
  unauthorized: 403,
  'jwt-invalid': 401, // credencial recusada pelo gateway/PostgREST (ex.: JWT vencido entre a validação e a RPC)
  'session-invalid': 403,
  'recipient-invalid': 403,
  'not-member': 403,
  'invalid-argument': 400,
  'idempotency-conflict': 409,
  'rate-limited': 429,
  'retry-limit': 409,
};

const prefix = (id: string): string => `${id.slice(0, 8)}…`;

export async function handleSignal(input: { authorization: string | null; body: string }, deps: SignalDeps): Promise<SignalResponse> {
  const jwt = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(input.authorization ?? '')?.[1];
  if (!jwt) return reject(deps, 401, 'unauthorized');

  const parsed = parseSignalRequest(input.body);
  if (!parsed.ok) return reject(deps, parsed.code === 'too-large' ? 413 : 400, parsed.code);
  const request = parsed.value;

  let userId: string | null;
  try {
    userId = await deps.verifyUser(jwt);
  } catch {
    return reject(deps, 503, 'auth-unavailable', true);
  }
  if (!userId) return reject(deps, 401, 'unauthorized');

  let auth: AuthorizeResult;
  try {
    auth = await deps.authorize(jwt, request, parsed.bytes);
  } catch (error) {
    if (error instanceof RpcError && error.code in RPC_STATUS) return reject(deps, RPC_STATUS[error.code]!, error.code, error.code === 'rate-limited');
    return reject(deps, 503, 'database-unavailable', true);
  }
  // Defesa em profundidade: o banco deve ter derivado o remetente do mesmo JWT.
  if (auth.from_user !== userId) return reject(deps, 403, 'unauthorized');

  if (auth.duplicate && (auth.state === 'published' || auth.state === 'acknowledged')) {
    deps.log({ outcome: 'duplicate-already-published', msg: prefix(auth.msg_id) });
    return { status: 200, body: { msg_id: auth.msg_id, seq: auth.seq, state: auth.state, duplicate: true } };
  }

  try {
    await deps.setState(auth.msg_id, 'publishing');
  } catch (error) {
    if (error instanceof RpcError && error.code === 'retry-limit') return reject(deps, 409, 'retry-limit');
    return reject(deps, 503, 'database-unavailable', true, auth);
  }

  const envelope: SignalEnvelope = {
    v: 1,
    msg_id: auth.msg_id,
    seq: auth.seq,
    from_session: request.session_id, // validado no banco como sessão do próprio usuário
    from_user: auth.from_user, // sempre do banco (auth.uid()), nunca do corpo
    to_session: request.to_session_id,
    sent_at: auth.accepted_at,
    kind: request.kind,
    pair_epoch: request.pair_epoch,
    payload: request.payload,
  };

  try {
    await deps.publish(sessionTopic(request.to_session_id), envelope);
  } catch {
    await deps.setState(auth.msg_id, 'failed').catch(() => undefined);
    return reject(deps, 503, 'publish-failed', true, auth, 'failed');
  }

  let recorded = true;
  try {
    await deps.setState(auth.msg_id, 'published');
  } catch {
    // Publicado de fato, mas o estado não foi gravado: a resposta diz a verdade; uma repetição do cliente
    // republica com o mesmo msg_id (o destinatário descarta a duplicata).
    recorded = false;
  }
  deps.log({ outcome: 'published', msg: prefix(auth.msg_id), kind: request.kind, bytes: parsed.bytes, duplicate: auth.duplicate, recorded });
  return { status: 202, body: { msg_id: auth.msg_id, seq: auth.seq, state: 'published', duplicate: auth.duplicate } };
}

function reject(
  deps: SignalDeps,
  status: number,
  code: string,
  retryable = false,
  auth?: AuthorizeResult,
  state?: PublishState,
): SignalResponse {
  deps.log({ outcome: 'rejected', status, code, ...(auth ? { msg: prefix(auth.msg_id) } : {}) });
  return { status, body: { error: code, retryable, ...(auth ? { msg_id: auth.msg_id, state: state ?? auth.state } : {}) } };
}
