// Nome global é apresentação, nunca autorização. Mesma normalização da migração de identidade.
// Também concentra os links do Auth (confirmação e recuperação de senha) e a troca de senha.
import { isAuthRetryableFetchError, isAuthSessionMissingError, type Session, type User } from '@supabase/supabase-js';

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

export interface Notice { tone: 'info' | 'error'; text: string }
export interface RecoveryTokens { readonly accessToken: string; readonly refreshToken: string }
export type AuthLink = { kind: 'none' } | { kind: 'notice'; notice: Notice } | { kind: 'recovery'; tokens: RecoveryTokens };

/** O erro do Auth não diz de que link veio: a mensagem cobre confirmação e recuperação. */
export const LINK_INVALID = 'Link inválido ou expirado. Para confirmar a conta, tente entrar; para trocar a senha, peça um novo link em "Esqueci minha senha".';
const LINK_CONFIRMED = 'Confirmação recebida. Entre com seu e-mail e senha.';
const TOKEN = /^[A-Za-z0-9._-]{1,4096}$/;

/** Primeiro passo da página: tira as credenciais do fragmento antes de qualquer outra coisa. A confirmação não troca
 * a conta desta aba (pede login normal); a recuperação só devolve os tokens, que ficam em memória. detectSessionInUrl
 * continua desligado. */
export function takeAuthLink(location: { hash: string; pathname: string; search: string }, replaceUrl: (url: string) => void): AuthLink {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has('access_token') && !params.has('error_code') && !params.has('error')) return { kind: 'none' };
  replaceUrl(`${location.pathname}${location.search}`);
  if (params.has('error') || params.has('error_code')) return { kind: 'notice', notice: { tone: 'error', text: LINK_INVALID } };
  if (params.get('type') !== 'recovery') return { kind: 'notice', notice: { tone: 'info', text: LINK_CONFIRMED } };
  const accessToken = params.get('access_token') ?? '';
  const refreshToken = params.get('refresh_token') ?? '';
  if (!TOKEN.test(accessToken) || !TOKEN.test(refreshToken)) return { kind: 'notice', notice: { tone: 'error', text: LINK_INVALID } };
  return { kind: 'recovery', tokens: { accessToken, refreshToken } };
}

// ---------- recuperação de senha ----------

/** Cliente só da recuperação: em memória, sem renovação nem aviso a outras abas; não toca na sessão de login. */
export function recoveryAuthOptions() {
  return { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'oryn.recovery' };
}

/** Volta para esta página, sem query nem fragmento. Só https (ou http local); a allowlist do Auth decide no fim, e
 * um destino recusado lá cai na Site URL. */
export function recoveryRedirect(location: { protocol: string; hostname: string; origin: string; pathname: string }): string | undefined {
  const local = location.hostname === '127.0.0.1' || location.hostname === 'localhost';
  if (location.protocol !== 'https:' && !(location.protocol === 'http:' && local)) return undefined;
  return `${location.origin}${location.pathname}`;
}

/** Mesma política do cadastro (8 no mínimo); 72 bytes é o máximo que o Auth aceita. */
export function newPasswordProblem(password: string, confirmation: string): string | null {
  if ([...password].length < 8) return 'Use pelo menos 8 caracteres.';
  if (new TextEncoder().encode(password).length > 72) return 'Senha longa demais: use até 72 bytes (cerca de 72 letras sem acento).';
  if (password !== confirmation) return 'As senhas não conferem.';
  return null;
}

export const RESET_SENT = 'Se houver uma conta com esse e-mail, enviaremos um link para criar uma nova senha. Confira também a caixa de spam. O link vale por pouco tempo e só uma vez.';
export const RESET_UNAVAILABLE = 'Não foi possível enviar agora (sem conexão com o servidor). Tente de novo em instantes.';
export const RECOVERY_EXPIRED = 'O link de recuperação expirou. Peça um novo em "Esqueci minha senha".';
export const PASSWORD_CHANGED = 'Senha alterada. Por segurança, todas as sessões da conta foram encerradas. Entre com a nova senha.';
export const PASSWORD_CHANGED_PARTIAL = 'Senha alterada. Entre com a nova senha. Não foi possível confirmar o encerramento das outras sessões: se suspeitar de acesso indevido, troque a senha de novo.';
export const RECOVERY_CANCELLED = 'Recuperação cancelada. Sua senha não foi alterada.';

const errorCode = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};
const errorStatus = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
};

export interface ResetRequestAuth {
  resetPasswordForEmail(email: string, options: { redirectTo?: string }): PromiseLike<{ error: unknown }>;
}
/** Resposta igual para conta existente ou não (inclusive limite por e-mail e falha de envio, que só acontecem com
 * conta): só a falta de conexão muda a mensagem. */
export async function requestPasswordReset(auth: ResetRequestAuth, email: string, redirectTo: string | undefined): Promise<Notice> {
  const address = email.trim();
  if (!address) return { tone: 'error', text: 'Informe o e-mail da conta.' };
  try {
    const { error } = await auth.resetPasswordForEmail(address, redirectTo ? { redirectTo } : {});
    if (error && isAuthRetryableFetchError(error)) return { tone: 'error', text: RESET_UNAVAILABLE };
  } catch {
    return { tone: 'error', text: RESET_UNAVAILABLE };
  }
  return { tone: 'info', text: RESET_SENT };
}

export interface RecoveryAuth {
  setSession(tokens: { access_token: string; refresh_token: string }): PromiseLike<{ data: { session: Session | null }; error: unknown }>;
  updateUser(attributes: { password: string }): PromiseLike<{ data: { user: User | null }; error: unknown }>;
  signOut(options: { scope: 'global' | 'local' }): PromiseLike<{ error: unknown }>;
}
/** O servidor valida o link (setSession consulta o usuário ou renova o token): sem isso, não há formulário. */
export async function openRecovery(auth: RecoveryAuth, tokens: RecoveryTokens): Promise<boolean> {
  try {
    const { data, error } = await auth.setSession({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken });
    return !error && data.session !== null;
  } catch {
    return false;
  }
}

export type PasswordResult = { kind: 'done'; signedOut: boolean } | { kind: 'retry'; text: string } | { kind: 'expired' };
export async function saveNewPassword(auth: RecoveryAuth, password: string, confirmation: string): Promise<PasswordResult> {
  const problem = newPasswordProblem(password, confirmation);
  if (problem) return { kind: 'retry', text: problem };
  let error: unknown;
  try {
    ({ error } = await auth.updateUser({ password }));
  } catch {
    return { kind: 'retry', text: RESET_UNAVAILABLE };
  }
  if (error) {
    const code = errorCode(error);
    if (code === 'same_password') return { kind: 'retry', text: 'Escolha uma senha diferente da atual.' };
    if (code === 'weak_password') return { kind: 'retry', text: 'O servidor recusou essa senha por ser fraca. Escolha outra.' };
    if (isAuthRetryableFetchError(error)) return { kind: 'retry', text: RESET_UNAVAILABLE };
    const status = errorStatus(error);
    // O supabase-js converte session_not_found em AuthSessionMissingError (400, sem código): conferido com a biblioteca real.
    if (isAuthSessionMissingError(error) || status === 401 || status === 403 || code === 'session_not_found' || code === 'session_expired' || code === 'bad_jwt') return { kind: 'expired' };
    // Só mensagem fixa: erros do Auth podem conter dados da conta.
    return { kind: 'retry', text: 'Não foi possível salvar a nova senha. Tente de novo ou peça um novo link.' };
  }
  // Quem pediu recuperação pode ter perdido o controle da conta: encerra todas as sessões, inclusive esta.
  const signedOut = await Promise.resolve(auth.signOut({ scope: 'global' })).then((r) => !r.error, () => false);
  return { kind: 'done', signedOut };
}
/** Desistiu: invalida a sessão temporária no servidor; a senha fica como estava. */
export async function abandonRecovery(auth: RecoveryAuth): Promise<void> {
  await Promise.resolve(auth.signOut({ scope: 'local' })).catch(() => undefined);
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
