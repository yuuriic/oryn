import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Session, User } from '@supabase/supabase-js';
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError } from '@supabase/supabase-js';
import {
  LINK_INVALID, RESET_SENT, RESET_UNAVAILABLE, abandonRecovery, accountName, newPasswordProblem, normalizeDisplayName, openRecovery,
  recoveryAuthOptions, recoveryRedirect, registerAccount, requestPasswordReset, saveAccountName, saveNewPassword, takeAuthLink,
  type IdentityAuth, type RecoveryAuth,
} from '../src/web/identity.ts';

const user = (name?: unknown) => ({ id: 'account-a', user_metadata: name === undefined ? {} : { display_name: name } }) as User;
const session = { user: user('Ana') } as Session;
function auth() {
  return {
    signUp: vi.fn(async () => ({ data: { session: null as Session | null }, error: null as unknown })),
    updateUser: vi.fn(async (args: { data: { display_name: string } }) => ({ data: { user: user(args.data.display_name) as User | null }, error: null as unknown })),
  } satisfies IdentityAuth;
}
describe('nome global', () => {
  it.each(['', '   ', '\u00a0\u3000', '\nAna', 'A\tB', 'A\u007fB', 'A\u0085B', '\ud800', '\udfff', 'x'.repeat(33), null, 12])('recusa %j', (input) => {
    expect(normalizeDisplayName(input)).toBeNull();
  });
  it('normaliza espaços Unicode e conta pontos de código, não UTF-16', () => {
    expect(normalizeDisplayName(' \u00a0 Ana  \u2003 Silva \u3000')).toBe('Ana Silva');
    expect(normalizeDisplayName('🎮'.repeat(32))).toBe('🎮'.repeat(32));
    expect(normalizeDisplayName('🎮'.repeat(33))).toBeNull();
    expect(normalizeDisplayName('<b>Ana</b>')).toBe('<b>Ana</b>'); // renderizado como texto
  });
  it('conta legada ou metadado inválido não inventa nome', () => {
    expect(accountName(user())).toBeNull();
    expect(accountName(user({ role: 'owner' }))).toBeNull();
  });
});
describe('cadastro e perfil', () => {
  it('envia somente os dados próprios do cadastro e aguarda confirmação sem sessão', async () => {
    const a = auth();
    expect(await registerAccount(a, ' a@example.test ', 'password', ' Ana  Silva ')).toEqual({ kind: 'confirm' });
    expect(a.signUp).toHaveBeenCalledWith({ email: 'a@example.test', password: 'password', options: { data: { display_name: 'Ana Silva' } } });
  });
  it('entra quando o Auth entrega sessão; dados retornados sem sessão não autenticam', async () => {
    const a = auth(); a.signUp.mockResolvedValue({ data: { session }, error: null });
    expect(await registerAccount(a, 'a@example.test', 'password', 'Ana')).toEqual({ kind: 'signed-in', session });
  });
  it('nome inválido não chega ao Auth; falhas não expõem sua mensagem', async () => {
    const a = auth();
    expect(await registerAccount(a, 'a@example.test', 'password', ' ')).toEqual({ kind: 'invalid' });
    expect(a.signUp).not.toHaveBeenCalled();
    a.signUp.mockRejectedValue(new Error('segredo'));
    expect(await registerAccount(a, 'a@example.test', 'password', 'Ana')).toEqual({ kind: 'failed' });
  });
  it('atualiza só display_name, sem UUID, papel, e-mail ou metadado de autorização', async () => {
    const a = auth();
    expect((await saveAccountName(a, ' Nova   Ana ')).user?.user_metadata).toEqual({ display_name: 'Nova Ana' });
    expect(a.updateUser).toHaveBeenCalledWith({ data: { display_name: 'Nova Ana' } });
    expect((await saveAccountName(a, ' ')).error).toBeTruthy();
    expect(a.updateUser).toHaveBeenCalledTimes(1);
  });
  it('não confirma sucesso se o Auth devolver dados antigos ou falhar', async () => {
    const a = auth(); a.updateUser.mockResolvedValue({ data: { user: user('Antigo') }, error: null });
    expect((await saveAccountName(a, 'Novo')).error).toBeTruthy();
    a.updateUser.mockRejectedValue(new Error('segredo'));
    expect((await saveAccountName(a, 'Novo')).error).not.toContain('segredo');
  });
  it('retira tokens de confirmação da URL e não os usa para trocar a sessão', () => {
    const replace = vi.fn();
    const confirmed = takeAuthLink({ hash: '#access_token=segredo&refresh_token=r&type=signup', pathname: '/', search: '' }, replace);
    expect(confirmed).toEqual({ kind: 'notice', notice: { tone: 'info', text: expect.stringContaining('Entre') } });
    expect(JSON.stringify(confirmed)).not.toContain('segredo');
    expect(replace).toHaveBeenCalledWith('/');
    expect(takeAuthLink({ hash: '#error=access_denied&error_code=otp_expired', pathname: '/', search: '' }, replace)).toEqual({ kind: 'notice', notice: { tone: 'error', text: LINK_INVALID } });
    replace.mockClear();
    expect(takeAuthLink({ hash: '#convite=abc', pathname: '/', search: '' }, replace)).toEqual({ kind: 'none' });
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('links de recuperação', () => {
  it('tira os tokens da URL (mantendo a query) e os devolve só em memória', () => {
    const replace = vi.fn();
    const link = takeAuthLink({ hash: '#access_token=a.b-c_d&expires_in=3600&refresh_token=r1&token_type=bearer&type=recovery', pathname: '/app', search: '?x=1' }, replace);
    expect(link).toEqual({ kind: 'recovery', tokens: { accessToken: 'a.b-c_d', refreshToken: 'r1' } });
    expect(replace).toHaveBeenCalledWith('/app?x=1');
  });
  it.each([
    ['sem refresh token', '#access_token=a&type=recovery'],
    ['token vazio', '#access_token=&refresh_token=r&type=recovery'],
    ['caracteres estranhos', '#access_token=a%3Cscript%3E&refresh_token=r&type=recovery'],
    ['erro do Auth', '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid&type=recovery'],
  ])('link de recuperação inválido não abre o formulário: %s', (_label, hash) => {
    const replace = vi.fn();
    expect(takeAuthLink({ hash, pathname: '/', search: '' }, replace)).toEqual({ kind: 'notice', notice: { tone: 'error', text: LINK_INVALID } });
    expect(replace).toHaveBeenCalledWith('/');
  });
  it('cliente da recuperação não persiste, não renova sozinho, não lê a URL e usa outra chave', () => {
    expect(recoveryAuthOptions()).toEqual({ persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'oryn.recovery' });
  });
  it('destino do link: a própria página, sem query nem fragmento; só https ou http local', () => {
    expect(recoveryRedirect({ protocol: 'https:', hostname: 'oryn-yuuriic.vercel.app', origin: 'https://oryn-yuuriic.vercel.app', pathname: '/' })).toBe('https://oryn-yuuriic.vercel.app/');
    expect(recoveryRedirect({ protocol: 'http:', hostname: '127.0.0.1', origin: 'http://127.0.0.1:5173', pathname: '/' })).toBe('http://127.0.0.1:5173/');
    expect(recoveryRedirect({ protocol: 'http:', hostname: 'oryn.example', origin: 'http://oryn.example', pathname: '/' })).toBeUndefined();
    expect(recoveryRedirect({ protocol: 'file:', hostname: '', origin: 'null', pathname: '/index.html' })).toBeUndefined();
  });
});

describe('pedido de recuperação', () => {
  const resetAuth = (result: unknown = { data: {}, error: null }) => ({ resetPasswordForEmail: vi.fn(async () => result as { error: unknown }) });
  it('envia só o e-mail aparado e o destino permitido', async () => {
    const a = resetAuth();
    expect(await requestPasswordReset(a, ' a@example.test ', 'https://oryn-yuuriic.vercel.app/')).toEqual({ tone: 'info', text: RESET_SENT });
    expect(a.resetPasswordForEmail).toHaveBeenCalledWith('a@example.test', { redirectTo: 'https://oryn-yuuriic.vercel.app/' });
    await requestPasswordReset(a, 'a@example.test', undefined);
    expect(a.resetPasswordForEmail).toHaveBeenLastCalledWith('a@example.test', {});
  });
  it('e-mail vazio não chega ao Auth', async () => {
    const a = resetAuth();
    expect((await requestPasswordReset(a, '   ', undefined)).tone).toBe('error');
    expect(a.resetPasswordForEmail).not.toHaveBeenCalled();
  });
  it('sem enumeração: conta inexistente, limite por e-mail e falha de envio dão a mesma resposta', async () => {
    const answers = await Promise.all([
      requestPasswordReset(resetAuth({ data: {}, error: null }), 'nao-existe@example.test', undefined),
      requestPasswordReset(resetAuth({ data: null, error: new AuthApiError('For security purposes, you can only request this after 60 seconds.', 429, 'over_email_send_rate_limit') }), 'a@example.test', undefined),
      requestPasswordReset(resetAuth({ data: null, error: new AuthApiError('Error sending recovery email', 500, 'unexpected_failure') }), 'a@example.test', undefined),
    ]);
    expect(answers).toEqual([{ tone: 'info', text: RESET_SENT }, { tone: 'info', text: RESET_SENT }, { tone: 'info', text: RESET_SENT }]);
  });
  it('só a falta de conexão muda a mensagem, sem repetir o erro do Auth', async () => {
    expect(await requestPasswordReset(resetAuth({ data: null, error: new AuthRetryableFetchError('Failed to fetch a@example.test', 0) }), 'a@example.test', undefined)).toEqual({ tone: 'error', text: RESET_UNAVAILABLE });
    const thrown = { resetPasswordForEmail: vi.fn(async () => { throw new Error('a@example.test'); }) };
    expect(await requestPasswordReset(thrown, 'a@example.test', undefined)).toEqual({ tone: 'error', text: RESET_UNAVAILABLE });
  });
});

describe('nova senha', () => {
  function recoveryAuth() {
    return {
      setSession: vi.fn(async () => ({ data: { session: session as Session | null }, error: null as unknown })),
      updateUser: vi.fn(async () => ({ data: { user: user('Ana') as User | null }, error: null as unknown })),
      signOut: vi.fn(async () => ({ error: null as unknown })),
    } satisfies RecoveryAuth;
  }
  it('valida tamanho e confirmação, contando caracteres e o limite de 72 bytes', () => {
    expect(newPasswordProblem('1234567', '1234567')).toMatch(/8/);
    expect(newPasswordProblem('12345678', '12345679')).toMatch(/não conferem/);
    expect(newPasswordProblem('12345678', '12345678')).toBeNull();
    expect(newPasswordProblem('🎮'.repeat(8), '🎮'.repeat(8))).toBeNull();
    expect(newPasswordProblem('ç'.repeat(37), 'ç'.repeat(37))).toMatch(/72 bytes/);
  });
  it('o link só vale depois de o servidor confirmar a sessão de recuperação', async () => {
    const a = recoveryAuth();
    expect(await openRecovery(a, { accessToken: 'a', refreshToken: 'r' })).toBe(true);
    expect(a.setSession).toHaveBeenCalledWith({ access_token: 'a', refresh_token: 'r' });
    a.setSession.mockResolvedValue({ data: { session: null }, error: new AuthApiError('invalid JWT', 403, 'bad_jwt') });
    expect(await openRecovery(a, { accessToken: 'a', refreshToken: 'r' })).toBe(false);
    a.setSession.mockResolvedValue({ data: { session: null }, error: null });
    expect(await openRecovery(a, { accessToken: 'a', refreshToken: 'r' })).toBe(false);
    a.setSession.mockRejectedValue(new Error('rede'));
    expect(await openRecovery(a, { accessToken: 'a', refreshToken: 'r' })).toBe(false);
  });
  it('senha inválida não chega ao Auth', async () => {
    const a = recoveryAuth();
    expect(await saveNewPassword(a, 'curta', 'curta')).toEqual({ kind: 'retry', text: expect.stringMatching(/8/) });
    expect(await saveNewPassword(a, '12345678', 'outra-senha')).toEqual({ kind: 'retry', text: expect.stringMatching(/conferem/) });
    expect(a.updateUser).not.toHaveBeenCalled();
  });
  it('troca só a senha e depois encerra todas as sessões da conta', async () => {
    const a = recoveryAuth();
    expect(await saveNewPassword(a, 'nova-senha-1', 'nova-senha-1')).toEqual({ kind: 'done', signedOut: true });
    expect(a.updateUser).toHaveBeenCalledWith({ password: 'nova-senha-1' });
    expect(a.signOut).toHaveBeenCalledWith({ scope: 'global' });
    expect(a.updateUser.mock.invocationCallOrder[0]).toBeLessThan(a.signOut.mock.invocationCallOrder[0]!);
  });
  it('senha trocada mesmo se o encerramento falhar: avisa, não esconde', async () => {
    const a = recoveryAuth();
    a.signOut.mockResolvedValue({ error: new AuthRetryableFetchError('rede', 0) });
    expect(await saveNewPassword(a, 'nova-senha-1', 'nova-senha-1')).toEqual({ kind: 'done', signedOut: false });
    a.signOut.mockRejectedValue(new Error('rede'));
    expect(await saveNewPassword(a, 'nova-senha-1', 'nova-senha-1')).toEqual({ kind: 'done', signedOut: false });
  });
  it.each([
    ['same_password', 422, /diferente/],
    ['weak_password', 422, /fraca/],
  ])('recusa do servidor (%s) permite tentar de novo, sem encerrar sessões', async (code, status, text) => {
    const a = recoveryAuth();
    a.updateUser.mockResolvedValue({ data: { user: null }, error: new AuthApiError('detalhe interno', status, code) });
    expect(await saveNewPassword(a, 'nova-senha-1', 'nova-senha-1')).toEqual({ kind: 'retry', text: expect.stringMatching(text) });
    expect(a.signOut).not.toHaveBeenCalled();
  });
  it.each([
    ['sessão inexistente', new AuthApiError('x', 403, 'session_not_found')],
    ['JWT inválido', new AuthApiError('x', 401, 'bad_jwt')],
    ['sessão expirada', new AuthApiError('x', 400, 'session_expired')],
    ['sessão ausente (como o supabase-js entrega session_not_found)', new AuthSessionMissingError()],
  ])('%s: link expirado, sem troca', async (_label, error) => {
    const a = recoveryAuth();
    a.updateUser.mockResolvedValue({ data: { user: null }, error });
    expect(await saveNewPassword(a, 'nova-senha-1', 'nova-senha-1')).toEqual({ kind: 'expired' });
    expect(a.signOut).not.toHaveBeenCalled();
  });
  it('falha de rede ou erro desconhecido: mensagem fixa, sem o texto do Auth', async () => {
    const a = recoveryAuth();
    a.updateUser.mockResolvedValue({ data: { user: null }, error: new AuthRetryableFetchError('a@example.test', 0) });
    const offline = await saveNewPassword(a, 'nova-senha-1', 'nova-senha-1');
    expect(offline).toEqual({ kind: 'retry', text: RESET_UNAVAILABLE });
    a.updateUser.mockResolvedValue({ data: { user: null }, error: new AuthApiError('a@example.test vazou', 500, 'unexpected_failure') });
    const unknown = await saveNewPassword(a, 'nova-senha-1', 'nova-senha-1');
    expect(unknown.kind).toBe('retry');
    expect(JSON.stringify(unknown)).not.toContain('example.test');
  });
  it('desistir invalida só a sessão temporária, mesmo com falha de rede', async () => {
    const a = recoveryAuth();
    await abandonRecovery(a);
    expect(a.signOut).toHaveBeenCalledWith({ scope: 'local' });
    a.signOut.mockRejectedValue(new Error('rede'));
    await expect(abandonRecovery(a)).resolves.toBeUndefined();
    expect(a.updateUser).not.toHaveBeenCalled();
  });
});

describe('ligação da recuperação na página', () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const main = read('src/web/main.ts');
  it('o link sai da URL no carregamento e, com recuperação, a sessão guardada só é restaurada no fim', () => {
    expect(main).toMatch(/const authLink = takeAuthLink\(window\.location/);
    expect(main).toMatch(/if \(authLink\.kind === 'recovery'\) void beginRecovery\(authLink\.tokens\);\s*else restoreLogin\(\);/);
    expect(/function finishRecovery[\s\S]*?\n\}\n/.exec(main)?.[0] ?? '').toMatch(/recovery = null;[\s\S]*restoreLogin\(\)/);
  });
  it('a recuperação usa um cliente próprio, nunca o armazenamento da sessão de login', () => {
    const begin = /async function beginRecovery[\s\S]*?\n\}\n/.exec(main)?.[0] ?? '';
    expect(begin).toMatch(/createClient\(cfg\.supabaseUrl, cfg\.publishableKey, \{ auth: recoveryAuthOptions\(\) \}\)/);
    expect(begin).not.toMatch(/authStorage|authOptions\(/);
    expect(begin.indexOf('openRecovery(')).toBeLessThan(begin.indexOf('ui.resetBtn.disabled = false'));
  });
  it('os campos de senha são limpos antes de chamar o Auth', () => {
    const submit = /ui\.resetForm\.addEventListener\('submit'[\s\S]*?\n\}\);\n/.exec(main)?.[0] ?? '';
    expect(submit.indexOf("ui.resetPassword.value = ''")).toBeLessThan(submit.indexOf('saveNewPassword('));
    expect(submit.indexOf("ui.resetConfirm.value = ''")).toBeLessThan(submit.indexOf('saveNewPassword('));
  });
  it('pedido e troca de senha só no módulo de identidade', () => {
    for (const f of readdirSync(new URL('../src/web/', import.meta.url)).filter((n) => n.endsWith('.ts') && n !== 'identity.ts')) {
      expect(read(`src/web/${f}`), f).not.toMatch(/resetPasswordForEmail|updateUser\(\s*\{\s*password/);
    }
  });
});
