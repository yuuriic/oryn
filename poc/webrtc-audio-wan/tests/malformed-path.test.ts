// Revisão independente IR-1: request-target malformado ("//", "/\\", "//[" …) não pode derrubar o processo.
// Requisições cruas por socket: fetch/http.get normalizam o caminho e nunca enviariam essas formas.
import { rmSync } from 'node:fs';
import net from 'node:net';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { requestPath, startServer, type RunningServer, type ServerConfig } from '../server/server.ts';
import { testIssuer } from './helpers/access.ts';
import { TestClient, fakeDist, wsUrlOf } from './helpers/ws-client.ts';

const PUBLIC = 'oryn-poc.example.com';
const MALFORMED = ['//', '/\\', '//[', '//x/ws', '/\\x/ws', '/a\\b', 'http://x/ws', '*'];
const running: RunningServer[] = [];
const dirs: string[] = [];

let issuer: Awaited<ReturnType<typeof testIssuer>>;
beforeAll(async () => {
  issuer = await testIssuer();
});

afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function server(options: Partial<ServerConfig> = {}): Promise<RunningServer> {
  const distDir = fakeDist();
  dirs.push(distDir);
  const s = await startServer({ distDir, httpPort: 0, adminPort: 0, log: () => undefined, ...options });
  running.push(s);
  return s;
}

/** Envia uma requisição crua e devolve a linha de status (ou "(fechada)" se o servidor fechar sem responder). */
function raw(origin: string, target: string, upgrade: boolean): Promise<string> {
  const { hostname, port } = new URL(origin);
  const headers = upgrade
    ? `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: ${origin}\r\n`
    : '';
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), hostname, () =>
      socket.write(`GET ${target} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n${headers}\r\n`),
    );
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      data += chunk;
      if (data.includes('\r\n')) {
        socket.destroy();
        resolve(data.split('\r\n')[0]!);
      }
    });
    socket.on('end', () => resolve(data ? data.split('\r\n')[0]! : '(fechada)'));
    socket.on('error', reject);
  });
}

/** O servidor continua de pé: página servida e WebSocket aceito no listener. */
async function stillServing(origin: string): Promise<void> {
  expect(await raw(origin, '/', false)).toMatch(/^HTTP\/1\.1 200 /);
  const c = await TestClient.open(wsUrlOf(origin), origin);
  c.ws.terminate();
}

describe('requestPath (IR-1)', () => {
  it('aceita só origin-form simples; formas malformadas ou ambíguas viram null sem lançar', () => {
    expect(requestPath('/')).toBe('/');
    expect(requestPath('/ws')).toBe('/ws');
    expect(requestPath('/assets/app.js?v=1#x')).toBe('/assets/app.js');
    expect(requestPath(undefined)).toBe('/');
    for (const target of MALFORMED) expect(requestPath(target), target).toBeNull();
  });
});

describe('caminho malformado não derruba o servidor (IR-1)', () => {
  for (const listener of ['admin', 'signal'] as const) {
    it(`${listener}: HTTP com request-target malformado → 400; servidor continua servindo`, async () => {
      const s = await server();
      const origin = listener === 'admin' ? s.adminOrigin! : s.httpOrigin;
      for (const target of MALFORMED) {
        expect(await raw(origin, target, false), target).toMatch(/^HTTP\/1\.1 400 /);
      }
      await stillServing(origin);
    });

    it(`${listener}: upgrade WebSocket com request-target malformado → 400; servidor continua aceitando`, async () => {
      const s = await server();
      const origin = listener === 'admin' ? s.adminOrigin! : s.httpOrigin;
      for (const target of MALFORMED) {
        expect(await raw(origin, target, true), target).toMatch(/^HTTP\/1\.1 400 /);
      }
      await stillServing(origin);
    });
  }

  it('sinalização com Cloudflare Access: upgrade malformado → 400 antes do JWT; HTTP sem JWT continua 403', async () => {
    const s = await server({ publicHostnames: [PUBLIC], ...issuer.server });
    for (const target of MALFORMED) {
      expect(await raw(s.httpOrigin, target, true), target).toMatch(/^HTTP\/1\.1 400 /);
      // O Access continua sendo exigido antes de qualquer rota HTTP: sem JWT, 403 (não 400).
      expect(await raw(s.httpOrigin, target, false), target).toMatch(/^HTTP\/1\.1 403 /);
    }
    // Caminho válido diferente de /ws continua 403 no upgrade; o listener administrativo segue servindo.
    expect(await raw(s.httpOrigin, '/outro', true)).toMatch(/^HTTP\/1\.1 403 /);
    expect(await raw(s.adminOrigin!, '/', false)).toMatch(/^HTTP\/1\.1 200 /);
  });

  it('Host e Origin continuam verificados antes do caminho válido', async () => {
    const s = await server();
    const { port } = new URL(s.adminOrigin!);
    const misdirected = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(Number(port), '127.0.0.1', () => socket.write('GET / HTTP/1.1\r\nHost: evil.example:80\r\n\r\n'));
      socket.setEncoding('utf8');
      socket.once('data', (d: string) => (socket.destroy(), resolve(d.split('\r\n')[0]!)));
      socket.on('error', reject);
    });
    expect(misdirected).toMatch(/^HTTP\/1\.1 421 /);
    await expect(TestClient.open(wsUrlOf(s.adminOrigin!), 'http://evil.example')).rejects.toThrow(/HTTP 403/);
  });
});
