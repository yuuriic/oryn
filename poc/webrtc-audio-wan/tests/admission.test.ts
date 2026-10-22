// Admissão (02B.2B): convites de uso único — lógica pura com relógio controlado.
// A autorização do operador saiu daqui no 02B.2C (pareamento: tests/admin-auth.test.ts).
import { beforeEach, describe, expect, it } from 'vitest';
import { Admission, hashToken, newToken } from '../server/admission.ts';

let clock: number;
let seq: number;
let admission: Admission;

function make(): Admission {
  return new Admission({
    inviteTtlMs: 10_000,
    now: () => clock,
    randomToken: () => `T${String(++seq).padStart(42, '0')}`,
  });
}

beforeEach(() => {
  clock = 1_000;
  seq = 0;
  admission = make();
});

describe('tokens', () => {
  it('newToken gera 256 bits em base64url (43 caracteres), sem repetição', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => newToken()));
    expect(tokens.size).toBe(200);
    for (const t of tokens) {
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(t, 'base64url')).toHaveLength(32);
    }
  });
});

describe('convites', () => {
  it('convite válido é consumido uma única vez (reutilização recusada)', () => {
    const { token, expiresAt } = admission.issueInvite('S1');
    expect(expiresAt).toBe(11_000);
    expect(admission.peekInvite(token)).toBe('S1'); // peek não consome
    expect(admission.consumeInvite(token)).toBe('S1');
    expect(admission.consumeInvite(token)).toBeNull();
    expect(admission.peekInvite(token)).toBeNull();
  });

  it('convite expirado é recusado', () => {
    const { token } = admission.issueInvite('S1');
    clock += 10_000;
    expect(admission.peekInvite(token)).toBeNull();
    expect(admission.consumeInvite(token)).toBeNull();
  });

  it('convite revogado (sessão encerrada) é recusado', () => {
    const { token } = admission.issueInvite('S1');
    admission.revokeSession('S1');
    expect(admission.consumeInvite(token)).toBeNull();
    expect(admission.activeInvites).toBe(0);
  });

  it('emitir um novo convite revoga o anterior da mesma sessão; sessões diferentes são independentes', () => {
    const first = admission.issueInvite('S1');
    const other = admission.issueInvite('S2');
    const second = admission.issueInvite('S1');
    expect(admission.consumeInvite(first.token)).toBeNull();
    expect(admission.consumeInvite(second.token)).toBe('S1');
    expect(admission.consumeInvite(other.token)).toBe('S2');
  });

  it('convite vinculado à sessão correta', () => {
    const a = admission.issueInvite('SA');
    const b = admission.issueInvite('SB');
    expect(admission.consumeInvite(b.token)).toBe('SB');
    expect(admission.consumeInvite(a.token)).toBe('SA');
  });

  it('consumo concorrente do mesmo convite: exatamente um sucesso', async () => {
    const { token } = admission.issueInvite('S1');
    const results = await Promise.all(Array.from({ length: 20 }, () => Promise.resolve().then(() => admission.consumeInvite(token))));
    expect(results.filter((r) => r === 'S1')).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(19);
  });

  it('só o hash do convite é armazenado (o token em claro não fica em memória)', () => {
    const { token } = admission.issueInvite('S1');
    const internals = JSON.stringify([...(admission as unknown as { invites: Map<string, unknown> }).invites.entries()]);
    expect(internals).not.toContain(token);
    expect(internals).toContain(hashToken(token).toString('hex'));
  });

  it('sweep remove convites expirados', () => {
    admission.issueInvite('S1');
    admission.issueInvite('S2');
    clock += 10_000;
    admission.sweep();
    expect(admission.activeInvites).toBe(0);
  });
});
