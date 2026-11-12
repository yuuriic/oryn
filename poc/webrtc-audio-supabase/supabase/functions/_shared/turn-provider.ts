// Provedor TURN da Edge Function `turn`: Cloudflare Realtime TURN. Porte de poc/webrtc-audio-wan/server/turn.ts
// (POC-02B.4, `CloudflareTurnProvider`) para APIs Web, sem Node (`Buffer`): roda igual no Deno e nos testes.
//
// - O token da API do provedor existe SÓ no servidor (secret da função). O navegador recebe apenas credenciais TURN
//   temporárias, geradas pelo provedor com validade (TTL).
// - Falha, timeout, status inesperado, resposta grande ou malformada → TurnProviderError. Nunca credencial fictícia.
// - Só os hosts documentados do provedor passam; URLs da porta 53 são removidas; sem TURN com credencial → falha.
// - Revogação explícita não é usada: a credencial vale até o fim do TTL (decisão documentada em TURN-RELAY.md).
//
// [Documentação da Cloudflare, consultada na POC-02B; NÃO exercitado contra a API real]:
//   POST https://rtc.live.cloudflare.com/v1/turn/keys/<KEY_ID>/credentials/generate-ice-servers
//   Authorization: Bearer <token>; corpo {"ttl": <s>}; resposta 201 com { iceServers: [...] }.

import { hasTurn, sanitizeIceServers, type IceServerConfig } from './ice-servers.ts';

export interface TurnIssue {
  /** Servidores ICE (STUN e TURN) com credenciais temporárias, já sanitizados. */
  iceServers: IceServerConfig[];
  /** Fim da validade (ms desde a época), calculado na emissão. */
  expiresAt: number;
}

export interface TurnProvider {
  /** Nome curto para logs. */
  readonly name: string;
  /** Emite credenciais com a validade pedida (segundos). Rejeita com TurnProviderError. */
  issue(ttlSec: number): Promise<TurnIssue>;
}

export class TurnProviderError extends Error {}

export const CLOUDFLARE_TURN_API = 'https://rtc.live.cloudflare.com/v1/turn/keys';
/** Hosts documentados das URLs devolvidas; qualquer outro é descartado (falha fechada se não sobrar TURN). */
export const CLOUDFLARE_ICE_HOSTS: ReadonlySet<string> = new Set(['stun.cloudflare.com', 'turn.cloudflare.com']);
export const TURN_KEY_ID = /^[A-Za-z0-9_-]{8,128}$/;
export const TURN_API_TOKEN = /^[A-Za-z0-9._-]{16,512}$/;

export type ProviderFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface CloudflareTurnOptions {
  keyId: string;
  /** Segredo administrativo (somente servidor; nunca em log, resposta ou repositório). */
  apiToken: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => number;
  fetch?: ProviderFetch;
}

export class CloudflareTurnProvider implements TurnProvider {
  readonly name = 'cloudflare';
  private readonly keyId: string;
  private readonly apiToken: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly doFetch: ProviderFetch;

  constructor(options: CloudflareTurnOptions) {
    // Mensagens sem o valor: um token inválido nunca aparece em log de erro.
    if (!TURN_KEY_ID.test(options.keyId)) throw new Error('ORYN_TURN_KEY_ID inválido.');
    if (!TURN_API_TOKEN.test(options.apiToken)) throw new Error('ORYN_TURN_API_TOKEN inválido.');
    this.keyId = options.keyId;
    this.apiToken = options.apiToken;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.maxBytes = options.maxResponseBytes ?? 32 * 1024;
    this.now = options.now ?? Date.now;
    this.doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  }

  async issue(ttlSec: number): Promise<TurnIssue> {
    const url = `${CLOUDFLARE_TURN_API}/${encodeURIComponent(this.keyId)}/credentials/generate-ice-servers`;
    const issuedAt = this.now();
    const body = await this.call(url, JSON.stringify({ ttl: ttlSec }));
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new TurnProviderError('resposta do provedor não é JSON');
    }
    const raw = (parsed as { iceServers?: unknown } | null)?.iceServers;
    if (!Array.isArray(raw)) throw new TurnProviderError('resposta do provedor sem iceServers');
    const iceServers = sanitizeIceServers(raw, CLOUDFLARE_ICE_HOSTS);
    if (!hasTurn(iceServers)) throw new TurnProviderError('resposta do provedor sem credencial TURN válida');
    // A validade conta do pedido, não da resposta: nunca promete mais do que o provedor concedeu.
    return { iceServers, expiresAt: issuedAt + ttlSec * 1000 };
  }

  private async call(url: string, body: string): Promise<string> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await this.doFetch(url, {
        method: 'POST',
        signal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        headers: { authorization: `Bearer ${this.apiToken}`, 'content-type': 'application/json' },
        body,
      });
    } catch {
      throw new TurnProviderError(signal.aborted ? 'tempo esgotado' : 'falha de rede');
    }
    if (res.status !== 200 && res.status !== 201) {
      await res.body?.cancel().catch(() => undefined);
      throw new TurnProviderError(`HTTP ${res.status}`);
    }
    if (Number(res.headers.get('content-length') ?? '0') > this.maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new TurnProviderError('resposta grande demais');
    }
    if (!res.body) throw new TurnProviderError('resposta vazia');
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '';
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new TurnProviderError('resposta grande demais');
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } catch (error) {
      if (error instanceof TurnProviderError) throw error;
      throw new TurnProviderError(signal.aborted ? 'tempo esgotado' : 'falha de leitura');
    }
    return text;
  }
}
