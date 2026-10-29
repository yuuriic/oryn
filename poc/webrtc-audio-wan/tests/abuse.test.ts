// Proteção contra abuso (02B.2B) no servidor real: limites independentes do IP aparente, prazo de
// admissão, falhas de autorização, concorrência de convites, rate limit com janela deslizante,
// limpeza após desconexão (nos dois listeners) e ausência de segredos nos logs.
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer, type ServerConfig } from '../server/server.ts';
import { TestClient, createAndInvite, fakeDist, pairAdmin, wsUrlOf } from './helpers/ws-client.ts';

const running: RunningServer[] = [];
const clients: TestClient[] = [];
const dirs: string[] = [];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function server(options: Partial<ServerConfig> = {}, logs?: string[]) {
  const dist = fakeDist();
  dirs.push(dist);
  const s = await startServer({
    distDir: dist,
    httpPort: 0,
    adminPort: 0,
    log: (l) => logs?.push(l),
    ...options,
  });
  running.push(s);
  const url = wsUrlOf(s.httpOrigin);
  const adminUrl = wsUrlOf(s.adminOrigin!);
  const token = await pairAdmin(s);
  /** Conexão no listener de sinalização (convidados). */
  const open = async () => {
    const c = await TestClient.open(url, s.httpOrigin);
    clients.push(c);
    return c;
  };
  /** Conexão no listener administrativo (operador). */
  const openAdmin = async () => {
    const c = await TestClient.open(adminUrl, s.adminOrigin);
    clients.push(c);
    return c;
  };
  return { s, open, openAdmin, url, adminUrl, token };
}

describe('limites de sessões e conexões', () => {
  it('máximo de sessões (padrão 3) → server-busy', async () => {
    const { openAdmin, token } = await server();
    for (let i = 0; i < 3; i++) await createAndInvite(await openAdmin(), token);
    const extra = await openAdmin();
    extra.send({ type: 'create', operatorKey: token });
    expect(await extra.next('error')).toEqual({ type: 'error', code: 'server-busy' });
  });

  it('máximo de conexões simultâneas → 503; liberar uma conexão reabre a vaga', async () => {
    const { s, open, url } = await server({ maxConnections: 2 });
    const a = await open();
    await open();
    await expect(TestClient.open(url, s.httpOrigin)).rejects.toThrow('503');
    a.ws.terminate();
    await a.closed;
    await wait(20);
    await open();
  });

  it('o limite de conexões é global: somado entre os dois listeners', async () => {
    const { s, open, openAdmin, url, adminUrl } = await server({ maxConnections: 2 });
    await openAdmin();
    await open();
    await expect(TestClient.open(url, s.httpOrigin)).rejects.toThrow('503');
    await expect(TestClient.open(adminUrl, s.adminOrigin)).rejects.toThrow('503');
  });
});

describe('prazo de admissão', () => {
  it('conexão que não entra numa sessão é encerrada (1008); conexão admitida permanece', async () => {
    const { open, openAdmin, token } = await server({ admissionTimeoutMs: 200, heartbeatMs: 50 });
    const idle = await open();
    const idleAdmin = await openAdmin();
    const operator = await openAdmin();
    await createAndInvite(operator, token);
    expect((await idleAdmin.closed).code).toBe(1008); // o listener administrativo também tem prazo
    expect((await idle.closed).code).toBe(1008);
    await wait(150);
    expect(operator.ws.readyState).toBe(operator.ws.OPEN);
  });

  it('quem sai da sessão e fica conectado sem sessão também é encerrado', async () => {
    const { openAdmin, token } = await server({ admissionTimeoutMs: 200, heartbeatMs: 50 });
    const operator = await openAdmin();
    await createAndInvite(operator, token);
    await wait(300);
    expect(operator.ws.readyState).toBe(operator.ws.OPEN);
    operator.send({ type: 'leave' });
    expect((await operator.closed).code).toBe(1008);
  });
});

describe('falhas de autorização', () => {
  it('3 falhas na mesma conexão encerram a conexão (1008)', async () => {
    const { open } = await server();
    const attacker = await open();
    for (let i = 0; i < 3; i++) attacker.send({ type: 'join', invite: `${'A'.repeat(42)}${i}` });
    expect((await attacker.closed).code).toBe(1008);
  });

  it('tokens administrativos errados no listener administrativo: 3 falhas encerram a conexão', async () => {
    const { openAdmin } = await server();
    const c = await openAdmin();
    for (let i = 0; i < 3; i++) c.send({ type: 'create', operatorKey: 'W'.repeat(43) });
    expect((await c.closed).code).toBe(1008);
  });

  it('token administrativo válido no listener de sinalização: unauthorized e contado como falha', async () => {
    const { open, token } = await server();
    const c = await open();
    for (let i = 0; i < 2; i++) {
      c.send({ type: 'create', operatorKey: token });
      expect(await c.next('error')).toEqual({ type: 'error', code: 'unauthorized' });
    }
    c.send({ type: 'rejoin', sessionId: 'S'.repeat(22), operatorKey: token });
    expect((await c.closed).code).toBe(1008);
  });
});

describe('concorrência no consumo do mesmo convite', () => {
  it('vários clientes enviam o mesmo convite ao mesmo tempo: exatamente um entra', async () => {
    const { open, openAdmin, token } = await server({ maxConnections: 10 });
    const operator = await openAdmin();
    const { invite } = await createAndInvite(operator, token);
    const contenders = await Promise.all(Array.from({ length: 6 }, () => open()));
    for (const c of contenders) c.send({ type: 'join', invite });
    const outcomes = await Promise.all(contenders.map((c) => c.next((m) => m.type === 'session' || m.type === 'error')));
    expect(outcomes.filter((m) => m.type === 'session')).toHaveLength(1);
    expect(outcomes.filter((m) => m['code'] === 'invite-invalid')).toHaveLength(5);
  });
});

describe('frequência de mensagens (janela deslizante)', () => {
  it('violações espaçadas além da janela não encerram; 3 dentro da janela encerram', async () => {
    const { open } = await server({ rateLimit: { capacity: 1, refillPerSecond: 1, violationWindowMs: 300 } });
    const c = await open();
    const burst = () => {
      c.ws.send('{"type":"leave"}');
      c.ws.send('{"type":"leave"}'); // a segunda excede a capacidade → 1 violação
    };
    for (let i = 0; i < 3; i++) {
      burst();
      expect((await c.next('error'))['code']).toBe('rate-limited');
      await wait(1100); // repõe o token e sai da janela de 300 ms
    }
    expect(c.ws.readyState).toBe(c.ws.OPEN);
    for (let i = 0; i < 3; i++) c.ws.send('{"type":"leave"}');
    c.ws.send('{"type":"leave"}');
    expect((await c.closed).code).toBe(1008);
  });
});

describe('desconexão e limpeza', () => {
  it('quando todos saem, a sessão e os convites somem; o heartbeat do servidor segue sem resíduos', async () => {
    const { s, open, openAdmin, token } = await server();
    const operator = await openAdmin();
    const { invite } = await createAndInvite(operator, token);
    const guest = await open();
    guest.send({ type: 'join', invite });
    await guest.next('session');
    guest.ws.terminate();
    await operator.next('peer-left');
    operator.send({ type: 'invite' });
    await operator.next('invite');
    expect(s.admission.activeInvites).toBe(1);
    operator.ws.terminate();
    await operator.closed;
    await wait(30);
    expect(s.registry.sessionCount).toBe(0);
    expect(s.admission.activeInvites).toBe(0);
  });
});

describe('logs', () => {
  it('não contêm o token administrativo, convites nem IDs completos; recusas de upgrade são amostradas', async () => {
    const logs: string[] = [];
    const { s, open, openAdmin, url, token } = await server({}, logs);
    const operator = await openAdmin();
    const { sessionId, invite } = await createAndInvite(operator, token);
    const bad = await openAdmin();
    bad.send({ type: 'create', operatorKey: 'W'.repeat(43) });
    await bad.next('error');
    for (let i = 0; i < 30; i++) await expect(TestClient.open(url, 'https://evil.example')).rejects.toThrow('403');
    const all = logs.join('\n');
    for (const secret of [token, invite, sessionId, 'W'.repeat(43)]) expect(all).not.toContain(secret);
    expect(logs.filter((l) => l.includes('upgrade recusado')).length).toBeLessThanOrEqual(1);
    expect(s.registry.sessionCount).toBe(1);
  });
});
