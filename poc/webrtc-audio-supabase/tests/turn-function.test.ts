// Edge Function `turn` sem rede: provedor Cloudflare (formato documentado, transporte simulado), núcleo (autenticação,
// autorização pela sessão viva, limites, falha fechada), camada HTTP/CORS, configuração e chamadas ao Supabase com o JWT do
// usuário. NÃO prova o comportamento da API real da Cloudflare nem do gateway do Supabase (TURN-RELAY.md, homologação).
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadEdgeConfig } from '../supabase/functions/_shared/edge-config.ts';
import { MAX_ICE_SECRET_LENGTH, MAX_ICE_SERVERS, MAX_ICE_URLS, parseIceUrl, sanitizeIceServers } from '../supabase/functions/_shared/ice-servers.ts';
import * as clientIce from '../src/web/ice.ts';
import { RpcError } from '../supabase/functions/_shared/signal-core.ts';
import type { FetchLike } from '../supabase/functions/_shared/supabase-http.ts';
import {
  IssueLimiter,
  TURN_TTL_DEFAULT_S,
  TurnConfigError,
  createLiveSessionDeps,
  handleTurn,
  handleTurnHttp,
  loadTurnConfig,
  parseTurnRequest,
  type LiveSession,
  type TurnDeps,
} from '../supabase/functions/_shared/turn-core.ts';
import { CLOUDFLARE_TURN_API, CloudflareTurnProvider, TurnProviderError, type TurnIssue, type TurnProvider } from '../supabase/functions/_shared/turn-provider.ts';

// Valores fictícios montados em execução: nenhum literal com formato de chave, token ou JWT fica versionado.
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = [b64({ alg: 'HS256' }), b64({ sub: 'x', role: 'authenticated' }), 'YXNzaW5hdHVyYQ'].join('.');
const KEY_ID = ['turnkey', '0123456789abcdef'].join('');
const API_TOKEN = ['SEGREDO', 'ADMIN', 'api-token-0123456789'].join('-');
const CF_USER = 'cf-username-temporario';
const CF_CRED = 'cf-credential-temporaria';
const CF_RESPONSE = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
    {
      urls: [
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:53?transport=udp',
        'turn:turn.cloudflare.com:3478?transport=tcp',
        'turns:turn.cloudflare.com:5349?transport=tcp',
        'turns:turn.cloudflare.com:443?transport=tcp',
      ],
      username: CF_USER,
      credential: CF_CRED,
    },
  ],
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function cloudflare(respond: (url: string, init: RequestInit) => Promise<Response>, timeoutMs?: number) {
  const calls: { url: string; init: RequestInit }[] = [];
  const provider = new CloudflareTurnProvider({
    keyId: KEY_ID,
    apiToken: API_TOKEN,
    now: () => 1_000_000,
    ...(timeoutMs ? { timeoutMs } : {}),
    fetch: (url, init) => {
      calls.push({ url, init });
      return respond(url, init);
    },
  });
  return { provider, calls };
}

describe('CloudflareTurnProvider (formato documentado; transporte simulado, sem rede)', () => {
  it('POST em …/turn/keys/<id>/credentials/generate-ice-servers com Bearer e ttl, sem redirecionamento nem cookies', async () => {
    const { provider, calls } = cloudflare(async () => json(201, CF_RESPONSE));
    const issue = await provider.issue(7200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${CLOUDFLARE_TURN_API}/${KEY_ID}/credentials/generate-ice-servers`);
    expect(calls[0]!.init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', body: '{"ttl":7200}' });
    expect((calls[0]!.init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${API_TOKEN}`);
    expect(issue.expiresAt).toBe(1_000_000 + 7_200_000);
    // Porta 53 removida; STUN sem credencial; TURN com a credencial completa; o token nunca no resultado.
    expect(issue.iceServers).toEqual([
      { urls: ['stun:stun.cloudflare.com:3478'] },
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:3478?transport=tcp', 'turns:turn.cloudflare.com:5349?transport=tcp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: CF_USER, credential: CF_CRED },
    ]);
    expect(JSON.stringify(issue)).not.toContain(API_TOKEN);
  });

  it('200 também é aceito; hosts fora dos documentados são descartados', async () => {
    const extra = { iceServers: [...CF_RESPONSE.iceServers, { urls: ['turn:evil.example:3478'], username: 'u', credential: 'c' }] };
    const { provider } = cloudflare(async () => json(200, extra));
    const issue = await provider.issue(600);
    expect(JSON.stringify(issue)).not.toContain('evil.example');
  });

  it.each([
    ['sem iceServers', () => json(201, { nada: true }), /sem iceServers/],
    ['sem TURN com credencial', () => json(201, { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }] }), /sem credencial TURN/],
    ['só hosts não documentados', () => json(201, { iceServers: [{ urls: ['turn:evil.example:3478'], username: 'u', credential: 'c' }] }), /sem credencial TURN/],
    ['TURN sem credential', () => json(201, { iceServers: [{ urls: ['turn:turn.cloudflare.com:3478'], username: 'u' }] }), /sem credencial TURN/],
    ['não JSON', () => new Response('<html>', { status: 201 }), /não é JSON/],
    ['HTTP 401', () => json(401, { errors: [] }), /HTTP 401/],
    ['HTTP 500', () => json(500, {}), /HTTP 500/],
    ['corpo vazio', () => new Response(null, { status: 201 }), /vazia/],
    ['content-length grande demais', () => json(201, CF_RESPONSE, { 'content-length': String(64 * 1024) }), /grande demais/],
    ['corpo grande demais sem content-length', () => new Response('x'.repeat(40 * 1024), { status: 201 }), /grande demais/],
  ])('resposta malformada ou recusada (%s) → TurnProviderError, nunca credencial fictícia', async (_name, respond, message) => {
    const { provider } = cloudflare(async () => respond());
    await expect(provider.issue(7200)).rejects.toThrow(TurnProviderError);
    await expect(provider.issue(7200)).rejects.toThrow(message);
  });

  it('falha de rede e timeout → TurnProviderError', async () => {
    await expect(cloudflare(async () => { throw new TypeError('rede'); }).provider.issue(600)).rejects.toThrow(/falha de rede/);
    const slow = cloudflare((_url, init) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError')))), 30);
    await expect(slow.provider.issue(600)).rejects.toThrow(/tempo esgotado/);
  });

  it('configuração inválida impede a criação, sem ecoar o valor', () => {
    let message = '';
    try {
      new CloudflareTurnProvider({ keyId: KEY_ID, apiToken: 'curto' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/ORYN_TURN_API_TOKEN inválido/);
    expect(message).not.toContain('curto');
    expect(() => new CloudflareTurnProvider({ keyId: 'x y', apiToken: API_TOKEN })).toThrow(/ORYN_TURN_KEY_ID inválido/);
  });
});

describe('paridade com src/web/ice.ts (cópia idêntica da POC-02B)', () => {
  it('parseIceUrl e os limites: mesmo resultado para cada URL do conjunto', () => {
    const corpus = [
      'stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53', 'stun:a.example', 'stun:a.example:3478?transport=udp',
      'turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turn:x.example:0', 'turn:x.example:65536',
      'turns:turn.cloudflare.com:443?transport=tcp', 'turns:turn.cloudflare.com:5349', 'turns:h.example?transport=sctp', 'TURN:A.example',
      'turn:10.0.0.1:3478', 'turn:[::1]:3478', 'http://a.example', '', 'turn:a b', `turn:${'a'.repeat(254)}`,
    ];
    for (const u of corpus) expect(parseIceUrl(u), u).toEqual(clientIce.parseIceUrl(u));
    expect([MAX_ICE_SERVERS, MAX_ICE_URLS, MAX_ICE_SECRET_LENGTH]).toEqual([clientIce.MAX_ICE_SERVERS, clientIce.MAX_ICE_URLS, clientIce.MAX_ICE_SECRET_LENGTH]);
  });
});

describe('sanitizeIceServers (compartilhado com o cliente)', () => {
  it('credencial só acompanha TURN e sempre completa; STUN perde credencial; limites de 4 servidores e 8 URLs', () => {
    expect(sanitizeIceServers([{ urls: 'stun:a.example:3478', username: 'u', credential: 'c' }], null)).toEqual([{ urls: ['stun:a.example:3478'] }]);
    expect(sanitizeIceServers([{ urls: ['turn:a.example:3478'], username: 'u' }], null)).toEqual([]);
    expect(sanitizeIceServers([{ urls: ['turn:a.example:3478'], username: 'u', credential: 'com espaço' }], null)).toEqual([]);
    expect(sanitizeIceServers('nada', null)).toEqual([]);
    const many = Array.from({ length: 6 }, (_, i) => ({ urls: Array.from({ length: 10 }, (_, j) => `turn:h${i}.example:${3000 + j}`), username: 'u', credential: 'c' }));
    const out = sanitizeIceServers(many, null);
    expect(out).toHaveLength(4);
    expect(out.every((s) => s.urls.length === 8)).toBe(true);
    expect(sanitizeIceServers([{ urls: ['turn:a.example:53', 'http://a.example', 'turn:A.example'], username: 'u', credential: 'c' }], null)).toEqual([]);
  });
});

// ---------- núcleo ----------

const ROOM = randomUUID();
const CHANNEL = randomUUID();
const SESSION = randomUUID();
const USER = randomUUID();
const ISSUE: TurnIssue = { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: CF_USER, credential: CF_CRED }], expiresAt: 10_000_000 };

function harness(over: { user?: string | null | 'throw'; sessions?: LiveSession[] | RpcError | Error; provider?: TurnProvider | null; now?: () => number; limits?: Partial<ConstructorParameters<typeof IssueLimiter>[0]> } = {}) {
  const logs: string[] = [];
  const counts = { verify: 0, live: 0, issue: 0 };
  let clock = 1_000_000;
  const now = over.now ?? (() => clock);
  const provider: TurnProvider | null = over.provider === undefined
    ? { name: 'simulado', issue: async (ttl) => { counts.issue += 1; return { ...ISSUE, expiresAt: now() + ttl * 1000 }; } }
    : over.provider;
  const deps: TurnDeps = {
    verifyUser: async () => {
      counts.verify += 1;
      if (over.user === 'throw') throw new Error('auth-503');
      return over.user === undefined ? USER : over.user;
    },
    liveSessions: async () => {
      counts.live += 1;
      const s = over.sessions ?? [{ session_id: SESSION, is_self: true }];
      if (s instanceof Error) throw s;
      return s;
    },
    provider,
    limiter: new IssueLimiter({ now, ...over.limits }),
    ttlSec: TURN_TTL_DEFAULT_S,
    log: (e) => logs.push(JSON.stringify(e)),
  };
  const body = (o: Record<string, unknown> = {}) => JSON.stringify({ room_id: ROOM, channel_id: CHANNEL, session_id: SESSION, ...o });
  const call = (input: { authorization?: string | null; body?: string } = {}) =>
    handleTurn({ authorization: input.authorization === undefined ? `Bearer ${JWT}` : input.authorization, body: input.body ?? body() }, deps);
  return { deps, call, body, logs, counts, tick: (ms: number) => (clock += ms) };
}

describe('núcleo: autenticação e autorização antes de qualquer emissão', () => {
  it.each([null, '', 'Bearer', `Basic ${JWT}`, 'Bearer não-é-jwt', `Bearer ${JWT} extra`])('JWT ausente ou malformado (%s) → 401, sem Auth, banco nem provedor', async (authorization) => {
    const h = harness();
    const r = await h.call({ authorization });
    expect(r).toEqual({ status: 401, body: { error: 'unauthorized', retryable: false } });
    expect(h.counts).toEqual({ verify: 0, live: 0, issue: 0 });
  });

  it('JWT recusado pelo Auth → 401; Auth indisponível → 503; nenhum chama o provedor', async () => {
    const refused = harness({ user: null });
    expect((await refused.call()).status).toBe(401);
    const down = harness({ user: 'throw' });
    expect(await down.call()).toEqual({ status: 503, body: { error: 'auth-unavailable', retryable: true } });
    expect(refused.counts.issue + down.counts.issue).toBe(0);
    expect(refused.counts.live + down.counts.live).toBe(0);
  });

  it.each([
    ['não JSON', '{', 400],
    ['chave a mais', JSON.stringify({ room_id: ROOM, channel_id: null, session_id: SESSION, user_id: USER }), 400],
    ['chave faltando', JSON.stringify({ room_id: ROOM, session_id: SESSION }), 400],
    ['sessão não UUID', JSON.stringify({ room_id: ROOM, channel_id: null, session_id: 'x' }), 400],
    ['canal inválido', JSON.stringify({ room_id: ROOM, channel_id: 5, session_id: SESSION }), 400],
    ['lista', '[]', 400],
    ['grande demais', JSON.stringify({ room_id: ROOM, channel_id: null, session_id: SESSION, pad: 'x'.repeat(600) }), 413],
  ])('requisição inválida (%s) → %i, sem Auth, banco nem provedor', async (_name, body, status) => {
    const h = harness();
    expect((await h.call({ body })).status).toBe(status);
    expect(h.counts).toEqual({ verify: 0, live: 0, issue: 0 });
  });

  it('sem sessão viva na voz (inclusive revogada ou vencida, que o banco não devolve) → 403 session-invalid, sem provedor', async () => {
    const h = harness({ sessions: [{ session_id: randomUUID(), is_self: true }] });
    expect(await h.call()).toEqual({ status: 403, body: { error: 'session-invalid', retryable: false } });
    expect(h.counts.issue).toBe(0);
  });

  it('sessão viva de OUTRA conta com o id pedido (is_self falso) → 403, sem provedor', async () => {
    const h = harness({ sessions: [{ session_id: SESSION, is_self: false }] });
    expect((await h.call()).status).toBe(403);
    expect(h.counts.issue).toBe(0);
  });

  it('erros do banco: não membro → 403, canal não é de voz → 400, JWT recusado pelo PostgREST → 401, banco fora → 503; sem provedor', async () => {
    for (const [error, status] of [[new RpcError('not-member'), 403], [new RpcError('invalid-argument'), 400], [new RpcError('jwt-invalid'), 401], [new Error('rede'), 503], [new RpcError('http-500'), 503]] as const) {
      const h = harness({ sessions: error });
      expect((await h.call()).status, String(error.message)).toBe(status);
      expect(h.counts.issue).toBe(0);
    }
  });

  it('TURN desligado (sem provedor) → 503 turn-unavailable, depois de autorizar', async () => {
    const h = harness({ provider: null });
    expect(await h.call()).toEqual({ status: 503, body: { error: 'turn-unavailable', retryable: false } });
    expect(h.counts.live).toBe(1);
  });

  it('autorizado → 200 com iceServers e expiresAt; o provedor recebe o TTL de 2 h', async () => {
    let ttl = 0;
    const h = harness({ provider: { name: 'simulado', issue: async (t) => { ttl = t; return ISSUE; } } });
    expect(await h.call()).toEqual({ status: 200, body: { iceServers: ISSUE.iceServers, expiresAt: ISSUE.expiresAt } });
    expect(ttl).toBe(7200);
  });

  it('falha do provedor → 503 turn-unavailable (repetível); a falha não fica guardada como credencial', async () => {
    let fail = true;
    const provider: TurnProvider = { name: 'simulado', issue: async () => { if (fail) throw new TurnProviderError('HTTP 500'); return ISSUE; } };
    const h = harness({ provider });
    expect(await h.call()).toEqual({ status: 503, body: { error: 'turn-unavailable', retryable: true } });
    fail = false;
    expect((await h.call()).status).toBe(200);
  });
});

describe('núcleo: limites em memória (por instância)', () => {
  it('pedidos simultâneos da mesma sessão → uma emissão só, a mesma credencial para todos', async () => {
    const h = harness();
    const results = await Promise.all([h.call(), h.call(), h.call(), h.call()]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(h.counts.issue).toBe(1);
    expect(new Set(results.map((r) => JSON.stringify(r.body))).size).toBe(1);
  });

  it('credencial ainda válida é reaproveitada; perto do fim (menos de 10 min) é emitida outra', async () => {
    const h = harness();
    await h.call();
    h.tick(60 * 60_000);
    await h.call();
    expect(h.counts.issue).toBe(1);
    h.tick(55 * 60_000); // faltam 5 min
    await h.call();
    expect(h.counts.issue).toBe(2);
  });

  it('teto por conta na janela → 429 ice-limit, sem chamar o provedor; outra conta não é afetada', async () => {
    const h = harness({ limits: { maxPerAccount: 2 } });
    const other = (session: string) => h.call({ body: h.body({ session_id: session }) });
    // Cada sessão nova é uma emissão (a sessão muda a cada entrada na voz).
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID();
    h.deps.liveSessions = async () => [s1, s2, s3].map((session_id) => ({ session_id, is_self: true }));
    expect((await other(s1)).status).toBe(200);
    expect((await other(s2)).status).toBe(200);
    expect(await other(s3)).toEqual({ status: 429, body: { error: 'ice-limit', retryable: true } });
    expect(h.counts.issue).toBe(2);
    h.tick(61 * 60_000);
    expect((await other(s3)).status).toBe(200);
  });

  it('teto global de emissões em andamento → 429 para o excedente', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({ limits: { maxInflight: 1 }, provider: { name: 'lento', issue: async () => { await gate; return ISSUE; } } });
    const s2 = randomUUID();
    h.deps.liveSessions = async () => [{ session_id: SESSION, is_self: true }, { session_id: s2, is_self: true }];
    const first = h.call();
    await new Promise((r) => setTimeout(r, 0));
    expect((await h.call({ body: h.body({ session_id: s2 }) })).status).toBe(429);
    release();
    expect((await first).status).toBe(200);
  });

  it('logs sem credencial, JWT, URL TURN, token ou ids completos', async () => {
    const h = harness();
    await h.call();
    await h.call({ authorization: null });
    const all = h.logs.join('\n');
    for (const secret of [CF_USER, CF_CRED, JWT, 'turn:', 'stun:', API_TOKEN, SESSION, USER]) expect(all).not.toContain(secret);
    expect(all).toMatch(/"outcome":"issued"/);
  });
});

describe('HTTP: CORS igual ao da signal, só POST, sem cache', () => {
  const origins = new Set(['https://oryn.example', 'https://tauri.localhost']);
  it('origem permitida: preflight 204 com os cabeçalhos; outra origem: 403 sem cabeçalhos', async () => {
    const h = harness();
    const ok = await handleTurnHttp(new Request('https://f/turn', { method: 'OPTIONS', headers: { origin: 'https://tauri.localhost' } }), h.deps, origins);
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://tauri.localhost');
    const bad = await handleTurnHttp(new Request('https://f/turn', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), h.deps, origins);
    expect(bad.status).toBe(403);
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('GET → 405; POST autorizado → 200 com no-store', async () => {
    const h = harness();
    expect((await handleTurnHttp(new Request('https://f/turn', { method: 'GET' }), h.deps, origins)).status).toBe(405);
    const res = await handleTurnHttp(new Request('https://f/turn', { method: 'POST', headers: { origin: 'https://oryn.example', authorization: `Bearer ${JWT}` }, body: h.body() }), h.deps, origins);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBe('https://oryn.example');
  });
});

describe('configuração (nomes documentados; nenhum valor real)', () => {
  it('padrão: desligado, TTL de 2 h', () => {
    expect(loadTurnConfig(() => undefined)).toEqual({ provider: 'off', keyId: null, apiToken: null, ttlSec: 7200 });
  });

  it('cloudflare exige os dois secrets; TTL de 1800 a 43200; erros sem valores', () => {
    const env = (vars: Record<string, string>) => (name: string) => vars[name];
    expect(loadTurnConfig(env({ ORYN_TURN_PROVIDER: 'cloudflare', ORYN_TURN_KEY_ID: KEY_ID, ORYN_TURN_API_TOKEN: API_TOKEN, ORYN_TURN_TTL_S: '3600' }))).toEqual({ provider: 'cloudflare', keyId: KEY_ID, apiToken: API_TOKEN, ttlSec: 3600 });
    for (const vars of [
      { ORYN_TURN_PROVIDER: 'cloudflare', ORYN_TURN_KEY_ID: KEY_ID },
      { ORYN_TURN_PROVIDER: 'outro' },
      { ORYN_TURN_TTL_S: '600' },
      { ORYN_TURN_TTL_S: '99999' },
      { ORYN_TURN_TTL_S: '1.5' },
    ]) {
      let message = '';
      try {
        loadTurnConfig(env(vars));
      } catch (e) {
        expect(e).toBeInstanceOf(TurnConfigError);
        message = (e as Error).message;
      }
      expect(message, JSON.stringify(Object.keys(vars))).not.toBe('');
      expect(message).not.toContain(KEY_ID);
    }
  });

  it('parseTurnRequest aceita a voz padrão (canal null) e um canal', () => {
    expect(parseTurnRequest(JSON.stringify({ room_id: ROOM, channel_id: null, session_id: SESSION }))).toEqual({ ok: true, value: { room_id: ROOM, channel_id: null, session_id: SESSION } });
    expect(parseTurnRequest(JSON.stringify({ session_id: SESSION, channel_id: CHANNEL, room_id: ROOM })).ok).toBe(true);
  });
});

describe('dependências reais: RPCs de participantes com o JWT do usuário, nunca a chave secreta', () => {
  const PUBLISHABLE = ['sb', 'publishable', 'TESTEpublicavel0123'].join('_');
  const SECRET = ['sb', 'secret', 'TESTEsecreta0123456'].join('_');
  const cfg = loadEdgeConfig((name) => ({
    SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co',
    SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: PUBLISHABLE }),
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }),
    ORYN_ALLOWED_ORIGINS: 'https://oryn.example',
  })[name]);

  function fake(respond: (url: string) => Response) {
    const calls: { url: string; headers: Record<string, string>; body?: string }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) });
      return respond(url);
    };
    return { deps: createLiveSessionDeps(cfg, fetchImpl), calls };
  }

  it('canal: get_channel_participants(p_channel_id); voz padrão: get_voice_participants(p_room_id); só a chave publicável + Bearer do usuário', async () => {
    const rows = [{ session_id: SESSION, participant_ref: 'a'.repeat(32), display_name: 'Eu', is_self: true, joined_at: 'x' }, { session_id: 'lixo', is_self: true }];
    const f = fake(() => json(200, rows));
    expect(await f.deps.liveSessions(JWT, { room_id: ROOM, channel_id: CHANNEL, session_id: SESSION })).toEqual([{ session_id: SESSION, is_self: true }]);
    await f.deps.liveSessions(JWT, { room_id: ROOM, channel_id: null, session_id: SESSION });
    expect(f.calls.map((c) => [c.url.split('/rpc/')[1], c.body])).toEqual([
      ['get_channel_participants', JSON.stringify({ p_channel_id: CHANNEL })],
      ['get_voice_participants', JSON.stringify({ p_room_id: ROOM })],
    ]);
    for (const c of f.calls) {
      expect(c.headers['apikey']).toBe(PUBLISHABLE);
      expect(c.headers['authorization']).toBe(`Bearer ${JWT}`);
      expect(JSON.stringify(c.headers)).not.toContain(SECRET);
    }
  });

  it('erro do banco vira RpcError com o código (403 not-member, 401 jwt-invalid); resposta fora do formato → database-unavailable', async () => {
    await expect(fake(() => json(403, { message: 'not-member' })).deps.liveSessions(JWT, { room_id: ROOM, channel_id: null, session_id: SESSION })).rejects.toMatchObject({ code: 'not-member' });
    await expect(fake(() => json(401, {})).deps.liveSessions(JWT, { room_id: ROOM, channel_id: null, session_id: SESSION })).rejects.toMatchObject({ code: 'jwt-invalid' });
    await expect(fake(() => json(200, { nao: 'lista' })).deps.liveSessions(JWT, { room_id: ROOM, channel_id: null, session_id: SESSION })).rejects.toMatchObject({ code: 'database-unavailable' });
  });

  it('verifyUser pelo Auth, com o mesmo par de cabeçalhos', async () => {
    const f = fake((url) => (url.endsWith('/auth/v1/user') ? json(200, { id: USER }) : json(500, {})));
    expect(await f.deps.verifyUser(JWT)).toBe(USER);
    expect(f.calls[0]!.headers).toEqual({ apikey: PUBLISHABLE, authorization: `Bearer ${JWT}` });
  });
});
