// TURN/STUN (POC-02B.4): adaptador de provedor TURN gerenciado + emissão de configuração ICE para
// participantes ADMITIDOS.
//
// - O segredo administrativo do provedor (API token) existe SÓ no servidor; o navegador recebe apenas
//   credenciais TURN temporárias, exclusivas da sua conexão.
// - Emissão somente para quem já está numa sessão (após Access, convite ou pareamento), com limites por
//   conexão e globais, uma emissão em andamento por conexão e revogação ao sair/desconectar.
// - Falha ou timeout do provedor → erro "turn-unavailable"; nunca credenciais fictícias.
// - Logs sem username, credential, token ou URLs com credenciais.

import type { IceMode, IceServerConfig } from '../src/ice.ts';
import { parseIceUrl } from '../src/ice.ts';
import { isIceServers } from '../src/protocol.ts';

// ---------- contrato do adaptador ----------

export interface TurnIssue {
  /** Servidores ICE (STUN e TURN) com credenciais temporárias. */
  iceServers: IceServerConfig[];
  /** Identificador da credencial no provedor (para revogação). Nunca registrado em log. */
  username: string;
  /** Validade da credencial (ms desde a época). */
  expiresAt: number;
}

export interface TurnProvider {
  /** Nome curto para logs (ex.: "cloudflare", "simulado"). */
  readonly name: string;
  /** Emite credenciais temporárias com a validade pedida (segundos). Rejeita em falha/timeout. */
  issue(ttlSec: number): Promise<TurnIssue>;
  /** Revoga a credencial (melhor esforço). Rejeita em falha. */
  revoke(username: string): Promise<void>;
}

export class TurnProviderError extends Error {}

// ---------- Cloudflare Realtime TURN (conforme a documentação oficial; não exercitado contra a API real) ----------

export const CLOUDFLARE_TURN_API = 'https://rtc.live.cloudflare.com/v1/turn/keys';
/** Hosts documentados das URLs devolvidas; qualquer outro host é descartado (falha fechada). */
export const CLOUDFLARE_ICE_HOSTS = new Set(['stun.cloudflare.com', 'turn.cloudflare.com']);
const KEY_ID = /^[A-Za-z0-9_-]{8,128}$/;
const API_TOKEN = /^[A-Za-z0-9._-]{16,512}$/;

export interface CloudflareTurnOptions {
  keyId: string;
  /** Segredo administrativo (somente servidor; nunca em log, argumento ou repositório). */
  apiToken: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => number;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

export class CloudflareTurnProvider implements TurnProvider {
  readonly name = 'cloudflare';
  private readonly keyId: string;
  private readonly apiToken: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly doFetch: (url: string, init: RequestInit) => Promise<Response>;

  constructor(options: CloudflareTurnOptions) {
    if (!KEY_ID.test(options.keyId)) throw new Error('ORYN_TURN_KEY_ID inválido.');
    if (!API_TOKEN.test(options.apiToken)) throw new Error('ORYN_TURN_API_TOKEN inválido.');
    this.keyId = options.keyId;
    this.apiToken = options.apiToken;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.maxBytes = options.maxResponseBytes ?? 32 * 1024;
    this.now = options.now ?? Date.now;
    this.doFetch = options.fetch ?? fetch;
  }

  async issue(ttlSec: number): Promise<TurnIssue> {
    const url = `${CLOUDFLARE_TURN_API}/${encodeURIComponent(this.keyId)}/credentials/generate-ice-servers`;
    const body = await this.call(url, JSON.stringify({ ttl: ttlSec }), [200, 201]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new TurnProviderError('resposta do provedor não é JSON');
    }
    const servers = (parsed as { iceServers?: unknown } | null)?.iceServers;
    if (!Array.isArray(servers)) throw new TurnProviderError('resposta do provedor sem iceServers');
    const clean = sanitizeServers(servers, CLOUDFLARE_ICE_HOSTS);
    const turn = clean.find((s) => s.username !== undefined);
    if (!turn?.username || !turn.credential) throw new TurnProviderError('resposta do provedor sem credencial TURN');
    return { iceServers: clean, username: turn.username, expiresAt: this.now() + ttlSec * 1000 };
  }

  async revoke(username: string): Promise<void> {
    const url = `${CLOUDFLARE_TURN_API}/${encodeURIComponent(this.keyId)}/credentials/${encodeURIComponent(username)}/revoke`;
    await this.call(url, '', [200, 204]);
  }

  private async call(url: string, body: string, okStatus: number[]): Promise<string> {
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
        ...(body ? { body } : {}),
      });
    } catch {
      throw new TurnProviderError(signal.aborted ? 'tempo esgotado' : 'falha de rede');
    }
    if (!okStatus.includes(res.status)) {
      await res.body?.cancel().catch(() => undefined);
      throw new TurnProviderError(`HTTP ${res.status}`);
    }
    if (Number(res.headers.get('content-length') ?? '0') > this.maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new TurnProviderError('resposta grande demais');
    }
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
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
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof TurnProviderError) throw error;
      throw new TurnProviderError(signal.aborted ? 'tempo esgotado' : 'falha de leitura');
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}

/**
 * Normaliza a lista do provedor: só URLs ICE válidas (sem porta 53) de hosts permitidos, credenciais
 * só junto de TURN, no máximo os limites do protocolo. Lança se o resultado não for um conjunto válido.
 */
export function sanitizeServers(raw: unknown[], allowedHosts: ReadonlySet<string> | null): IceServerConfig[] {
  const out: IceServerConfig[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const list = Array.isArray(e['urls']) ? e['urls'] : typeof e['urls'] === 'string' ? [e['urls']] : [];
    const urls = list.filter((u): u is string => {
      if (typeof u !== 'string') return false;
      const parsed = parseIceUrl(u);
      return parsed !== null && (allowedHosts === null || allowedHosts.has(parsed.host));
    });
    if (urls.length === 0) continue;
    const hasTurn = urls.some((u) => parseIceUrl(u)!.scheme !== 'stun');
    if (hasTurn) {
      if (typeof e['username'] !== 'string' || typeof e['credential'] !== 'string') continue;
      out.push({ urls: urls.slice(0, 8), username: e['username'], credential: e['credential'] });
    } else {
      out.push({ urls: urls.slice(0, 8) });
    }
  }
  const limited = out.slice(0, 4);
  if (!isIceServers(limited)) throw new TurnProviderError('servidores ICE do provedor inválidos');
  return limited;
}

// ---------- provedor simulado (testes e uso local; nenhuma rede) ----------

export interface SimulatedTurnOptions {
  /** URLs TURN/TURNS anunciadas (ex.: endereços locais sem servidor, para provar falha fechada). */
  turnUrls: string[];
  stunUrls?: string[];
  now?: () => number;
  /** Atraso/falha injetáveis. */
  behavior?: () => Promise<void>;
}

export class SimulatedTurnProvider implements TurnProvider {
  readonly name = 'simulado';
  readonly issued: string[] = [];
  readonly revoked: string[] = [];
  private seq = 0;
  private readonly options: SimulatedTurnOptions;

  constructor(options: SimulatedTurnOptions) {
    this.options = options;
  }

  async issue(ttlSec: number): Promise<TurnIssue> {
    await this.options.behavior?.();
    this.seq += 1;
    const username = `sim-${Date.now().toString(36)}-${this.seq}`;
    const credential = `cred-${this.seq}-${Math.random().toString(36).slice(2)}`;
    this.issued.push(username);
    const servers: IceServerConfig[] = [];
    if (this.options.stunUrls?.length) servers.push({ urls: this.options.stunUrls });
    if (this.options.turnUrls.length) servers.push({ urls: this.options.turnUrls, username, credential });
    return { iceServers: sanitizeServers(servers, null), username, expiresAt: (this.options.now ?? Date.now)() + ttlSec * 1000 };
  }

  async revoke(username: string): Promise<void> {
    this.revoked.push(username);
  }
}

// ---------- emissão para participantes admitidos ----------

export interface IceBrokerOptions {
  provider: TurnProvider | null;
  /** STUN usado nos modos auto/direct quando o provedor não fornece (ou não há provedor). */
  stunUrls: string[];
  /** Validade das credenciais TURN (s). */
  ttlSec: number;
  /** Intervalo mínimo entre emissões TURN para a mesma conexão. */
  minIntervalMs: number;
  /** Máximo de emissões TURN por conexão. */
  maxPerConnection: number;
  /** Máximo de chamadas simultâneas ao provedor (todas as conexões). */
  maxInflight: number;
  now: () => number;
  log: (line: string) => void;
}

export interface IceRequester {
  /** Identificador interno da conexão. */
  id: string;
  /** Ainda conectado e admitido? (consultado de novo após a resposta assíncrona do provedor). */
  admitted(): boolean;
  /** Prefixo da sessão para log (nunca o ID completo). */
  sessionTag(): string;
  send(message: { type: 'ice-config'; mode: IceMode; iceServers: IceServerConfig[]; expiresAt: number | null } | { type: 'error'; code: 'turn-unavailable' | 'ice-limit' }): void;
}

interface ConnectionState {
  issuedAt: number[];
  inflight: boolean;
  usernames: string[];
}

const needsTurn = (mode: IceMode): boolean => mode !== 'direct';

/** Emite configuração ICE só para conexões admitidas; revoga credenciais no fim da conexão. */
export class IceBroker {
  private readonly options: IceBrokerOptions;
  private readonly connections = new Map<string, ConnectionState>();
  private inflight = 0;

  constructor(options: IceBrokerOptions) {
    this.options = options;
  }

  get turnConfigured(): boolean {
    return this.options.provider !== null;
  }

  /** Credenciais ativas por conexão (diagnóstico/testes; sem valores). */
  activeCredentials(id: string): number {
    return this.connections.get(id)?.usernames.length ?? 0;
  }

  /** A conexão JÁ deve ter sido verificada como admitida pelo chamador. */
  async request(who: IceRequester, mode: IceMode): Promise<void> {
    const { provider, stunUrls } = this.options;
    if (!needsTurn(mode) || provider === null) {
      // direct, ou auto sem provedor: só STUN. relay/relay-tls sem provedor: falha fechada no cliente.
      if (needsTurn(mode) && mode !== 'auto') {
        who.send({ type: 'error', code: 'turn-unavailable' });
        return;
      }
      who.send({ type: 'ice-config', mode, iceServers: stunUrls.length ? [{ urls: stunUrls }] : [], expiresAt: null });
      return;
    }

    const state = this.connections.get(who.id) ?? { issuedAt: [], inflight: false, usernames: [] };
    this.connections.set(who.id, state);
    const now = this.options.now();
    const last = state.issuedAt.at(-1);
    if (
      state.inflight ||
      state.issuedAt.length >= this.options.maxPerConnection ||
      (last !== undefined && now - last < this.options.minIntervalMs) ||
      this.inflight >= this.options.maxInflight
    ) {
      who.send({ type: 'error', code: 'ice-limit' });
      return;
    }

    state.inflight = true;
    this.inflight += 1;
    let issue: TurnIssue;
    try {
      issue = await provider.issue(this.options.ttlSec);
    } catch (error) {
      this.options.log(`[turn] provedor ${provider.name} indisponível (${error instanceof TurnProviderError ? error.message : 'erro'})`);
      if (who.admitted()) who.send({ type: 'error', code: 'turn-unavailable' });
      return;
    } finally {
      state.inflight = false;
      this.inflight -= 1;
    }
    // A conexão pode ter saído enquanto o provedor respondia: a credencial nunca é entregue e é revogada.
    if (!who.admitted() || !this.connections.has(who.id)) {
      this.revoke(issue.username);
      return;
    }
    state.issuedAt.push(this.options.now());
    state.usernames.push(issue.username);
    // STUN configurado localmente só complementa quando o provedor não trouxe nenhum.
    const providerHasStun = issue.iceServers.some((s) => s.username === undefined);
    const servers = !providerHasStun && stunUrls.length ? [{ urls: stunUrls }, ...issue.iceServers] : issue.iceServers;
    who.send({ type: 'ice-config', mode, iceServers: servers.slice(0, 4), expiresAt: issue.expiresAt });
    this.options.log(`[turn] credencial temporária emitida (sessão ${who.sessionTag()}, modo ${mode}, validade ${Math.round(this.options.ttlSec / 60)} min)`);
  }

  /** Fim da conexão (saída, desconexão, expiração): revoga as credenciais dela e esquece o estado. */
  release(id: string): void {
    const state = this.connections.get(id);
    this.connections.delete(id);
    for (const username of state?.usernames ?? []) this.revoke(username);
  }

  /** Desligamento: revoga tudo (melhor esforço). */
  releaseAll(): void {
    for (const id of [...this.connections.keys()]) this.release(id);
  }

  private revoke(username: string): void {
    const provider = this.options.provider;
    if (!provider) return;
    provider.revoke(username).then(
      () => this.options.log('[turn] credencial revogada'),
      () => this.options.log('[turn] falha ao revogar credencial (expira sozinha no fim da validade)'),
    );
  }
}
