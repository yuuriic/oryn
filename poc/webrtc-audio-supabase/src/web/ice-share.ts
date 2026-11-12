// Configuração ICE de UMA chamada, compartilhada por todos os pares remotos. Cada par (PeerCall) pede a sua ao começar
// a negociar; aqui os pedidos viram uma emissão só na função `turn`, reaproveitada enquanto valer.
//
// - direct: só STUN, sem a função.
// - auto: STUN + TURN. Se a função ou o provedor falharem, segue só com STUN e avisa uma vez (conectividade degradada:
//   sem relay, redes restritivas podem não conectar). Nunca promete rota.
// - relay / relay-tls: exigem TURN. Sem TURN, cada par recebe turn-unavailable e falha fechado (sem fallback direto).
// - Validade: a configuração só é reaproveitada se ainda valer mais que `renewMarginMs`; vencida (ou quase), é pedida de
//   novo. Uma falha fica guardada por `retryAfterMs`, para os pares não repetirem o pedido em rajada.
// Nada aqui registra credencial, URL TURN ou JWT.

import { hasTurn, sanitizeIceServers } from '../../supabase/functions/_shared/ice-servers.ts';
import type { IceMode, IceServerConfig } from './ice.ts';
import type { ServerMessage } from './protocol.ts';

/** O que a chamada envia à função: a voz e a sessão desta aba. O servidor confere tudo com o JWT. */
export interface TurnTarget {
  room_id: string;
  channel_id: string | null;
  session_id: string;
}

export type TurnGrant = { ok: true; iceServers: IceServerConfig[]; expiresAt: number } | { ok: false; code: string };

/** Chamada HTTP à função (supabase-backend em produção). Lança em falha de rede. */
export type InvokeTurn = (target: TurnTarget) => Promise<{ status: number; body: Record<string, unknown> }>;

const CODE = /^[a-z0-9-]{1,40}$/;

/** Pede a configuração à função e valida a resposta inteira. Qualquer coisa fora do formato é falha, nunca meia config. */
export async function requestTurn(invoke: InvokeTurn, target: TurnTarget, now: () => number): Promise<TurnGrant> {
  let res: { status: number; body: Record<string, unknown> };
  try {
    res = await invoke(target);
  } catch {
    return { ok: false, code: 'unreachable' };
  }
  if (res.status !== 200) {
    const code = res.body['error'];
    return { ok: false, code: typeof code === 'string' && CODE.test(code) ? code : `http-${res.status}` };
  }
  const iceServers = sanitizeIceServers(res.body['iceServers'], null);
  const expiresAt = res.body['expiresAt'];
  if (!hasTurn(iceServers) || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= now()) return { ok: false, code: 'invalid-response' };
  return { ok: true, iceServers, expiresAt };
}

export interface IceShareOptions {
  /** Busca uma configuração nova (requestTurn com a sessão atual). */
  fetch(): Promise<TurnGrant>;
  /** STUN configurado no cliente: modo direct e o fallback do auto. */
  stun: IceServerConfig[];
  now: () => number;
  /** Folga mínima de validade para reaproveitar. Maior que a do PeerCall (5 min), para ele não pedir em laço. */
  renewMarginMs?: number;
  /** Quanto tempo uma falha vale antes de tentar a função de novo. */
  retryAfterMs?: number;
  /** Prazo da busca: menor que o do PeerCall (10 s) para o par receber resposta, nem que seja o fallback. */
  timeoutMs?: number;
  /** Primeira vez que o auto segue sem TURN nesta chamada (e cada volta ao normal depois disso). */
  onDegraded?(code: string): void;
  onRestored?(): void;
  log?(message: string): void;
}

type IceAnswer = Extract<ServerMessage, { type: 'ice-config' } | { type: 'error' }>;

export class IceShare {
  private readonly o: Required<Omit<IceShareOptions, 'onDegraded' | 'onRestored' | 'log'>> & Pick<IceShareOptions, 'onDegraded' | 'onRestored' | 'log'>;
  private grant: { iceServers: IceServerConfig[]; expiresAt: number } | null = null;
  private failure: { code: string; at: number } | null = null;
  private pending: Promise<void> | null = null;
  private degraded = false;
  /** Quantas vezes a função foi chamada nesta chamada (diagnóstico e testes). */
  fetches = 0;

  constructor(options: IceShareOptions) {
    this.o = { renewMarginMs: 10 * 60_000, retryAfterMs: 30_000, timeoutMs: 8_000, ...options };
  }

  /** Resposta ao pedido ICE de um par. */
  async request(mode: IceMode): Promise<IceAnswer> {
    if (mode === 'direct') return { type: 'ice-config', mode, iceServers: this.o.stun, expiresAt: null };
    await this.ensure();
    const grant = this.grant;
    if (grant) {
      // O provedor costuma trazer STUN próprio; sem ele, o STUN local completa (só no auto: relay não recebe STUN).
      const providerStun = grant.iceServers.some((s) => s.username === undefined);
      const servers = !providerStun && this.o.stun.length > 0 ? [...this.o.stun, ...grant.iceServers] : grant.iceServers;
      return { type: 'ice-config', mode, iceServers: servers.slice(0, 4), expiresAt: grant.expiresAt };
    }
    const code = this.failure?.code ?? 'turn-unavailable';
    if (mode !== 'auto') return { type: 'error', code: code === 'ice-limit' ? 'ice-limit' : 'turn-unavailable' };
    if (!this.degraded) {
      this.degraded = true;
      this.o.log?.(`TURN indisponível (${code}): seguindo só com STUN; redes restritivas podem não conectar.`);
      this.o.onDegraded?.(code);
    }
    return { type: 'ice-config', mode, iceServers: this.o.stun, expiresAt: null };
  }

  private usable(): boolean {
    return this.grant !== null && this.grant.expiresAt - this.o.now() > this.o.renewMarginMs;
  }

  /** Garante uma configuração válida ou uma falha recente; pedidos simultâneos esperam a mesma busca. */
  private ensure(): Promise<void> {
    if (this.usable()) return Promise.resolve();
    // Vencida ou quase: nunca reaproveitada.
    this.grant = null;
    if (this.failure && this.o.now() - this.failure.at < this.o.retryAfterMs) return Promise.resolve();
    if (this.pending) return this.pending;
    this.fetches += 1;
    const timeout = new Promise<TurnGrant>((resolve) => setTimeout(() => resolve({ ok: false, code: 'timeout' }), this.o.timeoutMs));
    this.pending = Promise.race([this.o.fetch().catch((): TurnGrant => ({ ok: false, code: 'unreachable' })), timeout]).then((received) => {
      let result = received;
      this.pending = null;
      // Já dentro da folga: o PeerCall a recusaria e pediria de novo, em ciclo. Vale como falha, guardada por retryAfterMs.
      if (result.ok && result.expiresAt - this.o.now() <= this.o.renewMarginMs) result = { ok: false, code: 'short-validity' };
      if (result.ok) {
        this.grant = { iceServers: result.iceServers, expiresAt: result.expiresAt };
        this.failure = null;
        if (this.degraded) {
          this.degraded = false;
          this.o.log?.('TURN disponível de novo para as próximas conexões.');
          this.o.onRestored?.();
        }
      } else {
        this.failure = { code: result.code, at: this.o.now() };
      }
    });
    return this.pending;
  }
}

/** Modo ICE pedido para testes técnicos, fora da interface: ?oryn-ice=<modo> na URL ou o padrão da build. */
export function chosenIceMode(search: string, buildDefault: IceMode): IceMode {
  const value = new URLSearchParams(search).get('oryn-ice');
  return value === 'auto' || value === 'direct' || value === 'relay' || value === 'relay-tls' ? value : buildDefault;
}
