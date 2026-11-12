// Núcleo da Edge Function `turn`: emite configuração ICE com credenciais TURN temporárias para quem está AGORA numa
// voz. Puro e testável: toda E/S entra por `TurnDeps`.
//
// Fluxo (uma requisição HTTP, nesta ordem; nenhum passo de recusa chama o provedor):
//   1. JWT do usuário no formato certo → senão 401.
//   2. Corpo pequeno e estrito: { room_id, channel_id | null, session_id } → senão 400/413.
//   3. JWT válido no Auth (verifyUser) → senão 401.
//   4. Autorização no banco, COM O JWT DO USUÁRIO: get_channel_participants (ou get_voice_participants, na voz padrão)
//      só devolve sessões vivas e não revogadas de quem é membro ativo. A sessão do corpo precisa estar lá e ser do
//      próprio usuário (is_self). Sala, canal e sessão do corpo valem só depois dessa confirmação.
//   5. Provedor configurado → senão 503 turn-unavailable (o cliente em `auto` segue por STUN).
//   6. Limites em memória: a mesma sessão reaproveita a credencial ainda válida, pedidos simultâneos dela esperam a
//      mesma emissão e cada conta tem um teto de emissões por hora → senão 429 ice-limit.
//   7. Emissão no provedor → 200 { iceServers, expiresAt } ou 503 turn-unavailable.
//
// Limites em memória valem por instância da função: NÃO são quota global nem controle financeiro (TURN-RELAY.md).
// Logs: só desfecho, código e prefixos curtos de conta e sessão. Nunca credencial, JWT, URL TURN, SDP ou IP.

import type { EdgeConfig } from './edge-config.ts';
import type { IceServerConfig } from './ice-servers.ts';
import { isUuid } from './signal-contract.ts';
import { RpcError } from './signal-core.ts';
import { TIMEOUT_MS, rpcError, userHeaders, verifyUserJwt, type FetchLike } from './supabase-http.ts';
import { TurnProviderError, type TurnIssue, type TurnProvider } from './turn-provider.ts';

export interface TurnRequest {
  room_id: string;
  /** Canal de voz (0900). null: a voz padrão da sala, pelo caminho antigo. */
  channel_id: string | null;
  session_id: string;
}

export const TURN_BODY_MAX_BYTES = 512;

export type ParsedTurnRequest = { ok: true; value: TurnRequest } | { ok: false; code: 'too-large' | 'invalid-body' };

/** Corpo estrito: exatamente as três chaves, UUIDs válidos (canal pode ser null). Nada a mais é aceito. */
export function parseTurnRequest(body: string): ParsedTurnRequest {
  if (new TextEncoder().encode(body).byteLength > TURN_BODY_MAX_BYTES) return { ok: false, code: 'too-large' };
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    return { ok: false, code: 'invalid-body' };
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false, code: 'invalid-body' };
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(',');
  if (keys !== 'channel_id,room_id,session_id') return { ok: false, code: 'invalid-body' };
  if (!isUuid(o['room_id']) || !isUuid(o['session_id']) || (o['channel_id'] !== null && !isUuid(o['channel_id']))) return { ok: false, code: 'invalid-body' };
  return { ok: true, value: { room_id: o['room_id'], channel_id: o['channel_id'] as string | null, session_id: o['session_id'] } };
}

/** Linha das RPCs de participantes: só o que a autorização usa. */
export interface LiveSession {
  session_id: string;
  is_self: boolean;
}

export interface TurnDeps {
  /** Valida o JWT e devolve o id da conta, ou null. Lança se o Auth estiver indisponível. */
  verifyUser(jwt: string): Promise<string | null>;
  /** Sessões vivas da voz pedida, vistas COM O JWT DO USUÁRIO. Lança RpcError com o código do banco. */
  liveSessions(jwt: string, request: TurnRequest): Promise<LiveSession[]>;
  /** null: TURN desligado (sem secrets). A função responde turn-unavailable, sem erro de partida. */
  provider: TurnProvider | null;
  limiter: IssueLimiter;
  ttlSec: number;
  log(event: Record<string, string | number | boolean>): void;
}

export interface TurnResponse {
  status: number;
  body: Record<string, unknown>;
}

const RPC_STATUS: Record<string, [number, string]> = {
  'not-member': [403, 'not-member'],
  unauthorized: [403, 'not-member'],
  'jwt-invalid': [401, 'unauthorized'],
  'invalid-argument': [400, 'invalid-body'],
};

const prefix = (id: string): string => `${id.slice(0, 8)}…`;

export async function handleTurn(input: { authorization: string | null; body: string }, deps: TurnDeps): Promise<TurnResponse> {
  const jwt = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(input.authorization ?? '')?.[1];
  if (!jwt) return reject(deps, 401, 'unauthorized');

  const parsed = parseTurnRequest(input.body);
  if (!parsed.ok) return reject(deps, parsed.code === 'too-large' ? 413 : 400, parsed.code);
  const request = parsed.value;

  let userId: string | null;
  try {
    userId = await deps.verifyUser(jwt);
  } catch {
    return reject(deps, 503, 'auth-unavailable', true);
  }
  if (!userId) return reject(deps, 401, 'unauthorized');

  let sessions: LiveSession[];
  try {
    sessions = await deps.liveSessions(jwt, request);
  } catch (error) {
    const mapped = error instanceof RpcError ? RPC_STATUS[error.code] : undefined;
    if (mapped) return reject(deps, mapped[0], mapped[1]);
    return reject(deps, 503, 'database-unavailable', true);
  }
  // A sessão precisa estar viva, não revogada e ser do próprio usuário: o banco decide as três coisas.
  if (!sessions.some((s) => s.session_id === request.session_id && s.is_self === true)) return reject(deps, 403, 'session-invalid');

  const provider = deps.provider;
  if (!provider) return reject(deps, 503, 'turn-unavailable', false);

  const outcome = await deps.limiter.issue(userId, request.session_id, () => provider.issue(deps.ttlSec));
  if (outcome.kind === 'limited') return reject(deps, 429, 'ice-limit', true);
  if (outcome.kind === 'failed') {
    deps.log({ outcome: 'provider-failed', provider: provider.name, reason: outcome.reason });
    return reject(deps, 503, 'turn-unavailable', true);
  }
  deps.log({ outcome: outcome.kind === 'reused' ? 'reused' : 'issued', user: prefix(userId), session: prefix(request.session_id), ttl_min: Math.round(deps.ttlSec / 60) });
  return { status: 200, body: { iceServers: outcome.issue.iceServers, expiresAt: outcome.issue.expiresAt } };
}

function reject(deps: TurnDeps, status: number, code: string, retryable = false): TurnResponse {
  deps.log({ outcome: 'rejected', status, code });
  return { status, body: { error: code, retryable } };
}

// ---------- limites em memória (por instância) ----------

export type IssueOutcome =
  | { kind: 'issued' | 'reused'; issue: TurnIssue }
  | { kind: 'limited' }
  | { kind: 'failed'; reason: string };

export interface IssueLimiterOptions {
  /** Emissões no provedor por conta, por janela. */
  maxPerAccount: number;
  windowMs: number;
  /** Emissões em andamento no provedor, todas as contas. */
  maxInflight: number;
  /** Uma credencial guardada só é reaproveitada se ainda valer pelo menos isto. */
  reuseMarginMs: number;
  /** Teto de entradas guardadas (credenciais e janelas); as mais antigas saem primeiro. */
  maxEntries: number;
  now: () => number;
}

export const DEFAULT_LIMITS: Omit<IssueLimiterOptions, 'now'> = {
  maxPerAccount: 12,
  windowMs: 60 * 60_000,
  maxInflight: 16,
  reuseMarginMs: 10 * 60_000,
  maxEntries: 2_000,
};

/**
 * Evita emissões redundantes e limita o volume, sem estado persistente:
 * - mesma conta e sessão com credencial ainda válida (folga `reuseMarginMs`) → a mesma credencial, sem provedor;
 * - pedidos simultâneos da mesma conta e sessão → uma emissão só, compartilhada;
 * - no máximo `maxPerAccount` emissões por conta na janela e `maxInflight` em andamento no total.
 * Por instância: outra instância da função começa do zero. Não é quota global.
 */
export class IssueLimiter {
  private readonly o: IssueLimiterOptions;
  private readonly cache = new Map<string, TurnIssue>();
  private readonly pending = new Map<string, Promise<IssueOutcome>>();
  private readonly windows = new Map<string, number[]>();
  private inflight = 0;

  constructor(options: Partial<IssueLimiterOptions> & { now: () => number }) {
    this.o = { ...DEFAULT_LIMITS, ...options };
  }

  issue(account: string, session: string, emit: () => Promise<TurnIssue>): Promise<IssueOutcome> {
    const key = `${account}:${session}`;
    const now = this.o.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt - now > this.o.reuseMarginMs) return Promise.resolve({ kind: 'reused', issue: cached });
    const running = this.pending.get(key);
    if (running) return running;
    const stamps = (this.windows.get(account) ?? []).filter((t) => now - t < this.o.windowMs);
    if (stamps.length >= this.o.maxPerAccount || this.inflight >= this.o.maxInflight) {
      this.windows.set(account, stamps);
      return Promise.resolve({ kind: 'limited' });
    }
    stamps.push(now);
    this.remember(this.windows, account, stamps);
    this.inflight += 1;
    const run = (async (): Promise<IssueOutcome> => {
      try {
        const issue = await emit();
        this.keep(key, issue);
        return { kind: 'issued', issue };
      } catch (error) {
        return { kind: 'failed', reason: error instanceof TurnProviderError ? error.message : 'erro' };
      } finally {
        this.inflight -= 1;
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, run);
    return run;
  }

  /** Para testes e diagnóstico: quantas credenciais estão guardadas. */
  get size(): number {
    return this.cache.size;
  }

  /** Guarda a credencial e esquece as vencidas. */
  private keep(key: string, issue: TurnIssue): void {
    const now = this.o.now();
    for (const [k, v] of this.cache) if (v.expiresAt <= now) this.cache.delete(k);
    this.remember(this.cache, key, issue);
  }

  /** Grava no fim (as mais antigas saem primeiro) e respeita o teto de entradas. */
  private remember<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > this.o.maxEntries) map.delete(map.keys().next().value as string);
  }
}

// ---------- configuração (secrets futuros; nomes documentados, sem valores) ----------

export class TurnConfigError extends Error {}

export interface TurnConfig {
  provider: 'cloudflare' | 'off';
  keyId: string | null;
  apiToken: string | null;
  ttlSec: number;
}

export const TURN_TTL_DEFAULT_S = 7_200;
/** Mínimo bem acima das folgas de renovação (10 min na função e no cliente, 5 min no PeerCall): sem ciclos de pedido. */
export const TURN_TTL_MIN_S = 1_800;
export const TURN_TTL_MAX_S = 43_200;

/**
 * ORYN_TURN_PROVIDER = cloudflare | off (padrão off: a função responde turn-unavailable).
 * Com cloudflare: ORYN_TURN_KEY_ID e ORYN_TURN_API_TOKEN obrigatórios; ORYN_TURN_TTL_S opcional (1800–43200, padrão 7200).
 * Mensagens de erro nunca citam valores.
 */
export function loadTurnConfig(get: (name: string) => string | undefined): TurnConfig {
  const provider = (get('ORYN_TURN_PROVIDER') ?? 'off').trim();
  if (provider !== 'cloudflare' && provider !== 'off') throw new TurnConfigError('ORYN_TURN_PROVIDER: use cloudflare ou off');
  const ttlRaw = (get('ORYN_TURN_TTL_S') ?? '').trim();
  const ttlSec = ttlRaw === '' ? TURN_TTL_DEFAULT_S : Number(ttlRaw);
  if (!Number.isInteger(ttlSec) || ttlSec < TURN_TTL_MIN_S || ttlSec > TURN_TTL_MAX_S) throw new TurnConfigError(`ORYN_TURN_TTL_S: inteiro de ${TURN_TTL_MIN_S} a ${TURN_TTL_MAX_S}`);
  if (provider === 'off') return { provider, keyId: null, apiToken: null, ttlSec };
  const keyId = (get('ORYN_TURN_KEY_ID') ?? '').trim();
  const apiToken = (get('ORYN_TURN_API_TOKEN') ?? '').trim();
  if (!keyId || !apiToken) throw new TurnConfigError('ORYN_TURN_KEY_ID e ORYN_TURN_API_TOKEN são obrigatórios com ORYN_TURN_PROVIDER=cloudflare');
  return { provider, keyId, apiToken, ttlSec };
}

// ---------- HTTP (CORS igual ao da função signal) ----------

const ALLOW_HEADERS = 'authorization, apikey, content-type, x-client-info';

export async function handleTurnHttp(req: Request, deps: TurnDeps, allowedOrigins: ReadonlySet<string>): Promise<Response> {
  const origin = req.headers.get('origin');
  const allowed = origin !== null && allowedOrigins.has(origin);
  const cors: Record<string, string> = allowed
    ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': ALLOW_HEADERS, 'access-control-allow-methods': 'POST', vary: 'origin' }
    : {};
  if (req.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: cors });
  const result = await handleTurn({ authorization: req.headers.get('authorization'), body: await req.text() }, deps);
  return new Response(JSON.stringify(result.body), { status: result.status, headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

/** Resposta de sucesso, para o cliente validar com o mesmo formato. */
export interface TurnGrant {
  iceServers: IceServerConfig[];
  expiresAt: number;
}

// ---------- dependências reais (Supabase) ----------

/**
 * verifyUser pelo Auth e as RPCs de participantes COM O JWT DO USUÁRIO (apikey publicável + Bearer do usuário): o banco
 * resolve auth.uid() e só devolve sessões vivas e não revogadas de quem é membro ativo. A chave secreta não é usada aqui.
 * Voz padrão (channel_id null): get_voice_participants(room_id). Canal: get_channel_participants(channel_id), que deriva
 * a sala do próprio canal.
 */
export function createLiveSessionDeps(cfg: EdgeConfig, fetchImpl: FetchLike, timeoutMs = TIMEOUT_MS): Pick<TurnDeps, 'verifyUser' | 'liveSessions'> {
  return {
    verifyUser: (jwt) => verifyUserJwt(cfg, fetchImpl, jwt, timeoutMs),
    async liveSessions(jwt, request) {
      const [fn, args] = request.channel_id === null
        ? ['get_voice_participants', { p_room_id: request.room_id }]
        : ['get_channel_participants', { p_channel_id: request.channel_id }];
      const res = await fetchImpl(`${cfg.url}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { ...userHeaders(cfg, jwt), 'content-type': 'application/json' },
        body: JSON.stringify(args),
      });
      if (!res.ok) throw await rpcError(res);
      const rows = (await res.json().catch(() => null)) as unknown;
      if (!Array.isArray(rows)) throw new RpcError('database-unavailable');
      return rows
        .filter((r): r is { session_id: string; is_self: boolean } => typeof r === 'object' && r !== null && isUuid((r as Record<string, unknown>)['session_id']) && typeof (r as Record<string, unknown>)['is_self'] === 'boolean')
        .map((r) => ({ session_id: r.session_id, is_self: r.is_self }));
    },
  };
}
