// Peças puras do harness remoto (02C.4B.1), sem rede: o que impede falso PASS e operação remota tardia.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classifyRefusal, guard, IdentityBudget, IdentityBudgetExceeded, isServerReply, joinOutcome, refusalVerdict, sanitize, serverReason, sleep, testSignal, waitFor,
} from './remote/harness-utils.ts';

const UUID = '3f2b8c1e-9a4d-4e7b-8c2f-1a2b3c4d5e6f';

describe('recusa de canal: servidor × transporte (realtime-js 2.118, normalizeChannelError)', () => {
  it('resposta de erro do servidor (payload em `cause`) conta como recusa do servidor', () => {
    const reason = `Unauthorized: You do not have permissions to read from this Channel topic: oryn:s:${UUID}`;
    expect(isServerReply(new Error(reason, { cause: { reason } }))).toBe(true);
  });

  it.each([
    ['CloseEvent copiado como objeto simples (code numérico)', new Error('socket closed: 1006', { cause: { code: 1006, reason: '' } })],
    ['CloseEvent com motivo', new Error('socket closed: 1011 (x)', { cause: { code: 1011, reason: 'x' } })],
    ['Event de transporte', new Error('channel error: transport failure', { cause: new Event('error') })],
    ['Error de rede', new Error('fetch failed')],
    ['texto solto', new Error('timeout')],
    ['payload vazio', new Error('error', { cause: {} })],
    ['payload sem texto', new Error('error', { cause: { reason: '' } })],
    ['sem erro', undefined],
  ])('NÃO conta como recusa do servidor: %s', (_label, err) => {
    expect(isServerReply(err)).toBe(false);
  });

});

// 02C.6E: textos REAIS. Os três primeiros vieram da 1ª C0-W (2026-10-27); os demais seguem o formato
// `<Código>: <mensagem>` do log_error do Realtime (realtime_channel.ex).
const UNAUTHORIZED = `Unauthorized: You do not have permissions to read from this Channel topic: oryn:s:${UUID}`;
const PRIVATE_ONLY = 'PrivateOnly: This project only allows private channels';
const MISSING_PARTITION = 'MissingPartition: Realtime was unable to find the expected messages partition';

describe('classificação da recusa (02C.6E)', () => {
  it.each([
    [UNAUTHORIZED, 'authorization'],
    ['Unauthorized: You do not have permissions to read from this Channel topic', 'authorization'],
    // O antigo /jwt|token/ chamaria isto de credencial só porque o NOME do tópico contém "token".
    ['Unauthorized: You do not have permissions to read from this Channel topic: it-token-jwt', 'authorization'],
    [PRIVATE_ONLY, 'private-only'],
    [MISSING_PARTITION, 'infrastructure'],
    ['InitializingProjectConnection: Realtime is initializing the project connection', 'infrastructure'],
    ['RealtimeRestarting: Realtime is restarting, please standby', 'infrastructure'],
    ['ChannelRateLimitReached: Too many channels', 'infrastructure'],
    ['Realtime was unable to connect to the project database', 'infrastructure'],
    ['InvalidJWTToken: Token expiration time is invalid', 'credential'],
    ['MalformedJWT: The token provided is not a valid JWT', 'credential'],
    ['JwtSignatureError: Failed to validate JWT signature', 'credential'],
  ])('%s → %s', (reason, kind) => {
    expect(classifyRefusal(reason)).toBe(kind);
  });

  it.each([
    ['Unauthorized com outra mensagem', 'Unauthorized: something else'],
    ['PrivateOnly com outra mensagem', 'PrivateOnly: This project only allows private channels, mostly'],
    ['código em minúsculas', 'unauthorized: You do not have permissions to read from this Channel topic'],
    ['código só citado no meio do texto', 'error: Unauthorized: You do not have permissions to read from this Channel topic'],
    ['código desconhecido', 'UnknownErrorOnChannel: boom'],
    ['payload inválido', 'InvalidJoinPayload: x'],
    ['sem código', 'Unknown Error on Channel'],
    ['vazio', ''],
  ])('correspondência estrita: %s → unknown', (_label, reason) => {
    expect(classifyRefusal(reason)).toBe('unknown');
  });

  it('o motivo vem do payload do servidor (`cause.reason`), não da mensagem montada pelo cliente', () => {
    expect(serverReason(new Error('x, y', { cause: { reason: PRIVATE_ONLY, other: 'y' } }))).toBe(PRIVATE_ONLY);
    expect(serverReason(new Error(UNAUTHORIZED))).toBe(UNAUTHORIZED);
    expect(serverReason(undefined)).toBe('');
  });

  it('regras: códigos de credencial e de infraestrutura não se sobrepõem nem incluem os de decisão', () => {
    const rules = JSON.parse(readFileSync(new URL('./remote/realtime-refusals.json', import.meta.url), 'utf8')) as {
      authorization: { code: string }; privateOnly: { code: string }; credentialCodes: string[]; infrastructureCodes: string[];
    };
    const all = [...rules.credentialCodes, ...rules.infrastructureCodes];
    expect(new Set(all).size).toBe(all.length);
    expect(all).not.toContain(rules.authorization.code);
    expect(all).not.toContain(rules.privateOnly.code);
  });
});

describe('veredito por teste: só o motivo esperado passa (02C.6E)', () => {
  const outcome = (status: string, server: boolean, reason = '') => joinOutcome(status, server, reason);

  it.each([
    // [cenário, resultado, veredito com esperado=authorization, veredito com esperado=private-only]
    ['Unauthorized', outcome('CHANNEL_ERROR', true, UNAUTHORIZED), 'PASS', 'FAIL'],
    ['PrivateOnly', outcome('CHANNEL_ERROR', true, PRIVATE_ONLY), 'FAIL', 'PASS'],
    ['SUBSCRIBED (entrou)', outcome('SUBSCRIBED', false), 'FAIL', 'FAIL'],
    ['MissingPartition', outcome('CHANNEL_ERROR', true, MISSING_PARTITION), 'INCONCLUSIVO', 'INCONCLUSIVO'],
    ['credencial', outcome('CHANNEL_ERROR', true, 'InvalidJWTToken: Token expiration time is invalid'), 'INCONCLUSIVO', 'INCONCLUSIVO'],
    ['desconhecido', outcome('CHANNEL_ERROR', true, 'UnknownErrorOnChannel: boom'), 'INCONCLUSIVO', 'INCONCLUSIVO'],
    ['TIMED_OUT', outcome('TIMED_OUT', false), 'INCONCLUSIVO', 'INCONCLUSIVO'],
    ['NO_REPLY', outcome('NO_REPLY', false), 'INCONCLUSIVO', 'INCONCLUSIVO'],
    ['CLOSED (conexão encerrada)', outcome('CLOSED', false), 'INCONCLUSIVO', 'INCONCLUSIVO'],
    // Mesmo com o texto de Unauthorized, sem resposta do SERVIDOR (transporte) não há decisão.
    ['CHANNEL_ERROR de transporte', outcome('CHANNEL_ERROR', false, UNAUTHORIZED), 'INCONCLUSIVO', 'INCONCLUSIVO'],
  ] as const)('%s', (_label, out, asAuthorization, asPrivateOnly) => {
    expect(refusalVerdict(out, 'authorization')).toBe(asAuthorization);
    expect(refusalVerdict(out, 'private-only')).toBe(asPrivateOnly);
  });

  it('resultados da 1ª C0-W reclassificados: Z6 INCONCLUSIVO, Z7 FAIL, Z8 PASS', () => {
    expect(refusalVerdict(outcome('CHANNEL_ERROR', true, MISSING_PARTITION), 'authorization')).toBe('INCONCLUSIVO');
    expect(refusalVerdict(outcome('SUBSCRIBED', false), 'private-only')).toBe('FAIL');
    expect(refusalVerdict(outcome('CHANNEL_ERROR', true, 'Unauthorized: You do not have permissions to read from this Channel topic: it-c0-d1fa4fd6-p'), 'authorization')).toBe('PASS');
  });
});

describe('sanitização do que vai para anotações', () => {
  it('remove UUID, JWT e chaves do Supabase e limita o tamanho', () => {
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ4In0', 'c2lnbmF0dXJl'].join('.');
    const key = ['sb', 'secret', 'ABCdef123'].join('_');
    const out = sanitize(`topic oryn:s:${UUID} token ${jwt} key ${key} ${'x'.repeat(200)}`);
    expect(out).not.toContain(UUID);
    expect(out).not.toContain(jwt);
    expect(out).not.toContain(key);
    expect(out).toContain('<uuid>');
    expect(out.length).toBeLessThanOrEqual(100);
  });
});

describe('encerramento: nada remoto depois do fim do teste', () => {
  it('guard deixa passar sem sinal (hooks) e com sinal ativo', () => {
    expect(() => guard()).not.toThrow();
    const ac = new AbortController();
    testSignal.run(ac.signal, () => expect(() => guard()).not.toThrow());
  });

  it('guard bloqueia a continuação de um teste já abortado (inclusive depois de um await)', async () => {
    const ac = new AbortController();
    await testSignal.run(ac.signal, async () => {
      await Promise.resolve();
      ac.abort();
      await Promise.resolve();
      expect(() => guard()).toThrow(/teste encerrado/);
    });
  });

  it('sleep rejeita na hora do abort e não espera o prazo inteiro', async () => {
    const ac = new AbortController();
    const started = Date.now();
    const pending = testSignal.run(ac.signal, () => sleep(60_000));
    setTimeout(() => ac.abort(), 20);
    await expect(pending).rejects.toThrow(/teste encerrado/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('waitFor de um teste abortado para de sondar', async () => {
    const ac = new AbortController();
    const pending = testSignal.run(ac.signal, () => waitFor(() => false, 60_000));
    setTimeout(() => ac.abort(), 20);
    await expect(pending).rejects.toThrow(/teste encerrado/);
  });

  it('sleep sem sinal (hooks) termina normalmente', async () => {
    await expect(sleep(5)).resolves.toBeUndefined();
  });
});

describe('orçamento de identidades: contador do processo (02C.4E)', () => {
  it('permite exatamente `limit` tentativas e bloqueia a seguinte antes da rede', () => {
    const budget = new IdentityBudget(2);
    budget.reserve();
    budget.reserve();
    expect(budget.used).toBe(2);
    expect(() => budget.reserve()).toThrow(IdentityBudgetExceeded);
    expect(() => budget.reserve()).toThrow(/esgotado \(2\/2\)/);
    expect(budget.used).toBe(2); // a tentativa recusada não conta
  });

  it('orçamento zero (portão desligado) não deixa nenhuma tentativa', () => {
    expect(() => new IdentityBudget(0).reserve()).toThrow(IdentityBudgetExceeded);
  });

  it.each([-1, 1.5, Number.NaN])('limite inválido %s → erro na construção', (limit) => {
    expect(() => new IdentityBudget(limit)).toThrow(RangeError);
  });
});
