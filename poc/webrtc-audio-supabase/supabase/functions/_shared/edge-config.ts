// Configuração da Edge Function `signal` (02C.1B.0A). Puro e testável: recebe um leitor de variáveis
// (Deno.env.get em produção, um Map nos testes).
//
// Variáveis INJETADAS pela plataforma (nomes com prefixo SUPABASE_ são reservados: nunca criados como
// secret pelo usuário):
//   SUPABASE_URL
//   SUPABASE_PUBLISHABLE_KEYS / SUPABASE_SECRET_KEYS  (JSON {nome: chave}; chaves novas sb_publishable_/sb_secret_)
//   SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY     (legadas, JWT; só como alternativa enquanto existirem)
// Secret PRÓPRIO (o único a criar): ORYN_ALLOWED_ORIGINS — origens HTTPS separadas por vírgula.
//
// Mensagens de erro citam só o NOME da variável, nunca o valor.

export type KeyKind = 'new' | 'legacy';

export interface EdgeConfig {
  url: string;
  /** Chave de baixo privilégio: acompanha o JWT do USUÁRIO no header `apikey`. */
  publishableKey: string;
  /** Chave de servidor (papel service_role): só no header `apikey`, nunca em `Authorization`. */
  secretKey: string;
  keyKind: KeyKind;
  allowedOrigins: ReadonlySet<string>;
}

export class ConfigError extends Error {}

const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
export const isJwtShaped = (v: string): boolean => JWT.test(v);
export const isPublishableKey = (v: string): boolean => /^sb_publishable_[A-Za-z0-9_-]+$/.test(v);
export const isSecretKey = (v: string): boolean => /^sb_secret_[A-Za-z0-9_-]+$/.test(v);

/** Papel declarado num JWT legado (sem validar assinatura: só para recusar chave trocada). */
function legacyRole(jwt: string): string | null {
  try {
    const part = jwt.split('.')[1] ?? '';
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as { role?: unknown };
    return typeof json.role === 'string' ? json.role : null;
  } catch {
    return null;
  }
}

function namedKey(get: (name: string) => string | undefined, name: string, keyName: string): string | undefined {
  const raw = get(name);
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`${name}: JSON inválido`);
  }
  const value = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)[keyName] : undefined;
  if (typeof value !== 'string' || !value) throw new ConfigError(`${name}: chave "${keyName}" ausente`);
  return value;
}

export function loadEdgeConfig(get: (name: string) => string | undefined, keyName = 'default'): EdgeConfig {
  const url = get('SUPABASE_URL');
  if (!url || !/^https?:\/\/[^/\s]+$/.test(url)) throw new ConfigError('SUPABASE_URL ausente ou inválida');

  const newPublishable = namedKey(get, 'SUPABASE_PUBLISHABLE_KEYS', keyName);
  const newSecret = namedKey(get, 'SUPABASE_SECRET_KEYS', keyName);
  let publishableKey: string;
  let secretKey: string;
  let keyKind: KeyKind;
  if (newPublishable !== undefined || newSecret !== undefined) {
    // Chaves novas: as duas precisam existir; nunca misturar com as legadas.
    if (!newPublishable || !isPublishableKey(newPublishable)) throw new ConfigError('SUPABASE_PUBLISHABLE_KEYS: chave publicável inválida');
    if (!newSecret || !isSecretKey(newSecret)) throw new ConfigError('SUPABASE_SECRET_KEYS: chave secreta inválida');
    publishableKey = newPublishable;
    secretKey = newSecret;
    keyKind = 'new';
  } else {
    const anon = get('SUPABASE_ANON_KEY');
    const service = get('SUPABASE_SERVICE_ROLE_KEY');
    if (!anon || !isJwtShaped(anon) || legacyRole(anon) !== 'anon') throw new ConfigError('SUPABASE_ANON_KEY ausente ou não é a chave anon');
    if (!service || !isJwtShaped(service) || legacyRole(service) !== 'service_role') throw new ConfigError('SUPABASE_SERVICE_ROLE_KEY ausente ou não é a chave service_role');
    publishableKey = anon;
    secretKey = service;
    keyKind = 'legacy';
  }
  if (publishableKey === secretKey) throw new ConfigError('chave publicável e secreta são iguais');

  const origins = (get('ORYN_ALLOWED_ORIGINS') ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  if (origins.length === 0) throw new ConfigError('ORYN_ALLOWED_ORIGINS ausente');
  for (const o of origins) if (!/^https:\/\/[^/\s]+$/.test(o) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)) throw new ConfigError('ORYN_ALLOWED_ORIGINS: origem inválida');

  return { url, publishableKey, secretKey, keyKind, allowedOrigins: new Set(origins) };
}
