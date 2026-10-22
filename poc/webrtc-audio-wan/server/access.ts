// Cloudflare Access (POC-02B.3A): validação criptográfica, na origem, do JWT que a borda da Cloudflare
// injeta no cabeçalho Cf-Access-Jwt-Assertion de cada requisição encaminhada ao listener de sinalização.
//
// - Biblioteca consolidada (jose) para verificar assinatura e claims; nenhuma primitiva própria.
// - Somente RS256 (algoritmo usado pelo Access). "none", HMAC e outros algoritmos são recusados antes
//   de qualquer busca de chave (sem confusão de algoritmos).
// - iss e URL das chaves DERIVADOS do domínio da equipe configurado; nada vindo do cliente define URL.
// - JWKS por HTTPS, com timeout, limite de tamanho, sem redirecionamentos, cache com validade, uso de
//   chaves em cache por tempo limitado após falha de atualização e intervalo mínimo entre atualizações
//   provocadas por "kid" desconhecido.
// - Falha fechada: token ausente, inválido ou JWKS indisponível NUNCA autorizam.

import { decodeProtectedHeader, importJWK, jwtVerify, type CryptoKey, type JWK } from 'jose';

export const ACCESS_HEADER = 'cf-access-jwt-assertion';
const ALGORITHM = 'RS256';
/** Tamanho máximo aceito para o cabeçalho com o JWT. */
export const MAX_JWT_LENGTH = 8192;
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const TEAM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const AUD_TAG = /^[0-9a-f]{64}$/;
const MAX_KEYS = 20;
const PRIVATE_JWK_FIELDS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];
/** Após uma busca de JWKS falhar, novas tentativas esperam este intervalo (não martela a origem). */
export const JWKS_FAILURE_BACKOFF_MS = 2_000;

export interface AccessConfig {
  /** Domínio da equipe, ex.: "minha-equipe.cloudflareaccess.com". Define iss e a URL das chaves. */
  teamDomain: string;
  /** AUD tag da aplicação Access (64 caracteres hexadecimais). */
  audience: string;
  /** Tempo máximo de uma busca de JWKS, incluindo o corpo (padrão 3 s). */
  jwksTimeoutMs?: number;
  /** Tamanho máximo da resposta do JWKS (padrão 64 KiB). */
  jwksMaxBytes?: number;
  /** Validade do cache de chaves (padrão 10 min). */
  jwksCacheTtlMs?: number;
  /** Após o vencimento do cache, por quanto tempo chaves antigas ainda servem se a atualização falhar (padrão 1 h). */
  jwksMaxStaleMs?: number;
  /** Intervalo mínimo entre buscas provocadas por "kid" desconhecido (padrão 30 s). */
  jwksRefreshCooldownMs?: number;
  /** Tolerância de relógio para exp/nbf, em segundos (padrão 30). */
  clockToleranceSec?: number;
}

/** Transporte HTTP do JWKS (fetch global por padrão; substituível nos testes, sem rede pública). */
export type JwksFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ResolvedAccessConfig {
  issuer: string;
  audience: string;
  jwksUrl: string;
  jwksTimeoutMs: number;
  jwksMaxBytes: number;
  jwksCacheTtlMs: number;
  jwksMaxStaleMs: number;
  jwksRefreshCooldownMs: number;
  clockToleranceSec: number;
}

function intInRange(name: string, value: number | undefined, fallback: number, min: number, max: number): number {
  const v = value ?? fallback;
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new Error(`Configuração do Cloudflare Access inválida: ${name} deve ser inteiro entre ${min} e ${max}.`);
  }
  return v;
}

/** Valida a configuração (qualquer erro impede a inicialização) e deriva issuer e URL das chaves. */
export function resolveAccessConfig(config: AccessConfig): ResolvedAccessConfig {
  const team = typeof config.teamDomain === 'string' ? config.teamDomain.trim().toLowerCase() : '';
  if (!TEAM_DOMAIN.test(team)) {
    throw new Error('Configuração do Cloudflare Access inválida: teamDomain deve ser "<equipe>.cloudflareaccess.com".');
  }
  const audience = typeof config.audience === 'string' ? config.audience.trim().toLowerCase() : '';
  if (!AUD_TAG.test(audience)) {
    throw new Error('Configuração do Cloudflare Access inválida: audience deve ser a AUD tag (64 caracteres hexadecimais).');
  }
  const jwksCacheTtlMs = intInRange('jwksCacheTtlMs', config.jwksCacheTtlMs, 10 * 60_000, 10_000, 24 * 60 * 60_000);
  return {
    issuer: `https://${team}`,
    audience,
    jwksUrl: `https://${team}/cdn-cgi/access/certs`,
    jwksTimeoutMs: intInRange('jwksTimeoutMs', config.jwksTimeoutMs, 3_000, 100, 30_000),
    jwksMaxBytes: intInRange('jwksMaxBytes', config.jwksMaxBytes, 64 * 1024, 1024, 1024 * 1024),
    jwksCacheTtlMs,
    jwksMaxStaleMs: intInRange('jwksMaxStaleMs', config.jwksMaxStaleMs, 60 * 60_000, 0, 24 * 60 * 60_000),
    jwksRefreshCooldownMs: intInRange('jwksRefreshCooldownMs', config.jwksRefreshCooldownMs, 30_000, 0, jwksCacheTtlMs),
    clockToleranceSec: intInRange('clockToleranceSec', config.clockToleranceSec, 30, 0, 300),
  };
}

export class JwksError extends Error {}

interface KeyCache {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

export interface JwksClientOptions {
  url: string;
  timeoutMs: number;
  maxBytes: number;
  cacheTtlMs: number;
  maxStaleMs: number;
  refreshCooldownMs: number;
  now: () => number;
  fetch: JwksFetch;
}

/** Busca e mantém em cache as chaves públicas do Access. Nunca devolve chaves não validadas. */
export class JwksClient {
  private cache: KeyCache | null = null;
  private inflight: Promise<KeyCache> | null = null;
  private lastAttempt = Number.NEGATIVE_INFINITY;
  private lastFailure = Number.NEGATIVE_INFINITY;
  private readonly options: JwksClientOptions;

  constructor(options: JwksClientOptions) {
    const url = new URL(options.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
      throw new Error('JWKS do Cloudflare Access precisa de URL https sem credenciais, consulta ou fragmento.');
    }
    this.options = options;
  }

  /** Quantas buscas foram iniciadas (diagnóstico e testes). */
  fetches = 0;

  /** Chaves vigentes: cache dentro da validade, atualização se vencido; chaves antigas só até maxStale. */
  async keys(): Promise<Map<string, CryptoKey>> {
    const now = this.options.now();
    const cache = this.cache;
    if (cache && now - cache.fetchedAt < this.options.cacheTtlMs) return cache.keys;
    const usableStale = cache !== null && now - cache.fetchedAt < this.options.cacheTtlMs + this.options.maxStaleMs;
    if (!this.inflight && now - this.lastFailure < JWKS_FAILURE_BACKOFF_MS) {
      if (usableStale) return cache.keys;
      throw new JwksError('JWKS indisponível (aguardando nova tentativa)');
    }
    try {
      return (await this.refresh()).keys;
    } catch (error) {
      if (usableStale) return cache.keys;
      throw error instanceof JwksError ? error : new JwksError('JWKS indisponível');
    }
  }

  /**
   * "kid" desconhecido: possível rotação. Atualiza no máximo uma vez por intervalo (impede que tokens
   * forjados com kids aleatórios provoquem buscas em massa). Devolve as chaves após a tentativa.
   */
  async keysAfterUnknownKid(): Promise<Map<string, CryptoKey> | null> {
    if (this.options.now() - this.lastAttempt < this.options.refreshCooldownMs && !this.inflight) return null;
    try {
      return (await this.refresh()).keys;
    } catch {
      return null;
    }
  }

  private refresh(): Promise<KeyCache> {
    // Uma busca por vez: requisições simultâneas aguardam a mesma promessa.
    this.inflight ??= this.load()
      .catch((error: unknown) => {
        this.lastFailure = this.options.now();
        throw error;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async load(): Promise<KeyCache> {
    this.lastAttempt = this.options.now();
    this.fetches += 1;
    const body = await this.download();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new JwksError('JWKS malformado (JSON inválido)');
    }
    const keys = await parseKeySet(parsed);
    this.cache = { keys, fetchedAt: this.options.now() };
    return this.cache;
  }

  private async download(): Promise<string> {
    const { url, timeoutMs, maxBytes } = this.options;
    const signal = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await this.options.fetch(url, {
        method: 'GET',
        signal,
        redirect: 'error', // a origem das chaves é fixa: nenhum redirecionamento é seguido
        credentials: 'omit',
        cache: 'no-store',
        headers: { accept: 'application/json' },
      });
    } catch {
      throw new JwksError(signal.aborted ? 'JWKS: tempo esgotado' : 'JWKS: falha de rede');
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      throw new JwksError(`JWKS: HTTP ${res.status}`);
    }
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new JwksError('JWKS: resposta grande demais');
    }
    if (!res.body) throw new JwksError('JWKS: resposta vazia');
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new JwksError('JWKS: resposta grande demais');
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof JwksError) throw error;
      throw new JwksError(signal.aborted ? 'JWKS: tempo esgotado' : 'JWKS: falha de leitura');
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}

/** Valida o JWKS e importa só chaves RSA públicas de assinatura RS256, indexadas por kid. */
async function parseKeySet(value: unknown): Promise<Map<string, CryptoKey>> {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { keys?: unknown }).keys)) {
    throw new JwksError('JWKS malformado (sem "keys")');
  }
  const list = (value as { keys: unknown[] }).keys;
  if (list.length === 0 || list.length > MAX_KEYS) throw new JwksError('JWKS malformado (quantidade de chaves)');
  const keys = new Map<string, CryptoKey>();
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) throw new JwksError('JWKS malformado (chave)');
    const jwk = raw as Record<string, unknown>;
    // Material privado num JWKS público indica erro grave de origem: o conjunto inteiro é recusado.
    if (PRIVATE_JWK_FIELDS.some((f) => f in jwk)) throw new JwksError('JWKS malformado (material privado)');
    // Chaves de outros tipos/usos são ignoradas (não servem para RS256).
    if (jwk['kty'] !== 'RSA') continue;
    if (jwk['alg'] !== undefined && jwk['alg'] !== ALGORITHM) continue;
    if (jwk['use'] !== undefined && jwk['use'] !== 'sig') continue;
    const kid = jwk['kid'];
    if (typeof kid !== 'string' || kid.length === 0 || kid.length > 256) throw new JwksError('JWKS malformado (kid)');
    if (keys.has(kid)) throw new JwksError('JWKS malformado (kid duplicado)');
    if (typeof jwk['n'] !== 'string' || typeof jwk['e'] !== 'string') throw new JwksError('JWKS malformado (RSA)');
    let key: CryptoKey;
    try {
      key = (await importJWK({ kty: 'RSA', n: jwk['n'], e: jwk['e'] } as JWK, ALGORITHM)) as CryptoKey;
    } catch {
      throw new JwksError('JWKS malformado (chave RSA inválida)');
    }
    const bits = (key.algorithm as { modulusLength?: number }).modulusLength ?? 0;
    if (bits < 2048) throw new JwksError('JWKS malformado (chave RSA fraca)');
    keys.set(kid, key);
  }
  if (keys.size === 0) throw new JwksError('JWKS sem chaves RS256 utilizáveis');
  return keys;
}

export type AccessFailure = 'missing' | 'malformed' | 'invalid' | 'unavailable';
export type AccessResult = { ok: true; expiresAt: number } | { ok: false; reason: AccessFailure };

export interface AccessVerifierOptions {
  config: ResolvedAccessConfig;
  now: () => number;
  fetch: JwksFetch;
}

/** Verifica o JWT do cabeçalho Cf-Access-Jwt-Assertion. Não concede nenhum privilégio administrativo. */
export class AccessVerifier {
  readonly jwks: JwksClient;
  private readonly config: ResolvedAccessConfig;
  private readonly now: () => number;

  constructor(options: AccessVerifierOptions) {
    this.config = options.config;
    this.now = options.now;
    this.jwks = new JwksClient({
      url: options.config.jwksUrl,
      timeoutMs: options.config.jwksTimeoutMs,
      maxBytes: options.config.jwksMaxBytes,
      cacheTtlMs: options.config.jwksCacheTtlMs,
      maxStaleMs: options.config.jwksMaxStaleMs,
      refreshCooldownMs: options.config.jwksRefreshCooldownMs,
      now: options.now,
      fetch: options.fetch,
    });
  }

  async verify(header: string | string[] | undefined): Promise<AccessResult> {
    if (header === undefined || header === '') return { ok: false, reason: 'missing' };
    // Cabeçalho repetido é ambíguo: recusado.
    if (typeof header !== 'string' || header.length > MAX_JWT_LENGTH || !COMPACT_JWS.test(header)) {
      return { ok: false, reason: 'malformed' };
    }
    let kid: string;
    try {
      const protectedHeader = decodeProtectedHeader(header);
      // Recusa antecipada (antes de buscar chaves): só RS256 e kid obrigatório.
      if (protectedHeader.alg !== ALGORITHM || typeof protectedHeader.kid !== 'string' || protectedHeader.crit !== undefined) {
        return { ok: false, reason: 'invalid' };
      }
      kid = protectedHeader.kid;
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    let keys: Map<string, CryptoKey>;
    try {
      keys = await this.jwks.keys();
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    let key = keys.get(kid);
    if (!key) {
      // Possível rotação: uma atualização controlada (intervalo mínimo); kid desconhecido nunca autoriza.
      key = (await this.jwks.keysAfterUnknownKid())?.get(kid);
      if (!key) return { ok: false, reason: 'invalid' };
    }
    try {
      const { payload } = await jwtVerify(header, key, {
        algorithms: [ALGORITHM],
        issuer: this.config.issuer,
        audience: this.config.audience,
        requiredClaims: ['exp', 'iat'],
        clockTolerance: this.config.clockToleranceSec,
        currentDate: new Date(this.now()),
      });
      return { ok: true, expiresAt: (payload.exp as number) * 1000 };
    } catch {
      return { ok: false, reason: 'invalid' };
    }
  }
}
