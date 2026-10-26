// Peças PURAS do harness remoto (02C.4B.1), separadas para serem testadas no `pnpm test` sem rede
// (tests/remote-harness-utils.test.ts): encerramento por timeout, classificação da recusa de canal e
// sanitização do que vai para anotações.
import { AsyncLocalStorage } from 'node:async_hooks';

// --- encerramento: nenhuma operação remota depois que o teste acabou ---------------------------------------

export const testSignal = new AsyncLocalStorage<AbortSignal>();

/** Lança se o teste dono desta continuação já terminou por timeout/cancelamento. Hooks não têm sinal. */
export function guard(): void {
  if (testSignal.getStore()?.aborted) throw new Error('teste encerrado: operação remota não iniciada');
}

/** Espera que rejeita assim que o teste dono termina (o timer é limpo). */
export const sleep = (ms: number) =>
  new Promise<void>((resolve, reject) => {
    const signal = testSignal.getStore();
    if (signal?.aborted) return reject(new Error('teste encerrado'));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('teste encerrado'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export const waitFor = async (cond: () => boolean, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await sleep(200);
  return cond();
};

// --- recusa de canal e sanitização -----------------------------------------------------------------------------

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Texto seguro para anotação: sem JWT, chave do Supabase ou UUID completo; no máximo 100 caracteres. */
export const sanitize = (text: string | undefined) =>
  (text ?? '')
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, '<jwt>')
    .replace(/sb_(publishable|secret)_[\w-]+/g, '<chave>')
    .replace(UUID_RE, '<uuid>')
    .slice(0, 100);

/**
 * Resposta de erro do SERVIDOR à entrada no canal. O realtime-js 2.118 entrega o payload da resposta
 * (objeto simples, ex. `{ reason: "..." }`) em `err.cause`; falhas de transporte chegam como
 * CloseEvent/Event/Error ou texto (normalizeChannelError), nunca como objeto simples com texto.
 */
export function isServerReply(err: Error | undefined): boolean {
  const cause = (err as { cause?: unknown } | undefined)?.cause;
  if (typeof cause !== 'object' || cause === null || Object.getPrototypeOf(cause) !== Object.prototype) return false;
  const obj = cause as Record<string, unknown>;
  // Fechamento de socket (CloseEvent copiado como objeto simples) tem `code` numérico: é transporte.
  if (typeof obj['code'] === 'number') return false;
  return Object.values(obj).some((v) => typeof v === 'string' && v.length > 0);
}

/** Recusa por credencial (JWT/token), e não por autorização (RLS). */
export const isCredentialRefusal = (reason: string) => /jwt|token/i.test(reason);
