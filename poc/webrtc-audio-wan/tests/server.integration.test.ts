// Integração do servidor real (HTTP + WebSocket em 127.0.0.1, porta efêmera) com clientes "ws".
// Cobre: sessão, limite de 2, encaminhamento, desconexão/limpeza e segurança da sinalização.
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_MESSAGE_BYTES } from '../src/protocol.ts';
import { CONTENT_SECURITY_POLICY, startServer, type RunningServer } from '../server/server.ts';
import { OPERATOR_KEY, OPERATOR_KEY_HASH, TestClient, createAndInvite, fakeDist } from './helpers/ws-client.ts';

const SDP = 'v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=ice-ufrag:SEGREDO\r\n';

let server: RunningServer;
let dist: string;
let logs: string[];
let wsUrl: string;
let origin: string;
const clients: TestClient[] = [];

async function client(o: string | null = origin): Promise<TestClient> {
  const c = await TestClient.open(wsUrl, o);
  clients.push(c);
  return c;
}

async function pair() {
  const host = await client();
  const { sessionId, invite } = await createAndInvite(host);
  const guest = await client();
  guest.send({ type: 'join', invite });
  await guest.next('session');
  await host.next('peer-joined');
  return { host, guest, sessionId, invite };
}

beforeEach(async () => {
  dist = fakeDist();
  logs = [];
  server = await startServer({
    distDir: dist,
    httpPort: 0,
    heartbeatMs: 150,
    operatorKeyHash: OPERATOR_KEY_HASH,
    rateLimit: { capacity: 20, refillPerSecond: 5 },
    log: (l) => logs.push(l),
  });
  origin = server.httpOrigin;
  wsUrl = `${server.httpOrigin.replace('http', 'ws')}/ws`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await server.close();
  rmSync(dist, { recursive: true, force: true });
});

describe('HTTP estático', () => {
  it('serve index com cabeçalhos de segurança; só GET/HEAD; sem path traversal', async () => {
    const res = await fetch(`${server.httpOrigin}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('permissions-policy')).toContain('microphone=(self)');
    expect((await fetch(`${server.httpOrigin}/assets/app.js`)).status).toBe(200);
    for (const path of ['/secret.key', '/../package.json', '/%2e%2e/package.json', '/assets/../../x', '/nao-existe']) {
      expect((await fetch(`${server.httpOrigin}${path}`)).status, path).toBe(404);
    }
    expect((await fetch(`${server.httpOrigin}/`, { method: 'POST' })).status).toBe(405);
  });

  it('/api/info não existe mais (02B.2A: sem origem HTTPS local para informar)', async () => {
    const res = await fetch(`${server.httpOrigin}/api/info`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('httpsOrigin');
  });
});

describe('WebSocket: origem e caminho (segurança, teste 9)', () => {
  it('recusa upgrade sem Origin, com Origin de outro site ou em outro caminho', async () => {
    await expect(TestClient.open(wsUrl, null)).rejects.toThrow('403');
    await expect(TestClient.open(wsUrl, 'https://evil.example')).rejects.toThrow('403');
    await expect(TestClient.open(wsUrl, 'http://localhost:1')).rejects.toThrow('403');
    await expect(TestClient.open(wsUrl, 'null')).rejects.toThrow('403');
    await expect(TestClient.open(wsUrl.replace('/ws', '/outro'), origin)).rejects.toThrow('403');
    const localhostOrigin = origin.replace('127.0.0.1', 'localhost');
    // localhost é aceito quando Host e Origin são coerentes; cruzado (Host 127.0.0.1 + Origin localhost) é recusado.
    await expect(TestClient.open(wsUrl, localhostOrigin)).rejects.toThrow('403');
    const ok = await TestClient.open(wsUrl, localhostOrigin, { headers: { Host: localhostOrigin.replace('http://', '') } });
    clients.push(ok);
    expect(ok.ws.readyState).toBe(ok.ws.OPEN);
  });
});

describe('sessão via WebSocket (testes 1–4)', () => {
  it('cria, entra, encaminha sinais e recusa o terceiro', async () => {
    const { host, guest, sessionId, invite } = await pair();
    expect(sessionId).toMatch(/^[A-Za-z0-9_-]{22}$/);

    host.send({ type: 'signal', epoch: 1, payload: { kind: 'offer', sdp: SDP } });
    expect(await guest.next('signal')).toEqual({ type: 'signal', epoch: 1, payload: { kind: 'offer', sdp: SDP } });
    guest.send({ type: 'signal', epoch: 1, payload: { kind: 'answer', sdp: SDP } });
    expect((await host.next('signal'))['payload']).toEqual({ kind: 'answer', sdp: SDP });

    // O convite já foi usado (uso único) e o operador não obtém outro com a sessão cheia.
    const third = await client();
    third.send({ type: 'join', invite });
    expect(await third.next('error')).toEqual({ type: 'error', code: 'invite-invalid' });
    host.send({ type: 'invite' });
    expect(await host.next('error')).toEqual({ type: 'error', code: 'session-full' });
  });

  it('IDs de sessão são imprevisíveis (128 bits, sem repetição em 10 sessões)', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const c = await client();
      ids.add((await createAndInvite(c)).sessionId);
      c.send({ type: 'leave' });
      c.ws.terminate(); // respeita o limite de conexões simultâneas
    }
    expect(ids.size).toBe(10);
    for (const id of ids) expect(Buffer.from(id, 'base64url')).toHaveLength(16);
  });

  it('fechar a conexão do guest avisa o host; fechar a do host remove a sessão', async () => {
    const { host, guest } = await pair();
    guest.close();
    expect(await host.next('peer-left')).toEqual({ type: 'peer-left', epoch: 1 });
    host.close();
    await host.closed;
    await new Promise((r) => setTimeout(r, 50));
    expect(server.registry.sessionCount).toBe(0);
  });

  it('heartbeat derruba conexão que não responde e libera a vaga na sessão', async () => {
    const { host, guest } = await pair();
    // Pausa a leitura do socket do guest: pings deixam de ser respondidos.
    (guest.ws as unknown as { _socket: { pause(): void } })._socket.pause();
    expect(await host.next('peer-left', 3000)).toEqual({ type: 'peer-left', epoch: 1 });
  });

  it('desligar o servidor avisa os participantes e fecha as conexões', async () => {
    const { host, guest } = await pair();
    const closed = Promise.all([host.closed, guest.closed]);
    await server.close();
    expect(await host.next('session-closed')).toEqual({ type: 'session-closed', reason: 'server-shutdown' });
    expect((await closed).map((c) => c.code)).toEqual([1001, 1001]);
    server = await startServer({ distDir: dist, httpPort: 0, operatorKeyHash: OPERATOR_KEY_HASH, log: () => undefined }); // para o afterEach
  });
});

describe('validação e limites (segurança, testes 3 e 9)', () => {
  it('JSON inválido, tipo desconhecido e chaves extras → invalid-message, conexão mantida', async () => {
    const c = await client();
    for (const raw of ['{x', '{"type":"relay-audio"}', '{"type":"create","admin":true}']) {
      c.ws.send(raw);
      expect(await c.next('error')).toEqual({ type: 'error', code: 'invalid-message' });
    }
    expect(c.ws.readyState).toBe(c.ws.OPEN);
  });

  it('mensagem binária é recusada e a conexão é fechada (servidor não transporta mídia)', async () => {
    const c = await client();
    c.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    expect(await c.next('error')).toEqual({ type: 'error', code: 'invalid-message' });
    expect((await c.closed).code).toBe(1003);
  });

  it('mensagem acima de 16 KiB derruba a conexão (1009)', async () => {
    const c = await client();
    c.ws.send(JSON.stringify({ type: 'create', pad: 'x'.repeat(MAX_MESSAGE_BYTES) }));
    expect((await c.closed).code).toBe(1009);
  });

  it('rajada acima do limite → rate-limited e fechamento (1008) após reincidência', async () => {
    const c = await client();
    for (let i = 0; i < 40; i++) c.ws.send('{"type":"leave"}');
    expect(await c.next('error')).toEqual({ type: 'error', code: 'rate-limited' });
    expect((await c.closed).code).toBe(1008);
  });

  it('epoch antigo e papel trocado são rejeitados pelo servidor', async () => {
    const { host, guest } = await pair();
    host.send({ type: 'signal', epoch: 0, payload: { kind: 'offer', sdp: SDP } });
    expect(await host.next('error')).toEqual({ type: 'error', code: 'stale-epoch' });
    guest.send({ type: 'signal', epoch: 1, payload: { kind: 'offer', sdp: SDP } });
    expect(await guest.next('error')).toEqual({ type: 'error', code: 'unexpected-signal' });
  });

  it('logs do servidor não contêm SDP, ufrag, candidatos nem IDs completos', async () => {
    const { host, guest, sessionId } = await pair();
    host.send({ type: 'signal', epoch: 1, payload: { kind: 'offer', sdp: SDP } });
    await guest.next('signal');
    guest.send({
      type: 'signal',
      epoch: 1,
      payload: { kind: 'candidate', candidate: { candidate: 'candidate:1 1 udp 1 192.0.2.7 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 } },
    });
    await host.next('signal');
    const all = logs.join('\n');
    for (const secret of ['v=0', 'SEGREDO', 'candidate:', '192.0.2.7', sessionId]) expect(all).not.toContain(secret);
  });
});
