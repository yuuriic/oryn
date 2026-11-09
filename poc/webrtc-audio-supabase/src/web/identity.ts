// Nome global é apresentação, nunca autorização. Mesma normalização da migração de identidade.
import type { Session, User } from '@supabase/supabase-js';

export const NAME_ERROR = 'Use um nome de 1 a 32 caracteres, sem caracteres de controle.';
const spaces = /[ \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g;
export function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value) || /[\ud800-\udfff]/u.test(value)) return null;
  const name = value.replace(spaces, ' ').replace(/^ | $/g, '');
  return [...name].length >= 1 && [...name].length <= 32 ? name : null;
}
export function accountName(user: Pick<User, 'user_metadata'>): string | null {
  return normalizeDisplayName(user.user_metadata?.['display_name']);
}

/** Confirmação por link não troca a conta desta aba. Remove credenciais do fragmento
 * e pede login normal; detectSessionInUrl continua desligado. */
export function takeConfirmation(location: { hash: string; pathname: string; search: string }, replaceUrl: (url: string) => void): string | null {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has('access_token') && !params.has('error_code') && !params.has('error')) return null;
  replaceUrl(`${location.pathname}${location.search}`);
  return params.has('error') || params.has('error_code') ? 'Link de confirmação inválido ou expirado. Tente entrar ou solicite ajuda.' : 'Confirmação recebida. Entre com seu e-mail e senha.';
}

export interface IdentityAuth {
  signUp(args: { email: string; password: string; options: { data: { display_name: string } } }): PromiseLike<{ data: { session: Session | null }; error: unknown }>;
  updateUser(args: { data: { display_name: string } }): PromiseLike<{ data: { user: User | null }; error: unknown }>;
}
export type SignupResult = { kind: 'invalid' | 'failed' | 'confirm' } | { kind: 'signed-in'; session: Session };
export async function registerAccount(auth: IdentityAuth, email: string, password: string, input: string): Promise<SignupResult> {
  const name = normalizeDisplayName(input);
  if (!name) return { kind: 'invalid' };
  try {
    const { data, error } = await auth.signUp({ email: email.trim(), password, options: { data: { display_name: name } } });
    if (error) return { kind: 'failed' };
    // Não revela se o endereço já existe: o Auth pode devolver um usuário ofuscado sem sessão.
    return data.session ? { kind: 'signed-in', session: data.session } : { kind: 'confirm' };
  } catch { return { kind: 'failed' }; }
}
export async function saveAccountName(auth: IdentityAuth, input: string): Promise<{ user: User | null; error: string | null }> {
  const name = normalizeDisplayName(input);
  if (!name) return { user: null, error: NAME_ERROR };
  try {
    const { data, error } = await auth.updateUser({ data: { display_name: name } });
    if (!error && data.user && accountName(data.user) === name) return { user: data.user, error: null };
  } catch { /* Só mensagem fixa: erros do Auth podem conter dados da conta. */ }
  return { user: null, error: 'Não foi possível salvar o nome. Confira a conexão e tente novamente.' };
}
