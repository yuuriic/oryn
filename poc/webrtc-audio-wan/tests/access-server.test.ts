// Cloudflare Access no servidor real (02B.3A): o listener de sinalização exige o JWT válido em
// Cf-Access-Jwt-Assertion em HTTP e no upgrade WebSocket; Host/Origin, limites e convites continuam
// valendo; o listener administrativo não usa Access e o Access não concede privilégio administrativo.
import { rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer, type ServerConfig } from '../server/server.ts';
import { FakeJwks, accessConfig, hang, newKey, token, type TestKey } from './helpers/access.ts';
import { TestClient, createAndInvite, fakeDist, pairAdmin, pairHeaders, post, wsUrlOf } from './helpers/ws-client.ts';

const PUBLIC = 'oryn-poc.example.com';
const running: RunningServer[] = [];
const clients: TestClient[] = [];
const dirs: string[] = [];
let key: TestKey;
let attacker: TestKey;
let jwks: FakeJwks;
let jwt: string;

beforeAll(async () => {
  [key, attacker] = await Promise.all([newKey('kid-a'), newKey('kid-a')]);
  jwt = await token(key, { expiresInSec: 3600 });
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function server(options: Partial<ServerConfig> = {}, logs?: string[]): Promise<RunningServer> {
  jwks = new FakeJwks();
  jwks.publish(key);
  const dist = fakeDist();
  dirs.push(dist);
  const s = await startServer({
    distDir: dist,
    httpPort: 0,
    adminPort: 0,
    publicHostnames: [PUBLIC],
    access: accessConfig(),
    accessFetch: (url, init) => jwks.fetch(url, init),
    log: (l) => logs?.push(l),
    ...options,
  });
  running.push(s);
  return s;
}

const port = (origin: string): string => new URL(origin).port;

function get(s: RunningServer, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: port(s.httpOrigin), path: '/', headers }, (res) => {
        let body = '';
        res.setEncoding('utf8').on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

/** Requisição como chegaria pelo túnel: Host público (+ JWT, se houver). */
const viaEdge = (token?: string): Record<string, string> => ({ Host: PUBLIC, ...(token ? { 'Cf-Access-Jwt-Assertion': token } : {}) });

async function openPublic(s: RunningServer, token?: string, extra: Record<string, string> = {}, origin = `https://${PUBLIC}`): Promise<TestClient> {
  const c = await TestClient.open(`ws://127.0.0.1:${port(s.httpOrigin)}/ws`, origin, { headers: { ...viaEdge(token), ...extra } });
  clients.push(c);
  return c;
}

describe('configuração (falha fechada)', () => {
  it('hostname público sem Access impede a partida (sem fallback silencioso) e não abre porta', async () => {
    const dist = fakeDist();
    dirs.push(dist);
    const probe = net.createServer();
    const free = await new Promise<number>((r) => probe.listen(0, '127.0.0.1', () => r((probe.address() as net.AddressInfo).port)));
    await new Promise((r) => probe.close(r));
    await expect(startServer({ distDir: dist, httpPort: free, publicHostnames: [PUBLIC], log: () => undefined })).rejects.toThrow(/exigem Cloudflare Access/);
    const listening = await new Promise<boolean>((resolve) => {
      const sock = net.connect(free, '127.0.0.1');
      sock.once('connect', () => (sock.destroy(), resolve(true)));
      sock.once('error', () => resolve(false));
    });
    expect(listening).toBe(false);
  });

  it('configuração do Access incompleta ou inválida impede a partida', async () => {
    const dist = fakeDist();
    dirs.push(dist);
    for (const bad of [{ teamDomain: '', audience: '' }, accessConfig({ audience: 'x' }), accessConfig({ teamDomain: 'evil.example.com' })]) {
      await expect(startServer({ distDir: dist, httpPort: 0, publicHostnames: [PUBLIC], access: bad, log: () => undefined })).rejects.toThrow(/Access inválida/);
    }
  });

  it('modo local (sem hostname público e sem Access) continua disponível para desenvolvimento', async () => {
    const dist = fakeDist();
    dirs.push(dist);
    const s = await startServer({ distDir: dist, httpPort: 0, log: () => undefined });
    running.push(s);
    expect(s.access).toBeNull();
    expect(s.publicOrigin).toBeNull();
  });
});

describe('HTTP no listener de sinalização', () => {
  it('sem token → 403 (Host público e Host local); com JWT válido → 200', async () => {
    const s = await server();
    const noToken = await get(s, viaEdge());
    expect(noToken.status).toBe(403);
    expect(noToken.body).not.toContain('<!doctype');
    expect((await get(s, { Host: `localhost:${port(s.httpOrigin)}` })).status).toBe(403); // Host reescrito não dispensa o JWT
    expect((await get(s, viaEdge(jwt))).status).toBe(200);
  });

  it('assinatura inválida, expirado, outro emissor ou outra audiência → 403', async () => {
    const s = await server();
    const bad = [
      await token(attacker),
      await token(key, { expiresInSec: -120 }),
      await token(key, { claims: { iss: 'https://outra.cloudflareaccess.com' } }),
      await token(key, { claims: { aud: ['f'.repeat(64)] } }),
      await token(key, { claims: { nbf: Math.floor(Date.now() / 1000) + 600 } }),
    ];
    for (const t of bad) expect((await get(s, viaEdge(t))).status).toBe(403);
  });

  it('token administrativo não substitui o Access (no cabeçalho do Access ou em Authorization)', async () => {
    const s = await server();
    const admin = await pairAdmin(s);
    expect((await get(s, viaEdge(admin))).status).toBe(403);
    expect((await get(s, { ...viaEdge(), Authorization: `Bearer ${admin}` })).status).toBe(403);
    expect((await get(s, { ...viaEdge(), Cookie: `CF_Authorization=${jwt}` })).status).toBe(403); // o cookie não é aceito
  });

  it('JWKS indisponível → 503 (nunca libera)', async () => {
    // Sem chaves em cache (o pré-carregamento também falhou).
    const s = await server({ accessFetch: () => Promise.reject(new TypeError('fetch failed')) });
    const reply = await get(s, viaEdge(jwt));
    expect(reply.status).toBe(503);
    expect(reply.body).not.toContain('<!doctype');
  });

  it('Host e Origin continuam verificados antes de tudo, mesmo com JWT válido', async () => {
    const s = await server();
    expect((await get(s, { Host: 'rebind.attacker.example', 'Cf-Access-Jwt-Assertion': jwt })).status).toBe(421);
    expect((await get(s, { ...viaEdge(jwt), Origin: 'https://evil.example' })).status).toBe(403);
  });

  it('POST /admin/pair no listener público com JWT válido → 405; o código segue intacto', async () => {
    const s = await server();
    const { code } = s.adminAuth.issuePairingCode();
    const headers = { ...pairHeaders(`https://${PUBLIC}`), Host: PUBLIC, 'Cf-Access-Jwt-Assertion': jwt };
    expect((await post(s.httpOrigin, '/admin/pair', JSON.stringify({ code }), headers)).status).toBe(405);
    expect(s.adminAuth.pairingPending).toBe(true);
  });
});

describe('WebSocket no listener de sinalização', () => {
  it('sem token ou com token inválido → 403 antes do upgrade; com JWT válido → conecta', async () => {
    const s = await server();
    await expect(openPublic(s)).rejects.toThrow('403');
    await expect(openPublic(s, await token(attacker))).rejects.toThrow('403');
    await expect(openPublic(s, await token(key, { expiresInSec: -120 }))).rejects.toThrow('403');
    await expect(openPublic(s, 'A'.repeat(43))).rejects.toThrow('403');
    const ok = await openPublic(s, jwt);
    expect(ok.ws.readyState).toBe(ok.ws.OPEN);
  });

  it('Host e Origin preservados: JWT válido não compensa Host desconhecido (421) nem Origin incoerente (403)', async () => {
    const s = await server();
    await expect(openPublic(s, jwt, { Host: 'rebind.attacker.example' }, 'https://rebind.attacker.example')).rejects.toThrow('421');
    for (const origin of ['https://evil.example', `http://${PUBLIC}`, 'null']) {
      await expect(openPublic(s, jwt, {}, origin), origin).rejects.toThrow('403');
    }
  });

  it('JWKS indisponível → 503 no upgrade', async () => {
    const s = await server({ accessFetch: () => Promise.reject(new TypeError('fetch failed')) });
    await expect(openPublic(s, jwt)).rejects.toThrow('503');
  });

  it('Access não concede privilégio administrativo: create/rejoin com token administrativo válido → unauthorized', async () => {
    const s = await server();
    const admin = await pairAdmin(s);
    const c = await openPublic(s, jwt);
    c.send({ type: 'create', operatorKey: admin });
    expect(await c.next('error')).toEqual({ type: 'error', code: 'unauthorized' });
    c.send({ type: 'rejoin', sessionId: 'S'.repeat(22), operatorKey: admin });
    expect(await c.next('error')).toEqual({ type: 'error', code: 'unauthorized' });
    expect(s.registry.sessionCount).toBe(0);
  });

  it('Access não substitui o convite: sem convite válido não entra; prazo de admissão continua valendo', async () => {
    const s = await server({ admissionTimeoutMs: 200, heartbeatMs: 50 });
    const c = await openPublic(s, jwt);
    c.send({ type: 'join', invite: 'Z'.repeat(43) });
    expect(await c.next('error')).toEqual({ type: 'error', code: 'invite-invalid' });
    expect((await c.closed).code).toBe(1008);
  });

  it('fluxo legítimo: operador no administrativo (sem Access), convidado autenticado entra e reentra com convites', async () => {
    const s = await server();
    const admin = await pairAdmin(s);
    const operator = await TestClient.open(wsUrlOf(s.adminOrigin!), s.adminOrigin); // nenhum JWT no administrativo
    clients.push(operator);
    const { invite } = await createAndInvite(operator, admin);
    const guest = await openPublic(s, jwt);
    guest.send({ type: 'join', invite });
    expect((await guest.next('session'))['role']).toBe('guest');
    guest.ws.terminate();
    await operator.next('peer-left');
    operator.send({ type: 'invite' });
    const invite2 = (await operator.next('invite'))['token'] as string;
    const back = await openPublic(s, jwt);
    back.send({ type: 'join', invite: invite2 });
    expect((await back.next('session'))['role']).toBe('guest');
  });

  it('limite global de conexões continua valendo para conexões autenticadas', async () => {
    const s = await server({ maxConnections: 2 });
    await openPublic(s, jwt);
    await openPublic(s, jwt);
    await expect(openPublic(s, jwt)).rejects.toThrow('503');
  });

  it('validações pendentes são limitadas (JWKS lento não acumula sockets): excedente recusado na hora', async () => {
    const s = await server({ maxPendingAccessChecks: 1, accessFetch: (_url, init) => hang(init), access: accessConfig({ jwksTimeoutMs: 3000 }) });
    const first = openPublic(s, jwt).catch((e: Error) => e.message);
    await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    await expect(openPublic(s, jwt)).rejects.toThrow('503');
    expect(Date.now() - started).toBeLessThan(1000); // não esperou o timeout do JWKS
    expect(await first).toMatch(/503/); // a primeira também falha fechada (timeout do JWKS)
  });

  it('a conexão autenticada é encerrada quando o JWT expira; o mesmo token não abre nova conexão', async () => {
    const s = await server({ heartbeatMs: 50, access: accessConfig({ clockToleranceSec: 0 }) });
    const short = await token(key, { expiresInSec: 2 });
    const c = await openPublic(s, short);
    const closed = await c.closed;
    expect(closed).toEqual({ code: 1008, reason: 'access expired' });
    await expect(openPublic(s, short)).rejects.toThrow('403');
  });
});

describe('listener administrativo sem Access', () => {
  it('página, pareamento e WebSocket funcionam sem JWT; cabeçalho de Access lixo é irrelevante', async () => {
    const s = await server();
    const admin = s.adminOrigin!;
    const status = await new Promise<number>((resolve, reject) => {
      http.get(`${admin}/`, { headers: { 'Cf-Access-Jwt-Assertion': 'lixo' } }, (res) => (res.resume(), resolve(res.statusCode ?? 0))).on('error', reject);
    });
    expect(status).toBe(200);
    const token = await pairAdmin(s);
    const c = await TestClient.open(wsUrlOf(admin), admin);
    clients.push(c);
    await createAndInvite(c, token);
    expect(jwks.requests.length).toBeLessThanOrEqual(1); // só o pré-carregamento; o administrativo não consulta o Access
  });

  it('continua recusando Host público, mesmo com JWT válido', async () => {
    const s = await server();
    const status = await new Promise<number>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: port(s.adminOrigin!), path: '/', headers: viaEdge(jwt) }, (res) => (res.resume(), resolve(res.statusCode ?? 0)))
        .on('error', reject);
    });
    expect(status).toBe(421);
  });
});

describe('logs', () => {
  it('recusas do Access registradas sem o JWT, e-mail ou sub', async () => {
    const logs: string[] = [];
    const s = await server({}, logs);
    await get(s, viaEdge(await token(attacker)));
    const c = await openPublic(s, jwt);
    c.ws.terminate();
    const all = logs.join('\n');
    expect(all).toContain('access (http): invalid');
    expect(all).toContain('[access] upgrade WebSocket autenticado (kid kid-a…');
    for (const secret of [jwt, 'convidado@example.com', 'test-user-id']) expect(all).not.toContain(secret);
  });
});
