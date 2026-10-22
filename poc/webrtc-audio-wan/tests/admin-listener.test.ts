// Separação administrativa (02B.2C): listener administrativo próprio, pareamento do operador e
// proteções contra páginas maliciosas/CSRF. O privilégio vem do listener + token, nunca do Host.
import { rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer, type ServerConfig } from '../server/server.ts';
import { testIssuer } from './helpers/access.ts';
import { TestClient, createAndInvite, fakeDist, pairAdmin, pairHeaders, post, wsUrlOf } from './helpers/ws-client.ts';

const PUBLIC = 'oryn-poc.example.com';
const running: RunningServer[] = [];
const clients: TestClient[] = [];
const dirs: string[] = [];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let issuer: Awaited<ReturnType<typeof testIssuer>>;
beforeAll(async () => {
  issuer = await testIssuer();
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dist(): string {
  const d = fakeDist();
  dirs.push(d);
  return d;
}

async function server(options: Partial<ServerConfig> = {}, logs?: string[]): Promise<RunningServer> {
  // Hostname público exige Cloudflare Access (02B.3A); o listener administrativo não o usa.
  const access = options.publicHostnames?.length ? issuer.server : {};
  const s = await startServer({ distDir: dist(), httpPort: 0, adminPort: 0, log: (l) => logs?.push(l), ...access, ...options });
  running.push(s);
  return s;
}

async function open(url: string, origin: string | null, headers: Record<string, string> = {}): Promise<TestClient> {
  const c = await TestClient.open(url, origin, { headers });
  clients.push(c);
  return c;
}

const portOf = (origin: string): number => Number(new URL(origin).port);

function get(origin: string, path: string, headers: Record<string, string> = {}): Promise<number> {
  const url = new URL(path, origin);
  return new Promise((resolve, reject) => {
    http.get({ host: url.hostname, port: url.port, path: url.pathname, headers }, (res) => (res.resume(), resolve(res.statusCode ?? 0))).on('error', reject);
  });
}

function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  const port = await new Promise<number>((r) => probe.listen(0, '127.0.0.1', () => r((probe.address() as net.AddressInfo).port)));
  await new Promise((r) => probe.close(r));
  return port;
}

describe('configuração dos listeners', () => {
  it('portas iguais são recusadas antes de abrir qualquer listener', async () => {
    const port = await freePort();
    await expect(startServer({ distDir: dist(), httpPort: port, adminPort: port, log: () => undefined })).rejects.toThrow(/Configuração ambígua/);
    expect(await isListening(port)).toBe(false);
  });

  it('opção legada operatorKeyHash é recusada (não ignorada)', async () => {
    const legacy = { distDir: dist(), httpPort: 0, adminPort: 0, operatorKeyHash: Buffer.alloc(32), log: () => undefined } as unknown as ServerConfig;
    await expect(startServer(legacy)).rejects.toThrow(/operatorKeyHash" removida/);
  });

  it('porta administrativa ocupada: o servidor não sobe e libera a porta de sinalização', async () => {
    const blocker = net.createServer();
    const busy = await new Promise<number>((r) => blocker.listen(0, '127.0.0.1', () => r((blocker.address() as net.AddressInfo).port)));
    const httpPort = await freePort();
    try {
      await expect(startServer({ distDir: dist(), httpPort, adminPort: busy, log: () => undefined })).rejects.toThrow(/EADDRINUSE/);
      expect(await isListening(httpPort)).toBe(false);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it('listeners distintos, ambos em loopback; sem porta administrativa não há listener administrativo', async () => {
    const s = await server();
    expect(s.adminOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(portOf(s.adminOrigin!)).not.toBe(portOf(s.httpOrigin));
    const only = await startServer({ distDir: dist(), httpPort: 0, log: () => undefined });
    running.push(only);
    expect(only.adminOrigin).toBeNull();
    // Sem listener administrativo, ninguém consegue privilégio de operador (mesmo com token válido de outro servidor).
    const token = await pairAdmin(s);
    const c = await open(wsUrlOf(only.httpOrigin), only.httpOrigin);
    c.send({ type: 'create', operatorKey: token });
    expect(await c.next('error')).toEqual({ type: 'error', code: 'unauthorized' });
  });
});

describe('listener de sinalização não tem capacidade administrativa', () => {
  it('POST /admin/pair → 405 mesmo com cabeçalhos perfeitos; o código continua intacto', async () => {
    const s = await server();
    const { code } = s.adminAuth.issuePairingCode();
    const reply = await post(s.httpOrigin, '/admin/pair', JSON.stringify({ code }), pairHeaders(s.httpOrigin));
    expect(reply.status).toBe(405);
    expect(reply.body).not.toMatch(/token/);
    expect(s.adminAuth.pairingPending).toBe(true);
    expect(await get(s.httpOrigin, '/admin/pair')).toBe(404);
  });

  it('create, rejoin e invite são negados mesmo com o token administrativo válido', async () => {
    const s = await server();
    const token = await pairAdmin(s);
    const operator = await open(wsUrlOf(s.adminOrigin!), s.adminOrigin);
    const { sessionId } = await createAndInvite(operator, token);
    operator.send({ type: 'leave' });
    await wait(20);
    const c = await open(wsUrlOf(s.httpOrigin), s.httpOrigin);
    c.send({ type: 'create', operatorKey: token });
    expect(await c.next('error')).toEqual({ type: 'error', code: 'unauthorized' });
    c.send({ type: 'invite' });
    expect(await c.next('error')).toEqual({ type: 'error', code: 'unauthorized' });
    expect(s.registry.sessionCount).toBe(0);
    expect(sessionId).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('o operador pode sair e voltar (rejoin) somente pelo listener administrativo', async () => {
    const s = await server();
    const token = await pairAdmin(s);
    const operator = await open(wsUrlOf(s.adminOrigin!), s.adminOrigin);
    const { sessionId, invite } = await createAndInvite(operator, token);
    const guest = await open(wsUrlOf(s.httpOrigin), s.httpOrigin);
    guest.send({ type: 'join', invite });
    await guest.next('session');
    operator.ws.terminate();
    await guest.next('peer-left');
    const viaSignal = await open(wsUrlOf(s.httpOrigin), s.httpOrigin);
    viaSignal.send({ type: 'rejoin', sessionId, operatorKey: token });
    expect(await viaSignal.next('error')).toEqual({ type: 'error', code: 'unauthorized' });
    const back = await open(wsUrlOf(s.adminOrigin!), s.adminOrigin);
    back.send({ type: 'rejoin', sessionId, operatorKey: token });
    expect(await back.next('session')).toMatchObject({ role: 'host', peerPresent: true });
  });
});

describe('listener administrativo: Host e Origin', () => {
  it('aceita somente Host local da própria porta; público, porta da sinalização e rebinding → 421', async () => {
    const s = await server({ publicHostnames: [PUBLIC] });
    const adminPort = portOf(s.adminOrigin!);
    const signalPort = portOf(s.httpOrigin);
    for (const h of [`127.0.0.1:${adminPort}`, `localhost:${adminPort}`]) expect(await get(s.adminOrigin!, '/', { Host: h }), h).toBe(200);
    for (const h of [PUBLIC, `${PUBLIC}:${adminPort}`, `127.0.0.1:${signalPort}`, `localhost:${signalPort}`, `rebind.attacker.example:${adminPort}`, '127.0.0.1']) {
      expect(await get(s.adminOrigin!, '/', { Host: h }), h).toBe(421);
    }
    // Cabeçalhos de proxy não substituem o Host.
    const spoof = { Host: PUBLIC, 'X-Forwarded-Host': `localhost:${adminPort}`, 'X-Forwarded-For': '127.0.0.1', 'CF-Connecting-IP': '127.0.0.1' };
    expect(await get(s.adminOrigin!, '/', spoof)).toBe(421);
  });

  it('WebSocket administrativo: Host público/forjado → 421; Origin de outra origem → 403', async () => {
    const s = await server({ publicHostnames: [PUBLIC] });
    const url = wsUrlOf(s.adminOrigin!);
    await expect(TestClient.open(url, `https://${PUBLIC}`, { headers: { Host: PUBLIC } })).rejects.toThrow('421');
    await expect(TestClient.open(url, s.httpOrigin, { headers: { Host: new URL(s.httpOrigin).host } })).rejects.toThrow('421');
    for (const origin of [null, 'null', s.httpOrigin, `https://${PUBLIC}`, 'https://evil.example', `http://localhost:${portOf(s.adminOrigin!)}`]) {
      await expect(TestClient.open(url, origin), String(origin)).rejects.toThrow('403');
    }
  });

  it('Host local no listener administrativo não basta: sem token válido, create/rejoin são negados', async () => {
    const s = await server();
    const c = await open(wsUrlOf(s.adminOrigin!), s.adminOrigin);
    c.send({ type: 'create', operatorKey: 'A'.repeat(43) });
    expect(await c.next('error')).toEqual({ type: 'error', code: 'unauthorized' });
    c.send({ type: 'rejoin', sessionId: 'S'.repeat(22), operatorKey: 'A'.repeat(43) });
    expect(await c.next('error')).toEqual({ type: 'error', code: 'unauthorized' });
  });
});

describe('POST /admin/pair: proteção contra CSRF e páginas maliciosas', () => {
  type Case = [string, (s: RunningServer, code: string) => { headers: Record<string, string>; body?: string }, number];
  const ok = (s: RunningServer) => pairHeaders(s.adminOrigin!);
  const without = (h: Record<string, string>, k: string) => Object.fromEntries(Object.entries(h).filter(([key]) => key !== k));
  const cases: Case[] = [
    ['sem Origin', (s) => ({ headers: without(ok(s), 'Origin') }), 403],
    ['Origin de outro site', (s) => ({ headers: { ...ok(s), Origin: 'https://evil.example' } }), 403],
    ['Origin "null" (iframe sandbox, file://)', (s) => ({ headers: { ...ok(s), Origin: 'null' } }), 403],
    ['Origin do listener de sinalização (outra porta local)', (s) => ({ headers: { ...ok(s), Origin: s.httpOrigin } }), 403],
    ['Origin localhost com Host 127.0.0.1 (incoerente)', (s) => ({ headers: { ...ok(s), Origin: `http://localhost:${portOf(s.adminOrigin!)}` } }), 403],
    ['Origin https da porta administrativa', (s) => ({ headers: { ...ok(s), Origin: s.adminOrigin!.replace('http:', 'https:') } }), 403],
    ['sem X-Oryn-Admin (formulário/fetch simples)', (s) => ({ headers: without(ok(s), 'X-Oryn-Admin') }), 403],
    ['X-Oryn-Admin com outro valor', (s) => ({ headers: { ...ok(s), 'X-Oryn-Admin': 'true' } }), 403],
    ['Sec-Fetch-Site cross-site', (s) => ({ headers: { ...ok(s), 'Sec-Fetch-Site': 'cross-site' } }), 403],
    ['Sec-Fetch-Site same-site', (s) => ({ headers: { ...ok(s), 'Sec-Fetch-Site': 'same-site' } }), 403],
    ['Content-Type text/plain (requisição "simples")', (s) => ({ headers: { ...ok(s), 'Content-Type': 'text/plain' } }), 415],
    ['Content-Type de formulário', (s) => ({ headers: { ...ok(s), 'Content-Type': 'application/x-www-form-urlencoded' } }), 415],
    ['JSON com chaves extras', (s, code) => ({ headers: ok(s), body: JSON.stringify({ code, admin: true }) }), 400],
    ['código não textual', (s) => ({ headers: ok(s), body: JSON.stringify({ code: 12345678 }) }), 400],
    ['JSON inválido', (s) => ({ headers: ok(s), body: '{code' }), 400],
    ['código longo demais', (s) => ({ headers: ok(s), body: JSON.stringify({ code: 'A'.repeat(33) }) }), 400],
  ];

  it.each(cases)('%s → recusado sem consumir o código', async (_name, build, status) => {
    const s = await server();
    const { code } = s.adminAuth.issuePairingCode();
    const { headers, body } = build(s, code);
    const reply = await post(s.adminOrigin!, '/admin/pair', body ?? JSON.stringify({ code }), headers);
    expect(reply.status).toBe(status);
    expect(reply.body).not.toMatch(/"token"/);
    // A recusa não queima o código nem conta tentativa: o operador legítimo pareia em seguida.
    const legit = await post(s.adminOrigin!, '/admin/pair', JSON.stringify({ code }), ok(s));
    expect(legit.status).toBe(200);
  });

  it('GET → 405; preflight OPTIONS → 405 sem cabeçalhos CORS (o navegador bloqueia o POST cruzado)', async () => {
    const s = await server();
    expect(await get(s.adminOrigin!, '/admin/pair')).toBe(405);
    const preflight = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: portOf(s.adminOrigin!),
          path: '/admin/pair',
          method: 'OPTIONS',
          headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-oryn-admin' },
        },
        (res) => (res.resume(), resolve(res)),
      );
      req.on('error', reject);
      req.end();
    });
    expect(preflight.statusCode).toBe(403); // Origin estranho recusado antes de qualquer rota
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    const sameOrigin = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: portOf(s.adminOrigin!), path: '/admin/pair', method: 'OPTIONS' }, (res) => (res.resume(), resolve(res)));
      req.on('error', reject);
      req.end();
    });
    expect(sameOrigin.statusCode).toBe(405);
    expect(sameOrigin.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sucesso: token 256 bits, sem cache; código de uso único; o token anterior é revogado no novo pareamento', async () => {
    const s = await server();
    const { code } = s.adminAuth.issuePairingCode();
    const first = await post(s.adminOrigin!, '/admin/pair', JSON.stringify({ code }), pairHeaders(s.adminOrigin!));
    expect(first.status).toBe(200);
    const { token } = JSON.parse(first.body) as { token: string };
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.adminAuth.verify(token)).toBe(true);
    const reuse = await post(s.adminOrigin!, '/admin/pair', JSON.stringify({ code }), pairHeaders(s.adminOrigin!));
    expect(reuse.status).toBe(403);
    const second = await pairAdmin(s);
    expect(s.adminAuth.verify(token)).toBe(false);
    const c = await open(wsUrlOf(s.adminOrigin!), s.adminOrigin);
    c.send({ type: 'create', operatorKey: token });
    expect(await c.next('error')).toEqual({ type: 'error', code: 'unauthorized' });
    await createAndInvite(c, second);
  });

  it('cabeçalho Cache-Control: no-store na resposta com o token', async () => {
    const s = await server();
    const { code } = s.adminAuth.issuePairingCode();
    const reply = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: portOf(s.adminOrigin!), path: '/admin/pair', method: 'POST', headers: pairHeaders(s.adminOrigin!) },
        (res) => (res.resume(), resolve(res)),
      );
      req.on('error', reject);
      req.end(JSON.stringify({ code }));
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.headers['cache-control']).toBe('no-store');
  });

  it('5 códigos errados → 429 e o código é queimado (nem o certo serve depois)', async () => {
    const s = await server();
    const { code } = s.adminAuth.issuePairingCode();
    const wrong = code === 'ZZZZZZZZ' ? 'YYYYYYYY' : 'ZZZZZZZZ';
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await post(s.adminOrigin!, '/admin/pair', JSON.stringify({ code: wrong }), pairHeaders(s.adminOrigin!))).status);
    expect(statuses).toEqual([403, 403, 403, 403, 429]);
    expect((await post(s.adminOrigin!, '/admin/pair', JSON.stringify({ code }), pairHeaders(s.adminOrigin!))).status).toBe(403);
  });

  it('código expirado → 403', async () => {
    const s = await server({ pairingCodeTtlMs: 50 });
    const { code } = s.adminAuth.issuePairingCode();
    await wait(80);
    expect((await post(s.adminOrigin!, '/admin/pair', JSON.stringify({ code }), pairHeaders(s.adminOrigin!))).status).toBe(403);
  });

  it('logs registram o pareamento sem o código nem o token', async () => {
    const logs: string[] = [];
    const s = await server({}, logs);
    const { code } = s.adminAuth.issuePairingCode();
    await post(s.adminOrigin!, '/admin/pair', JSON.stringify({ code: 'ZZZZZZZZ' }), pairHeaders(s.adminOrigin!));
    const reply = await post(s.adminOrigin!, '/admin/pair', JSON.stringify({ code }), pairHeaders(s.adminOrigin!));
    const { token } = JSON.parse(reply.body) as { token: string };
    const c = await open(wsUrlOf(s.adminOrigin!), s.adminOrigin);
    await createAndInvite(c, token);
    const all = logs.join('\n');
    expect(all).toContain('pareamento do operador concluído');
    for (const secret of [code, token, 'ZZZZZZZZ']) expect(all).not.toContain(secret);
  });
});
