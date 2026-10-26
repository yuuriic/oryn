// Portão do harness remoto (unitário, roda no `pnpm test`): desligado por padrão; ligado só com
// configuração explícita e só com credencial de cliente.
import { describe, expect, it } from 'vitest';
import { RemoteConfigError, remoteGate } from './remote/remote-env.ts';

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeJwt = (claims: object) => [b64({ alg: 'HS256' }), b64(claims), 'c2ln'].join('.');
const REF = 'abcdefghijklmnopqrst';
const PUBLISHABLE = ['sb', 'publishable', 'TESTE0123'].join('_');
const SECRET = ['sb', 'secret', 'TESTE0123'].join('_');
const base = { ORYN_REMOTE: '1', ORYN_REMOTE_REF: REF, ORYN_SUPABASE_URL: `https://${REF}.supabase.co`, ORYN_PUBLISHABLE_KEY: PUBLISHABLE };

describe('portão dos testes remotos', () => {
  it('desligado por padrão (sem ORYN_REMOTE=1), mesmo com as demais variáveis', () => {
    expect(remoteGate({}).enabled).toBe(false);
    expect(remoteGate({ ...base, ORYN_REMOTE: 'true' }).enabled).toBe(false);
  });

  it('ligado com configuração completa de cliente (chave nova ou anon legada)', () => {
    expect(remoteGate(base)).toMatchObject({ enabled: true, env: { ref: REF, publishableKey: PUBLISHABLE } });
    expect(remoteGate({ ...base, ORYN_PUBLISHABLE_KEY: fakeJwt({ role: 'anon' }) }).enabled).toBe(true);
  });

  it('D0: a C1 (sem convite) não depende da confirmação de partição', () => {
    expect(remoteGate(base)).toMatchObject({ enabled: true, env: { partitionsConfirmed: false, creatorInvite: undefined } });
    expect(remoteGate({ ...base, ORYN_IT_PARTITIONS_CONFIRMED: '' })).toMatchObject({ env: { partitionsConfirmed: false } });
    expect(remoteGate({ ...base, ORYN_IT_PARTITIONS_CONFIRMED: '1' })).toMatchObject({ env: { partitionsConfirmed: true } });
  });

  it('D0: a C2 (com convite) só liga com ORYN_IT_PARTITIONS_CONFIRMED=1', () => {
    const invite = 'A'.repeat(43);
    expect(() => remoteGate({ ...base, ORYN_IT_CREATOR_INVITE: invite })).toThrow(/ORYN_IT_PARTITIONS_CONFIRMED=1/);
    expect(() => remoteGate({ ...base, ORYN_IT_CREATOR_INVITE: invite, ORYN_IT_PARTITIONS_CONFIRMED: '' })).toThrow(RemoteConfigError);
    expect(remoteGate({ ...base, ORYN_IT_CREATOR_INVITE: invite, ORYN_IT_PARTITIONS_CONFIRMED: '1' })).toMatchObject({
      enabled: true,
      env: { creatorInvite: invite, partitionsConfirmed: true },
    });
  });

  it('a recusa da C2 sem D0 não cita o valor do convite', () => {
    const invite = 'B'.repeat(43);
    expect(() => remoteGate({ ...base, ORYN_IT_CREATOR_INVITE: invite })).toThrow(expect.objectContaining({ message: expect.not.stringContaining(invite) }));
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
    ['convite malformado', { ORYN_IT_CREATOR_INVITE: 'abc' }],
    ['confirmação de partição ambígua', { ORYN_IT_PARTITIONS_CONFIRMED: 'true' }],
  ])('recusa: %s', (_label, over) => {
    expect(() => remoteGate({ ...base, ...over })).toThrow(RemoteConfigError);
  });

  it('a mensagem cita o NOME da variável administrativa, nunca o valor', () => {
    try {
      remoteGate({ ...base, LEAKED: SECRET });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('LEAKED');
      expect((error as Error).message).not.toContain(SECRET);
    }
  });
});
