// A3 (auditoria do PR #3): validação do cabeçalho Host por listener (proteção contra DNS rebinding).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOpenssl, generateCertificates } from '../server/certs.ts';
import { checkHost, startServer, type RunningServer } from '../server/server.ts';
import { TestClient, fakeDist } from './helpers/ws-client.ts';

let opensslAvailable = true;
try {
  findOpenssl();
} catch {
  opensslAvailable = false;
}
const supportsIpv6 = await new Promise<boolean>((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(0, '::1', () => s.close(() => resolve(true)));
});

interface Reply {
  status: number;
  body: string;
}

/**
 * Requisição HTTP(S) com Host arbitrário, sempre conectando no endereço real do listener.
 * Em HTTPS, a cadeia é verificada com a CA local e a identidade do certificado é conferida contra o
 * endereço realmente conectado (o Node usaria o Host forjado). Nenhuma verificação é desabilitada.
 */
function request(origin: string, path: string, headers: Record<string, string>, ca?: Buffer): Promise<Reply> {
  const url = new URL(origin);
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        host: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port,
        path,
        method: 'GET',
        headers,
        ...(ca ? { ca, checkServerIdentity: (_host: string, cert: tls.PeerCertificate) => tls.checkServerIdentity(url.hostname, cert) } : {}),
      },
      (res) => {
        let body = '';
        res.on('data', (d: Buffer) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** HTTP/1.0 sem cabeçalho Host (o Node exige Host apenas em HTTP/1.1). */
function requestWithoutHost(origin: string): Promise<number> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: url.hostname, port: Number(url.port) }, () => socket.write('GET / HTTP/1.0\r\n\r\n'));
    let data = '';
    socket.on('data', (d) => (data += d.toString()));
    socket.on('end', () => resolve(Number(/^HTTP\/1\.[01] (\d{3})/.exec(data)?.[1] ?? 0)));
    socket.on('error', reject);
  });
}

describe('checkHost (puro)', () => {
  const allowed = new Set(['127.0.0.1:5180', 'localhost:5180']);
  it('aceita exatamente os hosts esperados, sem diferenciar maiúsculas', () => {
    expect(checkHost('127.0.0.1:5180', allowed)).toBe('ok');
    expect(checkHost('LOCALHOST:5180', allowed)).toBe('ok');
  });
  it('recusa ausente, externo, porta errada, sem porta e malformado', () => {
    expect(checkHost(undefined, allowed)).toBe('missing');
    expect(checkHost('', allowed)).toBe('missing');
    for (const h of ['evil.example:5180', 'evil.example', '127.0.0.1:1', '127.0.0.1', 'localhost', '127.0.0.1:5180.evil', 'a b:5180', '127.0.0.1:5180@evil'])
      expect(checkHost(h, allowed), h).toBe('unknown');
  });
});

describe('listener HTTP local (127.0.0.1)', () => {
  let server: RunningServer;
  let dist: string;
  let port: string;

  beforeAll(async () => {
    dist = fakeDist();
    server = await startServer({ distDir: dist, httpPort: 0, log: () => undefined });
    port = new URL(server.httpOrigin).port;
  });
  afterAll(async () => {
    await server.close();
    rmSync(dist, { recursive: true, force: true });
  });

  it.each([['127.0.0.1'], ['localhost'], ['LOCALHOST']])('Host local válido %s:porta → 200', async (h) => {
    expect((await request(server.httpOrigin, '/', { Host: `${h}:${port}` })).status).toBe(200);
  });

  it.each([
    ['externo arbitrário', () => `rebind.attacker.example:${port}`],
    ['externo sem porta', () => 'rebind.attacker.example'],
    ['porta incorreta', () => '127.0.0.1:1'],
    ['localhost com porta incorreta', () => 'localhost:1'],
    ['loopback sem porta', () => '127.0.0.1'],
    ['IP da LAN', () => `192.168.0.23:${port}`],
    ['IPv6 não vinculado neste listener', () => `[::1]:${port}`],
    ['malformado', () => `127.0.0.1:${port}@evil`],
  ])('Host %s → 421 (sem conteúdo)', async (_name, host) => {
    const reply = await request(server.httpOrigin, '/', { Host: host() });
    expect(reply.status).toBe(421);
    expect(reply.body).not.toContain('<!doctype');
  });

  it('/api/info inacessível com Host inválido (não revela a origem HTTPS)', async () => {
    const bad = await request(server.httpOrigin, '/api/info', { Host: `rebind.attacker.example:${port}` });
    expect(bad.status).toBe(421);
    expect(bad.body).not.toContain('httpsOrigin');
    const ok = await request(server.httpOrigin, '/api/info', { Host: `localhost:${port}` });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ httpsOrigin: null });
  });

  it('Host ausente → 400', async () => {
    expect(await requestWithoutHost(server.httpOrigin)).toBe(400);
  });

  it('X-Forwarded-Host é ignorado', async () => {
    expect((await request(server.httpOrigin, '/', { Host: `evil.example:${port}`, 'X-Forwarded-Host': `localhost:${port}` })).status).toBe(421);
    expect((await request(server.httpOrigin, '/', { Host: `localhost:${port}`, 'X-Forwarded-Host': 'evil.example' })).status).toBe(200);
  });

  it('upgrade WebSocket: Host inválido é recusado mesmo com Origin válido; Origin inválido continua recusado', async () => {
    const ws = `ws://127.0.0.1:${port}/ws`;
    await expect(TestClient.open(ws, server.httpOrigin, { headers: { Host: `rebind.attacker.example:${port}` } })).rejects.toThrow('421');
    await expect(TestClient.open(ws, server.httpOrigin, { headers: { Host: '127.0.0.1:1' } })).rejects.toThrow('421');
    await expect(TestClient.open(ws, 'https://evil.example', { headers: { Host: `localhost:${port}` } })).rejects.toThrow('403');
    const ok = await TestClient.open(ws, `http://localhost:${port}`, { headers: { Host: `localhost:${port}` } });
    ok.send({ type: 'create' });
    expect((await ok.next('session'))['role']).toBe('host');
    ok.ws.terminate();
  });
});

describe.skipIf(!supportsIpv6)('listener HTTP local em IPv6 (::1)', () => {
  let server: RunningServer;
  let dist: string;
  let port: string;

  beforeAll(async () => {
    dist = fakeDist();
    server = await startServer({ distDir: dist, httpHost: '::1', httpPort: 0, log: () => undefined });
    port = new URL(server.httpOrigin).port;
  });
  afterAll(async () => {
    await server.close();
    rmSync(dist, { recursive: true, force: true });
  });

  it('Host [::1]:porta e localhost:porta → 200; 127.0.0.1:porta → 421 (não vinculado)', async () => {
    expect((await request(server.httpOrigin, '/', { Host: `[::1]:${port}` })).status).toBe(200);
    expect((await request(server.httpOrigin, '/', { Host: `localhost:${port}` })).status).toBe(200);
    expect((await request(server.httpOrigin, '/', { Host: `127.0.0.1:${port}` })).status).toBe(421);
  });

  it('upgrade WebSocket com Host [::1]:porta funciona', async () => {
    const c = await TestClient.open(`ws://[::1]:${port}/ws`, server.httpOrigin);
    c.send({ type: 'create' });
    expect((await c.next('session'))['role']).toBe('host');
    c.ws.terminate();
  });
});

describe.skipIf(!opensslAvailable)('listener HTTPS da LAN', () => {
  let server: RunningServer;
  let dist: string;
  let certDir: string;
  let ca: Buffer;
  let tlsPort: string;
  let httpPort: string;

  beforeAll(async () => {
    dist = fakeDist();
    certDir = mkdtempSync(join(tmpdir(), 'oryn-wan-hosthdr-'));
    const certs = generateCertificates({ ip: '127.0.0.1', dir: certDir });
    ca = readFileSync(certs.caCertPath);
    server = await startServer({
      distDir: dist,
      httpPort: 0,
      https: { host: '127.0.0.1', port: 0, key: readFileSync(certs.serverKeyPath), cert: readFileSync(certs.serverCertPath) },
      log: () => undefined,
    });
    tlsPort = new URL(server.httpsOrigin!).port;
    httpPort = new URL(server.httpOrigin).port;
  });
  afterAll(async () => {
    await server.close();
    rmSync(dist, { recursive: true, force: true });
    rmSync(certDir, { recursive: true, force: true });
  });

  it('Host com o IP da LAN configurado → 200', async () => {
    expect((await request(server.httpsOrigin!, '/', { Host: `127.0.0.1:${tlsPort}` }, ca)).status).toBe(200);
  });

  it('Host externo, localhost, porta do HTTP local → 421', async () => {
    for (const host of [`rebind.attacker.example:${tlsPort}`, `localhost:${tlsPort}`, `127.0.0.1:${httpPort}`]) {
      expect((await request(server.httpsOrigin!, '/', { Host: host }, ca)).status, host).toBe(421);
    }
  });

  it('listeners não compartilham hosts: o HTTP local recusa o Host do HTTPS', async () => {
    expect((await request(server.httpOrigin, '/', { Host: `127.0.0.1:${tlsPort}` })).status).toBe(421);
  });

  it('upgrade WSS: Host válido conecta; Host de outro listener é recusado', async () => {
    const wss = `wss://127.0.0.1:${tlsPort}/ws`;
    await expect(TestClient.open(wss, server.httpsOrigin, { ca, headers: { Host: `localhost:${tlsPort}` } })).rejects.toThrow('421');
    const ok = await TestClient.open(wss, server.httpsOrigin, { ca });
    ok.send({ type: 'create' });
    expect((await ok.next('session'))['role']).toBe('host');
    ok.ws.terminate();
  });
});
