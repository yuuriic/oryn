// Fronteira de confiança da integração Cloudflare, OFFLINE (02B.3B): borda + cloudflared simulados por um
// proxy local (helpers/tunnel.ts), Access obrigatório na origem, emissor de JWT de teste. Cobre túnel
// apontado para 5281, Host reescrito, hostname desconhecido, Origin incompatível, JWT ausente/expirado/
// inválido/de outra aplicação, cabeçalhos de proxy, WebSocket não autenticado e convites inválidos.
import { rmSync } from 'node:fs';
import http from 'node:http';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { preflight } from '../server/cloudflare-preflight.ts';
import { startServer, type RunningServer } from '../server/server.ts';
import { AUD, accessConfig, newKey, testIssuer, token, type TestKey } from './helpers/access.ts';
import { startTunnel, type Tunnel, type TunnelOptions } from './helpers/tunnel.ts';
import { TestClient, createAndInvite, fakeDist, openOperator, pairAdmin, post } from './helpers/ws-client.ts';

const PUBLIC = 'oryn-poc.example.com';
let issuer: Awaited<ReturnType<typeof testIssuer>>;
let attacker: TestKey;
const cleanup: (() => Promise<void> | void)[] = [];
const clients: TestClient[] = [];

beforeAll(async () => {
  issuer = await testIssuer();
  attacker = await newKey(issuer.key.kid); // mesmo kid, outra chave
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function server(): Promise<RunningServer> {
  const dist = fakeDist();
  const s = await startServer({ distDir: dist, httpPort: 0, adminPort: 0, publicHostnames: [PUBLIC], ...issuer.server, log: () => undefined });
  cleanup.push(() => rmSync(dist, { recursive: true, force: true }), () => s.close());
  return s;
}

async function tunnel(options: TunnelOptions): Promise<Tunnel> {
  const t = await startTunnel(options);
  cleanup.push(() => t.close());
  return t;
}

const portOf = (origin: string): number => Number(new URL(origin).port);

function get(address: string, path = '/'): Promise<number> {
  const [host, port] = address.split(':');
  return new Promise((resolve, reject) => {
    http.get({ host, port, path }, (res) => (res.resume(), resolve(res.statusCode ?? 0))).on('error', reject);
  });
}

/** Abre WebSocket pelo túnel; devolve o cliente ou o status HTTP da recusa. */
async function ws(address: string, origin: string): Promise<TestClient | string> {
  try {
    const c = await TestClient.open(`ws://${address}/ws`, origin);
    clients.push(c);
    return c;
  } catch (error) {
    return (error as Error).message;
  }
}

describe('túnel correto (5280, Host público preservado, JWT injetado)', () => {
  it('página, WebSocket e entrada por convite funcionam; convite reutilizado e inválido são recusados', async () => {
    const s = await server();
    const t = await tunnel({ targetPort: portOf(s.httpOrigin), host: PUBLIC, jwt: issuer.jwt });
    expect(await get(t.address)).toBe(200);
    const { client: operator, token: admin } = await openOperator(s);
    clients.push(operator);
    const { invite } = await createAndInvite(operator, admin);
    const guest = await ws(t.address, `https://${PUBLIC}`);
    if (typeof guest === 'string') throw new Error(guest);
    guest.send({ type: 'join', invite });
    expect((await guest.next('session'))['role']).toBe('guest');
    const reuse = await ws(t.address, `https://${PUBLIC}`);
    if (typeof reuse === 'string') throw new Error(reuse);
    reuse.send({ type: 'join', invite });
    expect(await reuse.next('error')).toEqual({ type: 'error', code: 'invite-invalid' });
    reuse.send({ type: 'join', invite: 'Q'.repeat(43) });
    expect(await reuse.next('error')).toEqual({ type: 'error', code: 'invite-invalid' });
  });
});

describe('JWT na borda', () => {
  it('ausente, expirado, assinado por outra chave, de outra aplicação ou de outra equipe → 403 em HTTP e WebSocket', async () => {
    const s = await server();
    const bad: [string, string | null][] = [
      ['ausente (borda sem Access)', null],
      ['expirado', await token(issuer.key, { expiresInSec: -120 })],
      ['outra chave, mesmo kid', await token(attacker)],
      ['AUD de outra aplicação', await token(issuer.key, { claims: { aud: ['c'.repeat(64)] } })],
      ['outra equipe', await token(issuer.key, { claims: { iss: 'https://outra.cloudflareaccess.com' } })],
    ];
    for (const [name, jwt] of bad) {
      const t = await tunnel({ targetPort: portOf(s.httpOrigin), host: PUBLIC, jwt });
      expect(await get(t.address), name).toBe(403);
      expect(await ws(t.address, `https://${PUBLIC}`), name).toMatch(/403/);
    }
    expect(AUD).not.toBe('c'.repeat(64));
  });

  it('cabeçalhos de proxy e de "autorização" forjados não substituem o JWT', async () => {
    const s = await server();
    const admin = await pairAdmin(s);
    const t = await tunnel({
      targetPort: portOf(s.httpOrigin),
      host: PUBLIC,
      jwt: null,
      extraHeaders: {
        'x-forwarded-host': `localhost:${portOf(s.adminOrigin!)}`,
        forwarded: 'for=127.0.0.1;host=localhost;proto=http',
        'x-original-host': 'localhost',
        'x-real-ip': '127.0.0.1',
        authorization: `Bearer ${admin}`,
        cookie: `CF_Authorization=${issuer.jwt}`,
        'x-oryn-admin': '1',
      },
    });
    expect(await get(t.address)).toBe(403);
    expect(await ws(t.address, `https://${PUBLIC}`)).toMatch(/403/);
  });
});

describe('Host e Origin', () => {
  it('hostname desconhecido (mesmo com JWT válido) → 421', async () => {
    const s = await server();
    const t = await tunnel({ targetPort: portOf(s.httpOrigin), host: 'desconhecido.example.net', jwt: issuer.jwt });
    expect(await get(t.address)).toBe(421);
    expect(await ws(t.address, 'https://desconhecido.example.net')).toMatch(/421/);
  });

  it('Origin incompatível pelo túnel correto → 403', async () => {
    const s = await server();
    const t = await tunnel({ targetPort: portOf(s.httpOrigin), host: PUBLIC, jwt: issuer.jwt });
    for (const origin of ['https://evil.example', `http://${PUBLIC}`, 'null', `https://evil.${PUBLIC}`]) {
      expect(await ws(t.address, origin), origin).toMatch(/403/);
    }
  });

  it('Host reescrito para localhost:5280 → o navegador (Origin público) é recusado e nada administrativo existe', async () => {
    const s = await server();
    const local = `localhost:${portOf(s.httpOrigin)}`;
    const t = await tunnel({ targetPort: portOf(s.httpOrigin), host: local, jwt: issuer.jwt });
    expect(await ws(t.address, `https://${PUBLIC}`)).toMatch(/403/); // Origin do navegador não casa com o Host reescrito
    const { code } = s.adminAuth.issuePairingCode();
    const reply = await post(`http://${t.address}`, '/admin/pair', JSON.stringify({ code }), {
      Origin: `http://${local}`,
      'Content-Type': 'application/json',
      'X-Oryn-Admin': '1',
    });
    expect(reply.status).toBe(405);
    expect(s.adminAuth.pairingPending).toBe(true);
  });

  it('túnel apontado para 5281: com Host público → 421; com Host reescrito → Origin do navegador recusado', async () => {
    const s = await server();
    const adminPort = portOf(s.adminOrigin!);
    const misrouted = await tunnel({ targetPort: adminPort, host: PUBLIC, jwt: issuer.jwt });
    expect(await get(misrouted.address)).toBe(421);
    expect(await ws(misrouted.address, `https://${PUBLIC}`)).toMatch(/421/);
    const rewritten = await tunnel({ targetPort: adminPort, host: `localhost:${adminPort}`, jwt: issuer.jwt });
    expect(await ws(rewritten.address, `https://${PUBLIC}`)).toMatch(/403/);
    const { code } = s.adminAuth.issuePairingCode();
    const pair = await post(`http://${rewritten.address}`, '/admin/pair', JSON.stringify({ code }), {
      Origin: `https://${PUBLIC}`,
      'Content-Type': 'application/json',
      'X-Oryn-Admin': '1',
    });
    expect(pair.status).toBe(403);
    expect(s.adminAuth.pairingPending).toBe(true);
  });
});

describe('nenhuma configuração de proxy transforma conexão pública em operação administrativa', () => {
  it('matriz destino × Host × JWT × Origin: sem token administrativo, create nunca é autorizado', async () => {
    const s = await server();
    const signal = portOf(s.httpOrigin);
    const admin = portOf(s.adminOrigin!);
    const hosts = (target: number) => [PUBLIC, `localhost:${target}`, `127.0.0.1:${target}`, `localhost:${target === signal ? admin : signal}`];
    let opened = 0;
    const refusals: string[] = [];
    for (const target of [signal, admin]) {
      for (const host of hosts(target)) {
        for (const jwt of [issuer.jwt, null]) {
          const t = await tunnel({ targetPort: target, host, jwt });
          for (const origin of [`https://${PUBLIC}`, `http://${host}`]) {
            const c = await ws(t.address, origin);
            if (typeof c === 'string') {
              refusals.push(c);
              continue;
            }
            opened += 1;
            c.send({ type: 'create', operatorKey: 'R'.repeat(43) });
            expect(await c.next('error'), `${target} ${host} ${origin}`).toEqual({ type: 'error', code: 'unauthorized' });
            c.ws.terminate();
            await c.closed;
          }
        }
      }
    }
    expect(s.registry.sessionCount).toBe(0);
    expect(opened).toBeGreaterThan(0);
    // Toda recusa veio da política (Host/Origin/Access), nunca do teto de conexões.
    for (const r of refusals) expect(r).toMatch(/HTTP (403|421)/);
    expect(opened + refusals.length).toBe(32);
  });

  it('com token administrativo vazado, só o túnel PROIBIDO (5281 + Host reescrito) o aceitaria — e a pré-validação recusa essa configuração', async () => {
    const s = await server();
    const leaked = await pairAdmin(s);
    const signal = portOf(s.httpOrigin);
    const admin = portOf(s.adminOrigin!);
    const accepted: string[] = [];
    const variants: [number, string][] = [
      [signal, PUBLIC],
      [signal, `localhost:${signal}`],
      [admin, PUBLIC],
      [admin, `localhost:${admin}`],
    ];
    for (const [target, host] of variants) {
      const t = await tunnel({ targetPort: target, host, jwt: issuer.jwt });
      for (const origin of [`https://${PUBLIC}`, `http://${host}`]) {
        const c = await ws(t.address, origin);
        if (typeof c === 'string') continue;
        c.send({ type: 'create', operatorKey: leaked });
        const reply = await c.next((m) => m.type === 'session' || m.type === 'error');
        if (reply.type === 'session') accepted.push(`${target === admin ? 'admin' : 'signal'} ${host} ${origin}`);
        c.ws.terminate();
        await c.closed;
      }
    }
    expect(accepted).toEqual([`admin localhost:${admin} http://localhost:${admin}`]);

    // A configuração equivalente do cloudflared é bloqueada antes da ativação.
    const cfg = {
      tunnel: '6f1d2c3b-4a59-4e8f-9a7b-1c2d3e4f5a6b',
      'credentials-file': '/fora/do/repo/x.json',
      ingress: [
        {
          hostname: PUBLIC,
          service: `http://127.0.0.1:${admin}`,
          originRequest: { httpHostHeader: `localhost:${admin}`, access: { required: true, teamName: 'oryn-test', audTag: [AUD] } },
        },
        { service: 'http_status:404' },
      ],
    };
    const report = preflight({
      mode: 'template',
      configText: stringify(cfg),
      env: { ORYN_PUBLIC_HOSTNAMES: PUBLIC, ORYN_ACCESS_MODE: 'required', ORYN_ACCESS_TEAM_DOMAIN: accessConfig().teamDomain, ORYN_ACCESS_AUD: AUD },
      repoRoot: process.cwd(),
      configPath: 'x',
      signalPort: signal,
      adminPort: admin,
      readFile: () => null,
      isTrackedOrUnignored: () => false,
    });
    expect(report.errors.map((e) => e.id)).toEqual(expect.arrayContaining(['CFG_SERVICE', 'CFG_ADMIN_PORT', 'CFG_HOST_HEADER']));
  });
});
