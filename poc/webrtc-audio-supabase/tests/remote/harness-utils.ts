// Peças PURAS do harness remoto (02C.4B.1), separadas para serem testadas no `pnpm test` sem rede
// (tests/remote-harness-utils.test.ts): encerramento por timeout, classificação da recusa de canal e
// sanitização do que vai para anotações.
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';

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

// --- classificação da entrada no canal (02C.6E) -----------------------------------------------------------------
// A 1ª C0-W aprovou um `MissingPartition` (infraestrutura) como se fosse recusa de autorização. Agora só passa o
// motivo EXATO esperado; as regras vêm de realtime-refusals.json (também lido pelo executor PowerShell).

interface RefusalRules {
  authorization: { code: string; message: string };
  privateOnly: { code: string; message: string };
  credentialCodes: string[];
  infrastructureCodes: string[];
  infrastructureMessages: string[];
}
const rules = JSON.parse(readFileSync(new URL('./realtime-refusals.json', import.meta.url), 'utf8')) as RefusalRules;

/** Motivo da recusa do SERVIDOR. `authorization` = RLS; `private-only` = canal público desligado no projeto. */
export type RefusalKind = 'authorization' | 'private-only' | 'credential' | 'infrastructure' | 'unknown';
/** Resultado da entrada: decisão do servidor, recusa sem decisão de acesso, ou nenhuma resposta conclusiva. */
export type JoinOutcome = RefusalKind | 'subscribed' | 'timeout' | 'transport';
export type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVO';

/** Classifica o texto da recusa (`<Código>: <mensagem>`). Código e mensagem têm de bater; o resto é `unknown`. */
export function classifyRefusal(reason: string): RefusalKind {
  const m = /^([A-Za-z]+): ([\s\S]*)$/.exec(reason.trim());
  if (!m) return rules.infrastructureMessages.some((re) => new RegExp(re).test(reason.trim())) ? 'infrastructure' : 'unknown';
  const [, code, message] = m as unknown as [string, string, string];
  if (code === rules.authorization.code) return new RegExp(rules.authorization.message).test(message) ? 'authorization' : 'unknown';
  if (code === rules.privateOnly.code) return new RegExp(rules.privateOnly.message).test(message) ? 'private-only' : 'unknown';
  if (rules.credentialCodes.includes(code)) return 'credential';
  if (rules.infrastructureCodes.includes(code)) return 'infrastructure';
  return 'unknown';
}

/** Texto que o SERVIDOR devolveu (payload `{ reason }` em `err.cause`), antes de qualquer sanitização. */
export function serverReason(err: Error | undefined): string {
  const cause = (err as { cause?: unknown } | undefined)?.cause as Record<string, unknown> | undefined;
  return typeof cause?.['reason'] === 'string' ? cause['reason'] : (err?.message ?? '');
}

/** Resultado da entrada a partir do estado final, da origem da recusa e do motivo. */
export function joinOutcome(status: string, refusedByServer: boolean, reason: string): JoinOutcome {
  if (status === 'SUBSCRIBED') return 'subscribed';
  if (status === 'TIMED_OUT' || status === 'NO_REPLY') return 'timeout';
  if (status !== 'CHANNEL_ERROR' || !refusedByServer) return 'transport';
  return classifyRefusal(reason);
}

const ACCESS_DECISIONS: ReadonlySet<JoinOutcome> = new Set(['subscribed', 'authorization', 'private-only']);

/**
 * PASS só com o motivo esperado. FAIL quando o servidor DECIDIU outra coisa (entrou, ou recusou pelo outro
 * motivo de acesso). INCONCLUSIVO quando não houve decisão de acesso: credencial, infraestrutura, desconhecido,
 * timeout ou transporte. Nenhum dos dois últimos passa.
 */
export function refusalVerdict(outcome: JoinOutcome, expected: 'authorization' | 'private-only'): Verdict {
  if (outcome === expected) return 'PASS';
  return ACCESS_DECISIONS.has(outcome) ? 'FAIL' : 'INCONCLUSIVO';
}

// --- orçamento de identidades (02C.4E) --------------------------------------------------------------------------

export class IdentityBudgetExceeded extends Error {}

/**
 * Conta as TENTATIVAS de cadastro anônimo deste processo (com sucesso, falha ou recusa esperada) e bloqueia
 * a próxima antes da rede quando o limite é atingido. Conta tentativas, não identidades criadas: é o que gasta
 * o limite de 30/h por IP e o que pode deixar usuário no projeto.
 *
 * LIMITAÇÃO: a contagem vive só neste processo. Reexecuções (outro `pnpm test:remote`) começam do zero; o
 * controle entre processos é operacional (runbook §10: o operador lê, antes de cada execução, quantas
 * identidades a janela já criou e passa o saldo em ORYN_IT_IDENTITY_BUDGET).
 */
export class IdentityBudget {
  readonly limit: number;
  /** O que é contado (02C.5B): cadastros e logins usam instâncias SEPARADAS, nunca o mesmo saldo. */
  readonly what: string;
  #used = 0;
  constructor(limit: number, what = 'cadastro') {
    if (!Number.isInteger(limit) || limit < 0) throw new RangeError('orçamento inválido');
    this.limit = limit;
    this.what = what;
  }
  get used(): number {
    return this.#used;
  }
  /** Reserva uma tentativa; lança (sem tocar na rede) se o orçamento acabou. */
  reserve(): void {
    if (this.#used >= this.limit) throw new IdentityBudgetExceeded(`orçamento de ${this.what} esgotado (${this.#used}/${this.limit}): nenhuma nova tentativa de ${this.what}`);
    this.#used += 1;
  }
}
