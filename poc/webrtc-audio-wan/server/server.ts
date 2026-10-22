// Servidor da POC-02B (baseline copiado da POC-02A, f068509): arquivos estáticos + sinalização WebSocket.
// Não processa mídia.
//
// - Um único listener HTTP, SOMENTE em loopback literal (127.0.0.0/8 ou ::1). Não existe bind público.
// - Sem TLS local e sem CA própria (removidos no incremento 02B.2A). O acesso externo será feito por um
//   túnel HTTPS público (Cloudflare Tunnel, incremento futuro): o TLS termina na Cloudflare e o túnel
//   entrega o tráfego a este listener em loopback.
// - WebSocket no caminho /ws do mesmo host/porta.
// - 02B.2B: admissão por chave do operador e convites de uso único; hostnames públicos só por allowlist
//   explícita (fechada por padrão); Origin precisa corresponder ao Host; limites independentes de IP.
//   Cabeçalhos de proxy (X-Forwarded-*, CF-Connecting-IP) NUNCA são lidos: atrás do túnel todas as
//   conexões vêm de 127.0.0.1 e esses cabeçalhos não têm fronteira de confiança verificável aqui.

import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import { BlockList, isIP, type AddressInfo } from 'node:net';
import { join, relative, sep } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { MAX_MESSAGE_BYTES, parseClientMessage, type ServerMessage } from '../src/protocol.ts';
import { Admission, newToken } from './admission.ts';
import { TokenBucket } from './rate-limit.ts';
import { SessionRegistry, type ConnectionContext, type Participant } from './registry.ts';

export interface ServerConfig {
  distDir: string;
  httpPort: number;
  /**
   * Padrão: 127.0.0.1. Somente endereços LITERAIS de loopback (127.0.0.0/8 ou ::1) são aceitos;
   * qualquer outro valor, incluindo "localhost", é rejeitado antes de abrir listeners.
   */
  httpHost?: string;
  /** SHA-256 da chave efêmera do operador. Ausente = ninguém cria sessões (fechado por padrão). */
  operatorKeyHash?: Buffer;
  /**
   * Hostnames públicos autorizados (ex.: o do túnel). Ausente/vazio = nenhum acesso público.
   * Somente nomes DNS exatos: sem curingas, IPs, portas ou "localhost".
   */
  publicHostnames?: readonly string[];
  maxSessions?: number;
  /** Conexões WebSocket simultâneas (todas chegam de 127.0.0.1 atrás do túnel; limite global). */
  maxConnections?: number;
  /** Prazo para uma conexão entrar numa sessão (create/rejoin/join); depois disso é encerrada. */
  admissionTimeoutMs?: number;
  inviteTtlMs?: number;
  /** Falhas de autorização por conexão antes de encerrá-la. */
  maxAuthFailures?: number;
  idleTimeoutMs?: number;
  heartbeatMs?: number;
  /** violationWindowMs: janela das violações do rate limit (3 na janela encerram a conexão). Padrão 10 s. */
  rateLimit?: { capacity: number; refillPerSecond: number; violationWindowMs?: number };
  log?: (line: string) => void;
}

export interface RunningServer {
  httpOrigin: string;
  /** https://<primeiro hostname público>, ou null quando o acesso público está fechado. */
  publicOrigin: string | null;
  registry: SessionRegistry;
  admission: Admission;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "media-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=(), display-capture=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

export const newSessionId = (): string => randomBytes(16).toString('base64url');

/** Carrega dist/ em memória: só arquivos que existem no build são servidos (sem path traversal). */
export function loadStaticFiles(distDir: string): Map<string, { body: Buffer; type: string }> {
  const files = new Map<string, { body: Buffer; type: string }>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const ext = name.slice(name.lastIndexOf('.'));
      const type = MIME[ext];
      if (!type) continue;
      const urlPath = `/${relative(distDir, full).split(sep).join('/')}`;
      files.set(urlPath, { body: readFileSync(full), type });
    }
  };
  walk(distDir);
  if (!files.has('/index.html')) throw new Error(`Build ausente: ${distDir}/index.html (rode "pnpm build").`);
  return files;
}

function listen(server: http.Server, port: number, host: string): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server.address() as AddressInfo);
    });
  });
}

const hostForUrl = (host: string): string => (host.includes(':') ? `[${host}]` : host);

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

/** true para endereços literais de loopback (127.0.0.0/8 ou ::1), sem formas IPv4 mapeadas em IPv6. */
export function isLoopbackLiteral(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 6 && address.includes('.')) return false; // ex.: ::ffff:127.0.0.1 (forma ambígua)
  return LOOPBACK.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/**
 * Valida o host do listener HTTP (sem TLS). Somente loopback literal é aceito, sem fallback.
 * "localhost" é recusado de propósito: a resolução depende do sistema (arquivo hosts, ordem
 * IPv4/IPv6) e o bind ocorreria apenas no primeiro endereço resolvido, o que não é previsível.
 */
export function assertLoopbackHttpHost(host: string): void {
  if (isIP(host) === 0) {
    throw new Error(
      `httpHost inválido: "${host}". Use um endereço literal de loopback (127.0.0.1 ou ::1); nomes como "localhost" não são aceitos.`,
    );
  }
  if (!isLoopbackLiteral(host)) {
    throw new Error(`httpHost recusado: "${host}" não é loopback. O HTTP sem TLS só pode escutar em 127.0.0.0/8 ou ::1.`);
  }
}

export type HostCheck = 'ok' | 'missing' | 'unknown';

/**
 * Valida o cabeçalho Host contra o conjunto exato esperado para um listener ("host:porta",
 * minúsculo). Bloqueia DNS rebinding: um domínio externo que resolva para este computador
 * chega com Host diferente e é recusado. X-Forwarded-Host nunca é considerado.
 */
export function checkHost(host: string | undefined, allowed: ReadonlySet<string>): HostCheck {
  if (host === undefined || host === '') return 'missing';
  return allowed.has(host.toLowerCase()) ? 'ok' : 'unknown';
}

const DNS_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * Valida um hostname público da allowlist e devolve a forma normalizada (minúscula).
 * Recusa curingas, IPs, portas, "localhost", nomes sem domínio e caracteres inválidos.
 */
export function validatePublicHostname(raw: string): string {
  const host = raw.trim().toLowerCase();
  const fail = (why: string): never => {
    throw new Error(`Hostname público inválido "${raw}": ${why}.`);
  };
  if (host === '' || host.length > 253) fail('vazio ou longo demais');
  if (host.includes('*')) fail('curingas não são permitidos');
  if (host.includes(':') || host.includes('/')) fail('informe só o nome, sem esquema, porta ou caminho');
  if (isIP(host) !== 0) fail('IPs não são permitidos; use o nome DNS do túnel');
  if (host === 'localhost' || host.endsWith('.localhost')) fail('"localhost" não é público');
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((l) => DNS_LABEL.test(l))) fail('nome DNS inválido');
  return host;
}

export type Zone = 'local' | 'public';
export type OriginCheck = 'ok' | 'missing' | 'mismatch';

/**
 * O Origin deve corresponder exatamente ao Host da mesma requisição: http://<host local> ou
 * https://<host público>. "null" e combinações cruzadas (Host público com Origin local e vice-versa)
 * são recusadas. Origin ausente só é aceito quando a semântica da requisição permite (navegação HTTP).
 */
export function checkOrigin(origin: string | undefined, host: string, zone: Zone, required: boolean): OriginCheck {
  if (origin === undefined || origin === '') return required ? 'missing' : 'ok';
  const expected = `${zone === 'local' ? 'http' : 'https'}://${host.toLowerCase()}`;
  return origin.toLowerCase() === expected ? 'ok' : 'mismatch';
}

export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const log = config.log ?? ((line: string) => console.log(line));
  const httpHost = config.httpHost ?? '127.0.0.1';
  // Validação antes de qualquer outra coisa: nenhum listener é aberto com configuração inválida.
  // Configuração legada da POC-02A (listener HTTPS com CA local) é recusada explicitamente, nunca ignorada.
  if ('https' in (config as object)) {
    throw new Error('Opção "https" removida na POC-02B: não há TLS local nem CA própria; o acesso externo será pelo túnel público.');
  }
  assertLoopbackHttpHost(httpHost);
  // Allowlist pública validada antes de abrir qualquer listener (configuração inválida = não sobe).
  const publicHosts = new Set((config.publicHostnames ?? []).map(validatePublicHostname));
  const publicOrigin = publicHosts.size > 0 ? `https://${[...publicHosts][0]}` : null;
  const files = loadStaticFiles(config.distDir);

  const admission = new Admission({
    operatorKeyHash: config.operatorKeyHash ?? null,
    inviteTtlMs: config.inviteTtlMs ?? 10 * 60_000,
    maxOperatorFailures: 5,
    failureWindowMs: 60_000,
    lockoutMs: 60_000,
    now: Date.now,
    randomToken: newToken,
  });
  const registry = new SessionRegistry({
    maxSessions: config.maxSessions ?? 3,
    idleTimeoutMs: config.idleTimeoutMs ?? 10 * 60_000,
    maxAuthFailures: config.maxAuthFailures ?? 3,
    admission,
    publicOrigin,
    now: Date.now,
    randomId: newSessionId,
    log: (event) => log(`[sinalização] ${event}`),
  });
  const maxConnections = config.maxConnections ?? 8;
  const admissionTimeoutMs = config.admissionTimeoutMs ?? 10_000;

  // Hosts locais aceitos, preenchidos após o bind (com a porta efetiva). Antes disso, tudo é recusado.
  const httpHosts = new Set<string>();

  /** Zona do Host validado: local (loopback:porta) ou público (allowlist exata, sem porta). */
  const zoneOf = (host: string | undefined): Zone | 'missing' | 'unknown' => {
    if (host === undefined || host === '') return 'missing';
    const h = host.toLowerCase();
    if (httpHosts.has(h)) return 'local';
    if (publicHosts.has(h)) return 'public';
    return 'unknown';
  };

  // Log de recusas amostrado: no máximo uma linha a cada 10 s (evita inundação de log).
  let refusalsSuppressed = 0;
  let lastRefusalLog = 0;
  const logRefusal = (reason: string): void => {
    const now = Date.now();
    if (now - lastRefusalLog < 10_000) {
      refusalsSuppressed += 1;
      return;
    }
    log(`[sinalização] upgrade recusado (${reason})${refusalsSuppressed ? ` (+${refusalsSuppressed} suprimidos)` : ''}`);
    refusalsSuppressed = 0;
    lastRefusalLog = now;
  };

  const requestHandler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    // Host antes de qualquer conteúdo.
    const zone = zoneOf(req.headers.host);
    if (zone === 'missing' || zone === 'unknown') {
      res
        .writeHead(zone === 'missing' ? 400 : 421, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end(zone === 'missing' ? 'Host ausente' : 'Host não reconhecido');
      return;
    }
    // Navegação não envia Origin; se vier, precisa corresponder ao Host (bloqueia uso cruzado).
    if (checkOrigin(req.headers.origin, req.headers.host!, zone, false) !== 'ok') {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Origin não permitido');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const file = files.get(path === '/' ? '/index.html' : path);
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Não encontrado');
      return;
    }
    res.writeHead(200, { 'Content-Type': file.type, 'Content-Length': file.body.length });
    res.end(req.method === 'HEAD' ? undefined : file.body);
  };

  const httpServer = http.createServer(requestHandler);

  // ---------- WebSocket ----------
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  const alive = new WeakMap<WebSocket, boolean>();

  const refuse = (socket: Duplex, status: string, reason: string): void => {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    logRefusal(reason);
  };

  // Conexões ainda sem sessão e desde quando (admissão obrigatória dentro do prazo).
  const unadmittedSince = new Map<WebSocket, number>();
  const participants = new Map<WebSocket, Participant>();

  const onUpgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer): void => {
    // Política de Host verificada separadamente e antes do Origin.
    const zone = zoneOf(req.headers.host);
    if (zone === 'missing') return refuse(socket, '400 Bad Request', 'host ausente');
    if (zone === 'unknown') return refuse(socket, '421 Misdirected Request', 'host');
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path !== '/ws') return refuse(socket, '403 Forbidden', 'caminho');
    // Origin obrigatório, exato e coerente com o Host: impede uso por outros sites (CSWSH) e
    // combinações cruzadas (Host público com Origin local e vice-versa). "null" é recusado.
    if (checkOrigin(req.headers.origin, req.headers.host!, zone, true) !== 'ok') return refuse(socket, '403 Forbidden', 'origin');
    // Limite global de conexões (atrás do túnel todas vêm de 127.0.0.1: não há limite "por IP").
    if (wss.clients.size >= maxConnections) return refuse(socket, '503 Service Unavailable', 'capacidade');
    const context: ConnectionContext = { local: zone === 'local' };
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, context));
  };

  wss.on('connection', (ws: WebSocket, context: ConnectionContext) => {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    unadmittedSince.set(ws, Date.now());
    const bucket = new TokenBucket({
      capacity: config.rateLimit?.capacity ?? 60,
      refillPerSecond: config.rateLimit?.refillPerSecond ?? 20,
      now: Date.now,
    });
    // Violações do rate limit numa janela deslizante de 10 s (antes, as strikes nunca expiravam — A8).
    let violations: number[] = [];
    const participant: Participant = {
      id: randomBytes(9).toString('base64url'),
      send: (message: ServerMessage) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
      },
      close: (code, reason) => ws.close(code, reason),
    };
    participants.set(ws, participant);

    ws.on('message', (data, isBinary) => {
      // A sinalização é só texto JSON. Binário nunca é aceito: o servidor não transporta mídia.
      if (isBinary) {
        participant.send({ type: 'error', code: 'invalid-message' });
        ws.close(1003, 'binary not accepted');
        return;
      }
      if (!bucket.take()) {
        participant.send({ type: 'error', code: 'rate-limited' });
        const now = Date.now();
        violations = violations.filter((t) => t > now - (config.rateLimit?.violationWindowMs ?? 10_000));
        violations.push(now);
        if (violations.length >= 3) ws.close(1008, 'rate limited');
        return;
      }
      const parsed = parseClientMessage(data.toString());
      if (!parsed.ok) {
        participant.send({ type: 'error', code: parsed.code });
        return;
      }
      registry.handle(participant, parsed.value, context);
      if (registry.sessionOf(participant) !== null) unadmittedSince.delete(ws);
      else if (!unadmittedSince.has(ws)) unadmittedSince.set(ws, Date.now());
    });
    ws.on('close', () => {
      unadmittedSince.delete(ws);
      participants.delete(ws);
      registry.disconnect(participant);
    });
    ws.on('error', () => ws.terminate());
  });

  // Heartbeat: conexões que não respondem ao ping são encerradas (e saem da sessão); conexões que
  // não entram numa sessão dentro do prazo (ou ficam sem sessão depois de sair) também.
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      const participant = participants.get(ws);
      if (participant && registry.sessionOf(participant) !== null) unadmittedSince.delete(ws);
      else if (!unadmittedSince.has(ws)) unadmittedSince.set(ws, now);
      const since = unadmittedSince.get(ws);
      if (since !== undefined && now - since >= admissionTimeoutMs) {
        ws.close(1008, 'admission timeout');
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
    registry.sweep();
  }, config.heartbeatMs ?? Math.min(15_000, admissionTimeoutMs));

  httpServer.on('upgrade', onUpgrade);

  const shutdown = async (): Promise<void> => {
    clearInterval(heartbeat);
    registry.closeAll();
    for (const ws of wss.clients) ws.close(1001, 'server shutdown');
    wss.close();
    if (!httpServer.listening) return;
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };

  let httpOrigin: string;
  try {
    const bound = await listen(httpServer, config.httpPort, httpHost);
    // Defesa em profundidade: confere o endereço efetivamente vinculado.
    if (!isLoopbackLiteral(bound.address)) {
      throw new Error(`Listener HTTP vinculado fora do loopback (${bound.address}); servidor abortado.`);
    }
    // URL/Origin a partir do endereço canônico do bind (ex.: "::1" → "http://[::1]:porta").
    httpOrigin = `http://${hostForUrl(bound.address)}:${bound.port}`;
    // localhost aponta para o loopback no navegador do próprio PC.
    httpHosts.add(`${hostForUrl(bound.address)}:${bound.port}`.toLowerCase());
    httpHosts.add(`localhost:${bound.port}`);
  } catch (error) {
    // Falha ao abrir qualquer listener: fecha o que já abriu e para o heartbeat (sem recursos órfãos).
    await shutdown();
    throw error;
  }

  return { httpOrigin, publicOrigin, registry, admission, close: shutdown };
}
