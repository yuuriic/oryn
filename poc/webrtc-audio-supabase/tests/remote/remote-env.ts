// Portão do harness remoto (02C.1B). Os testes contra o Supabase real só rodam com configuração EXPLÍCITA
// e só com credenciais de CLIENTE. Qualquer sinal de credencial administrativa no ambiente aborta a
// execução (falha alta, nunca "pula em silêncio").
//
// Variáveis (só no ambiente do terminal; nunca em arquivo versionado nem em log):
//   ORYN_REMOTE=1                    liga o harness
//   ORYN_REMOTE_REF=<ref>            confirma o projeto-alvo (tem de bater com a URL)
//   ORYN_SUPABASE_URL=https://<ref>.supabase.co
//   ORYN_PUBLISHABLE_KEY=sb_publishable_…   (ou a anon legada) — NUNCA sb_secret_/service_role
//   ORYN_CAPTCHA_TOKEN=…             opcional (Turnstile com chave de teste no ambiente isolado; B5)
//   ORYN_IT_CREATOR_INVITE=…         opcional; convite de criador de USO ÚNICO emitido no SQL editor.
//                                    Sem ele, os testes que precisam de sala ficam pulados.

export interface RemoteEnv {
  url: string;
  ref: string;
  publishableKey: string;
  captchaToken: string | undefined;
  creatorInvite: string | undefined;
}

export type RemoteGate = { enabled: false; reason: string } | { enabled: true; env: RemoteEnv };

export class RemoteConfigError extends Error {}

const jwtRole = (v: string): string | null => {
  const parts = v.split('.');
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { role?: unknown };
    return typeof claims.role === 'string' ? claims.role : null;
  } catch {
    return null;
  }
};

/** Valor com cara de credencial administrativa (chave secreta nova ou JWT legado service_role). */
export const looksAdministrative = (v: string): boolean => /sb_secret_/.test(v) || jwtRole(v.trim()) === 'service_role';

export function remoteGate(env: Record<string, string | undefined>): RemoteGate {
  if (env['ORYN_REMOTE'] !== '1') return { enabled: false, reason: 'ORYN_REMOTE=1 não definido: testes remotos desligados' };

  // Nenhuma credencial administrativa pode estar acessível ao processo dos testes de cliente.
  const admin = Object.entries(env).filter(([, v]) => typeof v === 'string' && looksAdministrative(v)).map(([k]) => k);
  if (admin.length > 0) throw new RemoteConfigError(`credencial administrativa no ambiente (${admin.sort().join(', ')}): remova antes de rodar`);

  const url = env['ORYN_SUPABASE_URL'] ?? '';
  const m = /^https:\/\/([a-z0-9]{20})\.supabase\.co$/.exec(url);
  if (!m) throw new RemoteConfigError('ORYN_SUPABASE_URL ausente ou fora do formato https://<ref>.supabase.co');
  const ref = m[1]!;
  if (env['ORYN_REMOTE_REF'] !== ref) throw new RemoteConfigError('ORYN_REMOTE_REF não confirma o projeto da URL');

  const key = env['ORYN_PUBLISHABLE_KEY'] ?? '';
  const isPublishable = /^sb_publishable_[A-Za-z0-9_-]+$/.test(key) || jwtRole(key) === 'anon';
  if (!isPublishable) throw new RemoteConfigError('ORYN_PUBLISHABLE_KEY ausente ou não é uma chave publicável');

  const creatorInvite = env['ORYN_IT_CREATOR_INVITE'] || undefined;
  if (creatorInvite !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(creatorInvite)) throw new RemoteConfigError('ORYN_IT_CREATOR_INVITE fora do formato');

  return { enabled: true, env: { url, ref, publishableKey: key, captchaToken: env['ORYN_CAPTCHA_TOKEN'] || undefined, creatorInvite } };
}
