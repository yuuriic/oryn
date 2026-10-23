// Diagnóstico operacional LOCAL (POC-02B.5): sobe o servidor real em portas efêmeras de 127.0.0.1, com
// emissor Access SIMULADO, túnel SIMULADO e provedor TURN com transporte SIMULADO, e verifica as respostas
// HTTP/WebSocket, rejeições Access, falhas/timeout do provedor TURN, indisponibilidade do JWKS, revogação e
// sanitização dos logs.
//
// Nenhuma rede pública, nenhum túnel real, nenhuma credencial real, nenhuma porta fora do loopback.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { findSensitive } from '../src/evidence.ts';
import { startServer, type RunningServer } from './server.ts';
import { AUD, FakeJwks, TEAM, hang, newKey, token, type TestKey } from './sim/access-issuer.ts';
import { startTunnel, type Tunnel } from './sim/tunnel.ts';
import { CloudflareTurnProvider } from './turn.ts';

export type DiagnosticStatus = 'PASS' | 'FAIL';
export interface DiagnosticResult {
  id: string;
  area: string;
  cenario: string;
  status: DiagnosticStatus;
  /** Observado (status HTTP, código de erro); nunca segredos. */
  observado: string;
}

const PUBLIC = 'oryn-diagnostico.example.com';

/** Provedor TURN com transporte simulado no formato documentado da Cloudflare (sem rede). */
class FakeTurnApi {
  mode: 'ok' | 'fail' | 'hang' = 'ok';
  issued = 0;
  revoked = 0;
  readonly fetch = (url: string, init: RequestInit): Promise<Response> => {
    if (url.endsWith('/revoke')) {
      this.revoked += 1;
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (this.mode === 'fail') return Promise.resolve(new Response('{}', { status: 500 }));
    if (this.mode === 'hang') return hang(init);
    this.issued += 1;
    return Promise.resolve(
      Response.json(
        {
          iceServers: [
            { urls: ['stun:stun.cloudflare.com:3478'] },
            {
              urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp', 'turn:turn.cloudflare.com:53?transport=udp'],
              username: `diag-user-${this.issued}`,
              credential: `diag-cred-${this.issued}-segredo`,
            },
          ],
        },
        { status: 201 },
      ),
    );
  };
}

interface WsOutcome {
  status: number | 'open';
  ws?: WebSocket;
  inbox: Record<string, unknown>[];
}

function openWs(address: string, origin: string, headers: Record<string, string> = {}): Promise<WsOutcome> {
  return new Promise((resolve) => {
    const inbox: Record<string, unknown>[] = [];
    const ws = new WebSocket(`ws://${address}/ws`, { origin, headers });
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString()) as Record<string, unknown>));
    ws.once('open', () => resolve({ status: 'open', ws, inbox }));
    ws.once('unexpected-response', (_req, res) => resolve({ status: res.statusCode ?? 0, inbox }));
    ws.once('error', () => resolve({ status: 0, inbox }));
  });
}

async function next(o: WsOutcome, type: string, timeoutMs = 3000): Promise<Record<string, unknown> | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const i = o.inbox.findIndex((m) => m['type'] === type);
    if (i >= 0) return o.inbox.splice(i, 1)[0]!;
    await new Promise((r) => setTimeout(r, 10));
  }
  return null;
}

function httpStatus(address: string, path: string, method = 'GET', headers: Record<string, string> = {}, body = ''): Promise<{ status: number; body: string }> {
  const [host, port] = address.split(':');
  return new Promise((resolve) => {
    const req = http.request({ host, port, path, method, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8').on('data', (c: string) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end(body);
  });
}

export async function runDiagnostics(): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = [];
  const add = (id: string, area: string, cenario: string, ok: boolean, observado: string): void => {
    results.push({ id, area, cenario, status: ok ? 'PASS' : 'FAIL', observado });
  };
  const cleanup: (() => Promise<void> | void)[] = [];
  const logs: string[] = [];
  const dist = mkdtempSync(join(tmpdir(), 'oryn-diag-'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>diagnóstico</title>');
  cleanup.push(() => rmSync(dist, { recursive: true, force: true }));

  try {
    const key: TestKey = await newKey('kid-diag');
    const attacker: TestKey = await newKey('kid-diag'); // mesmo kid, outra chave
    const jwks = new FakeJwks();
    jwks.publish(key);
    const jwt = await token(key, { expiresInSec: 3600 });
    const turnApi = new FakeTurnApi();
    const provider = new CloudflareTurnProvider({ keyId: 'diagkey0123456789', apiToken: 'DIAG-TOKEN-0123456789abcdef', fetch: turnApi.fetch, timeoutMs: 300 });
    const server: RunningServer = await startServer({
      distDir: dist,
      httpPort: 0,
      adminPort: 0,
      publicHostnames: [PUBLIC],
      access: { teamDomain: TEAM, audience: AUD },
      accessFetch: jwks.fetch,
      ice: { provider, minIntervalMs: 0 },
      log: (l) => logs.push(l),
    });
    cleanup.push(() => server.close());
    const signalPort = Number(new URL(server.httpOrigin).port);
    const tunnel = async (jwtValue: string | null, host = PUBLIC, targetPort = signalPort): Promise<Tunnel> => {
      const t = await startTunnel({ targetPort, host, jwt: jwtValue });
      cleanup.push(() => t.close());
      return t;
    };
    const good = await tunnel(jwt);
    const none = await tunnel(null);
    const origin = `https://${PUBLIC}`;

    // ---------- Access (HTTP) ----------
    const noneStatus = (await httpStatus(none.address, '/')).status;
    add('D-A1', 'Access HTTP', 'sem JWT → recusado', noneStatus === 403, `HTTP ${noneStatus}`);
    const okStatus = (await httpStatus(good.address, '/')).status;
    add('D-A2', 'Access HTTP', 'JWT válido → página', okStatus === 200, `HTTP ${okStatus}`);
    for (const [id, cenario, bad] of [
      ['D-A3', 'JWT expirado → recusado', await token(key, { expiresInSec: -120 })],
      ['D-A4', 'AUD de outra aplicação → recusado', await token(key, { claims: { aud: ['f'.repeat(64)] } })],
      ['D-A5', 'assinatura de outra chave (mesmo kid) → recusado', await token(attacker)],
      ['D-A6', 'emissor de outra equipe → recusado', await token(key, { claims: { iss: 'https://outra.cloudflareaccess.com' } })],
    ] as const) {
      const t = await tunnel(bad);
      const st = (await httpStatus(t.address, '/')).status;
      add(id, 'Access HTTP', cenario, st === 403, `HTTP ${st}`);
    }

    // ---------- Access (WebSocket) e Host/Origin ----------
    const wsNone = await openWs(none.address, origin);
    add('D-W1', 'Access WebSocket', 'upgrade sem JWT → recusado', wsNone.status === 403, `upgrade ${wsNone.status}`);
    const wsOk = await openWs(good.address, origin);
    add('D-W2', 'Access WebSocket', 'upgrade com JWT válido → aceito', wsOk.status === 'open', `upgrade ${wsOk.status}`);
    wsOk.ws?.terminate();
    const wsOrigin = await openWs(good.address, 'https://evil.example');
    add('D-W3', 'Host/Origin', 'Origin incompatível (com JWT válido) → recusado', wsOrigin.status === 403, `upgrade ${wsOrigin.status}`);
    const unknownHost = await tunnel(jwt, 'desconhecido.example.net');
    const wsHost = await openWs(unknownHost.address, 'https://desconhecido.example.net');
    add('D-W4', 'Host/Origin', 'hostname desconhecido (com JWT válido) → recusado', wsHost.status === 421, `upgrade ${wsHost.status}`);
    const toAdmin = await tunnel(jwt, PUBLIC, Number(new URL(server.adminOrigin!).port));
    const adminStatus = (await httpStatus(toAdmin.address, '/')).status;
    add('D-W5', 'Host/Origin', 'túnel apontado por engano para 5281 com Host público → recusado', adminStatus === 421, `HTTP ${adminStatus}`);

    // ---------- operações administrativas pelo túnel ----------
    const { code } = server.adminAuth.issuePairingCode();
    const adminOrigin = server.adminOrigin!;
    const adminAddr = adminOrigin.replace('http://', '');
    const pairHeaders = { Host: adminAddr, Origin: adminOrigin, 'Content-Type': 'application/json', 'X-Oryn-Admin': '1' };
    const pairViaTunnel = await httpStatus(good.address, '/admin/pair', 'POST', { Origin: origin, 'Content-Type': 'application/json', 'X-Oryn-Admin': '1' }, JSON.stringify({ code }));
    add('D-B1', 'Administração', 'POST /admin/pair pelo túnel → recusado', pairViaTunnel.status === 405 && server.adminAuth.pairingPending, `HTTP ${pairViaTunnel.status}`);
    const paired = await httpStatus(adminAddr, '/admin/pair', 'POST', pairHeaders, JSON.stringify({ code }));
    const adminToken = (JSON.parse(paired.body || '{}') as { token?: string }).token ?? '';
    const intruder = await openWs(good.address, origin);
    intruder.ws?.send(JSON.stringify({ type: 'create', operatorKey: adminToken }));
    const intruderReply = await next(intruder, 'error');
    add('D-B2', 'Administração', 'create pelo túnel com token administrativo válido → recusado', intruderReply?.['code'] === 'unauthorized', `erro ${String(intruderReply?.['code'])}`);
    intruder.ws?.terminate();

    // ---------- convites ----------
    const operator = await openWs(adminAddr, adminOrigin);
    operator.ws?.send(JSON.stringify({ type: 'create', operatorKey: adminToken }));
    await next(operator, 'session');
    const invite = String((await next(operator, 'invite'))?.['token'] ?? '');
    const guest = await openWs(good.address, origin);
    guest.ws?.send(JSON.stringify({ type: 'join', invite }));
    const guestSession = await next(guest, 'session');
    const reuse = await openWs(good.address, origin);
    reuse.ws?.send(JSON.stringify({ type: 'join', invite }));
    const reuseReply = await next(reuse, 'error');
    add('D-I1', 'Convites', 'convite reutilizado → recusado', guestSession !== null && reuseReply?.['code'] === 'invite-invalid', `erro ${String(reuseReply?.['code'])}`);
    reuse.ws?.send(JSON.stringify({ type: 'join', invite: 'Q'.repeat(43) }));
    const invalidReply = await next(reuse, 'error');
    add('D-I2', 'Convites', 'convite inválido → recusado', invalidReply?.['code'] === 'invite-invalid', `erro ${String(invalidReply?.['code'])}`);

    // ---------- TURN ----------
    const issuedBefore = turnApi.issued;
    reuse.ws?.send(JSON.stringify({ type: 'ice-request', mode: 'relay' }));
    const unauth = await next(reuse, 'error');
    add('D-T1', 'TURN', 'pedido de credenciais sem admissão → recusado, provedor não chamado', unauth?.['code'] === 'unauthorized' && turnApi.issued === issuedBefore, `erro ${String(unauth?.['code'])}`);
    reuse.ws?.terminate();
    guest.ws?.send(JSON.stringify({ type: 'ice-request', mode: 'relay-tls' }));
    const config = await next(guest, 'ice-config');
    const urls = ((config?.['iceServers'] as { urls: string[] }[] | undefined) ?? []).flatMap((s) => s.urls);
    add('D-T2', 'TURN', 'admitido recebe credenciais temporárias com endpoint turns: (relay-tls)', urls.some((u) => u.startsWith('turns:')), `${urls.filter((u) => u.startsWith('turns:')).length} URL(s) turns:`);
    add('D-T3', 'TURN', 'URLs da porta 53 removidas', urls.length > 0 && !urls.some((u) => /:53(\?|$)/.test(u)), `${urls.length} URL(s), nenhuma na porta 53`);
    turnApi.mode = 'fail';
    operator.ws?.send(JSON.stringify({ type: 'ice-request', mode: 'relay' }));
    const failReply = await next(operator, 'error');
    add('D-T4', 'TURN', 'provedor com erro → turn-unavailable (sem credencial fictícia)', failReply?.['code'] === 'turn-unavailable', `erro ${String(failReply?.['code'])}`);
    turnApi.mode = 'hang';
    const hangStart = Date.now();
    operator.ws?.send(JSON.stringify({ type: 'ice-request', mode: 'relay' }));
    const hangReply = await next(operator, 'error', 5000);
    add('D-T5', 'TURN', 'provedor sem resposta → turn-unavailable dentro do prazo', hangReply?.['code'] === 'turn-unavailable' && Date.now() - hangStart < 3000, `erro ${String(hangReply?.['code'])} em ${Date.now() - hangStart} ms`);
    turnApi.mode = 'ok';
    const revokedBefore = turnApi.revoked;
    guest.ws?.terminate();
    await new Promise((r) => setTimeout(r, 100));
    add('D-T6', 'TURN', 'desconexão revoga a credencial emitida', turnApi.revoked > revokedBefore, `${turnApi.revoked - revokedBefore} revogação(ões)`);
    operator.ws?.terminate();

    // ---------- JWKS indisponível / lento (servidores separados) ----------
    for (const [id, cenario, fetchImpl, timeoutMs] of [
      ['D-J1', 'JWKS indisponível → 503 (nunca libera)', () => Promise.reject(new TypeError('fetch failed')), 3000],
      ['D-J2', 'JWKS sem resposta → 503 dentro do prazo', (_u: string, init: RequestInit) => hang(init), 300],
    ] as const) {
      const s = await startServer({
        distDir: dist,
        httpPort: 0,
        publicHostnames: [PUBLIC],
        access: { teamDomain: TEAM, audience: AUD, jwksTimeoutMs: timeoutMs },
        accessFetch: fetchImpl,
        log: (l) => logs.push(l),
      });
      cleanup.push(() => s.close());
      const t = await startTunnel({ targetPort: Number(new URL(s.httpOrigin).port), host: PUBLIC, jwt });
      cleanup.push(() => t.close());
      const started = Date.now();
      const st = (await httpStatus(t.address, '/')).status;
      add(id, 'Access HTTP', cenario, st === 503 && Date.now() - started < 5000, `HTTP ${st} em ${Date.now() - started} ms`);
    }

    // ---------- logs ----------
    const all = logs.join('\n');
    const secrets = [jwt, adminToken, invite, 'diag-user-', 'diag-cred-', 'DIAG-TOKEN', 'convidado@example.com', code].filter((s) => s !== '');
    const leaked = secrets.filter((s) => all.includes(s)).length;
    const patterns = findSensitive(all);
    add('D-L1', 'Logs', 'logs do servidor sem JWT, tokens, convites, credenciais TURN, e-mails, IPs ou URLs TURN', leaked === 0 && patterns.length === 0, leaked === 0 && patterns.length === 0 ? `${logs.length} linhas verificadas` : `${leaked} segredo(s); padrões: ${patterns.join(', ') || 'nenhum'}`);
  } catch (error) {
    add('D-X', 'Execução', 'diagnóstico executado até o fim', false, error instanceof Error ? error.name : 'erro');
  } finally {
    for (const fn of cleanup.reverse()) await Promise.resolve(fn()).catch(() => undefined);
  }
  return results;
}
