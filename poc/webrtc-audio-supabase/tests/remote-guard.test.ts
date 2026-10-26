// Portão do harness remoto (unitário, roda no `pnpm test`): desligado por padrão; ligado só com
// configuração explícita e COMPLETA, só com credencial de cliente, só com o CAPTCHA de teste oficial e com
// orçamento de identidades que cubra a fase (02C.4E).
import { describe, expect, it } from 'vitest';
import { PHASE_SIGNUPS, RemoteConfigError, remoteGate, TURNSTILE_TEST_TOKEN, WINDOW_IDENTITY_LIMIT } from './remote/remote-env.ts';

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeJwt = (claims: object) => [b64({ alg: 'HS256' }), b64(claims), 'c2ln'].join('.');
const REF = 'abcdefghijklmnopqrst';
const PUBLISHABLE = ['sb', 'publishable', 'TESTE0123'].join('_');
const SECRET = ['sb', 'secret', 'TESTE0123'].join('_');
const INVITE = 'A'.repeat(43);
const base = {
  ORYN_REMOTE: '1',
  ORYN_REMOTE_REF: REF,
  ORYN_SUPABASE_URL: `https://${REF}.supabase.co`,
  ORYN_PUBLISHABLE_KEY: PUBLISHABLE,
  ORYN_CAPTCHA_MODE: 'turnstile-test',
  ORYN_IT_PHASE: 'C1',
  ORYN_IT_IDENTITY_BUDGET: '10',
};
const c2 = { ...base, ORYN_IT_PHASE: 'C2', ORYN_IT_CREATOR_INVITE: INVITE, ORYN_IT_PARTITIONS_CONFIRMED: '1', ORYN_IT_IDENTITY_BUDGET: '8' };

/** Lança RemoteConfigError e a mensagem não contém nenhum dos valores sensíveis informados. */
function expectRefusal(env: Record<string, string>, pattern: RegExp, ...secrets: string[]) {
  let message = '';
  try {
    remoteGate(env);
  } catch (error) {
    expect(error).toBeInstanceOf(RemoteConfigError);
    message = (error as Error).message;
  }
  expect(message).toMatch(pattern);
  for (const s of secrets) expect(message).not.toContain(s);
}

describe('portão dos testes remotos', () => {
  it('desligado por padrão (sem ORYN_REMOTE=1), mesmo com as demais variáveis', () => {
    expect(remoteGate({}).enabled).toBe(false);
    expect(remoteGate({ ...base, ORYN_REMOTE: 'true' }).enabled).toBe(false);
  });

  it('ligado com configuração completa de cliente (chave nova ou anon legada)', () => {
    expect(remoteGate(base)).toMatchObject({ enabled: true, env: { ref: REF, publishableKey: PUBLISHABLE, phase: 'C1', identityBudget: 10 } });
    expect(remoteGate({ ...base, ORYN_PUBLISHABLE_KEY: fakeJwt({ role: 'anon' }) }).enabled).toBe(true);
  });

  it.each([
    ['chave secreta como publicável', { ORYN_PUBLISHABLE_KEY: SECRET }],
    ['service_role legada como publicável', { ORYN_PUBLISHABLE_KEY: fakeJwt({ role: 'service_role' }) }],
    ['chave secreta em QUALQUER variável', { SUPABASE_SECRET_KEY: SECRET }],
    ['service_role legada em qualquer variável', { SOME_TOKEN: fakeJwt({ role: 'service_role' }) }],
    ['JWT de usuário como chave', { ORYN_PUBLISHABLE_KEY: fakeJwt({ role: 'authenticated' }) }],
    ['URL fora do Supabase', { ORYN_SUPABASE_URL: 'https://evil.example' }],
    ['URL http', { ORYN_SUPABASE_URL: `http://${REF}.supabase.co` }],
    ['ref não confirmado', { ORYN_REMOTE_REF: 'outroprojetoxxxxxxxx' }],
    ['convite malformado (C2)', { ...c2, ORYN_IT_CREATOR_INVITE: 'abc' }],
    ['confirmação de partição ambígua', { ORYN_IT_PARTITIONS_CONFIRMED: 'true' }],
  ])('recusa: %s', (_label, over) => {
    expect(() => remoteGate({ ...base, ...over })).toThrow(RemoteConfigError);
  });

  it('a mensagem cita o NOME da variável administrativa, nunca o valor', () => {
    expectRefusal({ ...base, LEAKED: SECRET }, /LEAKED/, SECRET);
  });
});

describe('CAPTCHA: só o modo de teste oficial do Turnstile (02C.4E)', () => {
  it('modo de teste ausente → recusa (configuração incompleta)', () => {
    const { ORYN_CAPTCHA_MODE: _omit, ...withoutMode } = base;
    expectRefusal(withoutMode, /ORYN_CAPTCHA_MODE/);
  });

  it.each(['off', 'turnstile', 'TURNSTILE-TEST', 'hcaptcha-test', ''])('modo inválido "%s" → recusa', (mode) => {
    expectRefusal({ ...base, ORYN_CAPTCHA_MODE: mode }, /ORYN_CAPTCHA_MODE/);
  });

  it('token fictício oficial permitido no modo correto; é o que o harness envia', () => {
    expect(TURNSTILE_TEST_TOKEN).toBe('XXXX.DUMMY.TOKEN.XXXX');
    expect(remoteGate(base)).toMatchObject({ env: { captchaToken: TURNSTILE_TEST_TOKEN } });
    expect(remoteGate({ ...base, ORYN_CAPTCHA_TOKEN: TURNSTILE_TEST_TOKEN })).toMatchObject({ env: { captchaToken: TURNSTILE_TEST_TOKEN } });
  });

  it.each([
    ['token com cara de real (Turnstile)', `0.${'a'.repeat(120)}`],
    ['valor arbitrário', 'qualquer-coisa'],
    ['fictício com espaço', ` ${TURNSTILE_TEST_TOKEN}`],
    ['fictício em minúsculas', TURNSTILE_TEST_TOKEN.toLowerCase()],
  ])('token inválido → recusa sem repetir o valor: %s', (_label, token) => {
    expectRefusal({ ...base, ORYN_CAPTCHA_TOKEN: token }, /ORYN_CAPTCHA_TOKEN/, token.trim() || token);
  });

  it('token fictício sem o modo de teste → recusa (o token sozinho não liga nada)', () => {
    const { ORYN_CAPTCHA_MODE: _omit, ...withoutMode } = base;
    expectRefusal({ ...withoutMode, ORYN_CAPTCHA_TOKEN: TURNSTILE_TEST_TOKEN }, /ORYN_CAPTCHA_MODE/);
  });
});

describe('fases C1/C2 e D0', () => {
  it('fase ausente ou inválida → recusa', () => {
    const { ORYN_IT_PHASE: _omit, ...withoutPhase } = base;
    expectRefusal(withoutPhase, /ORYN_IT_PHASE/);
    expectRefusal({ ...base, ORYN_IT_PHASE: 'C3' }, /ORYN_IT_PHASE/);
  });

  it('C1 não depende da confirmação de partição', () => {
    expect(remoteGate(base)).toMatchObject({ enabled: true, env: { phase: 'C1', partitionsConfirmed: false, creatorInvite: undefined } });
    expect(remoteGate({ ...base, ORYN_IT_PARTITIONS_CONFIRMED: '1' })).toMatchObject({ env: { partitionsConfirmed: true } });
  });

  it('C1 com convite no ambiente → recusa (o convite de uso único só vale na C2), sem citar o valor', () => {
    expectRefusal({ ...base, ORYN_IT_CREATOR_INVITE: INVITE }, /não é usado na C1/, INVITE);
  });

  it('C2 sem confirmação de partição → recusa antes da rede, sem citar o convite', () => {
    const { ORYN_IT_PARTITIONS_CONFIRMED: _omit, ...withoutD0 } = c2;
    expectRefusal(withoutD0, /ORYN_IT_PARTITIONS_CONFIRMED=1/, INVITE);
    expectRefusal({ ...c2, ORYN_IT_PARTITIONS_CONFIRMED: '' }, /ORYN_IT_PARTITIONS_CONFIRMED=1/, INVITE);
  });

  it('C2 sem convite → recusa', () => {
    const { ORYN_IT_CREATOR_INVITE: _omit, ...withoutInvite } = c2;
    expectRefusal(withoutInvite, /exige ORYN_IT_CREATOR_INVITE/);
  });

  it('C2 completa liga', () => {
    expect(remoteGate(c2)).toMatchObject({ enabled: true, env: { phase: 'C2', creatorInvite: INVITE, partitionsConfirmed: true, identityBudget: 8 } });
  });
});

describe('orçamento de identidades por janela (02C.4E)', () => {
  it('as duas fases somam exatamente o teto da janela (10)', () => {
    expect(WINDOW_IDENTITY_LIMIT).toBe(10);
    expect(PHASE_SIGNUPS.C1 + PHASE_SIGNUPS.C2).toBe(WINDOW_IDENTITY_LIMIT);
  });

  it.each([
    ['ausente', undefined],
    ['vazio', ''],
    ['não inteiro', '2.5'],
    ['negativo', '-1'],
    ['zero', '0'],
    ['acima do teto', '11'],
    ['texto', 'dez'],
  ])('saldo %s → recusa', (_label, value) => {
    const env: Record<string, string> = { ...base };
    if (value === undefined) delete env['ORYN_IT_IDENTITY_BUDGET'];
    else env['ORYN_IT_IDENTITY_BUDGET'] = value;
    expectRefusal(env, /ORYN_IT_IDENTITY_BUDGET/);
  });

  it('saldo menor que o necessário para a fase → recusa antes da rede (C1 precisa de 2; C2 de 8)', () => {
    expectRefusal({ ...base, ORYN_IT_IDENTITY_BUDGET: '1' }, /orçamento insuficiente: a fase C1 faz 2/);
    expectRefusal({ ...c2, ORYN_IT_IDENTITY_BUDGET: '7' }, /orçamento insuficiente: a fase C2 faz 8/);
  });

  it('saldo exato da fase é aceito (reexecução da C2 depois da C1: 10 − 2 = 8)', () => {
    expect(remoteGate({ ...base, ORYN_IT_IDENTITY_BUDGET: '2' }).enabled).toBe(true);
    expect(remoteGate({ ...c2, ORYN_IT_IDENTITY_BUDGET: '8' }).enabled).toBe(true);
  });
});
