// RoomBackend real (supabase-js 2.118) para o SupabaseSignaling. Só a CHAVE PUBLICÁVEL e o JWT do usuário:
// - RPCs pelo PostgREST (`supabase.rpc`), como `authenticated`;
// - Edge Function `signal` por `functions.invoke`, que envia o JWT da sessão atual em Authorization;
// - canal PRIVADO do Realtime. Renovação de JWT: o supabase-js repassa o token novo ao Realtime
//   (TOKEN_REFRESHED → realtime.setAuth), e REST/função leem sempre a sessão atual.
// Nada aqui registra token, e-mail, SDP ou candidato.

import { FunctionsHttpError, type SupabaseClient } from '@supabase/supabase-js';
import type { SignalRequest } from '../../supabase/functions/_shared/signal-contract.ts';
import type { TransportResponse } from '../signal-sender.ts';
import type { ChannelHandle, ChannelHandlers, RoomBackend, RpcResult } from './supabase-signaling.ts';

/** Prazo para a entrada no canal privado (o harness usa 10–12 s). */
export const CHANNEL_JOIN_TIMEOUT_MS = 12_000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** O necessário para sair da sala sem o supabase-js, no descarregamento da página (ver leaveOnUnload). */
export interface UnloadConfig {
  url: string;
  publishableKey: string;
  /** JWT atual do usuário, lido na hora; null sem login. */
  accessToken(): string | null;
}

export function createSupabaseBackend(client: SupabaseClient, unload?: UnloadConfig): RoomBackend {
  return {
    async rpc<T>(fn: string, args: Record<string, unknown>): Promise<RpcResult<T>> {
      const { data, error } = await client.rpc(fn, args);
      return { data: (data as T) ?? null, error: error ? error.message : null };
    },

    // O supabase-js resolve a sessão de forma assíncrona antes do fetch: numa recarga, a página descarrega antes
    // e o leave_room nunca sai (o par fica sem bye até a sessão vencer). Aqui o fetch sai na própria chamada, com
    // keepalive, que o navegador mantém depois do descarregamento.
    leaveOnUnload(sessionId: string): boolean {
      const token = unload?.accessToken();
      if (!unload || !token) return false;
      void fetch(`${unload.url}/rest/v1/rpc/leave_room`, {
        method: 'POST',
        keepalive: true,
        headers: { apikey: unload.publishableKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_session_id: sessionId }),
      }).catch(() => undefined);
      return true;
    },

    async invokeSignal(request: SignalRequest): Promise<TransportResponse> {
      const { data, error } = await client.functions.invoke('signal', { body: request });
      if (!error) return { status: 202, body: isObj(data) ? data : {} };
      // Resposta HTTP da função (4xx/5xx): status e corpo curto ({ error, retryable }). Repassados ao
      // sendSignal, que decide se repete. Falha de rede/CORS/relay: lança (o sendSignal repete).
      if (error instanceof FunctionsHttpError) {
        const res = error.context as Response;
        const body: unknown = await res.json().catch(() => ({}));
        return { status: res.status, body: isObj(body) ? body : {} };
      }
      throw new Error('signal-unreachable');
    },

    openChannel(topic: string, handlers: ChannelHandlers): Promise<ChannelHandle> {
      const channel = client.channel(topic, { config: { private: true, broadcast: { self: false, ack: false } } });
      channel.on('broadcast', { event: '*' }, (msg) => handlers.onBroadcast(String(msg['event']), msg['payload']));
      const handle: ChannelHandle = { close: () => client.removeChannel(channel).then(() => undefined) };
      return new Promise<ChannelHandle>((resolve, reject) => {
        let joined = false;
        let settled = false;
        const fail = (reason: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // Entrada recusada: remove o canal para o cliente não tentar de novo em segundo plano.
          void client.removeChannel(channel).catch(() => undefined);
          reject(new Error(reason));
        };
        const timer = setTimeout(() => fail('channel-timeout'), CHANNEL_JOIN_TIMEOUT_MS);
        channel.subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            if (!joined) {
              joined = true;
              settled = true;
              clearTimeout(timer);
              resolve(handle);
            }
            return;
          }
          if (!joined) {
            // Motivo do servidor não é exposto: só o estado (o diagnóstico detalhado fica no harness).
            fail(status === 'CHANNEL_ERROR' ? 'channel-refused' : status === 'TIMED_OUT' ? 'channel-timeout' : 'channel-closed');
            return;
          }
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') handlers.onStatus(status);
        });
      });
    },
  };
}
