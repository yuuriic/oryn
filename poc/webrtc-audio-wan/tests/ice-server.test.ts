// Emissão de configuração ICE/TURN no servidor real (02B.4): só para participantes admitidos, pelos dois
// listeners, com Access obrigatório no público; revogação na saída, desconexão e desligamento; logs limpos.
import { rmSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer, type ServerConfig } from '../server/server.ts';
import { SimulatedTurnProvider } from '../server/turn.ts';
import { testIssuer } from './helpers/access.ts';
import { startTunnel } from './helpers/tunnel.ts';
import { TestClient, createAndInvite, fakeDist, openOperator, wsUrlOf } from './helpers/ws-client.ts';

const PUBLIC = 'oryn-poc.example.com';
const cleanup: (() => Promise<void> | void)[] = [];
const clients: TestClient[] = [];
let issuer: Awaited<ReturnType<typeof testIssuer>>;

beforeAll(async () => {
  issuer = await testIssuer();
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const flush = () => new Promise((r) => setTimeout(r, 20));

async function server(options: Partial<ServerConfig> = {}, logs?: string[]) {
  const provider = new SimulatedTurnProvider({
    turnUrls: ['turn:127.0.0.1:3478?transport=udp', 'turns:127.0.0.1:5349?transport=tcp'],
    stunUrls: ['stun:127.0.0.1:3478'],
  });
  const dist = fakeDist();
  const s = await startServer({ distDir: dist, httpPort: 0, adminPort: 0, ice: { provider }, log: (l) => logs?.push(l), ...options });
  cleanup.push(() => rmSync(dist, { recursive: true, force: true }), () => s.close());
  return { s, provider };
}

async function guestOf(s: RunningServer, operator: TestClient, token: string, url = wsUrlOf(s.httpOrigin), origin = s.httpOrigin) {
  const { invite } = await createAndInvite(operator, token);
  const guest = await TestClient.open(url, origin);
  clients.push(guest);
  guest.send({ type: 'join', invite });
  await guest.next('session');
  return guest;
}

describe('emissão somente após admissão', () => {
  it('conexão não admitida: unauthorized, provedor não é chamado; 3 tentativas encerram a conexão', async () => {
    const { s, provider } = await server();
    const c = await TestClient.open(wsUrlOf(s.httpOrigin), s.httpOrigin);
    clients.push(c);
    c.send({ type: 'ice-request', mode: 'relay' });
    expect(await c.next('error')).toEqual({ type: 'error', code: 'unauthorized' });
    c.send({ type: 'ice-request', mode: 'auto' });
    c.send({ type: 'ice-request', mode: 'relay-tls' });
    expect((await c.closed).code).toBe(1008);
    expect(provider.issued).toHaveLength(0);
  });

  it('convite inválido não abre caminho para credenciais', async () => {
    const { s, provider } = await server();
    const c = await TestClient.open(wsUrlOf(s.httpOrigin), s.httpOrigin);
    clients.push(c);
    c.send({ type: 'join', invite: 'Z'.repeat(43) });
    expect(await c.next('error')).toEqual({ type: 'error', code: 'invite-invalid' });
    c.send({ type: 'ice-request', mode: 'relay' });
    expect(await c.next('error')).toEqual({ type: 'error', code: 'unauthorized' });
    expect(provider.issued).toHaveLength(0);
  });

  it('operador (5281) e convidado (5280) admitidos recebem credenciais distintas e temporárias', async () => {
    const { s, provider } = await server();
    const { client: operator, token } = await openOperator(s);
    clients.push(operator);
    const guest = await guestOf(s, operator, token);
    operator.send({ type: 'ice-request', mode: 'relay' });
    guest.send({ type: 'ice-request', mode: 'relay-tls' });
    const a = await operator.next('ice-config');
    const b = await guest.next('ice-config');
    expect(a['mode']).toBe('relay');
    expect(b['mode']).toBe('relay-tls');
    const userOf = (m: Record<string, unknown>) => (m['iceServers'] as { username?: string }[]).find((x) => x.username)?.username;
    expect(userOf(a)).toBeDefined();
    expect(userOf(a)).not.toBe(userOf(b));
    expect(typeof a['expiresAt']).toBe('number');
    expect(provider.issued).toHaveLength(2);
  });

  it('modo direct não emite credencial TURN', async () => {
    const { s, provider } = await server();
    const { client: operator, token } = await openOperator(s);
    clients.push(operator);
    await createAndInvite(operator, token);
    operator.send({ type: 'ice-request', mode: 'direct' });
    const m = await operator.next('ice-config');
    expect(m['iceServers']).toEqual([]);
    expect(m['expiresAt']).toBeNull();
    expect(provider.issued).toHaveLength(0);
  });

  it('sem provedor TURN: relay → turn-unavailable', async () => {
    const { s } = await server({ ice: { provider: null } });
    const { client: operator, token } = await openOperator(s);
    clients.push(operator);
    await createAndInvite(operator, token);
    operator.send({ type: 'ice-request', mode: 'relay' });
    expect(await operator.next('error')).toEqual({ type: 'error', code: 'turn-unavailable' });
  });

  it('limite por conexão: pedido repetido dentro do intervalo → ice-limit', async () => {
    const { s, provider } = await server();
    const { client: operator, token } = await openOperator(s);
    clients.push(operator);
    await createAndInvite(operator, token);
    operator.send({ type: 'ice-request', mode: 'relay' });
    await operator.next('ice-config');
    operator.send({ type: 'ice-request', mode: 'relay' });
    expect(await operator.next('error')).toEqual({ type: 'error', code: 'ice-limit' });
    expect(provider.issued).toHaveLength(1);
  });
});

describe('limpeza', () => {
  it('saída da sessão (leave) e desconexão revogam as credenciais da conexão', async () => {
    const { s, provider } = await server({ admissionTimeoutMs: 60_000 });
    const { client: operator, token } = await openOperator(s);
    clients.push(operator);
    const guest = await guestOf(s, operator, token);
    guest.send({ type: 'ice-request', mode: 'relay' });
    operator.send({ type: 'ice-request', mode: 'relay' });
    await guest.next('ice-config');
    await operator.next('ice-config');
    guest.send({ type: 'leave' });
    await operator.next('peer-left');
    await flush();
    expect(provider.revoked).toHaveLength(1);
    operator.ws.terminate();
    await operator.closed;
    await flush();
    expect(provider.revoked.sort()).toEqual([...provider.issued].sort());
  });

  it('desligamento do servidor revoga tudo', async () => {
    const { s, provider } = await server();
    const { client: operator, token } = await openOperator(s);
    clients.push(operator);
    await createAndInvite(operator, token);
    operator.send({ type: 'ice-request', mode: 'auto' });
    await operator.next('ice-config');
    await s.close();
    await flush();
    expect(provider.revoked).toEqual(provider.issued);
  });

  it('configuração ICE inválida impede a partida', async () => {
    const dist = fakeDist();
    cleanup.push(() => rmSync(dist, { recursive: true, force: true }));
    await expect(startServer({ distDir: dist, httpPort: 0, ice: { provider: null, ttlSec: 60 }, log: () => undefined })).rejects.toThrow(/ttlSec/);
    await expect(startServer({ distDir: dist, httpPort: 0, ice: { provider: null, stunUrls: ['stun:x.example:53'] }, log: () => undefined })).rejects.toThrow(/STUN/);
  });
});

describe('regressão com Cloudflare Access e convite (túnel simulado)', () => {
  it('convidado autenticado pelo Access e admitido por convite recebe credenciais; sem JWT nem chega a pedir', async () => {
    const { s, provider } = await server({ publicHostnames: [PUBLIC], ...issuer.server });
    const tunnel = await startTunnel({ targetPort: Number(new URL(s.httpOrigin).port), host: PUBLIC, jwt: issuer.jwt });
    cleanup.push(() => tunnel.close());
    const { client: operator, token } = await openOperator(s);
    clients.push(operator);
    const guest = await guestOf(s, operator, token, `ws://${tunnel.address}/ws`, `https://${PUBLIC}`);
    guest.send({ type: 'ice-request', mode: 'relay-tls' });
    expect((await guest.next('ice-config'))['mode']).toBe('relay-tls');

    const noJwt = await startTunnel({ targetPort: Number(new URL(s.httpOrigin).port), host: PUBLIC, jwt: null });
    cleanup.push(() => noJwt.close());
    await expect(TestClient.open(`ws://${noJwt.address}/ws`, `https://${PUBLIC}`)).rejects.toThrow('403');
    expect(provider.issued).toHaveLength(1);
  });
});

describe('logs', () => {
  it('sem username, credential ou URLs TURN', async () => {
    const logs: string[] = [];
    const { s, provider } = await server({}, logs);
    const { client: operator, token } = await openOperator(s);
    clients.push(operator);
    await createAndInvite(operator, token);
    operator.send({ type: 'ice-request', mode: 'relay' });
    const m = await operator.next('ice-config');
    operator.ws.terminate();
    await operator.closed;
    await flush();
    const all = logs.join('\n');
    const turn = (m['iceServers'] as { username?: string; credential?: string }[]).find((x) => x.username)!;
    expect(all).toContain('credencial temporária emitida');
    expect(all).toContain('credencial revogada');
    for (const secret of [turn.username!, turn.credential!, '127.0.0.1:3478', ...provider.issued]) expect(all).not.toContain(secret);
  });
});
