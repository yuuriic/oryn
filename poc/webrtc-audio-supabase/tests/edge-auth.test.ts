// Credenciais da Edge Function `signal` (02C.1B.0A, correção B1/B2). fetch SIMULADO: prova quais headers
// cada chamada envia e como o núcleo reage a credenciais ausentes ou recusadas. NÃO prova o comportamento
// do gateway do Supabase real (NOT VERIFIED: tests/integration.pending.test.ts).
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadEdgeConfig, type EdgeConfig } from '../supabase/functions/_shared/edge-config.ts';
import { createSignalDeps, type FetchLike } from '../supabase/functions/_shared/supabase-http.ts';
import { handleHttp } from '../supabase/functions/_shared/signal-http.ts';

// Valores fictícios montados em execução (nenhum literal com formato de chave ou JWT fica versionado).
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeJwt = (claims: object) => [b64({ alg: 'HS256', typ: 'JWT' }), b64(claims), 'c2lnbmF0dXJh'].join('.');
const PUBLISHABLE = ['sb', 'publishable', 'TESTEpublicavel0123'].join('_');
const SECRET = ['sb', 'secret', 'TESTEsecreta0123456'].join('_');
const LEGACY_ANON = fakeJwt({ role: 'anon' });
const LEGACY_SERVICE = fakeJwt({ role: 'service_role' });
const USER_JWT = fakeJwt({ sub: randomUUID(), role: 'authenticated' });
const USER_ID = randomUUID();
const URL_ = 'https://abcdefghijklmnop.supabase.co';
const ORIGIN = 'https://oryn.example';

const env = (over: Record<string, string | undefined> = {}) => {
  const vars: Record<string, string | undefined> = {
    SUPABASE_URL: URL_,
    SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: PUBLISHABLE }),
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }),
    ORYN_ALLOWED_ORIGINS: ORIGIN,
    ...over,
  };
  return (name: string) => vars[name];
};

describe('configuração e nomes reservados (B2)', () => {
  it('chaves novas: lidas de SUPABASE_*_KEYS (JSON, "default")', () => {
    const cfg = loadEdgeConfig(env());
    expect(cfg).toMatchObject({ url: URL_, publishableKey: PUBLISHABLE, secretKey: SECRET, keyKind: 'new' });
    expect([...cfg.allowedOrigins]).toEqual([ORIGIN]);
  });

  it('chaves novas têm prioridade sobre as legadas', () => {
    expect(loadEdgeConfig(env({ SUPABASE_ANON_KEY: LEGACY_ANON, SUPABASE_SERVICE_ROLE_KEY: LEGACY_SERVICE })).keyKind).toBe('new');
  });

  it('alternativa legada só com anon e service_role de papéis corretos', () => {
    const legacy = env({ SUPABASE_PUBLISHABLE_KEYS: undefined, SUPABASE_SECRET_KEYS: undefined, SUPABASE_ANON_KEY: LEGACY_ANON, SUPABASE_SERVICE_ROLE_KEY: LEGACY_SERVICE });
    expect(loadEdgeConfig(legacy)).toMatchObject({ publishableKey: LEGACY_ANON, secretKey: LEGACY_SERVICE, keyKind: 'legacy' });
    // Chaves legadas trocadas (anon no lugar da service_role e vice-versa) são recusadas.
    const swapped = env({ SUPABASE_PUBLISHABLE_KEYS: undefined, SUPABASE_SECRET_KEYS: undefined, SUPABASE_ANON_KEY: LEGACY_SERVICE, SUPABASE_SERVICE_ROLE_KEY: LEGACY_ANON });
    expect(() => loadEdgeConfig(swapped)).toThrow(ConfigError);
  });

  it.each([
    ['URL ausente', { SUPABASE_URL: undefined }],
    ['URL com caminho', { SUPABASE_URL: `${URL_}/rest/v1` }],
    ['secreta no lugar da publicável', { SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: SECRET }) }],
    ['publicável no lugar da secreta', { SUPABASE_SECRET_KEYS: JSON.stringify({ default: PUBLISHABLE }) }],
    ['JWT legado no lugar da secreta nova', { SUPABASE_SECRET_KEYS: JSON.stringify({ default: LEGACY_SERVICE }) }],
    ['só uma das chaves novas', { SUPABASE_SECRET_KEYS: undefined }],
    ['JSON inválido', { SUPABASE_SECRET_KEYS: SECRET }],
    ['sem "default"', { SUPABASE_SECRET_KEYS: JSON.stringify({ outra: SECRET }) }],
    ['sem origens', { ORYN_ALLOWED_ORIGINS: '' }],
    ['origem http pública', { ORYN_ALLOWED_ORIGINS: 'http://oryn.example' }],
    ['origem com caminho', { ORYN_ALLOWED_ORIGINS: `${ORIGIN}/app` }],
  ])('recusa: %s', (_label, over) => {
    expect(() => loadEdgeConfig(env(over))).toThrow(ConfigError);
  });

  it('mensagens de erro de configuração nunca contêm o valor das chaves', () => {
    const errors: string[] = [];
    for (const over of [{ SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: SECRET }) }, { SUPABASE_SECRET_KEYS: SECRET }, { SUPABASE_SECRET_KEYS: JSON.stringify({ default: PUBLISHABLE }) }]) {
      try {
        loadEdgeConfig(env(over));
      } catch (error) {
        errors.push((error as Error).message);
      }
    }
    expect(errors).toHaveLength(3);
    for (const m of errors) for (const v of [SECRET, PUBLISHABLE]) expect(m).not.toContain(v);
  });
});

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** fetch simulado: responde por rota e registra cada chamada. */
function fakeFetch(routes: Partial<Record<'user' | 'authorize' | 'state' | 'broadcast', () => Response>> = {}) {
  const calls: Call[] = [];
  const msgId = randomUUID();
  const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const defaults = {
    user: () => ok({ id: USER_ID }),
    authorize: () => ok([{ msg_id: msgId, seq: 1, from_user: USER_ID, room_id: randomUUID(), state: 'accepted', duplicate: false, accepted_at: '2026-10-23T12:00:00.000Z' }]),
    state: () => ok('published'),
    broadcast: () => new Response(null, { status: 202 }),
  };
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const route = url.endsWith('/auth/v1/user') ? 'user' : url.endsWith('/rpc/authorize_signal') ? 'authorize' : url.endsWith('/rpc/set_signal_state') ? 'state' : url.endsWith('/realtime/v1/api/broadcast') ? 'broadcast' : null;
    if (!route) throw new Error(`rota inesperada: ${url}`);
    return (routes[route] ?? defaults[route])();
  };
  return { fetchImpl, calls };
}

const SDP = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const body = () => JSON.stringify({ session_id: randomUUID(), to_session_id: randomUUID(), client_msg_id: randomUUID(), kind: 'offer', pair_epoch: 1, payload: { sdp: SDP } });

function setup(cfg: EdgeConfig, routes?: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(routes);
  const logs: Record<string, unknown>[] = [];
  const deps = createSignalDeps(cfg, f.fetchImpl, (e) => logs.push(e));
  const send = (authorization: string | null, init: { method?: string; origin?: string; body?: string } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (authorization !== null) headers['authorization'] = authorization;
    if (init.origin) headers['origin'] = init.origin;
    const method = init.method ?? 'POST';
    return handleHttp(new Request(`${URL_}/functions/v1/signal`, { method, headers, ...(method === 'POST' ? { body: init.body ?? body() } : {}) }), deps, cfg.allowedOrigins);
  };
  return { ...f, logs, send };
}

const byRoute = (calls: Call[], suffix: string) => calls.filter((c) => c.url.endsWith(suffix));

describe.each([
  ['chaves novas', env()],
  ['chaves legadas', env({ SUPABASE_PUBLISHABLE_KEYS: undefined, SUPABASE_SECRET_KEYS: undefined, SUPABASE_ANON_KEY: LEGACY_ANON, SUPABASE_SERVICE_ROLE_KEY: LEGACY_SERVICE })],
])('headers por operação (B1) — %s', (_label, getEnv) => {
  const cfg = loadEdgeConfig(getEnv);

  it('caminho feliz: usuário → apikey publicável + Bearer JWT do usuário; servidor → só apikey secreta', async () => {
    const t = setup(cfg);
    const res = await t.send(`Bearer ${USER_JWT}`);
    expect(res.status).toBe(202);
    expect(t.calls.map((c) => c.url.replace(URL_, ''))).toEqual([
      '/auth/v1/user',
      '/rest/v1/rpc/authorize_signal',
      '/rest/v1/rpc/set_signal_state',
      '/realtime/v1/api/broadcast',
      '/rest/v1/rpc/set_signal_state',
    ]);
    for (const c of [...byRoute(t.calls, '/auth/v1/user'), ...byRoute(t.calls, '/rpc/authorize_signal')]) {
      expect(c.headers['apikey'], c.url).toBe(cfg.publishableKey);
      expect(c.headers['authorization'], c.url).toBe(`Bearer ${USER_JWT}`);
    }
    for (const c of [...byRoute(t.calls, '/rpc/set_signal_state'), ...byRoute(t.calls, '/api/broadcast')]) {
      expect(c.headers['apikey'], c.url).toBe(cfg.secretKey);
      expect(Object.keys(c.headers).map((k) => k.toLowerCase()), c.url).not.toContain('authorization');
    }
  });

  it('a chave secreta só aparece em chamadas de servidor; o JWT do usuário nunca acompanha a chave secreta', async () => {
    const t = setup(cfg);
    await t.send(`Bearer ${USER_JWT}`);
    for (const c of t.calls) {
      const values = JSON.stringify(c.headers);
      const isServer = c.url.endsWith('/rpc/set_signal_state') || c.url.endsWith('/api/broadcast');
      expect(values.includes(cfg.secretKey), c.url).toBe(isServer);
      if (isServer) expect(values, c.url).not.toContain(USER_JWT);
    }
  });

  it('authorize_signal leva só metadados: sem remetente, sem payload (auth.uid() vem do JWT)', async () => {
    const t = setup(cfg);
    await t.send(`Bearer ${USER_JWT}`);
    const args = byRoute(t.calls, '/rpc/authorize_signal')[0]!.body as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual(['p_client_msg_id', 'p_kind', 'p_pair_epoch', 'p_payload_bytes', 'p_session_id', 'p_to_session_id']);
    expect(JSON.stringify(args)).not.toContain('v=0');
  });
});

describe('credenciais ausentes ou inválidas (negativos)', () => {
  const cfg = loadEdgeConfig(env());

  it.each([
    ['sem Authorization', null],
    ['Authorization vazio', ''],
    ['esquema Basic', `Basic ${USER_JWT}`],
    ['chave secreta como Bearer', `Bearer ${SECRET}`],
    ['chave publicável como Bearer', `Bearer ${PUBLISHABLE}`],
    ['dois tokens', `Bearer ${USER_JWT} ${USER_JWT}`],
  ])('%s → 401 sem NENHUMA chamada ao Supabase', async (_label, authorization) => {
    const t = setup(cfg);
    const res = await t.send(authorization);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized', retryable: false });
    expect(t.calls).toEqual([]);
  });

  it('JWT recusado pelo Auth (401/403) → 401, sem RPC nem publicação', async () => {
    for (const status of [401, 403]) {
      const t = setup(cfg, { user: () => new Response('{}', { status }) });
      expect((await t.send(`Bearer ${USER_JWT}`)).status).toBe(401);
      expect(t.calls.map((c) => c.url.replace(URL_, ''))).toEqual(['/auth/v1/user']);
    }
  });

  it('Auth devolve id que não é UUID → 401', async () => {
    const t = setup(cfg, { user: () => new Response(JSON.stringify({ id: 'admin' }), { status: 200 }) });
    expect((await t.send(`Bearer ${USER_JWT}`)).status).toBe(401);
  });

  it('Auth indisponível (5xx) → 503 retryable, não 401', async () => {
    const t = setup(cfg, { user: () => new Response('{}', { status: 502 }) });
    const res = await t.send(`Bearer ${USER_JWT}`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'auth-unavailable', retryable: true });
  });

  it('PostgREST recusa o JWT na RPC (vencido entre a validação e a chamada) → 401 jwt-invalid, sem publicar', async () => {
    const t = setup(cfg, { authorize: () => new Response(JSON.stringify({ message: 'JWT expired' }), { status: 401 }) });
    const res = await t.send(`Bearer ${USER_JWT}`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'jwt-invalid' });
    expect(byRoute(t.calls, '/api/broadcast')).toEqual([]);
  });

  it('RPC nega por autorização do banco (session-invalid) → 403, sem publicar', async () => {
    const t = setup(cfg, { authorize: () => new Response(JSON.stringify({ code: '42501', message: 'session-invalid' }), { status: 403 }) });
    expect((await t.send(`Bearer ${USER_JWT}`)).status).toBe(403);
    expect(byRoute(t.calls, '/rpc/set_signal_state')).toEqual([]);
  });

  it('chave secreta recusada (401 em set_signal_state) → 503, sem publicar e sem expor detalhes', async () => {
    const t = setup(cfg, { state: () => new Response(JSON.stringify({ message: 'Invalid API key' }), { status: 401 }) });
    const res = await t.send(`Bearer ${USER_JWT}`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'database-unavailable', retryable: true });
    expect(byRoute(t.calls, '/api/broadcast')).toEqual([]);
  });

  it('Broadcast REST recusado → 503 publish-failed e estado failed', async () => {
    const t = setup(cfg, { broadcast: () => new Response('{}', { status: 401 }) });
    const res = await t.send(`Bearer ${USER_JWT}`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'publish-failed', state: 'failed' });
    expect(byRoute(t.calls, '/rpc/set_signal_state').map((c) => (c.body as { p_state: string }).p_state)).toEqual(['publishing', 'failed']);
  });

  it('respostas e logs nunca contêm chaves, JWT ou SDP, em nenhum cenário', async () => {
    const texts: string[] = [];
    const scenarios: Parameters<typeof fakeFetch>[0][] = [
      {},
      { user: () => new Response('{}', { status: 401 }) },
      { authorize: () => new Response(JSON.stringify({ message: 'JWT expired' }), { status: 401 }) },
      { state: () => new Response(JSON.stringify({ message: `bad key ${SECRET}` }), { status: 500 }) },
      { broadcast: () => new Response('{}', { status: 500 }) },
    ];
    for (const routes of scenarios) {
      const t = setup(cfg, routes);
      for (const auth of [`Bearer ${USER_JWT}`, `Bearer ${SECRET}`, null]) texts.push(await (await t.send(auth)).text());
      texts.push(JSON.stringify(t.logs));
    }
    const all = texts.join('\n');
    for (const v of [SECRET, PUBLISHABLE, USER_JWT, 'v=0']) expect(all).not.toContain(v);
  });
});

describe('camada HTTP (CORS e método)', () => {
  const cfg = loadEdgeConfig(env());

  it('preflight de origem permitida → 204 com apikey/x-client-info nos headers permitidos; outra origem → 403', async () => {
    const t = setup(cfg);
    const ok = await t.send(null, { method: 'OPTIONS', origin: ORIGIN });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(ok.headers.get('access-control-allow-headers')).toMatch(/apikey/);
    expect(ok.headers.get('access-control-allow-headers')).toMatch(/x-client-info/);
    const bad = await t.send(null, { method: 'OPTIONS', origin: 'https://evil.example' });
    expect(bad.status).toBe(403);
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
    expect(t.calls).toEqual([]);
  });

  it('método diferente de POST → 405 sem chamadas; resposta POST sem cache', async () => {
    const t = setup(cfg);
    expect((await t.send(`Bearer ${USER_JWT}`, { method: 'GET' })).status).toBe(405);
    expect(t.calls).toEqual([]);
    const res = await t.send(`Bearer ${USER_JWT}`, { origin: 'https://evil.example' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
