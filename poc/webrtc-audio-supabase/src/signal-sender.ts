// Envio de sinalização no cliente (POC-02C.1A): repete o MESMO pedido (mesmo client_msg_id) até a
// mensagem ficar `published`, com espera crescente, só para falhas transitórias. Erros definitivos
// (400/401/403/409/413) não são repetidos. Garantia: pelo menos uma vez; o destinatário descarta duplicatas.

import type { SignalRequest } from '../supabase/functions/_shared/signal-contract.ts';

export interface TransportResponse {
  status: number;
  body: Record<string, unknown>;
}

export type SendResult =
  | { state: 'published'; msg_id: string; seq: number; attempts: number; duplicate: boolean }
  | { state: 'failed'; reason: string; attempts: number; retryable: boolean };

export interface SendOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = new Set([429, 502, 503, 504]);

export async function sendSignal(request: SignalRequest, transport: (request: SignalRequest) => Promise<TransportResponse>, options: SendOptions = {}): Promise<SendResult> {
  const maxAttempts = options.maxAttempts ?? 5;
  const base = options.baseDelayMs ?? 250;
  const cap = options.maxDelayMs ?? 2_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last = 'unknown';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: TransportResponse | null = null;
    try {
      res = await transport(request); // o MESMO objeto (mesmo client_msg_id) a cada tentativa
    } catch {
      last = 'network-error';
    }
    if (res) {
      const state = res.body['state'];
      if ((res.status === 200 || res.status === 202) && (state === 'published' || state === 'acknowledged')) {
        return { state: 'published', msg_id: String(res.body['msg_id']), seq: Number(res.body['seq']), attempts: attempt, duplicate: res.body['duplicate'] === true };
      }
      last = typeof res.body['error'] === 'string' ? res.body['error'] : `http-${res.status}`;
      if (!RETRYABLE.has(res.status)) return { state: 'failed', reason: last, attempts: attempt, retryable: false };
    }
    if (attempt < maxAttempts) await sleep(Math.min(cap, base * 2 ** (attempt - 1)));
  }
  return { state: 'failed', reason: last, attempts: maxAttempts, retryable: true };
}
