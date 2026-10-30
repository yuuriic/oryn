// Revisão independente IR-2: revogar, substituir ou expirar o token administrativo encerra as conexões de host
// autorizadas por ele; nenhum convite novo depois da revogação; isolamento entre sessões preservado.
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerMessage } from '../src/protocol.ts';
import { AdminAuth } from '../server/admin-auth.ts';
import { Admission } from '../server/admission.ts';
import { SessionRegistry, type ConnectionContext, type Participant } from '../server/registry.ts';
import { startServer, type RunningServer } from '../server/server.ts';
import { TestClient, createAndInvite, fakeDist, openOperator, pairAdmin, wsUrlOf } from './helpers/ws-client.ts';

// ---------------------------------------------------------------- registro (unitário) ----------------

const ADMIN: ConnectionContext = { admin: true };
const SIGNAL: ConnectionContext = { admin: false };

class FakeParticipant implements Participant {
  readonly inbox: ServerMessage[] = [];
  closedWith: number | null = null;
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
  send(message: ServerMessage): void {
    this.inbox.push(message);
  }
  close(code: number): void {
    this.closedWith = code;
  }
  lastOf<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    return this.inbox.filter((m) => m.type === type).at(-1) as Extract<ServerMessage, { type: T }> | undefined;
  }
}

describe('registro: autorização do host acompanha a sessão administrativa (IR-2)', () => {
  let clock: number;
  let auth: AdminAuth;
  let admission: Admission;
  let registry: SessionRegistry;
  let logs: string[];
  let n: number;

  beforeEach(() => {
    clock = 1_000;
    n = 0;
    logs = [];
    auth = new AdminAuth({
      codeTtlMs: 60_000,
      maxCodeAttempts: 5,
      sessionTtlMs: 120_000,
      now: () => clock,
      newCode: () => 'ABCDEFGH',
      newToken: () => `T${String(++n).padStart(42, '0')}`,
    });
    admission = new Admission({ inviteTtlMs: 60_000, now: () => clock, randomToken: () => `I${String(++n).padStart(42, '0')}` });
    registry = new SessionRegistry({
      maxSessions: 3,
      idleTimeoutMs: 600_000,
      maxAuthFailures: 3,
      admission,
      verifyAdmin: (token) => auth.verify(token),
      adminGeneration: () => auth.activeGeneration,
      publicOrigin: null,
      now: () => clock,
      randomId: () => `S${String(++n).padStart(21, '0')}`,
      log: (e) => logs.push(e),
    });
    auth.onRevoke(() => registry.enforceAdminRevocation());
  });

  function token(): string {
    auth.issuePairingCode();
    const r = auth.pair('ABCDEFGH');
    if (!r.ok) throw new Error('pareamento falhou');
    return r.token;
  }

  function host(id: string, key: string): { p: FakeParticipant; sessionId: string; invite: string } {
    const p = new FakeParticipant(id);
    registry.handle(p, { type: 'create', operatorKey: key }, ADMIN);
    return { p, sessionId: p.lastOf('session')!.sessionId, invite: p.lastOf('invite')!.token };
  }

  it('revokeAll: host sai da sessão e a conexão é fechada (1008); o convidado é avisado e continua conectado', () => {
    const key = token();
    const h = host('h', key);
    const guest = new FakeParticipant('g');
    registry.handle(guest, { type: 'join', invite: h.invite }, SIGNAL);
    auth.revokeAll();
    expect(h.p.closedWith).toBe(1008);
    expect(registry.sessionOf(h.p)).toBeNull();
    expect(registry.inspect(h.sessionId)).toEqual({ host: false, guest: true, epoch: 1 });
    expect(guest.lastOf('peer-left')).toBeDefined();
    expect(guest.closedWith).toBeNull();
  });

  it('corrida: invite que chega depois da revogação (antes do fechamento) é recusado e não emite convite', () => {
    const key = token();
    const h = host('h', key);
    const before = admission.activeInvites;
    // Autorização perdida sem aviso (expiração): o invite que chega antes do sweep é recusado no próprio invite.
    clock += 120_001; // token expirado: activeGeneration = null
    registry.handle(h.p, { type: 'invite' }, ADMIN);
    expect(h.p.lastOf('error')).toEqual({ type: 'error', code: 'unauthorized' });
    expect(h.p.closedWith).toBe(1008);
    expect(admission.activeInvites).toBeLessThanOrEqual(before);
    expect(h.p.inbox.filter((m) => m.type === 'invite')).toHaveLength(1); // só o convite do create
  });

  it('expiração do token (sem aviso): o sweep encerra o host', () => {
    const h = host('h', token());
    clock += 120_001;
    registry.sweep();
    expect(h.p.closedWith).toBe(1008);
    expect(registry.sessionOf(h.p)).toBeNull();
  });

  it('novo pareamento legítimo substitui o anterior: host antigo encerrado; novo host reentra (sessão com convidado)', () => {
    const h = host('h', token());
    const guest = new FakeParticipant('g');
    registry.handle(guest, { type: 'join', invite: h.invite }, SIGNAL);
    const fresh = token(); // novo pareamento: gera nova geração e avisa
    expect(h.p.closedWith).toBe(1008);
    const again = new FakeParticipant('h2');
    registry.handle(again, { type: 'rejoin', sessionId: h.sessionId, operatorKey: fresh }, ADMIN);
    expect(again.lastOf('session')?.role).toBe('host');
    expect(guest.lastOf('peer-joined')).toBeDefined();
    expect(again.closedWith).toBeNull();
  });

  it('novo pareamento legítimo: sessão sem convidado é encerrada com o host; o novo token cria sessão e emite convite', () => {
    const h = host('h', token());
    const fresh = token();
    expect(h.p.closedWith).toBe(1008);
    expect(registry.inspect(h.sessionId)).toBeNull(); // vazia: destruída como numa desconexão comum
    const again = host('h2', fresh);
    registry.handle(again.p, { type: 'invite' }, ADMIN);
    expect(again.p.inbox.filter((m) => m.type === 'invite')).toHaveLength(2);
    expect(again.p.closedWith).toBeNull();
  });

  it('token antigo não reautoriza depois da revogação (create e rejoin recusados)', () => {
    const old = token();
    const h = host('h', old);
    auth.revokeAll();
    const retry = new FakeParticipant('r');
    registry.handle(retry, { type: 'rejoin', sessionId: h.sessionId, operatorKey: old }, ADMIN);
    expect(retry.lastOf('error')).toEqual({ type: 'error', code: 'unauthorized' });
    registry.handle(retry, { type: 'create', operatorKey: old }, ADMIN);
    expect(retry.lastOf('error')).toEqual({ type: 'error', code: 'unauthorized' });
  });

  it('isolamento: a revogação encerra os hosts de todas as sessões, sem mover convidados entre sessões', () => {
    const key = token();
    const a = host('ha', key);
    const b = host('hb', key);
    const ga = new FakeParticipant('ga');
    const gb = new FakeParticipant('gb');
    registry.handle(ga, { type: 'join', invite: a.invite }, SIGNAL);
    registry.handle(gb, { type: 'join', invite: b.invite }, SIGNAL);
    auth.revokeAll();
    expect([a.p.closedWith, b.p.closedWith]).toEqual([1008, 1008]);
    expect(registry.sessionOf(ga)).toBe(a.sessionId);
    expect(registry.sessionOf(gb)).toBe(b.sessionId);
  });

  it('logs da revogação não contêm o token nem o convite', () => {
    const key = token();
    const h = host('h', key);
    auth.revokeAll();
    const all = logs.join('\n');
    expect(all).toMatch(/autorização administrativa revogada/);
    expect(all).not.toContain(key);
    expect(all).not.toContain(h.invite);
  });

  it('sem adminGeneration (configuração de teste antiga), o comportamento anterior é mantido', () => {
    const legacy = new SessionRegistry({
      maxSessions: 1,
      idleTimeoutMs: 1_000,
      maxAuthFailures: 3,
      admission,
      verifyAdmin: () => true,
      publicOrigin: null,
      now: () => clock,
      randomId: () => 'L'.repeat(22),
    });
    const p = new FakeParticipant('p');
    legacy.handle(p, { type: 'create', operatorKey: 'qualquer' }, ADMIN);
    legacy.handle(p, { type: 'invite' }, ADMIN);
    expect(p.inbox.filter((m) => m.type === 'invite')).toHaveLength(2);
    expect(p.closedWith).toBeNull();
  });
});

// ---------------------------------------------------------------- servidor (integração) -------------

describe('servidor: revogação do token administrativo com conexão ativa (IR-2)', () => {
  const running: RunningServer[] = [];
  const clients: TestClient[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) c.ws.terminate();
    for (const s of running.splice(0)) await s.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function server(logs: string[]): Promise<RunningServer> {
    const distDir = fakeDist();
    dirs.push(distDir);
    const s = await startServer({ distDir, httpPort: 0, adminPort: 0, log: (l) => logs.push(l) });
    running.push(s);
    return s;
  }

  it('"codigo" (revokeAll): host conectado é encerrado com 1008; convidado recebe peer-left; logs sem token', async () => {
    const logs: string[] = [];
    const s = await server(logs);
    const { client: host, token } = await openOperator(s);
    clients.push(host);
    const { invite } = await createAndInvite(host, token);
    const guest = await TestClient.open(wsUrlOf(s.httpOrigin), s.httpOrigin);
    clients.push(guest);
    guest.send({ type: 'join', invite });
    await guest.next('session');
    s.adminAuth.revokeAll();
    expect(await host.closed).toEqual({ code: 1008, reason: 'admin revoked' });
    expect(await guest.next('peer-left')).toMatchObject({ type: 'peer-left' });
    expect(logs.join('\n')).not.toContain(token);
  });

  it('novo pareamento legítimo: conexão do token antigo encerrada; o novo operador reentra e emite convite', async () => {
    const s = await server([]);
    const { client: oldHost, token: oldToken } = await openOperator(s);
    clients.push(oldHost);
    const { sessionId, invite } = await createAndInvite(oldHost, oldToken);
    const guest = await TestClient.open(wsUrlOf(s.httpOrigin), s.httpOrigin);
    clients.push(guest);
    guest.send({ type: 'join', invite });
    await guest.next('session');
    const newToken = await pairAdmin(s); // substitui a sessão administrativa
    expect(await oldHost.closed).toEqual({ code: 1008, reason: 'admin revoked' });
    const host = await TestClient.open(wsUrlOf(s.adminOrigin!), s.adminOrigin);
    clients.push(host);
    host.send({ type: 'rejoin', sessionId, operatorKey: newToken });
    expect(await host.next('session')).toMatchObject({ role: 'host', peerPresent: true });
    expect(await guest.next('peer-joined')).toMatchObject({ type: 'peer-joined' });
    // Token antigo não reautoriza.
    const stale = await TestClient.open(wsUrlOf(s.adminOrigin!), s.adminOrigin);
    clients.push(stale);
    stale.send({ type: 'create', operatorKey: oldToken });
    expect(await stale.next('error')).toEqual({ type: 'error', code: 'unauthorized' });
  });

  it('desligamento continua avisando "server-shutdown" ao host (ordem: sessões antes da revogação)', async () => {
    const s = await server([]);
    const { client: host, token } = await openOperator(s);
    clients.push(host);
    await createAndInvite(host, token);
    running.splice(running.indexOf(s), 1);
    await s.close();
    expect(await host.next('session-closed')).toEqual({ type: 'session-closed', reason: 'server-shutdown' });
  });
});
