// Portão do harness remoto (02C.1B; fases, CAPTCHA de teste e orçamento no 02C.4E; C0 e identidades por senha
// no 02C.5B). Os testes contra o Supabase real só rodam com configuração EXPLÍCITA e COMPLETA, e só com
// credenciais de CLIENTE. Qualquer sinal de credencial administrativa, configuração incompleta ou valor fora do
// esperado aborta ANTES da rede (falha alta, nunca "pula em silêncio"). Mensagens de erro citam NOMES de
// variáveis, nunca valores.
//
// Variáveis (só no ambiente do terminal; nunca em arquivo versionado nem em log):
//   ORYN_REMOTE=1                    liga o harness
//   ORYN_REMOTE_REF=<ref>            confirma o projeto-alvo (tem de bater com a URL)
//   ORYN_SUPABASE_URL=https://<ref>.supabase.co
//   ORYN_PUBLISHABLE_KEY=sb_publishable_…   (ou a anon legada) — NUNCA sb_secret_/service_role
//   ORYN_IT_PHASE=C0|C1|C2           C0 (02C.5B): sem identidade, só recusas (REST; WebSocket só com
//                                    ORYN_IT_ALLOW_WS=1). C1: sem sala, cadastra. C2: sala.
//   ORYN_IT_ALLOW_WS=1               (02C.5B) só na C0: libera os testes de WebSocket Z6–Z8, que CRIAM as
//                                    partições de realtime.messages na 1ª conexão (autorização separada).
//   ORYN_IT_IDENTITY=signup|password (02C.5B) como a C2 obtém usuários. `signup` (padrão; comportamento do
//                                    02C.4E): cadastro anônimo com o CAPTCHA de teste. `password`: login em 3 contas
//                                    PREEXISTENTES (criadas pelo operador); nenhum cadastro, nenhum CAPTCHA.
//   ORYN_IT_USER_{OWNER,MEMBER,STRANGER}_{EMAIL,PASSWORD}  só com `password`; digitadas (Read-Host), nunca salvas.
//   ORYN_CAPTCHA_MODE=turnstile-test (02C.4E) obrigatória quando há CADASTRO (C1; C2 com `signup`). Único modo: o
//                                    projeto está com o Turnstile e o SECRET DE TESTE oficial; o harness envia o
//                                    token fictício oficial. Tokens reais (uso único) nunca passam por aqui.
//   ORYN_CAPTCHA_TOKEN               opcional e legado; se presente, tem de ser EXATAMENTE o token fictício.
//   ORYN_IT_IDENTITY_BUDGET          saldo de tentativas de CADASTRO da janela (runbook §10). 1..10 quando há
//                                    cadastro (tem de cobrir a fase); 0 (ou ausente) quando não há (C0; C2 `password`).
//   ORYN_IT_CREATOR_INVITE=…         só na C2; convite de criador de USO ÚNICO emitido no SQL editor.
//   ORYN_IT_PARTITIONS_CONFIRMED=1   só na C2 (D0): o operador confirmou, por leitura, a partição de HOJE em
//                                    realtime.messages (sem ela, realtime.send descarta o evento em silêncio).

/** Token fictício OFICIAL do Turnstile; só é aceito por secrets de teste (Cloudflare, "Testing"). */
export const TURNSTILE_TEST_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

/** Teto de tentativas de cadastro anônimo por janela de teste (02C.4E). */
export const WINDOW_IDENTITY_LIMIT = 10;

/** Tentativas de cadastro que cada fase faz no modo `signup`. C1 + C2 = teto da janela; C0 nunca cadastra. */
export const PHASE_SIGNUPS = {
  C0: 0,
  // 1 identidade com o token fictício (#5 positivo) + 1 tentativa SEM token (#5 negativo, não deve criar).
  C1: 2,
  // 3 no beforeAll da sala (dono, membro, estranho) + 5 no #15.
  C2: 8,
} as const;

export type Phase = keyof typeof PHASE_SIGNUPS;
export type IdentityMode = 'signup' | 'password';

/** Papéis das contas preexistentes do modo `password` (02C.5B). */
export const PASSWORD_ROLES = ['OWNER', 'MEMBER', 'STRANGER'] as const;
export type PasswordRole = (typeof PASSWORD_ROLES)[number];

export interface PasswordCredential {
  email: string;
  password: string;
}

export interface RemoteEnv {
  url: string;
  ref: string;
  publishableKey: string;
  phase: Phase;
  identityMode: IdentityMode;
  /** Só faz sentido quando há cadastro; nos outros casos é o token fictício (nunca enviado). */
  captchaToken: string;
  /** Saldo de CADASTROS (0 na C0 e na C2 `password`). */
  identityBudget: number;
  /** Logins em contas preexistentes permitidos neste processo (3 na C2 `password`; 0 nos demais). */
  loginBudget: number;
  credentials: Record<PasswordRole, PasswordCredential> | undefined;
  allowWebSocket: boolean;
  creatorInvite: string | undefined;
  partitionsConfirmed: boolean;
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

const isSet = (v: string | undefined) => v !== undefined && v !== '';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Lê as 3 contas do modo `password`; recusa ausência, formato inválido ou conta repetida, sem citar valores. */
function readCredentials(env: Record<string, string | undefined>): Record<PasswordRole, PasswordCredential> {
  const out = {} as Record<PasswordRole, PasswordCredential>;
  for (const role of PASSWORD_ROLES) {
    const email = (env[`ORYN_IT_USER_${role}_EMAIL`] ?? '').trim();
    const password = env[`ORYN_IT_USER_${role}_PASSWORD`] ?? '';
    if (!EMAIL_RE.test(email)) throw new RemoteConfigError(`ORYN_IT_USER_${role}_EMAIL ausente ou fora do formato`);
    if (password.length === 0) throw new RemoteConfigError(`ORYN_IT_USER_${role}_PASSWORD ausente`);
    out[role] = { email, password };
  }
  const emails = new Set(PASSWORD_ROLES.map((r) => out[r].email.toLowerCase()));
  if (emails.size !== PASSWORD_ROLES.length) throw new RemoteConfigError('as contas OWNER, MEMBER e STRANGER têm de ser 3 contas DIFERENTES');
  return out;
}

const anyCredentialVar = (env: Record<string, string | undefined>) =>
  Object.keys(env).filter((k) => /^ORYN_IT_USER_/.test(k) && isSet(env[k])).sort();

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

  const phase = env['ORYN_IT_PHASE'];
  if (phase !== 'C0' && phase !== 'C1' && phase !== 'C2') throw new RemoteConfigError('ORYN_IT_PHASE ausente ou inválido: use C0, C1 ou C2');

  // Token legado: mesmo fora das fases com cadastro, um token real nunca é aceito no ambiente.
  const legacyToken = env['ORYN_CAPTCHA_TOKEN'];
  if (isSet(legacyToken) && legacyToken !== TURNSTILE_TEST_TOKEN) {
    throw new RemoteConfigError('ORYN_CAPTCHA_TOKEN recusado: só o token fictício oficial do Turnstile é aceito (tokens reais nunca)');
  }

  const identityRaw = env['ORYN_IT_IDENTITY'];
  if (isSet(identityRaw) && identityRaw !== 'signup' && identityRaw !== 'password') throw new RemoteConfigError('ORYN_IT_IDENTITY inválido: use signup ou password');
  const identityMode: IdentityMode = identityRaw === 'password' ? 'password' : 'signup';
  if (identityMode === 'password' && phase !== 'C2') throw new RemoteConfigError('ORYN_IT_IDENTITY=password só vale na C2');

  const allowWsRaw = env['ORYN_IT_ALLOW_WS'];
  if (isSet(allowWsRaw) && allowWsRaw !== '1') throw new RemoteConfigError('ORYN_IT_ALLOW_WS só aceita 1');
  if (isSet(allowWsRaw) && phase !== 'C0') throw new RemoteConfigError('ORYN_IT_ALLOW_WS só vale na C0 (as outras fases já abrem WebSocket)');

  const creatorInvite = env['ORYN_IT_CREATOR_INVITE'] || undefined;
  if (creatorInvite !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(creatorInvite)) throw new RemoteConfigError('ORYN_IT_CREATOR_INVITE fora do formato');

  const partitions = env['ORYN_IT_PARTITIONS_CONFIRMED'];
  if (isSet(partitions) && partitions !== '1') throw new RemoteConfigError('ORYN_IT_PARTITIONS_CONFIRMED só aceita 1');

  // Credenciais de usuário só existem no modo `password`: fora dele, não deixá-las no processo.
  const credentialVars = anyCredentialVar(env);
  if (identityMode !== 'password' && credentialVars.length > 0) {
    throw new RemoteConfigError(`credenciais de usuário no ambiente fora do modo password (${credentialVars.join(', ')}): remova antes de rodar`);
  }

  const signsUp = phase === 'C1' || (phase === 'C2' && identityMode === 'signup');
  const budgetRaw = env['ORYN_IT_IDENTITY_BUDGET'] ?? '';
  let identityBudget: number;
  if (signsUp) {
    // 02C.4E: CAPTCHA só no modo de teste oficial; orçamento explícito que cubra a fase.
    if (env['ORYN_CAPTCHA_MODE'] !== 'turnstile-test') {
      throw new RemoteConfigError('ORYN_CAPTCHA_MODE ausente ou inválido: o único modo aceito é turnstile-test (secret de teste oficial no projeto)');
    }
    if (!/^\d{1,2}$/.test(budgetRaw)) throw new RemoteConfigError('ORYN_IT_IDENTITY_BUDGET ausente ou não é um inteiro');
    identityBudget = Number(budgetRaw);
    if (identityBudget < 1 || identityBudget > WINDOW_IDENTITY_LIMIT) {
      throw new RemoteConfigError(`ORYN_IT_IDENTITY_BUDGET fora de 1..${WINDOW_IDENTITY_LIMIT} (teto por janela)`);
    }
    if (identityBudget < PHASE_SIGNUPS[phase]) {
      throw new RemoteConfigError(`orçamento insuficiente: a fase ${phase} faz ${PHASE_SIGNUPS[phase]} tentativas de cadastro e o saldo declarado é ${identityBudget}`);
    }
  } else {
    // 02C.5B: sem cadastro, o orçamento é ZERO por construção; qualquer outro valor é engano de configuração.
    if (isSet(budgetRaw) && budgetRaw !== '0') {
      throw new RemoteConfigError(`ORYN_IT_IDENTITY_BUDGET tem de ser 0 (ou ausente) quando a fase não cadastra (${phase}${phase === 'C2' ? ' password' : ''})`);
    }
    identityBudget = 0;
  }

  if (phase === 'C0' && creatorInvite !== undefined) throw new RemoteConfigError('ORYN_IT_CREATOR_INVITE não é usado na C0: remova-o do ambiente');
  if (phase === 'C1' && creatorInvite !== undefined) {
    // O convite é de uso único e só vale na C2: não deixá-lo exposto num processo que não o usa.
    throw new RemoteConfigError('ORYN_IT_CREATOR_INVITE não é usado na C1: remova-o do ambiente');
  }
  if (phase === 'C2') {
    // 02C.4B.1: a C2 nunca começa sem D0. Abortar ANTES da rede evita gastar o convite de uso único numa
    // execução cujos testes de entrega não provariam nada.
    if (creatorInvite === undefined) throw new RemoteConfigError('a fase C2 exige ORYN_IT_CREATOR_INVITE');
    if (partitions !== '1') throw new RemoteConfigError('a fase C2 exige ORYN_IT_PARTITIONS_CONFIRMED=1: confira a partição de hoje (D0) depois da C1');
  }

  const credentials = identityMode === 'password' ? readCredentials(env) : undefined;

  return {
    enabled: true,
    env: {
      url,
      ref,
      publishableKey: key,
      phase,
      identityMode,
      captchaToken: TURNSTILE_TEST_TOKEN,
      identityBudget,
      loginBudget: credentials ? PASSWORD_ROLES.length : 0,
      credentials,
      allowWebSocket: allowWsRaw === '1',
      creatorInvite,
      partitionsConfirmed: partitions === '1',
    },
  };
}
