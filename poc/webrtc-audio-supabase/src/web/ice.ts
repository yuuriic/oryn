// Copiado de poc/webrtc-audio-wan/src/ice.ts (POC-02B, 6daeb99) para a integração 02C (cliente web).
// POCs isoladas: sem import cruzado. Conteúdo original abaixo, sem alterações.
// Modos ICE da POC-02B.4 (puro, sem DOM): monta a RTCConfiguration a partir dos servidores ICE
// entregues pelo servidor de sinalização, com FALHA FECHADA para os modos de retransmissão.
//
//   auto       STUN + TURN (todas as URLs), iceTransportPolicy "all"
//   direct     somente STUN, iceTransportPolicy "all" (não garante rota direta entre quaisquer redes)
//   relay      somente TURN (turn: e turns:), iceTransportPolicy "relay"; sem TURN → falha
//   relay-tls  somente turns: com transport=tcp, iceTransportPolicy "relay"; sem TURNS → falha
//
// Nenhum fallback silencioso: relay/relay-tls nunca recebem STUN nem URLs de outro transporte.
// TURN/TLS selecionado NÃO prova que UDP está bloqueado na rede: só que este modo foi usado.

export const ICE_MODES = ['auto', 'direct', 'relay', 'relay-tls'] as const;
export type IceMode = (typeof ICE_MODES)[number];

export const isIceMode = (v: unknown): v is IceMode => typeof v === 'string' && (ICE_MODES as readonly string[]).includes(v);

/** Servidor ICE como trafega na sinalização (subconjunto estrito de RTCIceServer). */
export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

export const MAX_ICE_SERVERS = 4;
export const MAX_ICE_URLS = 8;
export const MAX_ICE_SECRET_LENGTH = 512;

/**
 * URL ICE aceita: esquema stun/turn/turns, host DNS ou IPv4, porta opcional e, só para TURN,
 * ?transport=udp|tcp. Porta 53 é recusada (bloqueada pelos navegadores; a URL só expiraria).
 */
const ICE_URL = /^(stun|turn|turns):([a-z0-9.-]{1,253})(?::(\d{1,5}))?(?:\?transport=(udp|tcp))?$/;

export interface ParsedIceUrl {
  scheme: 'stun' | 'turn' | 'turns';
  host: string;
  port: number | null;
  transport: 'udp' | 'tcp' | null;
}

export function parseIceUrl(url: string): ParsedIceUrl | null {
  const m = ICE_URL.exec(url);
  if (!m) return null;
  const scheme = m[1] as ParsedIceUrl['scheme'];
  const port = m[3] === undefined ? null : Number(m[3]);
  const transport = (m[4] as ParsedIceUrl['transport'] | undefined) ?? null;
  if (port !== null && (port < 1 || port > 65535 || port === 53)) return null;
  if (scheme === 'stun' && transport !== null) return null;
  return { scheme, host: m[2]!, port, transport };
}

export type IceConfigResult =
  | { ok: true; config: RTCConfiguration; turnConfigured: boolean; summary: string }
  | { ok: false; reason: string };

/** Monta a RTCConfiguration do modo. Servidores inválidos ou sem credencial são descartados. */
export function buildRtcConfiguration(mode: IceMode, servers: readonly IceServerConfig[]): IceConfigResult {
  const stun: string[] = [];
  const turn: { urls: string[]; username: string; credential: string }[] = [];
  for (const server of servers) {
    const urls = server.urls.filter((u) => parseIceUrl(u) !== null);
    const stunUrls = urls.filter((u) => parseIceUrl(u)!.scheme === 'stun');
    const turnUrls = urls.filter((u) => parseIceUrl(u)!.scheme !== 'stun');
    stun.push(...stunUrls);
    // TURN sem credencial completa é inútil e não é usado.
    if (turnUrls.length > 0 && server.username && server.credential) {
      turn.push({ urls: turnUrls, username: server.username, credential: server.credential });
    }
  }
  const tlsOnly = turn
    .map((t) => ({ ...t, urls: t.urls.filter((u) => { const p = parseIceUrl(u)!; return p.scheme === 'turns' && p.transport !== 'udp'; }) }))
    .filter((t) => t.urls.length > 0);

  switch (mode) {
    case 'auto': {
      const iceServers: RTCIceServer[] = [...(stun.length ? [{ urls: stun }] : []), ...turn];
      return { ok: true, config: { iceServers, iceTransportPolicy: 'all' }, turnConfigured: turn.length > 0, summary: describe(stun.length, turn) };
    }
    case 'direct':
      return { ok: true, config: { iceServers: stun.length ? [{ urls: stun }] : [], iceTransportPolicy: 'all' }, turnConfigured: false, summary: describe(stun.length, []) };
    case 'relay':
      if (turn.length === 0) return { ok: false, reason: 'Modo relay exige um servidor TURN com credenciais; nenhum foi fornecido.' };
      return { ok: true, config: { iceServers: turn, iceTransportPolicy: 'relay' }, turnConfigured: true, summary: describe(0, turn) };
    case 'relay-tls':
      if (tlsOnly.length === 0) return { ok: false, reason: 'Modo relay-tls exige um servidor TURNS (TLS) com credenciais; nenhum foi fornecido.' };
      return { ok: true, config: { iceServers: tlsOnly, iceTransportPolicy: 'relay' }, turnConfigured: true, summary: describe(0, tlsOnly) };
  }
}

/** Resumo sem hosts, portas ou credenciais: "STUN 1 · TURN 4 (udp, tcp, tls)". */
function describe(stunCount: number, turn: readonly { urls: string[] }[]): string {
  const kinds = new Set<string>();
  let count = 0;
  for (const t of turn) {
    for (const u of t.urls) {
      const p = parseIceUrl(u);
      if (!p) continue;
      count += 1;
      kinds.add(p.scheme === 'turns' ? 'tls' : (p.transport ?? 'udp'));
    }
  }
  return `STUN ${stunCount} · TURN ${count}${count ? ` (${[...kinds].sort().join(', ')})` : ''}`;
}
