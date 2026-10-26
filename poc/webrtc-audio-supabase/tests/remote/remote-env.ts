// Portão do harness remoto (02C.1B; fases, CAPTCHA de teste e orçamento no 02C.4E). Os testes contra o
// Supabase real só rodam com configuração EXPLÍCITA e COMPLETA, e só com credenciais de CLIENTE. Qualquer
// sinal de credencial administrativa, configuração incompleta ou valor fora do esperado aborta ANTES da rede
// (falha alta, nunca "pula em silêncio"). Mensagens de erro citam NOMES de variáveis, nunca valores.
//
// Variáveis (só no ambiente do terminal; nunca em arquivo versionado nem em log):
//   ORYN_REMOTE=1                    liga o harness
//   ORYN_REMOTE_REF=<ref>            confirma o projeto-alvo (tem de bater com a URL)
//   ORYN_SUPABASE_URL=https://<ref>.supabase.co
//   ORYN_PUBLISHABLE_KEY=sb_publishable_…   (ou a anon legada) — NUNCA sb_secret_/service_role
//   ORYN_IT_PHASE=C1|C2              (02C.4E) fase da janela. C1: sem sala. C2: sala, exige as duas abaixo.
//   ORYN_CAPTCHA_MODE=turnstile-test (02C.4E) OBRIGATÓRIA. Único modo: o projeto está com o Turnstile e o
//                                    SECRET DE TESTE oficial da Cloudflare (sempre aceita); o harness envia o
//                                    token fictício oficial. Tokens reais (uso único) nunca passam por aqui.
//   ORYN_CAPTCHA_TOKEN               opcional e legado; se presente, tem de ser EXATAMENTE o token fictício.
//   ORYN_IT_IDENTITY_BUDGET=1..10    (02C.4E) OBRIGATÓRIA. Saldo de tentativas de cadastro da JANELA, lido pelo
//                                    operador antes de cada execução (runbook §10). Tem de cobrir a fase.
//   ORYN_IT_CREATOR_INVITE=…         só na C2; convite de criador de USO ÚNICO emitido no SQL editor.
//   ORYN_IT_PARTITIONS_CONFIRMED=1   só na C2 (D0): o operador confirmou, por leitura, a partição de HOJE em
//                                    realtime.messages (sem ela, realtime.send descarta o evento em silêncio).

/** Token fictício OFICIAL do Turnstile; só é aceito por secrets de teste (Cloudflare, "Testing"). */
export const TURNSTILE_TEST_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

/** Teto de tentativas de cadastro anônimo por janela de teste (02C.4E). */
export const WINDOW_IDENTITY_LIMIT = 10;

/** Tentativas de cadastro que cada fase faz. Somadas: exatamente o teto da janela. */
export const PHASE_SIGNUPS = {
  // 1 identidade com o token fictício (#5 positivo) + 1 tentativa SEM token (#5 negativo, não deve criar).
  C1: 2,
  // 3 no beforeAll da sala (dono, membro, estranho) + 5 no #15.
  C2: 8,
} as const;

export type Phase = keyof typeof PHASE_SIGNUPS;

export interface RemoteEnv {
  url: string;
  ref: string;
  publishableKey: string;
  phase: Phase;
  captchaToken: string;
  identityBudget: number;
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

  // 02C.4E: CAPTCHA só no modo de teste oficial. Um token real é de uso único (quebraria a partir do 2º
  // cadastro) e não deve circular pelo terminal; qualquer outro valor é recusado sem ser repetido na mensagem.
  if (env['ORYN_CAPTCHA_MODE'] !== 'turnstile-test') {
    throw new RemoteConfigError('ORYN_CAPTCHA_MODE ausente ou inválido: o único modo aceito é turnstile-test (secret de teste oficial no projeto)');
  }
  const legacyToken = env['ORYN_CAPTCHA_TOKEN'];
  if (legacyToken !== undefined && legacyToken !== '' && legacyToken !== TURNSTILE_TEST_TOKEN) {
    throw new RemoteConfigError('ORYN_CAPTCHA_TOKEN recusado: só o token fictício oficial do Turnstile é aceito (tokens reais nunca)');
  }

  const phase = env['ORYN_IT_PHASE'];
  if (phase !== 'C1' && phase !== 'C2') throw new RemoteConfigError('ORYN_IT_PHASE ausente ou inválido: use C1 ou C2');

  const budgetRaw = env['ORYN_IT_IDENTITY_BUDGET'] ?? '';
  if (!/^\d{1,2}$/.test(budgetRaw)) throw new RemoteConfigError('ORYN_IT_IDENTITY_BUDGET ausente ou não é um inteiro');
  const identityBudget = Number(budgetRaw);
  if (identityBudget < 1 || identityBudget > WINDOW_IDENTITY_LIMIT) {
    throw new RemoteConfigError(`ORYN_IT_IDENTITY_BUDGET fora de 1..${WINDOW_IDENTITY_LIMIT} (teto por janela)`);
  }
  if (identityBudget < PHASE_SIGNUPS[phase]) {
    throw new RemoteConfigError(`orçamento insuficiente: a fase ${phase} faz ${PHASE_SIGNUPS[phase]} tentativas de cadastro e o saldo declarado é ${identityBudget}`);
  }

  const creatorInvite = env['ORYN_IT_CREATOR_INVITE'] || undefined;
  if (creatorInvite !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(creatorInvite)) throw new RemoteConfigError('ORYN_IT_CREATOR_INVITE fora do formato');

  const partitions = env['ORYN_IT_PARTITIONS_CONFIRMED'];
  if (partitions !== undefined && partitions !== '' && partitions !== '1') throw new RemoteConfigError('ORYN_IT_PARTITIONS_CONFIRMED só aceita 1');

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

  return {
    enabled: true,
    env: { url, ref, publishableKey: key, phase, captchaToken: TURNSTILE_TEST_TOKEN, identityBudget, creatorInvite, partitionsConfirmed: partitions === '1' },
  };
}
