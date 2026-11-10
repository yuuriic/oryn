// Recuperação de senha com o supabase-js REAL: só a rede é simulada. Confere o que vai para o Auth e que a sessão
// temporária não toca no armazenamento da sessão de login.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { abandonRecovery, openRecovery, recoveryAuthOptions, requestPasswordReset, saveNewPassword, takeAuthLink, RESET_SENT } from '../src/web/identity.ts';

const URL_BASE = 'http://127.0.0.1:54321';
const USER = { id: '0c2a0000-0000-4000-8000-00000000000b', aud: 'authenticated', role: 'authenticated', email: 'a@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-11-10T00:00:00Z' };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const nowS = () => Math.floor(Date.now() / 1000);
const jwt = (exp: number) => `${b64({ alg: 'HS256' })}.${b64({ sub: USER.id, exp, role: 'authenticated', amr: [{ method: 'recovery' }] })}.assinatura`;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call { method: string; path: string; query: URLSearchParams; auth: string | null; body: unknown }
function fakeAuth(handle: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const call = { method: init?.method ?? 'GET', path: url.pathname, query: url.searchParams, auth: headers.get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    return handle(call);
  };
  return { calls, fetch };
}
const client = (fetch: typeof globalThis.fetch, auth: object): SupabaseClient => createClient(URL_BASE, 'sb_publishable_chave', { auth, global: { fetch } });

describe('pedido de recuperação com o supabase-js real', () => {
  it('POST /recover só com o e-mail; destino vai como redirect_to', async () => {
    const net = fakeAuth(() => json(200, {}));
    const login = client(net.fetch, { persistSession: false, autoRefreshToken: false });
    expect(await requestPasswordReset(login.auth, ' a@example.com ', 'https://oryn-yuuriic.vercel.app/')).toEqual({ tone: 'info', text: RESET_SENT });
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]).toMatchObject({ method: 'POST', path: '/auth/v1/recover' });
    expect(net.calls[0]!.query.get('redirect_to')).toBe('https://oryn-yuuriic.vercel.app/');
    // A biblioteca acrescenta campos neutros (PKCE nulo, captcha vazio); nada além do e-mail vem do Oryn.
    expect(net.calls[0]!.body).toEqual({ email: 'a@example.com', code_challenge: null, code_challenge_method: null, gotrue_meta_security: {} });
  });
  it('limite por e-mail (429) do servidor real dá a mesma resposta da conta inexistente', async () => {
    const net = fakeAuth(() => json(429, { code: 429, error_code: 'over_email_send_rate_limit', msg: 'For security purposes, you can only request this after 59 seconds.' }));
    const login = client(net.fetch, { persistSession: false, autoRefreshToken: false });
    expect(await requestPasswordReset(login.auth, 'a@example.com', undefined)).toEqual({ tone: 'info', text: RESET_SENT });
  });
});

describe('link e troca de senha com o supabase-js real', () => {
  const linkHash = (token: string) => `#access_token=${token}&expires_at=${nowS() + 3600}&expires_in=3600&refresh_token=rt-recovery&token_type=bearer&type=recovery`;

  it('valida o link no servidor, troca só a senha, encerra todas as sessões e nada fica guardado', async () => {
    const token = jwt(nowS() + 3600);
    const link = takeAuthLink({ hash: linkHash(token), pathname: '/', search: '' }, () => undefined);
    if (link.kind !== 'recovery') throw new Error('link de recuperação não reconhecido');
    const net = fakeAuth((c) => {
      if (c.path === '/auth/v1/user' && c.method === 'GET') return json(200, USER);
      if (c.path === '/auth/v1/user' && c.method === 'PUT') return json(200, USER);
      if (c.path === '/auth/v1/logout') return new Response(null, { status: 204 });
      return json(404, {});
    });
    const recovery = client(net.fetch, recoveryAuthOptions());
    expect(await openRecovery(recovery.auth, link.tokens)).toBe(true);
    expect(await saveNewPassword(recovery.auth, 'nova-senha-1', 'nova-senha-1')).toEqual({ kind: 'done', signedOut: true });
    expect(net.calls.map((c) => `${c.method} ${c.path}${c.query.get('scope') ? `?scope=${c.query.get('scope')}` : ''}`)).toEqual([
      'GET /auth/v1/user', 'PUT /auth/v1/user', 'POST /auth/v1/logout?scope=global',
    ]);
    expect(net.calls.every((c) => c.auth === `Bearer ${token}`)).toBe(true);
    // Só a senha: nenhum e-mail, telefone ou metadado (o resto são campos PKCE nulos da própria biblioteca).
    expect(net.calls[1]!.body).toEqual({ password: 'nova-senha-1', code_challenge: null, code_challenge_method: null });
    expect((await recovery.auth.getSession()).data.session).toBeNull();
  });

  it('link recusado pelo servidor (403) não abre o formulário e nenhuma senha é enviada', async () => {
    const net = fakeAuth((c) => (c.path === '/auth/v1/user' ? json(403, { code: 403, error_code: 'bad_jwt', msg: 'invalid JWT' }) : json(404, {})));
    const recovery = client(net.fetch, recoveryAuthOptions());
    expect(await openRecovery(recovery.auth, { accessToken: jwt(nowS() + 3600), refreshToken: 'rt-recovery' })).toBe(false);
    expect(net.calls.filter((c) => c.method === 'PUT')).toEqual([]);
  });

  it('token de acesso vencido: renova com o refresh do link; refresh já usado = link inválido', async () => {
    const fresh = { access_token: jwt(nowS() + 3600), refresh_token: 'rt-2', token_type: 'bearer', expires_in: 3600, expires_at: nowS() + 3600, user: USER };
    const ok = fakeAuth((c) => (c.query.get('grant_type') === 'refresh_token' ? json(200, fresh) : json(404, {})));
    expect(await openRecovery(client(ok.fetch, recoveryAuthOptions()).auth, { accessToken: jwt(nowS() - 10), refreshToken: 'rt-recovery' })).toBe(true);
    expect(ok.calls[0]!.body).toEqual({ refresh_token: 'rt-recovery' });
    const used = fakeAuth(() => json(400, { code: 400, error_code: 'refresh_token_already_used', msg: 'Invalid Refresh Token: Already Used' }));
    expect(await openRecovery(client(used.fetch, recoveryAuthOptions()).auth, { accessToken: jwt(nowS() - 10), refreshToken: 'rt-recovery' })).toBe(false);
  });

  it('sessão de recuperação encerrada no servidor: troca recusada vira "link expirado"', async () => {
    const net = fakeAuth((c) => {
      if (c.method === 'GET') return json(200, USER);
      if (c.method === 'PUT') return json(403, { code: 403, error_code: 'session_not_found', msg: 'Session from session_id claim in JWT does not exist' });
      return json(404, {});
    });
    const recovery = client(net.fetch, recoveryAuthOptions());
    expect(await openRecovery(recovery.auth, { accessToken: jwt(nowS() + 3600), refreshToken: 'rt-recovery' })).toBe(true);
    expect(await saveNewPassword(recovery.auth, 'nova-senha-1', 'nova-senha-1')).toEqual({ kind: 'expired' });
    expect(net.calls.some((c) => c.path === '/auth/v1/logout')).toBe(false);
  });

  it('mesma senha (422 same_password): pode tentar outra, sessão continua aberta', async () => {
    const net = fakeAuth((c) => {
      if (c.method === 'GET') return json(200, USER);
      if (c.method === 'PUT') return json(422, { code: 422, error_code: 'same_password', msg: 'New password should be different from the old password.' });
      return json(404, {});
    });
    const recovery = client(net.fetch, recoveryAuthOptions());
    await openRecovery(recovery.auth, { accessToken: jwt(nowS() + 3600), refreshToken: 'rt-recovery' });
    expect(await saveNewPassword(recovery.auth, 'mesma-senha', 'mesma-senha')).toEqual({ kind: 'retry', text: expect.stringMatching(/diferente/) });
  });

  it('cancelar encerra só a sessão temporária (scope=local)', async () => {
    const net = fakeAuth((c) => (c.method === 'GET' ? json(200, USER) : new Response(null, { status: 204 })));
    const recovery = client(net.fetch, recoveryAuthOptions());
    await openRecovery(recovery.auth, { accessToken: jwt(nowS() + 3600), refreshToken: 'rt-recovery' });
    await abandonRecovery(recovery.auth);
    expect(net.calls.at(-1)).toMatchObject({ method: 'POST', path: '/auth/v1/logout' });
    expect(net.calls.at(-1)!.query.get('scope')).toBe('local');
    expect(net.calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});
