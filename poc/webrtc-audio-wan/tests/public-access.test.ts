// Acesso público (02B.2B): allowlist de hostnames, Host/Origin coerentes, DNS rebinding, Host spoofing e
// comportamento atrás de um proxy local que simula o túnel (sem Cloudflare e sem expor nada).
import { rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { checkOrigin, startServer, validatePublicHostname, type RunningServer } from '../server/server.ts';
import { testIssuer } from './helpers/access.ts';
import { TestClient, createAndInvite, fakeDist, openOperator, post } from './helpers/ws-client.ts';

const PUBLIC = 'oryn-poc.example.com';
const running: { close(): Promise<void> | void }[] = [];
const dirs: string[] = [];

// 02B.3A: hostname público exige Cloudflare Access. O proxy abaixo injeta um JWT válido de um emissor de
// teste, como a borda da Cloudflare faria depois do login.
let issuer: Awaited<ReturnType<typeof testIssuer>>;
beforeAll(async () => {
  issuer = await testIssuer();
});

afterEach(async () => {
  for (const r of running.splice(0).reverse()) await r.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function server(options: { publicHostnames?: string[]; maxConnections?: number } = {}): Promise<RunningServer> {
  const dist = fakeDist();
  dirs.push(dist);
  const access = options.publicHostnames?.length ? issuer.server : {};
  const s = await startServer({ distDir: dist, httpPort: 0, adminPort: 0, log: () => undefined, ...access, ...options });
  running.push(s);
  return s;
}

/**
 * Proxy reverso local que imita o túnel: reescreve o Host para o hostname público e injeta
 * cabeçalhos de proxy (inclusive um X-Forwarded-Host forjado apontando para o loopback).
 */
async function tunnelProxy(
  target: RunningServer,
  publicHost: string,
  clientIp = '203.0.113.9',
  targetOrigin: string = target.httpOrigin,
): Promise<string> {
  const port = Number(new URL(targetOrigin).port);
  const rewrite = (headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders => ({
    ...headers,
    host: publicHost,
    'x-forwarded-for': clientIp,
    'cf-connecting-ip': clientIp,
    'x-forwarded-host': `localhost:${port}`,
    'x-forwarded-proto': 'https',
    'cf-access-jwt-assertion': issuer.jwt, // a borda injeta o JWT do Access em toda requisição
  });
  const proxy = http.createServer((req, res) => {
    const upstream = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: rewrite(req.headers) }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  proxy.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(port, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(rewrite(req.headers))) {
        for (const value of Array.isArray(v) ? v : [v]) if (value !== undefined) lines.push(`${k}: ${value}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  const proxyPort = await new Promise<number>((r) => proxy.listen(0, '127.0.0.1', () => r((proxy.address() as net.AddressInfo).port)));
  running.push({ close: () => new Promise<void>((r) => (proxy.closeAllConnections(), proxy.close(() => r()))) });
  return `127.0.0.1:${proxyPort}`;
}

function get(hostPort: string, headers: Record<string, string> = {}): Promise<number> {
  const [host, port] = hostPort.split(':');
  return new Promise((resolve, reject) => {
    http.get({ host, port, path: '/', headers }, (res) => (res.resume(), resolve(res.statusCode ?? 0))).on('error', reject);
  });
}

describe('validatePublicHostname (configuração)', () => {
  it('aceita nomes DNS exatos e normaliza para minúsculas', () => {
    expect(validatePublicHostname('oryn-poc.example.com')).toBe('oryn-poc.example.com');
    expect(validatePublicHostname(' ORYN-POC.Example.COM ')).toBe('oryn-poc.example.com');
  });

  it.each([
    ['*.example.com', 'curinga'],
    ['example', 'sem domínio'],
    ['localhost', 'localhost'],
    ['app.localhost', 'subdomínio de localhost'],
    ['127.0.0.1', 'IPv4'],
    ['::1', 'IPv6'],
    ['https://oryn-poc.example.com', 'com esquema'],
    ['oryn-poc.example.com:443', 'com porta'],
    ['-bad.example.com', 'rótulo inválido'],
    ['a..example.com', 'rótulo vazio'],
    ['', 'vazio'],
  ])('recusa %s (%s)', (value) => {
    expect(() => validatePublicHostname(value)).toThrow(/Hostname público inválido/);
  });

  it('allowlist inválida impede o servidor de subir (nenhuma porta aberta)', async () => {
    const dist = fakeDist();
    dirs.push(dist);
    await expect(startServer({ distDir: dist, httpPort: 0, publicHostnames: ['*.example.com'], log: () => undefined })).rejects.toThrow(/curingas/);
  });
});

describe('checkOrigin (puro)', () => {
  it('Origin deve corresponder ao Host com o esquema da zona', () => {
    expect(checkOrigin('http://localhost:5280', 'localhost:5280', 'local', true)).toBe('ok');
    expect(checkOrigin(`https://${PUBLIC}`, PUBLIC, 'public', true)).toBe('ok');
    expect(checkOrigin(`HTTPS://${PUBLIC.toUpperCase()}`, PUBLIC, 'public', true)).toBe('ok');
    expect(checkOrigin(`http://${PUBLIC}`, PUBLIC, 'public', true)).toBe('mismatch'); // esquema errado
    expect(checkOrigin('https://localhost:5280', 'localhost:5280', 'local', true)).toBe('mismatch');
    expect(checkOrigin('http://127.0.0.1:5280', 'localhost:5280', 'local', true)).toBe('mismatch'); // cruzado
    expect(checkOrigin('http://localhost:5280', PUBLIC, 'public', true)).toBe('mismatch'); // Host público + Origin local
    expect(checkOrigin('null', PUBLIC, 'public', true)).toBe('mismatch');
    expect(checkOrigin(undefined, PUBLIC, 'public', true)).toBe('missing');
    expect(checkOrigin(undefined, PUBLIC, 'public', false)).toBe('ok'); // navegação HTTP sem Origin
  });
});

describe('configuração pública ausente (fechado por padrão)', () => {
  it('sem allowlist, o hostname público é recusado mesmo pelo proxy e com X-Forwarded-Host local', async () => {
    const s = await server();
    expect(s.publicOrigin).toBeNull();
    const proxy = await tunnelProxy(s, PUBLIC);
    expect(await get(proxy)).toBe(421);
    await expect(TestClient.open(`ws://${proxy}/ws`, `https://${PUBLIC}`)).rejects.toThrow('421');
  });
});

describe('atrás do proxy local simulado (hostname público autorizado)', () => {
  it('serve a página e aceita WebSocket com Origin https://<host público>; recusa Origin incoerente', async () => {
    const s = await server({ publicHostnames: [PUBLIC] });
    expect(s.publicOrigin).toBe(`https://${PUBLIC}`);
    const proxy = await tunnelProxy(s, PUBLIC);
    expect(await get(proxy)).toBe(200);
    expect(await get(proxy, { Origin: 'https://evil.example' })).toBe(403);
    const ok = await TestClient.open(`ws://${proxy}/ws`, `https://${PUBLIC}`);
    ok.ws.terminate();
    for (const origin of [null, 'null', `http://${PUBLIC}`, 'http://localhost:5280', `https://evil.${PUBLIC}`]) {
      await expect(TestClient.open(`ws://${proxy}/ws`, origin), String(origin)).rejects.toThrow('403');
    }
  });

  it('pelo túnel, criar sessão é negado mesmo com o token administrativo válido; convidado entra com convite', async () => {
    const s = await server({ publicHostnames: [PUBLIC] });
    const proxy = await tunnelProxy(s, PUBLIC);
    const { client: operator, token } = await openOperator(s);
    const remoteOperator = await TestClient.open(`ws://${proxy}/ws`, `https://${PUBLIC}`);
    remoteOperator.send({ type: 'create', operatorKey: token });
    expect(await remoteOperator.next('error')).toEqual({ type: 'error', code: 'unauthorized' });
    remoteOperator.ws.terminate();

    const { invite } = await createAndInvite(operator, token);
    const phone = await TestClient.open(`ws://${proxy}/ws`, `https://${PUBLIC}`);
    phone.send({ type: 'join', invite });
    expect((await phone.next('session'))['role']).toBe('guest');
    expect((await operator.next('peer-joined'))['type']).toBe('peer-joined');
    operator.ws.terminate();
    phone.ws.terminate();
  });

  it('o convite emitido ao operador traz a origem pública configurada', async () => {
    const s = await server({ publicHostnames: [PUBLIC] });
    const { client: operator, token } = await openOperator(s);
    operator.send({ type: 'create', operatorKey: token });
    await operator.next('session');
    expect((await operator.next('invite'))['publicOrigin']).toBe(`https://${PUBLIC}`);
    operator.ws.terminate();
  });

  it('cabeçalhos de proxy não contornam o limite global de conexões (IPs "diferentes" contam igual)', async () => {
    const s = await server({ publicHostnames: [PUBLIC], maxConnections: 3 });
    const proxies = await Promise.all(['198.51.100.1', '198.51.100.2', '198.51.100.3', '198.51.100.4'].map((ip) => tunnelProxy(s, PUBLIC, ip)));
    const open: TestClient[] = [];
    for (const p of proxies.slice(0, 3)) open.push(await TestClient.open(`ws://${p}/ws`, `https://${PUBLIC}`));
    await expect(TestClient.open(`ws://${proxies[3]}/ws`, `https://${PUBLIC}`)).rejects.toThrow('503');
    for (const c of open) c.ws.terminate();
  });
});

describe('separação administrativa atrás do túnel (02B.2C)', () => {
  it('túnel que reescreve o Host para localhost:<porta de sinalização> não ganha privilégio administrativo', async () => {
    const s = await server({ publicHostnames: [PUBLIC] });
    const local = `localhost:${new URL(s.httpOrigin).port}`;
    const proxy = await tunnelProxy(s, local);
    const { client: operator, token } = await openOperator(s);
    // Para o servidor, a requisição parece local (Host loopback), mas chega pelo listener de sinalização.
    expect(await get(proxy)).toBe(200);
    const viaTunnel = await TestClient.open(`ws://${proxy}/ws`, `http://${local}`);
    viaTunnel.send({ type: 'create', operatorKey: token });
    expect(await viaTunnel.next('error')).toEqual({ type: 'error', code: 'unauthorized' });
    const { code } = s.adminAuth.issuePairingCode();
    const headers = { Origin: `http://${local}`, 'Content-Type': 'application/json', 'X-Oryn-Admin': '1', 'Sec-Fetch-Site': 'same-origin' };
    const reply = await post(`http://${proxy}`, '/admin/pair', JSON.stringify({ code }), headers);
    expect(reply.status).toBe(405);
    expect(s.adminAuth.pairingPending).toBe(true); // o código não foi consumido nem tentado
    viaTunnel.ws.terminate();
    operator.ws.terminate();
  });

  it('túnel mal configurado apontando para a porta administrativa com Host público → 421 em tudo', async () => {
    const s = await server({ publicHostnames: [PUBLIC] });
    const proxy = await tunnelProxy(s, PUBLIC, '203.0.113.9', s.adminOrigin!);
    expect(await get(proxy)).toBe(421);
    await expect(TestClient.open(`ws://${proxy}/ws`, `https://${PUBLIC}`)).rejects.toThrow('421');
    const { code } = s.adminAuth.issuePairingCode();
    const reply = await post(`http://${proxy}`, '/admin/pair', JSON.stringify({ code }), {
      Origin: `https://${PUBLIC}`,
      'Content-Type': 'application/json',
      'X-Oryn-Admin': '1',
    });
    expect(reply.status).toBe(421);
    expect(s.adminAuth.pairingPending).toBe(true);
  });

  it('pior caso (túnel para a porta administrativa reescrevendo Host para localhost): ainda exige token por pareamento', async () => {
    const s = await server({ publicHostnames: [PUBLIC] });
    const local = `localhost:${new URL(s.adminOrigin!).port}`;
    const proxy = await tunnelProxy(s, local, '203.0.113.9', s.adminOrigin!);
    const attacker = await TestClient.open(`ws://${proxy}/ws`, `http://${local}`);
    attacker.send({ type: 'create', operatorKey: 'A'.repeat(43) });
    expect(await attacker.next('error')).toEqual({ type: 'error', code: 'unauthorized' });
    attacker.ws.terminate();
    // Sem conhecer o código (exibido só no terminal), 5 palpites queimam o código.
    s.adminAuth.issuePairingCode();
    const headers = { Origin: `http://${local}`, 'Content-Type': 'application/json', 'X-Oryn-Admin': '1' };
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await post(`http://${proxy}`, '/admin/pair', JSON.stringify({ code: `GUESS00${i}` }), headers)).status);
    expect(statuses.at(-1)).toBe(429);
    expect(s.adminAuth.pairingPending).toBe(false);
  });
});

describe('DNS rebinding e Host spoofing', () => {
  it.each([
    ['domínio do atacante (rebinding)', 'rebind.attacker.example'],
    ['subdomínio do host público (sem curingas)', `evil.${PUBLIC}`],
    ['sufixo enganoso', `${PUBLIC}.evil.com`],
    ['host público com porta', `${PUBLIC}:443`],
    ['host público com ponto final', `${PUBLIC}.`],
  ])('Host %s → 421', async (_name, host) => {
    const s = await server({ publicHostnames: [PUBLIC] });
    const port = new URL(s.httpOrigin).port;
    expect(await get(`127.0.0.1:${port}`, { Host: host })).toBe(421);
    await expect(TestClient.open(`ws://127.0.0.1:${port}/ws`, `https://${host}`, { headers: { Host: host } })).rejects.toThrow('421');
  });

  it('Host público com caixa diferente é o mesmo nome DNS (aceito)', async () => {
    const s = await server({ publicHostnames: [PUBLIC] });
    const port = new URL(s.httpOrigin).port;
    expect(await get(`127.0.0.1:${port}`, { Host: PUBLIC.toUpperCase(), 'Cf-Access-Jwt-Assertion': issuer.jwt })).toBe(200);
  });

  it('X-Forwarded-Host, X-Forwarded-For e CF-Connecting-IP são ignorados', async () => {
    const s = await server({ publicHostnames: [PUBLIC] });
    const port = new URL(s.httpOrigin).port;
    const spoof = { 'X-Forwarded-Host': PUBLIC, 'X-Forwarded-For': '203.0.113.1', 'CF-Connecting-IP': '203.0.113.1' };
    expect(await get(`127.0.0.1:${port}`, { Host: 'rebind.attacker.example', ...spoof })).toBe(421);
    // Com Access ativo, nem Host local nem cabeçalhos de proxy dispensam o JWT.
    expect(await get(`127.0.0.1:${port}`, { Host: `localhost:${port}`, ...spoof })).toBe(403);
    expect(await get(`127.0.0.1:${port}`, { Host: `localhost:${port}`, ...spoof, 'Cf-Access-Jwt-Assertion': issuer.jwt })).toBe(200);
  });
});
