// Sessão de login persistida pelo mecanismo oficial do Supabase Auth: supabase-js REAL, só a rede é simulada.
import { readFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTH_STORAGE_KEY, authOptions, createAuthStorage, logout, restoreSession, type AuthStorage } from '../src/web/auth-session.ts';

const URL_BASE = 'http://127.0.0.1:54321';
const USER = { id: '0c2a0000-0000-4000-8000-00000000000a', aud: 'authenticated', role: 'authenticated', email: 'a@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-11-04T00:00:00Z' };

function jwt(expSeconds: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64({ sub: USER.id, exp: expSeconds, role: 'authenticated' })}.assinatura`;
}
const nowS = () => Math.floor(Date.now() / 1000);
const session = (expiresIn: number, tag = '1') => ({ access_token: jwt(nowS() + expiresIn), refresh_token: `refresh-${tag}`, token_type: 'bearer', expires_in: expiresIn, expires_at: nowS() + expiresIn, user: USER });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

class MemoryStore {
  readonly data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
}

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
const clients: SupabaseClient[] = [];

/** Cada chamada é como um carregamento novo da página: outro cliente sobre o mesmo armazenamento. */
function page(store: MemoryStore | (() => MemoryStore | null), route: Route): { client: SupabaseClient; storage: AuthStorage } {
  const storage = createAuthStorage(typeof store === 'function' ? store : () => store);
  const client = createClient(URL_BASE, 'sb_publishable_chave', {
    auth: { ...authOptions(storage), autoRefreshToken: false },
    global: { fetch: async (input, init) => route(String(input), init) },
  });
  clients.push(client);
  return { client, storage };
}
const okRoutes: Route = (url) => {
  if (url.includes('grant_type=password')) return json(200, session(3600));
  if (url.includes('/auth/v1/user')) return json(200, USER);
  if (url.includes('/auth/v1/logout')) return new Response(null, { status: 204 });
  return json(404, {});
};
async function loggedIn(store: MemoryStore): Promise<void> {
  const { client } = page(store, okRoutes);
  const { error } = await client.auth.signInWithPassword({ email: 'a@example.com', password: 'senha-de-teste' });
  expect(error).toBeNull();
}

afterEach(async () => {
  clients.splice(0);
  vi.restoreAllMocks();
});

describe('configuração', () => {
  it('usa a persistência oficial, com renovação automática e sem ler sessão da URL', () => {
    const options = authOptions(createAuthStorage(() => new MemoryStore()));
    expect(options).toMatchObject({ persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: AUTH_STORAGE_KEY });
  });
  it('a senha nunca é gravada: o armazenamento recebe só a sessão, numa única chave', async () => {
    const store = new MemoryStore();
    await loggedIn(store);
    expect([...store.data.keys()].every((k) => k.startsWith(AUTH_STORAGE_KEY))).toBe(true);
    expect([...store.data.values()].join()).not.toContain('senha-de-teste');
  });
});

describe('restoreSession', () => {
  it('sem sessão guardada: pede login, sem ir ao servidor', async () => {
    const route = vi.fn(okRoutes);
    const { client, storage } = page(new MemoryStore(), route);
    expect((await restoreSession(client, storage)).status).toBe('none');
    expect(route).not.toHaveBeenCalled();
  });

  it('F5 ou reabertura: a sessão volta e é confirmada no servidor', async () => {
    const store = new MemoryStore();
    await loggedIn(store);
    const route = vi.fn(okRoutes);
    const { client, storage } = page(store, route);
    const restored = await restoreSession(client, storage);
    expect(restored.status).toBe('valid');
    expect(restored.status === 'valid' && restored.session.user.id).toBe(USER.id);
    expect(route.mock.calls.some(([u]) => u.includes('/auth/v1/user'))).toBe(true);
  });

  it('token de acesso expirado: renova pelo refresh token e segue', async () => {
    const store = new MemoryStore();
    store.setItem(AUTH_STORAGE_KEY, JSON.stringify(session(-120, 'antigo')));
    const novo = session(3600, 'novo');
    const { client, storage } = page(store, (url) => (url.includes('grant_type=refresh_token') ? json(200, novo) : okRoutes(url)));
    const restored = await restoreSession(client, storage);
    expect(restored.status).toBe('valid');
    expect(restored.status === 'valid' && restored.session.refresh_token).toBe('refresh-novo');
    expect(store.getItem(AUTH_STORAGE_KEY)).toContain('refresh-novo');
  });

  it('refresh token revogado: limpa tudo e pede login', async () => {
    const store = new MemoryStore();
    store.setItem(AUTH_STORAGE_KEY, JSON.stringify(session(-120)));
    const { client, storage } = page(store, () => json(400, { code: 'refresh_token_not_found', error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' }));
    expect((await restoreSession(client, storage)).status).toBe('revoked');
    expect(store.data.size).toBe(0);
  });

  it('sessão revogada no servidor com token ainda válido: getUser recusa, limpa tudo e pede login', async () => {
    for (const status of [401, 403]) {
      const store = new MemoryStore();
      await loggedIn(store);
      const { client, storage } = page(store, (url) => (url.includes('/auth/v1/user') ? json(status, { error_code: 'session_not_found', msg: 'x' }) : okRoutes(url)));
      expect((await restoreSession(client, storage)).status, String(status)).toBe('revoked');
      expect(store.data.size, String(status)).toBe(0);
    }
  });

  it('sem rede com token válido: entra sem confirmação e guarda a sessão', async () => {
    const store = new MemoryStore();
    await loggedIn(store);
    const { client, storage } = page(store, () => {
      throw new TypeError('fetch failed');
    });
    expect((await restoreSession(client, storage)).status).toBe('unverified');
    expect(store.getItem(AUTH_STORAGE_KEY)).not.toBeNull();
  });

  it('sem rede com token expirado: não entra, mas não perde a sessão', async () => {
    const store = new MemoryStore();
    store.setItem(AUTH_STORAGE_KEY, JSON.stringify(session(-120)));
    const { client, storage } = page(store, () => {
      throw new TypeError('fetch failed');
    });
    expect((await restoreSession(client, storage)).status).toBe('unavailable');
    expect(store.getItem(AUTH_STORAGE_KEY)).not.toBeNull();
  });
});

it('recarga usa o nome atual do servidor, alterado em outro dispositivo, sem trocar tokens nem identidade', async () => {
  const store = new MemoryStore();
  await loggedIn(store);
  const { client, storage } = page(store, (url) => url.includes('/auth/v1/user') ? json(200, { ...USER, user_metadata: { display_name: 'Nome atualizado' } }) : okRoutes(url));
  const restored = await restoreSession(client, storage);
  expect(restored.status).toBe('valid');
  if (restored.status !== 'valid') throw new Error('Sessão não restaurada');
  expect(restored.session.user.id).toBe(USER.id);
  expect(restored.session.user.user_metadata['display_name']).toBe('Nome atualizado');
  expect(restored.session.refresh_token).toBe('refresh-1');
});

describe('logout', () => {
  it('encerra a sessão no servidor e remove tudo do navegador', async () => {
    const store = new MemoryStore();
    await loggedIn(store);
    const route = vi.fn(okRoutes);
    const { client, storage } = page(store, route);
    await logout(client, storage);
    expect(route.mock.calls.some(([u]) => u.includes('/auth/v1/logout'))).toBe(true);
    expect(store.data.size).toBe(0);
    expect((await restoreSession(client, storage)).status).toBe('none');
  });

  it('servidor fora do ar ou erro 500: o navegador fica limpo do mesmo jeito', async () => {
    for (const route of [(() => {
      throw new TypeError('fetch failed');
    }) as Route, (() => json(500, {})) as Route]) {
      const store = new MemoryStore();
      await loggedIn(store);
      const { client, storage } = page(store, route);
      await logout(client, storage);
      expect(store.data.size).toBe(0);
    }
  });

  it('limpa também as chaves auxiliares do Auth, sem tocar em chaves de outros', async () => {
    const store = new MemoryStore();
    store.setItem(`${AUTH_STORAGE_KEY}-code-verifier`, 'x');
    store.setItem(`${AUTH_STORAGE_KEY}-user`, 'x');
    store.setItem('outra-chave', 'y');
    createAuthStorage(() => store).purge();
    expect([...store.data.keys()]).toEqual(['outra-chave']);
  });
});

describe('armazenamento indisponível', () => {
  it('acesso negado ou cota cheia: a sessão fica em memória, sem lançar, e não sobrevive à recarga', async () => {
    const denied = () => {
      throw new DOMException('negado', 'SecurityError');
    };
    const full = new MemoryStore();
    full.setItem = () => {
      throw new DOMException('cheio', 'QuotaExceededError');
    };
    for (const getStore of [denied as () => MemoryStore, () => full, () => null]) {
      const s = createAuthStorage(getStore);
      expect(() => s.setItem(AUTH_STORAGE_KEY, 'v')).not.toThrow();
      expect(s.getItem(AUTH_STORAGE_KEY)).toBe('v');
      expect(() => s.purge()).not.toThrow();
      expect(s.getItem(AUTH_STORAGE_KEY)).toBeNull();
      expect(createAuthStorage(getStore).getItem(AUTH_STORAGE_KEY)).toBeNull();
    }
  });
});

describe('ligação na página', () => {
  const main = readFileSync(new URL('../src/web/main.ts', import.meta.url), 'utf8');
  it('entrada e saída passam pelo módulo de sessão; logout também limpa o retorno', () => {
    expect(main).toMatch(/createClient\(cfg\.supabaseUrl, cfg\.publishableKey, \{ auth: authOptions\(authStorage\) \}\)/);
    expect(main).toMatch(/restoreSession\(client, authStorage\)/);
    const out = /ui\.logoutBtn\.addEventListener[\s\S]*?\n\}\);\n/.exec(main)?.[0] ?? '';
    expect(out).toMatch(/callReturn\.forget\(\)/);
    expect(out).toMatch(/logout\(client, authStorage\)/);
  });
  it('fim da sessão vindo do Auth (revogada ou logout em outra aba) encerra a chamada e limpa o retorno', () => {
    const handler = /onAuthStateChange\(\(event, session\) => \{[\s\S]*?\n {2}\}\);\n/.exec(main)?.[0] ?? '';
    expect(handler).toMatch(/SIGNED_OUT/);
    expect(handler).toMatch(/endByAuth\(/);
    expect(/function endByAuth[\s\S]*?\n\}\n/.exec(main)?.[0] ?? '').toMatch(/callReturn\.forget\(\)[\s\S]*call\?\.end\(\)/);
  });
  it('regressão: sem sessão no Auth, a saída da sala ainda vai com o último JWT, para não deixar sessão fantasma', () => {
    // O supabase-js deixa de enviar o token assim que a sessão é limpa e o leave_room recebia 401.
    const end = /function endByAuth[\s\S]*?\n\}\n/.exec(main)?.[0] ?? '';
    expect(end.indexOf('signaling?.closeOnPageHide()')).toBeGreaterThanOrEqual(0);
    expect(end.indexOf('signaling?.closeOnPageHide()')).toBeLessThan(end.indexOf('call?.end()'));
    expect(main).toMatch(/accessToken = session\?\.access_token \?\? accessToken;/);
    expect(/function showLoggedOut[\s\S]*?\n\}\n/.exec(main)?.[0] ?? '').toMatch(/accessToken = null;/);
  });
  it('restaurar a sessão não inicia chamada nem microfone', () => {
    const enter = /async function enterSession[\s\S]*?\n\}\n/.exec(main)?.[0] ?? '';
    expect(enter).toMatch(/callReturn\.offer\(\)/);
    expect(enter).not.toMatch(/startCall|getUserMedia|accept\(\)/);
  });
});
