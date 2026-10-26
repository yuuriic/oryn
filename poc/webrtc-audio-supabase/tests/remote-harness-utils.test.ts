// Peças puras do harness remoto (02C.4B.1), sem rede: o que impede falso PASS e operação remota tardia.
import { describe, expect, it } from 'vitest';
import { guard, isCredentialRefusal, isServerReply, sanitize, sleep, testSignal, waitFor } from './remote/harness-utils.ts';

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

  it('recusa por credencial é distinguida da recusa por autorização', () => {
    expect(isCredentialRefusal('InvalidJWTToken: Token has expired')).toBe(true);
    expect(isCredentialRefusal('Unauthorized: You do not have permissions to read from this Channel topic')).toBe(false);
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
