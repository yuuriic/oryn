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

export function createSupabaseBackend(client: SupabaseClient): RoomBackend {
  return {
    async rpc<T>(fn: string, args: Record<string, unknown>): Promise<RpcResult<T>> {
      const { data, error } = await client.rpc(fn, args);
      return { data: (data as T) ?? null, error: error ? error.message : null };
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
