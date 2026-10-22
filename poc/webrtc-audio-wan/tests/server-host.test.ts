// HTTP sem TLS exclusivamente em loopback (revisão do PR #3; POC-02B.2A sem CA nem HTTPS local).
// Garante que endereços não-loopback são rejeitados ANTES de abrir qualquer listener, sem
// fallback, que não existe mais infraestrutura de CA/HTTPS local e que o encerramento é limpo.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertLoopbackHttpHost, isLoopbackLiteral, startServer, type RunningServer } from '../server/server.ts';
import { TestClient, fakeDist } from './helpers/ws-client.ts';

const REJECTED: [string, string][] = [
  ['0.0.0.0', 'todas as interfaces IPv4'],
  ['::', 'todas as interfaces IPv6'],
  ['192.168.0.23', 'IP privado da LAN'],
  ['10.1.2.3', 'IP privado da LAN'],
  ['8.8.8.8', 'IP público'],
  ['2001:4860:4860::8888', 'IPv6 público'],
  ['fe80::1', 'IPv6 link-local'],
  ['::ffff:127.0.0.1', 'IPv4 mapeado em IPv6 (forma ambígua)'],
  ['localhost', 'nome: depende de resolução'],
  ['example.com', 'nome que pode resolver para qualquer interface'],
  ['', 'vazio'],
];

/** Reserva uma porta livre em 127.0.0.1 e a libera (para checar depois que nada passou a escutar nela). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

/** true se algo aceita conexões TCP no host:porta. */
function isListening(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

function ipv6LoopbackAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(0, '::1', () => s.close(() => resolve(true)));
  });
}

const supportsIpv6 = await ipv6LoopbackAvailable();

/**
 * Observa o intervalo de heartbeat do servidor, identificado por um período exclusivo, espionando
 * setInterval/clearInterval (determinístico, sem depender de outros timers do processo).
 */
const HEARTBEAT_MS = 4321;
function watchHeartbeat() {
  const set = vi.spyOn(globalThis, 'setInterval');
  const clear = vi.spyOn(globalThis, 'clearInterval');
  const handles = () => set.mock.calls.flatMap((call, i) => (call[1] === HEARTBEAT_MS ? [set.mock.results[i]?.value] : []));
  return {
    created: () => handles().length,
    allCleared: () => handles().every((h) => clear.mock.calls.some((c) => c[0] === h)),
    restore: () => {
      set.mockRestore();
      clear.mockRestore();
    },
  };
}

const running: RunningServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dist(): string {
  const d = fakeDist();
  dirs.push(d);
  return d;
}

describe('validação do httpHost (pura)', () => {
  it.each([['127.0.0.1'], ['127.5.6.7'], ['::1'], ['0:0:0:0:0:0:0:1']])('aceita loopback literal %s', (host) => {
    expect(isLoopbackLiteral(host)).toBe(true);
    expect(() => assertLoopbackHttpHost(host)).not.toThrow();
  });

  it.each(REJECTED)('rejeita %s (%s) com erro explícito', (host) => {
    expect(isLoopbackLiteral(host)).toBe(false);
    expect(() => assertLoopbackHttpHost(host)).toThrow(/httpHost (inválido|recusado)/);
  });
});

describe('startServer: nenhum listener com configuração inválida', () => {
  it.each(REJECTED)('httpHost %s (%s): rejeita e não abre listener', async (host) => {
    const httpPort = await freePort();
    const hb = watchHeartbeat();
    try {
      const attempt = startServer({ distDir: dist(), httpHost: host, httpPort, heartbeatMs: HEARTBEAT_MS, log: () => undefined });
      await expect(attempt).rejects.toThrow(/httpHost (inválido|recusado)/);
      expect(await isListening('127.0.0.1', httpPort)).toBe(false);
      expect(hb.created()).toBe(0); // a validação acontece antes de qualquer recurso
    } finally {
      hb.restore();
    }
  });

  it('configuração legada com "https" (CA local da POC-02A) é recusada explicitamente, sem abrir portas', async () => {
    const [httpPort, httpsPort] = [await freePort(), await freePort()];
    const legacy = {
      distDir: dist(),
      httpPort,
      https: { host: '127.0.0.1', port: httpsPort, key: 'x', cert: 'x' },
      log: () => undefined,
    } as unknown as Parameters<typeof startServer>[0];
    await expect(startServer(legacy)).rejects.toThrow(/Opção "https" removida/);
    expect(await isListening('127.0.0.1', httpPort)).toBe(false);
    expect(await isListening('127.0.0.1', httpsPort)).toBe(false);
  });

  it('porta HTTP ocupada: rejeita (EADDRINUSE) sem deixar heartbeat nem recursos órfãos', async () => {
    const blocker = net.createServer();
    const busyPort = await new Promise<number>((r) => blocker.listen(0, '127.0.0.1', () => r((blocker.address() as net.AddressInfo).port)));
    const hb = watchHeartbeat();
    try {
      await expect(startServer({ distDir: dist(), httpPort: busyPort, heartbeatMs: HEARTBEAT_MS, log: () => undefined })).rejects.toThrow(/EADDRINUSE/);
      expect(hb.created()).toBe(1);
      expect(hb.allCleared()).toBe(true);
    } finally {
      hb.restore();
      await new Promise((r) => blocker.close(r));
    }
  });
});

describe('startServer: loopback aceito', () => {
  it('IPv4: 127.0.0.1 serve HTTP e WebSocket; origens 127.0.0.1 e localhost aceitas', async () => {
    const server = await startServer({ distDir: dist(), httpPort: 0, log: () => undefined });
    running.push(server);
    expect(server.httpOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(`${server.httpOrigin}/`)).status).toBe(200);
    const port = new URL(server.httpOrigin).port;
    for (const origin of [server.httpOrigin, `http://localhost:${port}`]) {
      const c = await TestClient.open(`ws://127.0.0.1:${port}/ws`, origin);
      c.send({ type: 'create' });
      expect((await c.next('session'))['role']).toBe('host');
      c.ws.terminate();
    }
    await expect(TestClient.open(`ws://127.0.0.1:${port}/ws`, `http://192.168.0.23:${port}`)).rejects.toThrow('403');
  });

  it.skipIf(!supportsIpv6)('IPv6: ::1 (inclusive forma longa) gera URL "[::1]" e aceita a origem correspondente', async () => {
    const server = await startServer({ distDir: dist(), httpHost: '0:0:0:0:0:0:0:1', httpPort: 0, log: () => undefined });
    running.push(server);
    expect(server.httpOrigin).toMatch(/^http:\/\/\[::1\]:\d+$/);
    expect((await fetch(`${server.httpOrigin}/`)).status).toBe(200);
    const port = new URL(server.httpOrigin).port;
    const c = await TestClient.open(`ws://[::1]:${port}/ws`, server.httpOrigin);
    c.send({ type: 'create' });
    expect((await c.next('session'))['role']).toBe('host');
    c.ws.terminate();
    // O loopback IPv4 não está escutando nessa porta (bind apenas em ::1, sem fallback).
    expect(await isListening('127.0.0.1', Number(port))).toBe(false);
  });

  it('funciona sem CA nem certificado: sessão completa (create, join, signal) só em HTTP loopback', async () => {
    const server = await startServer({ distDir: dist(), httpPort: 0, log: () => undefined });
    running.push(server);
    expect(Object.keys(server).sort()).toEqual(['close', 'httpOrigin', 'registry']); // sem httpsOrigin
    const ws = `${server.httpOrigin.replace('http', 'ws')}/ws`;
    const host = await TestClient.open(ws, server.httpOrigin);
    host.send({ type: 'create' });
    const session = await host.next('session');
    const guest = await TestClient.open(ws, server.httpOrigin);
    guest.send({ type: 'join', sessionId: session['sessionId'] });
    expect((await guest.next('session'))['role']).toBe('guest');
    await host.next('peer-joined');
    host.send({ type: 'signal', epoch: 1, payload: { kind: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' } });
    expect((await guest.next('signal'))['payload']).toMatchObject({ kind: 'offer' });
    host.ws.terminate();
    guest.ws.terminate();
  });
});

describe('encerramento limpo do servidor', () => {
  it('close() fecha a porta, encerra os WebSockets (1001), para o heartbeat e é idempotente', async () => {
    const hb = watchHeartbeat();
    try {
      const server = await startServer({ distDir: dist(), httpPort: 0, heartbeatMs: HEARTBEAT_MS, log: () => undefined });
      const port = Number(new URL(server.httpOrigin).port);
      const client = await TestClient.open(`ws://127.0.0.1:${port}/ws`, server.httpOrigin);
      expect(hb.created()).toBe(1);
      expect(hb.allCleared()).toBe(false);
      await server.close();
      expect((await client.closed).code).toBe(1001);
      expect(await isListening('127.0.0.1', port)).toBe(false);
      expect(hb.allCleared()).toBe(true);
      await expect(server.close()).resolves.toBeUndefined();
    } finally {
      hb.restore();
    }
  });
});

describe('infraestrutura de CA/HTTPS local removida da POC-02B', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));

  it('não existem módulos nem scripts de certificados', () => {
    for (const file of ['server/certs.ts', 'server/certs-cli.ts', 'server/share-ca.ts']) {
      expect(existsSync(`${root}${file}`), file).toBe(false);
    }
    const scripts = (JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { scripts: Record<string, string> }).scripts;
    expect(Object.keys(scripts)).not.toContain('certs');
    expect(Object.keys(scripts)).not.toContain('share-ca');
  });

  it('o servidor não importa TLS/HTTPS nem OpenSSL', () => {
    for (const file of ['server/server.ts', 'server/index.ts']) {
      const source = readFileSync(`${root}${file}`, 'utf8');
      expect(source, file).not.toMatch(/from 'node:(https|tls)'/);
      expect(source, file).not.toMatch(/openssl|certs\.ts|createSecureContext/i);
    }
  });
});
