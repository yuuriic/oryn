// Chamadas HTTP da Edge Function `signal` ao Supabase (02C.1B.0A). Puro e testável: `fetch` é injetado.
//
// DUAS credenciais, nunca misturadas (correção B1):
// - USUÁRIO (verifyUser, authorize_signal):
//     apikey: <publicável>, Authorization: Bearer <JWT do usuário>
//   O PostgREST roda a RPC como `authenticated` com as claims desse JWT: auth.uid() é o usuário.
// - SERVIDOR (set_signal_state, Broadcast REST):
//     apikey: <secreta>, SEM Authorization
//   As chaves sb_secret_ não são JWT e são recusadas em `Authorization: Bearer`. Sem Authorization, a
//   plataforma usa o papel da chave (service_role). Vale também para a chave legada service_role.
// O JWT do usuário nunca vai junto da chave secreta, e a chave secreta nunca vai em Authorization.

import { RpcError, type AuthorizeResult, type SignalDeps } from './signal-core.ts';
import type { SignalEnvelope, SignalRequest } from './signal-contract.ts';
import { isUuid } from './signal-contract.ts';
import type { EdgeConfig } from './edge-config.ts';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;

export const TIMEOUT_MS = 5_000;

export function userHeaders(cfg: EdgeConfig, jwt: string): Record<string, string> {
  return { apikey: cfg.publishableKey, authorization: `Bearer ${jwt}` };
}

export function serverHeaders(cfg: EdgeConfig): Record<string, string> {
  return { apikey: cfg.secretKey };
}

async function rpcError(res: Response): Promise<RpcError> {
  // 401 do gateway/PostgREST = credencial recusada (JWT vencido, chave inválida): nunca "banco fora".
  if (res.status === 401) return new RpcError('jwt-invalid');
  const body = (await res.json().catch(() => ({}))) as { message?: unknown };
  return new RpcError(typeof body.message === 'string' ? body.message : `http-${res.status}`);
}

export function createSignalDeps(cfg: EdgeConfig, fetchImpl: FetchLike, log: SignalDeps['log'], timeoutMs = TIMEOUT_MS): SignalDeps {
  const post = (path: string, headers: Record<string, string>, body: unknown) =>
    fetchImpl(`${cfg.url}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  return {
    async verifyUser(jwt) {
      const res = await fetchImpl(`${cfg.url}/auth/v1/user`, { method: 'GET', signal: AbortSignal.timeout(timeoutMs), headers: userHeaders(cfg, jwt) });
      if (res.status === 401 || res.status === 403) return null;
      if (!res.ok) throw new Error(`auth-${res.status}`); // indisponível → 503 no núcleo
      const user = (await res.json().catch(() => ({}))) as { id?: unknown };
      return isUuid(user.id) ? user.id : null;
    },

    async authorize(jwt: string, request: SignalRequest, bytes: number): Promise<AuthorizeResult> {
      const res = await post('/rest/v1/rpc/authorize_signal', userHeaders(cfg, jwt), {
        p_session_id: request.session_id,
        p_to_session_id: request.to_session_id,
        p_client_msg_id: request.client_msg_id,
        p_kind: request.kind,
        p_pair_epoch: request.pair_epoch,
        p_payload_bytes: bytes,
      });
      if (!res.ok) throw await rpcError(res);
      const rows = (await res.json()) as AuthorizeResult[];
      const row = rows[0];
      if (!row) throw new RpcError('database-unavailable');
      return row;
    },

    async setState(msgId, state) {
      const res = await post('/rest/v1/rpc/set_signal_state', serverHeaders(cfg), { p_msg_id: msgId, p_state: state });
      if (!res.ok) throw await rpcError(res);
    },

    async publish(topic: string, envelope: SignalEnvelope) {
      // Broadcast REST para canal PRIVADO (NOT VERIFIED no Supabase real: entrega e não persistência).
      const res = await post('/realtime/v1/api/broadcast', serverHeaders(cfg), { messages: [{ topic, event: 'signal', payload: envelope, private: true }] });
      if (!res.ok) throw new Error(`broadcast-${res.status}`);
    },

    log,
  };
}
