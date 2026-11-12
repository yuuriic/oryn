// Servidores ICE: formato das URLs e sanitização de listas. Puro e sem APIs de runtime: usado pela Edge Function `turn`
// (resposta do provedor) e pelo cliente web (validação da resposta da função, em src/web/ice-share.ts).
// Origem: poc/webrtc-audio-wan/src/ice.ts e server/turn.ts (POC-02B, 6daeb99). `parseIceUrl` e os limites repetem os
// de src/web/ice.ts, que precisa seguir idêntico à cópia da POC; tests/turn-function.test.ts prova que os dois aceitam e
// recusam exatamente as mesmas URLs.

/** Servidor ICE como trafega entre função e cliente (subconjunto estrito de RTCIceServer). */
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

const SECRET = /^[\x21-\x7e]{1,512}$/;

/**
 * Normaliza uma lista vinda de fora (provedor ou função): só URLs válidas (sem porta 53) de hosts permitidos
 * (`null` = qualquer host), credencial só junto de TURN e sempre completa, no máximo 4 servidores com 8 URLs cada.
 * Entradas inválidas são descartadas; o resultado pode ficar vazio (quem chama decide se isso é falha).
 */
export function sanitizeIceServers(raw: unknown, allowedHosts: ReadonlySet<string> | null): IceServerConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: IceServerConfig[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const list = Array.isArray(e['urls']) ? e['urls'] : typeof e['urls'] === 'string' ? [e['urls']] : [];
    const urls = list.filter((u): u is string => {
      if (typeof u !== 'string') return false;
      const parsed = parseIceUrl(u);
      return parsed !== null && (allowedHosts === null || allowedHosts.has(parsed.host));
    }).slice(0, MAX_ICE_URLS);
    if (urls.length === 0) continue;
    const turnUrls = urls.filter((u) => parseIceUrl(u)!.scheme !== 'stun');
    const stunUrls = urls.filter((u) => parseIceUrl(u)!.scheme === 'stun');
    if (stunUrls.length > 0) out.push({ urls: stunUrls });
    const username = e['username'];
    const credential = e['credential'];
    // TURN sem credencial completa é inútil: descartado, nunca entregue pela metade.
    if (turnUrls.length > 0 && typeof username === 'string' && typeof credential === 'string' && SECRET.test(username) && SECRET.test(credential)) {
      out.push({ urls: turnUrls, username, credential });
    }
  }
  return out.slice(0, MAX_ICE_SERVERS);
}

/** Há ao menos um servidor TURN com credencial? */
export const hasTurn = (servers: readonly IceServerConfig[]): boolean =>
  servers.some((s) => s.username !== undefined && s.urls.some((u) => parseIceUrl(u)?.scheme !== 'stun'));
