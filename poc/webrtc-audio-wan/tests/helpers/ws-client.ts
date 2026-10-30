// Cliente WebSocket de teste (pacote "ws"), com fila de mensagens e espera por tipo.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import WebSocket, { type ClientOptions } from 'ws';
import type { RunningServer } from '../../server/server.ts';

export interface Received {
  type: string;
  [key: string]: unknown;
}

export class TestClient {
  readonly inbox: Received[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private waiters: { match: (m: Received) => boolean; resolve: (m: Received) => void }[] = [];
  readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Received;
      const i = this.waiters.findIndex((w) => w.match(msg));
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(msg);
      else this.inbox.push(msg);
    });
  }

  static open(url: string, origin: string | null, options: ClientOptions = {}): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { ...(origin ? { origin } : {}), ...options });
      const client = new TestClient(ws);
      ws.once('open', () => resolve(client));
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  /** Espera a próxima mensagem do tipo (ou que satisfaça o predicado). */
  next(match: string | ((m: Received) => boolean), timeoutMs = 3000): Promise<Received> {
    const fn = typeof match === 'string' ? (m: Received) => m.type === match : match;
    const queued = this.inbox.findIndex(fn);
    if (queued >= 0) return Promise.resolve(this.inbox.splice(queued, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Tempo esgotado esperando ${String(match)}`)), timeoutMs);
      this.waiters.push({
        match: fn,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}

/** Resposta crua de um POST (sem as restrições de cabeçalho do fetch: Origin/Host livres). */
export function post(
  origin: string,
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const url = new URL(path, origin);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port, path: url.pathname, method: 'POST', headers },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** Cabeçalhos que a página administrativa legítima envia em POST /admin/pair. */
export function pairHeaders(adminOrigin: string): Record<string, string> {
  return {
    Host: new URL(adminOrigin).host,
    Origin: adminOrigin,
    'Content-Type': 'application/json',
    'X-Oryn-Admin': '1',
    'Sec-Fetch-Site': 'same-origin',
  };
}

/**
 * Fluxo real do operador: o "terminal" gera o código (adminAuth.issuePairingCode) e a página o troca
 * por um token administrativo via POST /admin/pair no listener administrativo.
 */
export async function pairAdmin(server: RunningServer): Promise<string> {
  const origin = server.adminOrigin;
  if (!origin) throw new Error('servidor sem listener administrativo');
  const { code } = server.adminAuth.issuePairingCode();
  const reply = await post(origin, '/admin/pair', JSON.stringify({ code }), pairHeaders(origin));
  if (reply.status !== 200) throw new Error(`pareamento falhou: HTTP ${reply.status}`);
  return (JSON.parse(reply.body) as { token: string }).token;
}

/** URL do WebSocket de um listener (origem http://… → ws://…/ws). */
export const wsUrlOf = (origin: string): string => `${origin.replace(/^http/, 'ws')}/ws`;

/** Abre o operador no listener administrativo e obtém um token por pareamento. */
export async function openOperator(server: RunningServer): Promise<{ client: TestClient; token: string }> {
  const token = await pairAdmin(server);
  const client = await TestClient.open(wsUrlOf(server.adminOrigin!), server.adminOrigin);
  return { client, token };
}

/** Operador cria a sessão; devolve o ID e o convite de uso único emitido junto. */
export async function createAndInvite(host: TestClient, operatorKey: string): Promise<{ sessionId: string; invite: string }> {
  host.send({ type: 'create', operatorKey });
  const session = await host.next('session');
  const invite = await host.next('invite');
  return { sessionId: session['sessionId'] as string, invite: invite['token'] as string };
}

/** dist/ mínimo para os testes do servidor (sem depender do build do Vite). */
export function fakeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oryn-wan-dist-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(dir, 'secret.key'), 'nao-servir'); // extensão fora da lista: nunca servida
  return dir;
}
