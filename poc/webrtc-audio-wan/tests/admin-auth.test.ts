// Autenticação administrativa (02B.2C): código de pareamento de uso único → token administrativo.
// Lógica pura com relógio e aleatoriedade controlados.
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AdminAuth, formatPairingCode, newPairingCode, normalizePairingCode } from '../server/admin-auth.ts';
import { newToken } from '../server/admission.ts';

let clock: number;
let codes: string[];
let auth: AdminAuth;

function make(): AdminAuth {
  return new AdminAuth({
    codeTtlMs: 300_000,
    maxCodeAttempts: 5,
    sessionTtlMs: 3_600_000,
    now: () => clock,
    newCode: () => codes.shift() ?? newPairingCode(),
    newToken,
  });
}

beforeEach(() => {
  clock = 1_000;
  codes = ['ABCD2345', 'WXYZ6789'];
  auth = make();
});

const paired = (r: ReturnType<AdminAuth['pair']>): string => {
  if (!r.ok) throw new Error(`pareamento falhou: ${r.reason}`);
  return r.token;
};

describe('código de pareamento', () => {
  it('8 caracteres Crockford base32 (40 bits), sem repetição em 500 códigos', () => {
    const all = new Set(Array.from({ length: 500 }, () => newPairingCode()));
    expect(all.size).toBe(500);
    for (const c of all) expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
  });

  it('exibição em dois grupos e normalização do que o operador digita', () => {
    expect(formatPairingCode('ABCD2345')).toBe('ABCD-2345');
    expect(normalizePairingCode(' abcd-2345 ')).toBe('ABCD2345');
    expect(normalizePairingCode('O1L0-iiii')).toBe('01101111'); // O→0, I/L→1
  });

  it('aceita o código digitado com hífen e em minúsculas', () => {
    auth.issuePairingCode();
    expect(auth.pair('abcd-2345').ok).toBe(true);
  });

  it('uso único: o mesmo código não serve duas vezes', () => {
    auth.issuePairingCode();
    paired(auth.pair('ABCD2345'));
    expect(auth.pair('ABCD2345')).toEqual({ ok: false, reason: 'invalid' });
    expect(auth.pairingPending).toBe(false);
  });

  it('expira após o TTL (5 min)', () => {
    const { expiresAt } = auth.issuePairingCode();
    expect(expiresAt).toBe(301_000);
    clock = expiresAt;
    expect(auth.pairingPending).toBe(false);
    expect(auth.pair('ABCD2345')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('5 tentativas erradas queimam o código (inclusive para o código certo depois)', () => {
    auth.issuePairingCode();
    for (let i = 0; i < 4; i++) expect(auth.pair('ZZZZZZZZ')).toEqual({ ok: false, reason: 'invalid' });
    expect(auth.pair('ZZZZZZZZ')).toEqual({ ok: false, reason: 'exhausted' });
    expect(auth.pair('ABCD2345')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('gerar um novo código invalida o anterior e zera as tentativas', () => {
    auth.issuePairingCode();
    for (let i = 0; i < 4; i++) auth.pair('ZZZZZZZZ');
    auth.issuePairingCode();
    expect(auth.pair('ABCD2345')).toEqual({ ok: false, reason: 'invalid' });
    expect(auth.pair('WXYZ6789').ok).toBe(true);
  });

  it('sem código emitido, nada é aceito (fechado por padrão)', () => {
    expect(auth.pair('ABCD2345')).toEqual({ ok: false, reason: 'invalid' });
    expect(auth.pair('')).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('token administrativo', () => {
  it('256 bits em base64url; verificado em tempo constante; token arbitrário recusado', () => {
    auth.issuePairingCode();
    const token = paired(auth.pair('ABCD2345'));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(auth.verify(token)).toBe(true);
    expect(auth.verify(newToken())).toBe(false);
    expect(auth.verify('')).toBe(false);
  });

  it('expira após o TTL da sessão administrativa', () => {
    auth.issuePairingCode();
    const r = auth.pair('ABCD2345');
    if (!r.ok) throw new Error('falhou');
    clock = r.expiresAt - 1;
    expect(auth.verify(r.token)).toBe(true);
    clock = r.expiresAt;
    expect(auth.verify(r.token)).toBe(false);
  });

  it('novo pareamento revoga o token anterior (uma sessão administrativa por vez)', () => {
    auth.issuePairingCode();
    const first = paired(auth.pair('ABCD2345'));
    auth.issuePairingCode();
    const second = paired(auth.pair('WXYZ6789'));
    expect(auth.verify(first)).toBe(false);
    expect(auth.verify(second)).toBe(true);
  });

  it('emitir um novo código, sozinho, não revoga o token vigente; revokeAll revoga ambos', () => {
    auth.issuePairingCode();
    const token = paired(auth.pair('ABCD2345'));
    auth.issuePairingCode();
    expect(auth.verify(token)).toBe(true);
    auth.revokeAll();
    expect(auth.verify(token)).toBe(false);
    expect(auth.pair('WXYZ6789')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('só hashes ficam em memória (nem o código nem o token em claro)', () => {
    auth.issuePairingCode();
    const internalsBefore = JSON.stringify(auth);
    expect(internalsBefore).not.toContain('ABCD2345');
    const token = paired(auth.pair('ABCD2345'));
    const internals = JSON.stringify(auth);
    expect(internals).not.toContain(token);
    const hash = createHash('sha256').update(token).digest();
    expect(internals).toContain(JSON.stringify([...hash]).slice(1, -1));
  });
});
