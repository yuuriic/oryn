// HTTP sem TLS exclusivamente em loopback (revisão do PR #3).
// Garante que endereços não-loopback são rejeitados ANTES de abrir qualquer listener, sem
// fallback, e que o HTTP local e o HTTPS/WSS continuam funcionando.
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findOpenssl, generateCertificates } from '../server/certs.ts';
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
let opensslAvailable = true;
try {
  findOpenssl();
} catch {
  opensslAvailable = false;
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
  it.each(REJECTED)('httpHost %s (%s): rejeita e não abre HTTP nem HTTPS', async (host) => {
    const [httpPort, httpsPort] = [await freePort(), await freePort()];
    const attempt = startServer({
      distDir: dist(),
      httpHost: host,
      httpPort,
      // Mesmo com HTTPS configurado, nada deve ser aberto.
      https: { host: '127.0.0.1', port: httpsPort, key: 'x', cert: 'x' },
      log: () => undefined,
    });
    await expect(attempt).rejects.toThrow(/httpHost (inválido|recusado)/);
    expect(await isListening('127.0.0.1', httpPort)).toBe(false);
    expect(await isListening('127.0.0.1', httpsPort)).toBe(false);
  });

  it('falha ao abrir o HTTPS (porta ocupada) fecha o HTTP já aberto e não deixa recursos órfãos', async () => {
    if (!opensslAvailable) return;
    const certDir = mkdtempSync(join(tmpdir(), 'oryn-lan-host-'));
    dirs.push(certDir);
    const certs = generateCertificates({ ip: '127.0.0.1', dir: certDir });
    const blocker = net.createServer();
    const busyPort = await new Promise<number>((r) => blocker.listen(0, '127.0.0.1', () => r((blocker.address() as net.AddressInfo).port)));
    const httpPort = await freePort();
    try {
      await expect(
        startServer({
          distDir: dist(),
          httpPort,
          https: { host: '127.0.0.1', port: busyPort, key: readFileSync(certs.serverKeyPath), cert: readFileSync(certs.serverCertPath) },
          log: () => undefined,
        }),
      ).rejects.toThrow(/EADDRINUSE/);
      expect(await isListening('127.0.0.1', httpPort)).toBe(false);
    } finally {
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

  it.skipIf(!opensslAvailable)('HTTP local e HTTPS/WSS continuam funcionando juntos', async () => {
    const certDir = mkdtempSync(join(tmpdir(), 'oryn-lan-host-'));
    dirs.push(certDir);
    const certs = generateCertificates({ ip: '127.0.0.1', dir: certDir });
    const ca = readFileSync(certs.caCertPath);
    const server = await startServer({
      distDir: dist(),
      httpPort: 0,
      https: { host: '127.0.0.1', port: 0, key: readFileSync(certs.serverKeyPath), cert: readFileSync(certs.serverCertPath) },
      log: () => undefined,
    });
    running.push(server);
    expect((await fetch(`${server.httpOrigin}/`)).status).toBe(200);
    const wss = await TestClient.open(`${server.httpsOrigin!.replace('https', 'wss')}/ws`, server.httpsOrigin, { ca });
    wss.send({ type: 'create' });
    expect((await wss.next('session'))['role']).toBe('host');
    wss.ws.terminate();
  });
});
