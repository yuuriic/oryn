// Servidor da POC-02A: arquivos estáticos + sinalização WebSocket. Não processa mídia.
//
// - Listener HTTP somente em 127.0.0.1 (navegador do próprio PC; localhost é contexto seguro).
// - Listener HTTPS opcional somente no IP da LAN (celular), com certificado de CA local.
// - WebSocket no caminho /ws do mesmo host/porta (ws:// no HTTP, wss:// no HTTPS).

import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { join, relative, sep } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { MAX_MESSAGE_BYTES, parseClientMessage, type ServerMessage } from '../src/protocol.ts';
import { TokenBucket } from './rate-limit.ts';
import { SessionRegistry, type Participant } from './registry.ts';

export interface HttpsOptions {
  /** IP da LAN em que o HTTPS escuta (o mesmo do SAN do certificado). */
  host: string;
  port: number;
  key: string | Buffer;
  cert: string | Buffer;
}

export interface ServerConfig {
  distDir: string;
  httpPort: number;
  /** Padrão: 127.0.0.1. O HTTP nunca deve escutar na LAN. */
  httpHost?: string;
  https?: HttpsOptions;
  maxSessions?: number;
  idleTimeoutMs?: number;
  heartbeatMs?: number;
  rateLimit?: { capacity: number; refillPerSecond: number };
  log?: (line: string) => void;
}

export interface RunningServer {
  httpOrigin: string;
  httpsOrigin: string | null;
  registry: SessionRegistry;
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

function listen(server: http.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

const hostForUrl = (host: string): string => (host.includes(':') ? `[${host}]` : host);

export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const log = config.log ?? ((line: string) => console.log(line));
  const httpHost = config.httpHost ?? '127.0.0.1';
  const files = loadStaticFiles(config.distDir);

  const registry = new SessionRegistry({
    maxSessions: config.maxSessions ?? 20,
    idleTimeoutMs: config.idleTimeoutMs ?? 10 * 60_000,
    now: Date.now,
    randomId: newSessionId,
    log: (event) => log(`[sinalização] ${event}`),
  });

  const allowedOrigins = new Set<string>();
  let httpsOrigin: string | null = null;

  const requestHandler = (req: http.IncomingMessage, res: http.ServerResponse, isLocal: boolean): void => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    // O endereço HTTPS da LAN só é informado ao navegador local (para montar link/QR do convite).
    if (path === '/api/info' && isLocal) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ httpsOrigin }));
      return;
    }
    const file = files.get(path === '/' ? '/index.html' : path);
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Não encontrado');
      return;
    }
    res.writeHead(200, { 'Content-Type': file.type, 'Content-Length': file.body.length });
    res.end(req.method === 'HEAD' ? undefined : file.body);
  };

  const httpServer = http.createServer((req, res) => requestHandler(req, res, true));
  const httpsServer = config.https
    ? https.createServer({ key: config.https.key, cert: config.https.cert, minVersion: 'TLSv1.2' }, (req, res) =>
        requestHandler(req, res, false),
      )
    : null;

  // ---------- WebSocket ----------
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  const alive = new WeakMap<WebSocket, boolean>();

  const onUpgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer): void => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const origin = req.headers.origin;
    // Origin obrigatório e exato: impede que páginas de outros sites usem a sinalização (CSWSH).
    if (path !== '/ws' || !origin || !allowedOrigins.has(origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      log(`[sinalização] upgrade recusado (${path !== '/ws' ? 'caminho' : 'origin'})`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };

  wss.on('connection', (ws: WebSocket) => {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    const bucket = new TokenBucket({
      capacity: config.rateLimit?.capacity ?? 60,
      refillPerSecond: config.rateLimit?.refillPerSecond ?? 20,
      now: Date.now,
    });
    let strikes = 0;
    const participant: Participant = {
      id: randomBytes(9).toString('base64url'),
      send: (message: ServerMessage) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
      },
    };

    ws.on('message', (data, isBinary) => {
      // A sinalização é só texto JSON. Binário nunca é aceito: o servidor não transporta mídia.
      if (isBinary) {
        participant.send({ type: 'error', code: 'invalid-message' });
        ws.close(1003, 'binary not accepted');
        return;
      }
      if (!bucket.take()) {
        participant.send({ type: 'error', code: 'rate-limited' });
        if (++strikes >= 3) ws.close(1008, 'rate limited');
        return;
      }
      const parsed = parseClientMessage(data.toString());
      if (!parsed.ok) {
        participant.send({ type: 'error', code: parsed.code });
        return;
      }
      registry.handle(participant, parsed.value);
    });
    ws.on('close', () => registry.disconnect(participant));
    ws.on('error', () => ws.terminate());
  });

  // Heartbeat: conexões que não respondem ao ping são encerradas (e saem da sessão).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
    registry.sweep();
  }, config.heartbeatMs ?? 15_000);

  httpServer.on('upgrade', onUpgrade);
  httpsServer?.on('upgrade', onUpgrade);

  const httpPort = await listen(httpServer, config.httpPort, httpHost);
  const httpOrigin = `http://${hostForUrl(httpHost)}:${httpPort}`;
  allowedOrigins.add(httpOrigin);
  if (httpHost === '127.0.0.1') allowedOrigins.add(`http://localhost:${httpPort}`);

  if (httpsServer && config.https) {
    const httpsPort = await listen(httpsServer, config.https.port, config.https.host);
    httpsOrigin = `https://${hostForUrl(config.https.host)}:${httpsPort}`;
    allowedOrigins.add(httpsOrigin);
  }

  return {
    httpOrigin,
    httpsOrigin,
    registry,
    close: async () => {
      clearInterval(heartbeat);
      registry.closeAll();
      for (const ws of wss.clients) ws.close(1001, 'server shutdown');
      wss.close();
      const stop = (s: http.Server | null) =>
        new Promise<void>((resolve) => {
          if (!s) return resolve();
          s.closeAllConnections?.();
          s.close(() => resolve());
        });
      await Promise.all([stop(httpServer), stop(httpsServer)]);
    },
  };
}
