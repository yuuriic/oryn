// Adaptador TURN e emissão (02B.4): cliente Cloudflare conforme a documentação, exercitado só com
// transporte simulado (nenhuma rede), provedor simulado e IceBroker (limites, falhas, revogação, logs).
import { describe, expect, it } from 'vitest';
import type { IceMode, IceServerConfig } from '../src/ice.ts';
import {
  CLOUDFLARE_TURN_API,
  CloudflareTurnProvider,
  IceBroker,
  SimulatedTurnProvider,
  sanitizeServers,
  type IceBrokerOptions,
  type IceRequester,
  type TurnIssue,
  type TurnProvider,
} from '../server/turn.ts';

const KEY_ID = 'turnkey0123456789abcdef';
const API_TOKEN = 'SEGREDO-ADMIN-api-token-0123456789';
const CF_RESPONSE = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
    {
      urls: [
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:53?transport=udp',
        'turn:turn.cloudflare.com:3478?transport=tcp',
        'turn:turn.cloudflare.com:80?transport=tcp',
        'turns:turn.cloudflare.com:5349?transport=tcp',
        'turns:turn.cloudflare.com:443?transport=tcp',
      ],
      username: 'cf-username-temporario',
      credential: 'cf-credential-temporaria',
    },
  ],
};

type Call = { url: string; init: RequestInit };
function cloudflare(respond: (call: Call) => Promise<Response>, options: { timeoutMs?: number } = {}) {
  const calls: Call[] = [];
  const provider = new CloudflareTurnProvider({
    keyId: KEY_ID,
    apiToken: API_TOKEN,
    now: () => 1_000_000,
    ...options,
    fetch: (url, init) => {
      const call = { url, init };
      calls.push(call);
      return respond(call);
    },
  });
  return { provider, calls };
}

describe('CloudflareTurnProvider (formato documentado; sem rede)', () => {
  it('POST em …/turn/keys/<id>/credentials/generate-ice-servers com Bearer e ttl; sem redirecionamento', async () => {
    const { provider, calls } = cloudflare(async () => Response.json(CF_RESPONSE, { status: 201 }));
    const issue = await provider.issue(7200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${CLOUDFLARE_TURN_API}/${KEY_ID}/credentials/generate-ice-servers`);
    expect(calls[0]!.url.startsWith('https://rtc.live.cloudflare.com/v1/turn/keys/')).toBe(true);
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.redirect).toBe('error');
    expect((calls[0]!.init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${API_TOKEN}`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ ttl: 7200 });
    expect(issue.username).toBe('cf-username-temporario');
    expect(issue.expiresAt).toBe(1_000_000 + 7200 * 1000);
  });

  it('URLs da porta 53 (bloqueadas pelos navegadores) são removidas; o segredo administrativo não aparece no resultado', async () => {
    const { provider } = cloudflare(async () => Response.json(CF_RESPONSE, { status: 201 }));
    const issue = await provider.issue(600);
    const urls = issue.iceServers.flatMap((s) => s.urls);
    expect(urls.some((u) => /:53(\?|$)/.test(u))).toBe(false);
    expect(urls).toContain('turns:turn.cloudflare.com:443?transport=tcp');
    expect(JSON.stringify(issue)).not.toContain(API_TOKEN);
  });

  it('hosts fora dos documentados são descartados (falha fechada se não sobrar TURN)', async () => {
    const evil = { iceServers: [{ urls: ['turn:evil.example:3478'], username: 'u', credential: 'c' }] };
    const { provider } = cloudflare(async () => Response.json(evil, { status: 201 }));
    await expect(provider.issue(600)).rejects.toThrow(/inválidos|sem credencial/);
  });

  it.each([
    ['erro de rede', async () => Promise.reject(new TypeError('fetch failed')), /falha de rede/],
    ['401', async () => new Response('{"errors":[]}', { status: 401 }), /HTTP 401/],
    ['500', async () => new Response('x', { status: 500 }), /HTTP 500/],
    ['redirecionamento', async () => new Response('', { status: 302, headers: { location: 'https://evil.example' } }), /HTTP 302/],
    ['JSON inválido', async () => new Response('{x', { status: 201 }), /não é JSON/],
    ['sem iceServers', async () => Response.json({}, { status: 201 }), /sem iceServers/],
    ['sem credencial TURN', async () => Response.json({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }] }, { status: 201 }), /sem credencial/],
    ['resposta grande demais', async () => new Response(JSON.stringify({ ...CF_RESPONSE, pad: 'x'.repeat(40_000) }), { status: 201 }), /grande demais/],
  ])('%s → rejeita sem credenciais e sem expor o token', async (_name, respond, message) => {
    const { provider } = cloudflare(respond as () => Promise<Response>);
    const error = await provider.issue(600).then(
      () => null,
      (e: Error) => e,
    );
    expect(error?.message).toMatch(message);
    expect(String(error)).not.toContain(API_TOKEN);
  });

  it('timeout → rejeita dentro do prazo', async () => {
    const { provider } = cloudflare(
      ({ init }) =>
        new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('abort')))),
      { timeoutMs: 100 },
    );
    const started = Date.now();
    await expect(provider.issue(600)).rejects.toThrow(/tempo esgotado/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('revogação: POST …/credentials/<username>/revoke (username codificado)', async () => {
    const { provider, calls } = cloudflare(async () => new Response(null, { status: 204 }));
    await provider.revoke('user/../x');
    expect(calls[0]!.url).toBe(`${CLOUDFLARE_TURN_API}/${KEY_ID}/credentials/user%2F..%2Fx/revoke`);
    expect(calls[0]!.init.method).toBe('POST');
  });

  it('configuração inválida impede a criação, sem ecoar o token', () => {
    expect(() => new CloudflareTurnProvider({ keyId: 'x', apiToken: API_TOKEN })).toThrow(/KEY_ID/);
    let message = '';
    try {
      new CloudflareTurnProvider({ keyId: KEY_ID, apiToken: 'curto' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/API_TOKEN/);
    expect(message).not.toContain('curto');
  });
});

describe('sanitizeServers', () => {
  it('credencial só acompanha TURN; STUN com credencial perde a credencial; limites aplicados', () => {
    const out = sanitizeServers(
      [
        { urls: 'stun:stun.cloudflare.com:3478', username: 'x', credential: 'y' },
        { urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'c', credentialType: 'oauth' },
        { urls: ['turn:turn.cloudflare.com:3478'] }, // TURN sem credencial: descartado
      ],
      null,
    );
    expect(out).toEqual([{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'c' }]);
  });
});

// ---------- IceBroker ----------

class Requester implements IceRequester {
  readonly sent: unknown[] = [];
  isAdmitted = true;
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
  admitted(): boolean {
    return this.isAdmitted;
  }
  sessionTag(): string {
    return 'SeSs…';
  }
  send(message: unknown): void {
    this.sent.push(message);
  }
  last(): Record<string, unknown> {
    return this.sent.at(-1) as Record<string, unknown>;
  }
}

function broker(provider: TurnProvider | null, overrides: Partial<IceBrokerOptions> = {}) {
  let clock = 0;
  const logs: string[] = [];
  const b = new IceBroker({
    provider,
    stunUrls: [],
    ttlSec: 3600,
    minIntervalMs: 10_000,
    maxPerConnection: 3,
    maxInflight: 4,
    now: () => clock,
    log: (l) => logs.push(l),
    ...overrides,
  });
  return { b, logs, tick: (ms: number) => (clock += ms) };
}

const sim = () => new SimulatedTurnProvider({ turnUrls: ['turn:127.0.0.1:3478?transport=udp', 'turns:127.0.0.1:5349?transport=tcp'], stunUrls: ['stun:127.0.0.1:3478'] });

describe('IceBroker', () => {
  it('direct não consome o provedor (só STUN); auto/relay/relay-tls recebem credenciais temporárias', async () => {
    const provider = sim();
    const { b } = broker(provider, { stunUrls: ['stun:stun.cloudflare.com:3478'] });
    const r = new Requester('c1');
    await b.request(r, 'direct');
    expect(r.last()).toEqual({ type: 'ice-config', mode: 'direct', iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }], expiresAt: null });
    expect(provider.issued).toHaveLength(0);
    await b.request(r, 'relay');
    const config = r.last();
    expect(config['type']).toBe('ice-config');
    expect((config['iceServers'] as IceServerConfig[]).some((s) => s.username !== undefined)).toBe(true);
    expect(provider.issued).toHaveLength(1);
  });

  it('sem provedor: relay e relay-tls → turn-unavailable (falha fechada); auto → só STUN, sem credenciais', async () => {
    const { b } = broker(null, { stunUrls: ['stun:stun.cloudflare.com:3478'] });
    for (const mode of ['relay', 'relay-tls'] as IceMode[]) {
      const r = new Requester(`c-${mode}`);
      await b.request(r, mode);
      expect(r.last()).toEqual({ type: 'error', code: 'turn-unavailable' });
    }
    const auto = new Requester('auto');
    await b.request(auto, 'auto');
    expect(auto.last()).toEqual({ type: 'ice-config', mode: 'auto', iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }], expiresAt: null });
  });

  it('falha ou timeout do provedor → turn-unavailable, nenhuma credencial fictícia', async () => {
    const failing: TurnProvider = { name: 'falho', issue: () => Promise.reject(new Error('timeout')), revoke: async () => undefined };
    const { b, logs } = broker(failing);
    const r = new Requester('c1');
    await b.request(r, 'relay');
    expect(r.sent).toEqual([{ type: 'error', code: 'turn-unavailable' }]);
    expect(b.activeCredentials('c1')).toBe(0);
    expect(logs.join('\n')).toContain('provedor falho indisponível');
  });

  it('limites: intervalo mínimo, máximo por conexão e uma emissão em andamento por conexão', async () => {
    const provider = sim();
    const { b, tick } = broker(provider, { minIntervalMs: 10_000, maxPerConnection: 2 });
    const r = new Requester('c1');
    await b.request(r, 'relay');
    await b.request(r, 'relay');
    expect(r.last()).toEqual({ type: 'error', code: 'ice-limit' }); // dentro do intervalo
    tick(10_000);
    await b.request(r, 'relay');
    expect(r.last()['type']).toBe('ice-config');
    tick(10_000);
    await b.request(r, 'relay');
    expect(r.last()).toEqual({ type: 'error', code: 'ice-limit' }); // máximo por conexão
    expect(provider.issued).toHaveLength(2);
  });

  it('concorrência: pedidos simultâneos da mesma conexão → um emite, os outros recebem ice-limit', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const provider = new SimulatedTurnProvider({ turnUrls: ['turn:127.0.0.1:3478'], behavior: () => gate });
    const { b } = broker(provider);
    const r = new Requester('c1');
    const all = Promise.all([b.request(r, 'relay'), b.request(r, 'relay'), b.request(r, 'relay')]);
    release();
    await all;
    expect(r.sent.filter((m) => (m as { type: string }).type === 'ice-config')).toHaveLength(1);
    expect(r.sent.filter((m) => (m as { code?: string }).code === 'ice-limit')).toHaveLength(2);
    expect(provider.issued).toHaveLength(1);
  });

  it('limite global de chamadas simultâneas ao provedor', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const provider = new SimulatedTurnProvider({ turnUrls: ['turn:127.0.0.1:3478'], behavior: () => gate });
    const { b } = broker(provider, { maxInflight: 2 });
    const rs = ['a', 'b', 'c'].map((id) => new Requester(id));
    const all = Promise.all(rs.map((r) => b.request(r, 'relay')));
    release();
    await all;
    expect(rs.map((r) => (r.last()['type'] === 'ice-config' ? 'ok' : r.last()['code']))).toEqual(['ok', 'ok', 'ice-limit']);
  });

  it('conexão que sai durante a emissão não recebe a credencial, que é revogada', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const provider = new SimulatedTurnProvider({ turnUrls: ['turn:127.0.0.1:3478'], behavior: () => gate });
    const { b } = broker(provider);
    const r = new Requester('c1');
    const pending = b.request(r, 'relay');
    r.isAdmitted = false;
    b.release('c1');
    release();
    await pending;
    await new Promise((x) => setTimeout(x, 0));
    expect(r.sent).toEqual([]);
    expect(provider.revoked).toEqual(provider.issued);
  });

  it('release (saída/desconexão) e releaseAll (desligamento) revogam as credenciais emitidas', async () => {
    const provider = sim();
    const { b, tick } = broker(provider);
    const r1 = new Requester('c1');
    const r2 = new Requester('c2');
    await b.request(r1, 'auto');
    tick(10_000);
    await b.request(r1, 'relay');
    await b.request(r2, 'relay-tls');
    b.release('c1');
    await new Promise((x) => setTimeout(x, 0));
    expect(provider.revoked).toEqual(provider.issued.slice(0, 2));
    expect(b.activeCredentials('c1')).toBe(0);
    b.releaseAll();
    await new Promise((x) => setTimeout(x, 0));
    expect(provider.revoked).toEqual(provider.issued);
  });

  it('logs sem username, credential, URLs ou token', async () => {
    const issued: TurnIssue = {
      iceServers: [{ urls: ['turn:turn.cloudflare.com:3478'], username: 'USR-temporario', credential: 'CRED-temporaria' }],
      username: 'USR-temporario',
      expiresAt: 1,
    };
    const provider: TurnProvider = { name: 'teste', issue: async () => issued, revoke: () => Promise.reject(new Error(API_TOKEN)) };
    const { b, logs } = broker(provider);
    const r = new Requester('c1');
    await b.request(r, 'relay');
    b.release('c1');
    await new Promise((x) => setTimeout(x, 0));
    const all = logs.join('\n');
    expect(all).toContain('credencial temporária emitida (sessão SeSs…, modo relay');
    expect(all).toContain('falha ao revogar');
    for (const secret of ['USR-temporario', 'CRED-temporaria', 'turn.cloudflare.com', API_TOKEN]) expect(all).not.toContain(secret);
  });
});
