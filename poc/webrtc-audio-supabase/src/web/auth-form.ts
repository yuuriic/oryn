// Validação dos formulários de entrada e cadastro (Midnight V2). Só regras que o servidor também aplica ou que dependem
// apenas do próprio formulário: nome (a mesma normalização da migração de identidade), e-mail, telefone brasileiro,
// senha (8 caracteres no mínimo e 72 bytes no máximo, como o Auth) e confirmação. Nenhuma regra extra de senha
// (maiúsculas, números, símbolos) sem aprovação: divergiria da política do Auth.
//
// O telefone é validado aqui, mas NÃO é enviado: sua persistência depende de decisão própria (ver o relatório).
import { NAME_ERROR, normalizeDisplayName } from './identity.ts';

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX_BYTES = 72;

/** Formato básico de e-mail: algo@algo.dominio, sem espaços. A palavra final é do Auth. */
export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim()) && value.trim().length <= 254;
}

/** Só os dígitos do telefone, sem o +55 inicial quando o número tem 12 ou 13 dígitos. */
export function phoneDigits(value: string): string {
  const digits = value.replace(/\D/g, '');
  return (digits.length === 12 || digits.length === 13) && digits.startsWith('55') ? digits.slice(2) : digits.slice(0, 11);
}

/** Máscara brasileira enquanto se digita: (11) 91234-5678 ou (11) 1234-5678. */
export function formatPhoneBR(value: string): string {
  const d = phoneDigits(value);
  if (d.length === 0) return '';
  if (d.length <= 2) return `(${d}`;
  const ddd = d.slice(0, 2);
  const rest = d.slice(2);
  if (rest.length <= 4) return `(${ddd}) ${rest}`;
  // Com 11 dígitos, celular (9 + 8); com até 10, fixo (4 + 4).
  const split = d.length === 11 ? 5 : 4;
  return `(${ddd}) ${rest.slice(0, split)}-${rest.slice(split)}`;
}

/** DDD de 11 a 99 (sem zero em nenhum dígito); celular com 9 dígitos começando por 9, ou fixo com 8 começando de 2 a 5. */
export function isPhoneBR(value: string): boolean {
  const d = phoneDigits(value);
  if (!/^[1-9][1-9]/.test(d)) return false;
  if (d.length === 11) return d[2] === '9';
  if (d.length === 10) return /^[2-5]$/.test(d[2]!);
  return false;
}

export interface PasswordChecks {
  /** Pelo menos 8 caracteres. */
  length: boolean;
  /** No máximo 72 bytes (o limite do Auth). */
  bytes: boolean;
  /** Confirmação igual e preenchida. */
  match: boolean;
}

export function passwordChecks(password: string, confirmation: string): PasswordChecks {
  return {
    length: [...password].length >= PASSWORD_MIN,
    bytes: new TextEncoder().encode(password).length <= PASSWORD_MAX_BYTES,
    match: confirmation.length > 0 && password === confirmation,
  };
}

export interface SignupInput {
  name: string;
  email: string;
  phone: string;
  password: string;
  confirmation: string;
}
export type SignupField = keyof SignupInput;
export type SignupErrors = Partial<Record<SignupField, string>>;

/** Erros por campo, com texto fixo (nunca o valor digitado). Vazio: pode enviar. */
export function validateSignup(input: SignupInput): SignupErrors {
  const errors: SignupErrors = {};
  if (!input.name.trim()) errors.name = 'Informe um nome de exibição.';
  else if (!normalizeDisplayName(input.name)) errors.name = NAME_ERROR;
  if (!input.email.trim()) errors.email = 'Informe seu e-mail.';
  else if (!isEmail(input.email)) errors.email = 'E-mail em formato inválido.';
  if (!input.phone.trim()) errors.phone = 'Informe seu telefone.';
  else if (!isPhoneBR(input.phone)) errors.phone = 'Telefone inválido: use DDD e número, como (11) 91234-5678.';
  const checks = passwordChecks(input.password, input.confirmation);
  if (!input.password) errors.password = 'Crie uma senha.';
  else if (!checks.length) errors.password = `Use pelo menos ${PASSWORD_MIN} caracteres.`;
  else if (!checks.bytes) errors.password = 'Senha longa demais: use até 72 bytes (cerca de 72 letras sem acento).';
  if (!input.confirmation) errors.confirmation = 'Confirme a senha.';
  else if (!checks.match) errors.confirmation = 'As senhas não conferem.';
  return errors;
}

/** Entrada: só confere o preenchimento e o formato do e-mail; a senha quem decide é o Auth. */
export function validateLogin(email: string, password: string): { email?: string; password?: string } {
  const errors: { email?: string; password?: string } = {};
  if (!email.trim()) errors.email = 'Informe seu e-mail.';
  else if (!isEmail(email)) errors.email = 'E-mail em formato inválido.';
  if (!password) errors.password = 'Informe sua senha.';
  return errors;
}
