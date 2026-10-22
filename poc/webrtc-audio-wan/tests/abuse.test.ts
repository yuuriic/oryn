// Proteção contra abuso (02B.2B) no servidor real: limites independentes do IP aparente, prazo de
// admissão, falhas de autorização, bloqueio do operador, concorrência de convites, rate limit com
// janela deslizante, limpeza após desconexão e ausência de segredos nos logs.
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer, type ServerConfig } from '../server/server.ts';
import { OPERATOR_KEY, OPERATOR_KEY_HASH, TestClient, createAndInvite, fakeDist } from './helpers/ws-client.ts';

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
    operatorKeyHash: OPERATOR_KEY_HASH,
    log: (l) => logs?.push(l),
    ...options,
  });
  running.push(s);
  const url = `ws://127.0.0.1:${new URL(s.httpOrigin).port}/ws`;
  const open = async () => {
    const c = await TestClient.open(url, s.httpOrigin);
    clients.push(c);
    return c;
  };
  return { s, open, url };
}

describe('limites de sessões e conexões', () => {
  it('máximo de sessões (padrão 3) → server-busy', async () => {
    const { open } = await server();
    for (let i = 0; i < 3; i++) await createAndInvite(await open());
    const extra = await open();
    extra.send({ type: 'create', operatorKey: OPERATOR_KEY });
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
});

describe('prazo de admissão', () => {
  it('conexão que não entra numa sessão é encerrada (1008); conexão admitida permanece', async () => {
    const { open } = await server({ admissionTimeoutMs: 200, heartbeatMs: 50 });
    const idle = await open();
    const operator = await open();
    await createAndInvite(operator);
    expect((await idle.closed).code).toBe(1008);
    await wait(150);
    expect(operator.ws.readyState).toBe(operator.ws.OPEN);
  });

  it('quem sai da sessão e fica conectado sem sessão também é encerrado', async () => {
    const { open } = await server({ admissionTimeoutMs: 200, heartbeatMs: 50 });
    const operator = await open();
    await createAndInvite(operator);
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

  it('5 chaves erradas (em várias conexões) bloqueiam o operador; a chave certa recebe "locked"', async () => {
    const { open } = await server();
    for (let round = 0; round < 2; round++) {
      const c = await open();
      for (let i = 0; i < (round === 0 ? 3 : 2); i++) {
        c.send({ type: 'create', operatorKey: 'W'.repeat(43) });
        expect((await c.next('error'))['code']).toBe('unauthorized');
      }
    }
    const operator = await open();
    operator.send({ type: 'create', operatorKey: OPERATOR_KEY });
    expect(await operator.next('error')).toEqual({ type: 'error', code: 'locked' });
  });
});

describe('concorrência no consumo do mesmo convite', () => {
  it('vários clientes enviam o mesmo convite ao mesmo tempo: exatamente um entra', async () => {
    const { open } = await server({ maxConnections: 10 });
    const operator = await open();
    const { invite } = await createAndInvite(operator);
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
    const { s, open } = await server();
    const operator = await open();
    const { invite } = await createAndInvite(operator);
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
  it('não contêm a chave do operador, convites nem IDs completos; recusas de upgrade são amostradas', async () => {
    const logs: string[] = [];
    const { s, open, url } = await server({}, logs);
    const operator = await open();
    const { sessionId, invite } = await createAndInvite(operator);
    const bad = await open();
    bad.send({ type: 'create', operatorKey: 'W'.repeat(43) });
    await bad.next('error');
    for (let i = 0; i < 30; i++) await expect(TestClient.open(url, 'https://evil.example')).rejects.toThrow('403');
    const all = logs.join('\n');
    for (const secret of [OPERATOR_KEY, invite, sessionId, 'W'.repeat(43)]) expect(all).not.toContain(secret);
    expect(logs.filter((l) => l.includes('upgrade recusado')).length).toBeLessThanOrEqual(1);
    expect(s.registry.sessionCount).toBe(1);
  });
});
