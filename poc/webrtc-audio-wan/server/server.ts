// Servidor da POC-02B (baseline copiado da POC-02A, f068509): arquivos estáticos + sinalização WebSocket.
// Não processa mídia.
//
// - Um único listener HTTP, SOMENTE em loopback literal (127.0.0.0/8 ou ::1). Não existe bind público.
// - Sem TLS local e sem CA própria (removidos no incremento 02B.2A). O acesso externo será feito por um
//   túnel HTTPS público (Cloudflare Tunnel, incremento futuro): o TLS termina na Cloudflare e o túnel
//   entrega o tráfego a este listener em loopback.
// - WebSocket no caminho /ws do mesmo host/porta.
// - 02B.2B: convites de uso único; hostnames públicos só por allowlist explícita (fechada por padrão);
//   Origin precisa corresponder ao Host; limites independentes de IP.
// - 02B.2C: DOIS listeners em loopback, em portas distintas:
//     · sinalização (alvo do futuro túnel): página, join/signal/leave; NENHUMA capacidade administrativa;
//     · administrativo (só o operador, nunca exposto): página, POST /admin/pair e create/rejoin/invite.
//   O privilégio vem do listener que aceitou a conexão + token de pareamento, nunca do cabeçalho Host.
//   Cabeçalhos de proxy (X-Forwarded-*, CF-Connecting-IP) NUNCA são lidos: atrás do túnel todas as
//   conexões vêm de 127.0.0.1 e esses cabeçalhos não têm fronteira de confiança verificável aqui.
// - 02B.3A: Cloudflare Access. Com hostnames públicos configurados, o Access é OBRIGATÓRIO: TODA
//   requisição HTTP e TODO upgrade WebSocket do listener de sinalização (qualquer Host) precisam do JWT
//   válido em Cf-Access-Jwt-Assertion, injetado pela borda da Cloudflare. O listener administrativo não
//   usa Access. O Access identifica quem pode chegar à página; não substitui o convite nem concede
//   privilégio administrativo.

import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import { BlockList, isIP, type AddressInfo } from 'node:net';
import { join, relative, sep } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { MAX_MESSAGE_BYTES, parseClientMessage, type ServerMessage } from '../src/protocol.ts';
import { ACCESS_HEADER, AccessVerifier, resolveAccessConfig, type AccessConfig, type JwksFetch } from './access.ts';
import { AdminAuth, newPairingCode } from './admin-auth.ts';
import { Admission, newToken } from './admission.ts';
import { TokenBucket } from './rate-limit.ts';
import { SessionRegistry, type ConnectionContext, type Participant } from './registry.ts';

export type ListenerKind = 'signal' | 'admin';

export interface ServerConfig {
  distDir: string;
  /** Listener de SINALIZAÇÃO (alvo do futuro túnel): sem capacidade administrativa. */
  httpPort: number;
  /**
   * Listener ADMINISTRATIVO (operador), porta própria em loopback; nunca deve ser alvo do túnel.
   * Ausente = sem administração (ninguém cria sessões). Igual a httpPort = configuração recusada.
   */
  adminPort?: number;
  /**
   * Padrão: 127.0.0.1. Somente endereços LITERAIS de loopback (127.0.0.0/8 ou ::1) são aceitos;
   * qualquer outro valor, incluindo "localhost", é rejeitado antes de abrir listeners.
   */
  httpHost?: string;
  /** Validade do código de pareamento (padrão 5 min). */
  pairingCodeTtlMs?: number;
  /** Tentativas erradas que queimam o código (padrão 5). */
  maxPairingAttempts?: number;
  /** Validade do token administrativo (padrão 12 h; sempre limitado à vida do processo). */
  adminSessionTtlMs?: number;
  /**
   * Hostnames públicos autorizados (ex.: o do túnel). Ausente/vazio = nenhum acesso público.
   * Somente nomes DNS exatos: sem curingas, IPs, portas ou "localhost".
   */
  publicHostnames?: readonly string[];
  /**
   * Cloudflare Access (02B.3A). Obrigatório quando há hostnames públicos (sem fallback silencioso).
   * Ativo = todo o listener de sinalização exige o JWT válido em Cf-Access-Jwt-Assertion.
   */
  access?: AccessConfig;
  /** Transporte do JWKS (padrão: fetch global). Só para testes, sem rede pública. */
  accessFetch?: JwksFetch;
  /** Validações de Access pendentes simultâneas no upgrade (padrão 16; acima disso, 503). */
  maxPendingAccessChecks?: number;
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
  /** Origem do listener de sinalização (loopback). */
  httpOrigin: string;
  /** Origem do listener administrativo (loopback), ou null se desativado. */
  adminOrigin: string | null;
  /** https://<primeiro hostname público>, ou null quando o acesso público está fechado. */
  publicOrigin: string | null;
  /** Validador do Cloudflare Access do listener de sinalização, ou null (modo local sem Access). */
  access: AccessVerifier | null;
  registry: SessionRegistry;
  admission: Admission;
  /** Pareamento do operador (o terminal emite o código; nunca imprime o token). */
  adminAuth: AdminAuth;
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
  // Configurações legadas são recusadas explicitamente, nunca ignoradas.
  if ('https' in (config as object)) {
    throw new Error('Opção "https" removida na POC-02B: não há TLS local nem CA própria; o acesso externo será pelo túnel público.');
  }
  if ('operatorKeyHash' in (config as object)) {
    throw new Error('Opção "operatorKeyHash" removida no 02B.2C: a autorização do operador é feita por pareamento no listener administrativo.');
  }
  assertLoopbackHttpHost(httpHost);
  // Configuração ambígua: os dois listeners não podem compartilhar a porta.
  if (config.adminPort !== undefined && config.adminPort !== 0 && config.adminPort === config.httpPort) {
    throw new Error(`Configuração ambígua: listener administrativo e de sinalização na mesma porta (${config.httpPort}).`);
  }
  // Allowlist pública validada antes de abrir qualquer listener (configuração inválida = não sobe).
  const publicHosts = new Set((config.publicHostnames ?? []).map(validatePublicHostname));
  const publicOrigin = publicHosts.size > 0 ? `https://${[...publicHosts][0]}` : null;
  // Sem fallback silencioso: configuração de exposição (hostname público) exige Cloudflare Access.
  if (publicHosts.size > 0 && config.access === undefined) {
    throw new Error('Hostnames públicos exigem Cloudflare Access (02B.3A): configure teamDomain e audience. O modo sem Access é só para uso local.');
  }
  // Configuração do Access incompleta ou inválida impede a inicialização.
  const access = config.access === undefined
    ? null
    : new AccessVerifier({ config: resolveAccessConfig(config.access), now: Date.now, fetch: config.accessFetch ?? fetch });
  const maxPendingAccessChecks = config.maxPendingAccessChecks ?? 16;
  const files = loadStaticFiles(config.distDir);

  const adminAuth = new AdminAuth({
    codeTtlMs: config.pairingCodeTtlMs ?? 5 * 60_000,
    maxCodeAttempts: config.maxPairingAttempts ?? 5,
    sessionTtlMs: config.adminSessionTtlMs ?? 12 * 60 * 60_000,
    now: Date.now,
    newCode: newPairingCode,
    newToken,
  });
  const admission = new Admission({
    inviteTtlMs: config.inviteTtlMs ?? 10 * 60_000,
    now: Date.now,
    randomToken: newToken,
  });
  const registry = new SessionRegistry({
    maxSessions: config.maxSessions ?? 3,
    idleTimeoutMs: config.idleTimeoutMs ?? 10 * 60_000,
    maxAuthFailures: config.maxAuthFailures ?? 3,
    admission,
    verifyAdmin: (token) => adminAuth.verify(token),
    publicOrigin,
    now: Date.now,
    randomId: newSessionId,
    log: (event) => log(`[sinalização] ${event}`),
  });
  const maxConnections = config.maxConnections ?? 8;
  const admissionTimeoutMs = config.admissionTimeoutMs ?? 10_000;

  // Hosts locais aceitos por listener, preenchidos após o bind (com a porta efetiva). Antes disso, tudo é recusado.
  const signalHosts = new Set<string>();
  const adminHosts = new Set<string>();

  /**
   * Zona do Host validado. Listener de sinalização: local (loopback:porta) ou público (allowlist exata).
   * Listener administrativo: SOMENTE local — hostnames públicos nunca são aceitos ali.
   */
  const zoneOf = (kind: ListenerKind, host: string | undefined): Zone | 'missing' | 'unknown' => {
    if (host === undefined || host === '') return 'missing';
    const h = host.toLowerCase();
    if (kind === 'admin') return adminHosts.has(h) ? 'local' : 'unknown';
    if (signalHosts.has(h)) return 'local';
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
    log(`[sinalização] recusado (${reason})${refusalsSuppressed ? ` (+${refusalsSuppressed} suprimidos)` : ''}`);
    refusalsSuppressed = 0;
    lastRefusalLog = now;
  };

  const sendJson = (res: http.ServerResponse, status: number, body: unknown): void => {
    // no-store: a resposta do pareamento contém o token administrativo (nunca em cache).
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
  };

  /**
   * POST /admin/pair (somente listener administrativo): troca o código de pareamento por um token
   * administrativo. Proteções contra páginas maliciosas e CSRF:
   * - Origin obrigatório e EXATAMENTE a origem administrativa (http://<Host local>:<porta admin>);
   *   outras origens de 127.0.0.1 (outras portas/servidores locais) são recusadas;
   * - Content-Type application/json e cabeçalho X-Oryn-Admin: exigem preflight CORS, que nunca é aceito;
   * - Sec-Fetch-Site, quando enviado, precisa ser same-origin;
   * - corpo pequeno e estrito; o código é de uso único e tem tentativas limitadas.
   */
  const handlePair = (req: http.IncomingMessage, res: http.ServerResponse, host: string): void => {
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    const site = req.headers['sec-fetch-site'];
    if (
      checkOrigin(req.headers.origin, host, 'local', true) !== 'ok' ||
      req.headers['x-oryn-admin'] !== '1' ||
      (site !== undefined && site !== 'same-origin')
    ) {
      logRefusal('pareamento: origem');
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }
    if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
      sendJson(res, 415, { error: 'unsupported-media-type' });
      return;
    }
    let body = '';
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 1024) {
        tooLarge = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooLarge) return;
      let code: unknown;
      try {
        const parsed = JSON.parse(body) as unknown;
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && Object.keys(parsed).join() === 'code') {
          code = (parsed as { code: unknown }).code;
        }
      } catch {
        code = undefined;
      }
      if (typeof code !== 'string' || code.length > 32) {
        sendJson(res, 400, { error: 'invalid-request' });
        return;
      }
      const result = adminAuth.pair(code);
      if (result.ok) {
        log('[admin] pareamento do operador concluído'); // nem o código nem o token são registrados
        sendJson(res, 200, { token: result.token, expiresAt: result.expiresAt });
      } else {
        log(`[admin] pareamento recusado (${result.reason})`);
        sendJson(res, result.reason === 'exhausted' ? 429 : 403, { error: result.reason });
      }
    });
  };

  /** Resposta HTTP de uma falha do Access (403; JWKS indisponível = 503). Nunca libera o conteúdo. */
  const accessDenied = (reason: string): { status: number; text: string } =>
    reason === 'unavailable' ? { status: 503, text: '503 Service Unavailable' } : { status: 403, text: '403 Forbidden' };

  const requestHandler = (kind: ListenerKind) => (req: http.IncomingMessage, res: http.ServerResponse): void => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    // Host antes de qualquer conteúdo.
    const zone = zoneOf(kind, req.headers.host);
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
    // Cloudflare Access: todo o listener de sinalização (qualquer Host, inclusive local) exige o JWT.
    if (kind === 'signal' && access) {
      access
        .verify(req.headers[ACCESS_HEADER])
        .then((result) => {
          if (result.ok) return serve(kind, req, res);
          logRefusal(`access: ${result.reason}`);
          const denied = accessDenied(result.reason);
          res.writeHead(denied.status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end(denied.text);
        })
        .catch(() => res.writeHead(500).end());
      return;
    }
    serve(kind, req, res);
  };

  /** Rotas, depois de Host, Origin e (na sinalização com Access) do JWT validados. */
  const serve = (kind: ListenerKind, req: http.IncomingMessage, res: http.ServerResponse): void => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    // Endpoint administrativo existe SOMENTE no listener administrativo.
    if (kind === 'admin' && path === '/admin/pair') {
      handlePair(req, res, req.headers.host!);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
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

  const signalServer = http.createServer(requestHandler('signal'));
  const adminServer = config.adminPort === undefined ? null : http.createServer(requestHandler('admin'));

  // ---------- WebSocket (compartilhado; o contexto vem do listener que aceitou a conexão) ----------
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  const alive = new WeakMap<WebSocket, boolean>();

  const refuse = (socket: Duplex, status: string, reason: string): void => {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    logRefusal(reason);
  };

  // Conexões ainda sem sessão e desde quando (admissão obrigatória dentro do prazo).
  const unadmittedSince = new Map<WebSocket, number>();
  const participants = new Map<WebSocket, Participant>();

  const onUpgrade = (kind: ListenerKind) => (req: http.IncomingMessage, socket: Duplex, head: Buffer): void => {
    // Política de Host verificada separadamente e antes do Origin.
    const zone = zoneOf(kind, req.headers.host);
    if (zone === 'missing') return refuse(socket, '400 Bad Request', 'host ausente');
    if (zone === 'unknown') return refuse(socket, '421 Misdirected Request', 'host');
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path !== '/ws') return refuse(socket, '403 Forbidden', 'caminho');
    // Origin obrigatório, exato e coerente com o Host: impede uso por outros sites (CSWSH) e
    // combinações cruzadas (Host público com Origin local e vice-versa). "null" é recusado.
    if (checkOrigin(req.headers.origin, req.headers.host!, zone, true) !== 'ok') return refuse(socket, '403 Forbidden', 'origin');
    if (kind === 'signal' && access) {
      // JWT do Access validado ANTES de concluir o upgrade. Validações pendentes são limitadas.
      if (pendingAccessChecks >= maxPendingAccessChecks) return refuse(socket, '503 Service Unavailable', 'access: pendentes');
      pendingAccessChecks += 1;
      access
        .verify(req.headers[ACCESS_HEADER])
        .then((result) => {
          if (socket.destroyed) return;
          if (!result.ok) return refuse(socket, accessDenied(result.reason).text, `access: ${result.reason}`);
          accept(kind, req, socket, head, result.expiresAt);
        })
        .catch(() => socket.destroy())
        .finally(() => {
          pendingAccessChecks -= 1;
        });
      return;
    }
    accept(kind, req, socket, head, null);
  };

  let pendingAccessChecks = 0;
  /** Conexões autenticadas pelo Access e quando o JWT delas expira (a conexão é encerrada nesse momento). */
  const accessExpiry = new Map<WebSocket, number>();

  const accept = (kind: ListenerKind, req: http.IncomingMessage, socket: Duplex, head: Buffer, accessExpiresAt: number | null): void => {
    // Limite global de conexões (atrás do túnel todas vêm de 127.0.0.1: não há limite "por IP").
    // Verificado depois da validação assíncrona do Access, imediatamente antes de aceitar.
    if (wss.clients.size >= maxConnections) return refuse(socket, '503 Service Unavailable', 'capacidade');
    // O privilégio administrativo vem do LISTENER, nunca do Host, de cabeçalhos de proxy ou do Access.
    const context: ConnectionContext = { admin: kind === 'admin' };
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (accessExpiresAt !== null) accessExpiry.set(ws, accessExpiresAt);
      wss.emit('connection', ws, context);
    });
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
    // Violações do rate limit numa janela deslizante (antes, as strikes nunca expiravam — A8).
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
      accessExpiry.delete(ws);
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
      // Prazo da sessão autenticada pelo Access: JWT expirado encerra a conexão (nova conexão exige novo JWT).
      const expiresAt = accessExpiry.get(ws);
      if (expiresAt !== undefined && now >= expiresAt) {
        ws.close(1008, 'access expired');
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

  signalServer.on('upgrade', onUpgrade('signal'));
  adminServer?.on('upgrade', onUpgrade('admin'));

  const stop = async (server: http.Server | null): Promise<void> => {
    if (!server?.listening) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  const shutdown = async (): Promise<void> => {
    clearInterval(heartbeat);
    adminAuth.revokeAll();
    registry.closeAll();
    for (const ws of wss.clients) ws.close(1001, 'server shutdown');
    wss.close();
    await Promise.all([stop(signalServer), stop(adminServer)]);
  };

  /** Abre um listener em loopback, confere o endereço efetivo e registra os hosts locais aceitos. */
  const open = async (server: http.Server, port: number, hosts: Set<string>): Promise<string> => {
    const bound = await listen(server, port, httpHost);
    // Defesa em profundidade: confere o endereço efetivamente vinculado.
    if (!isLoopbackLiteral(bound.address)) {
      throw new Error(`Listener vinculado fora do loopback (${bound.address}); servidor abortado.`);
    }
    hosts.add(`${hostForUrl(bound.address)}:${bound.port}`.toLowerCase());
    // localhost aponta para o loopback no navegador do próprio PC.
    hosts.add(`localhost:${bound.port}`);
    // URL/Origin a partir do endereço canônico do bind (ex.: "::1" → "http://[::1]:porta").
    return `http://${hostForUrl(bound.address)}:${bound.port}`;
  };

  let httpOrigin: string;
  let adminOrigin: string | null = null;
  try {
    httpOrigin = await open(signalServer, config.httpPort, signalHosts);
    if (adminServer && config.adminPort !== undefined) {
      adminOrigin = await open(adminServer, config.adminPort, adminHosts);
    }
  } catch (error) {
    // Falha ao abrir qualquer listener: fecha o que já abriu e para o heartbeat (sem recursos órfãos).
    await shutdown();
    throw error;
  }

  // Pré-carrega as chaves do Access (falha não impede a partida: as requisições falham fechadas até obtê-las).
  if (access) {
    access.jwks
      .keys()
      .then(() => log('[access] chaves públicas do Cloudflare Access carregadas'))
      .catch(() => log('[access] chaves públicas indisponíveis: requisições da sinalização serão recusadas (503) até obtê-las'));
  }

  return { httpOrigin, adminOrigin, publicOrigin, access, registry, admission, adminAuth, close: shutdown };
}
