import { describe, expect, it, vi } from 'vitest';
import type { Session, User } from '@supabase/supabase-js';
import { accountName, normalizeDisplayName, registerAccount, saveAccountName, takeConfirmation, type IdentityAuth } from '../src/web/identity.ts';

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
    expect(takeConfirmation({ hash: '#access_token=segredo&type=signup', pathname: '/', search: '' }, replace)).toContain('Entre');
    expect(replace).toHaveBeenCalledWith('/');
    expect(takeConfirmation({ hash: '#error=access_denied&error_code=otp_expired', pathname: '/', search: '' }, replace)).toContain('expirado');
    replace.mockClear();
    expect(takeConfirmation({ hash: '#convite=abc', pathname: '/', search: '' }, replace)).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });
});
