// A3 (auditoria do PR #3): validação do cabeçalho Host (proteção contra DNS rebinding).
// POC-02B.2A: o listener HTTPS da LAN foi removido; os testes dele foram substituídos pelos de
// "sem acesso público nesta etapa" (final do arquivo).
import { rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkHost, startServer, type RunningServer } from '../server/server.ts';
import { TestClient, createAndInvite, fakeDist, openOperator } from './helpers/ws-client.ts';

const supportsIpv6 = await new Promise<boolean>((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(0, '::1', () => s.close(() => resolve(true)));
});

interface Reply {
  status: number;
  body: string;
}

/** Requisição HTTP com Host arbitrário, sempre conectando no endereço real do listener. */
function request(origin: string, path: string, headers: Record<string, string>): Promise<Reply> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port,
        path,
        method: 'GET',
        headers,
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
    server = await startServer({ distDir: dist, httpPort: 0, adminPort: 0, log: () => undefined });
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

  it('/api/info foi removido (02B.2A): 404 com Host válido, 421 com Host inválido', async () => {
    const bad = await request(server.httpOrigin, '/api/info', { Host: `rebind.attacker.example:${port}` });
    expect(bad.status).toBe(421);
    expect(bad.body).not.toContain('httpsOrigin');
    const ok = await request(server.httpOrigin, '/api/info', { Host: `localhost:${port}` });
    expect(ok.status).toBe(404);
    expect(ok.body).not.toContain('httpsOrigin');
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
    const { client: operator, token } = await openOperator(server);
    const { invite } = await createAndInvite(operator, token);
    ok.send({ type: 'join', invite });
    expect((await ok.next('session'))['role']).toBe('guest');
    ok.ws.terminate();
    operator.ws.terminate();
  });
});

describe.skipIf(!supportsIpv6)('listener HTTP local em IPv6 (::1)', () => {
  let server: RunningServer;
  let dist: string;
  let port: string;

  beforeAll(async () => {
    dist = fakeDist();
    server = await startServer({ distDir: dist, httpHost: '::1', httpPort: 0, adminPort: 0, log: () => undefined });
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

  it('upgrade WebSocket com Host [::1]:porta funciona nos dois listeners', async () => {
    expect(server.adminOrigin).toMatch(/^http:\/\/\[::1\]:\d+$/);
    const { client: operator, token } = await openOperator(server);
    const { invite } = await createAndInvite(operator, token);
    const c = await TestClient.open(`ws://[::1]:${port}/ws`, server.httpOrigin);
    c.send({ type: 'join', invite });
    expect((await c.next('session'))['role']).toBe('guest');
    c.ws.terminate();
    operator.ws.terminate();
  });
});

describe('sem acesso público nesta etapa (substitui os testes do antigo listener HTTPS da LAN)', () => {
  let server: RunningServer;
  let dist: string;
  let port: string;
  const PUBLIC = 'oryn-poc.example.com'; // hostname de exemplo de um túnel futuro

  beforeAll(async () => {
    dist = fakeDist();
    server = await startServer({ distDir: dist, httpPort: 0, log: () => undefined });
    port = new URL(server.httpOrigin).port;
  });
  afterAll(async () => {
    await server.close();
    rmSync(dist, { recursive: true, force: true });
  });

  it('hostname público (como o de um túnel) é recusado enquanto não for configurado explicitamente', async () => {
    for (const host of [PUBLIC, `${PUBLIC}:443`, `${PUBLIC}:${port}`]) {
      const reply = await request(server.httpOrigin, '/', { Host: host });
      expect(reply.status, host).toBe(421);
      expect(reply.body, host).not.toContain('<!doctype');
    }
  });

  it('Host do antigo listener HTTPS da LAN (IP:5543) é recusado', async () => {
    expect((await request(server.httpOrigin, '/', { Host: '192.168.0.23:5543' })).status).toBe(421);
  });

  it('upgrade WebSocket com Host público é recusado; com Origin público também', async () => {
    const ws = `ws://127.0.0.1:${port}/ws`;
    await expect(TestClient.open(ws, `https://${PUBLIC}`, { headers: { Host: PUBLIC } })).rejects.toThrow('421');
    await expect(TestClient.open(ws, `https://${PUBLIC}`, { headers: { Host: `localhost:${port}` } })).rejects.toThrow('403');
  });

  it('não há TLS local: um handshake TLS no listener falha', async () => {
    await expect(
      new Promise<void>((resolve, reject) => {
        const socket = tls.connect({ host: '127.0.0.1', port: Number(port), servername: 'localhost' }, () => {
          socket.destroy();
          resolve();
        });
        socket.once('error', reject);
      }),
    ).rejects.toThrow();
  });
});
