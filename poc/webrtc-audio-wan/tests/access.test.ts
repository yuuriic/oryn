// Cloudflare Access (02B.3A): validação criptográfica do JWT e gerenciamento do JWKS, com chaves e
// tokens gerados localmente e transporte em memória (sem rede pública, sem credenciais reais).
import { KeyObject, generateKeyPairSync, sign as rawSign } from 'node:crypto';
import { SignJWT, base64url } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccessVerifier, JWKS_FAILURE_BACKOFF_MS, JwksClient, resolveAccessConfig, type AccessConfig } from '../server/access.ts';
import { AUD, FakeJwks, ISSUER, JWKS_URL, TEAM, accessConfig, hang, newKey, token, type TestKey } from './helpers/access.ts';

let k1: TestKey;
let k2: TestKey;
let attacker: TestKey;
let ec: TestKey;
let clock: number;
let jwks: FakeJwks;

beforeAll(async () => {
  [k1, k2, attacker, ec] = await Promise.all([newKey('kid-1'), newKey('kid-2'), newKey('kid-1'), newKey('kid-1', 'ES256')]);
});

beforeEach(() => {
  clock = Date.now();
  jwks = new FakeJwks();
  jwks.publish(k1);
});

function verifier(overrides: Partial<AccessConfig> = {}): AccessVerifier {
  return new AccessVerifier({ config: resolveAccessConfig(accessConfig(overrides)), now: () => clock, fetch: jwks.fetch });
}

const sign = (key: TestKey, options: Parameters<typeof token>[1] = {}) => token(key, { nowMs: clock, ...options });

/** Assina "à mão" (node:crypto), para cabeçalhos que a biblioteca se recusa a produzir. */
function rawToken(header: Record<string, unknown>, key: TestKey, hash = 'sha256', claims: Record<string, unknown> = {}): string {
  const now = Math.floor(clock / 1000);
  const h = base64url.encode(JSON.stringify(header));
  const p = base64url.encode(JSON.stringify({ iss: ISSUER, aud: [AUD], iat: now, exp: now + 600, ...claims }));
  const sig = rawSign(hash, Buffer.from(`${h}.${p}`), KeyObject.from(key.privateKey));
  return `${h}.${p}.${base64url.encode(sig)}`;
}

describe('configuração', () => {
  it('deriva iss e URL das chaves do domínio da equipe (nada vem do cliente)', () => {
    const c = resolveAccessConfig(accessConfig({ teamDomain: ` ${TEAM.toUpperCase()} ` }));
    expect(c.issuer).toBe(ISSUER);
    expect(c.jwksUrl).toBe(JWKS_URL);
    expect(c.audience).toBe(AUD);
  });

  it.each([
    ['domínio fora de cloudflareaccess.com', { teamDomain: 'evil.example.com' }],
    ['domínio com esquema', { teamDomain: `https://${TEAM}` }],
    ['domínio com caminho', { teamDomain: `${TEAM}/x` }],
    ['domínio vazio', { teamDomain: '' }],
    ['audiência vazia', { audience: '' }],
    ['audiência que não é AUD tag', { audience: 'minha-app' }],
    ['timeout zero', { jwksTimeoutMs: 0 }],
    ['timeout não inteiro', { jwksTimeoutMs: 1.5 }],
    ['cache curto demais', { jwksCacheTtlMs: 1 }],
    ['limite de tamanho absurdo', { jwksMaxBytes: 10 * 1024 * 1024 }],
    ['tolerância de relógio excessiva', { clockToleranceSec: 3600 }],
  ])('recusa %s', (_name, overrides) => {
    expect(() => resolveAccessConfig(accessConfig(overrides as Partial<AccessConfig>))).toThrow(/Cloudflare Access inválida/);
  });

  it('cliente JWKS recusa URL que não seja https (ou com credenciais/consulta)', () => {
    const base = { timeoutMs: 1000, maxBytes: 1024, cacheTtlMs: 60_000, maxStaleMs: 0, refreshCooldownMs: 0, now: () => 0, fetch: jwks.fetch };
    for (const url of [`http://${TEAM}/cdn-cgi/access/certs`, `https://u:p@${TEAM}/c`, `https://${TEAM}/c?x=1`, 'file:///etc/passwd']) {
      expect(() => new JwksClient({ ...base, url }), url).toThrow(/https/);
    }
  });
});

describe('validação do JWT', () => {
  it('JWT válido → ok, com o prazo do exp', async () => {
    const t = await sign(k1, { expiresInSec: 300 });
    const r = await verifier().verify(t);
    expect(r).toEqual({ ok: true, expiresAt: (Math.floor(clock / 1000) + 300) * 1000, kid: 'kid-1' });
  });

  it('aceita aud como string única', async () => {
    expect((await verifier().verify(await sign(k1, { claims: { aud: AUD } }))).ok).toBe(true);
  });

  it('ausente → missing; cabeçalho repetido, lixo, longo demais ou token administrativo → malformed', async () => {
    const v = verifier();
    const valid = await sign(k1);
    expect(await v.verify(undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(await v.verify('')).toEqual({ ok: false, reason: 'missing' });
    for (const bad of [[valid, valid], 'abc', `${valid}.x`, 'a.b.c'.padEnd(9000, 'a'), 'A'.repeat(43), `Bearer ${valid}`]) {
      expect((await v.verify(bad as string)).ok, String(bad).slice(0, 20)).toBe(false);
    }
    expect(await v.verify([valid, valid])).toEqual({ ok: false, reason: 'malformed' });
  });

  it('assinatura inválida (chave do atacante com o mesmo kid) → invalid', async () => {
    expect(await verifier().verify(await sign(attacker))).toEqual({ ok: false, reason: 'invalid' });
  });

  it('payload adulterado após a assinatura → invalid', async () => {
    const [h, , sig] = (await sign(k1)).split('.');
    const forged = base64url.encode(JSON.stringify({ iss: ISSUER, aud: [AUD], iat: 1, exp: 9_999_999_999, email: 'admin@x' }));
    expect(await verifier().verify(`${h}.${forged}.${sig}`)).toEqual({ ok: false, reason: 'invalid' });
  });

  it.each([
    ['emissor incorreto', { iss: 'https://outra-equipe.cloudflareaccess.com' }],
    ['emissor com barra final', { iss: `${ISSUER}/` }],
    ['audiência incorreta', { aud: ['b'.repeat(64)] }],
    ['sem audiência', { aud: undefined }],
  ])('%s → invalid', async (_name, claims) => {
    expect(await verifier().verify(await sign(k1, { claims }))).toEqual({ ok: false, reason: 'invalid' });
  });

  it('token expirado (além da tolerância de 30 s) → invalid; dentro da tolerância → ok', async () => {
    const v = verifier();
    expect(await v.verify(await sign(k1, { expiresInSec: -31 }))).toEqual({ ok: false, reason: 'invalid' });
    expect((await v.verify(await sign(k1, { expiresInSec: -5 }))).ok).toBe(true);
    expect(await verifier({ clockToleranceSec: 0 }).verify(await sign(k1, { expiresInSec: -1 }))).toEqual({ ok: false, reason: 'invalid' });
  });

  it('nbf no futuro → invalid', async () => {
    const nbf = Math.floor(clock / 1000) + 120;
    expect(await verifier().verify(await sign(k1, { claims: { nbf } }))).toEqual({ ok: false, reason: 'invalid' });
  });

  it('sem exp ou sem iat → invalid', async () => {
    expect(await verifier().verify(await sign(k1, { claims: { exp: undefined } }))).toEqual({ ok: false, reason: 'invalid' });
    expect(await verifier().verify(await sign(k1, { claims: { iat: undefined } }))).toEqual({ ok: false, reason: 'invalid' });
  });

  it('kid inexistente → invalid (após no máximo uma atualização controlada)', async () => {
    const v = verifier();
    await v.verify(await sign(k1)); // carrega o cache
    clock += 31_000;
    expect(await v.verify(await sign(k2))).toEqual({ ok: false, reason: 'invalid' });
    expect(jwks.requests).toHaveLength(2);
  });

  it('kid desconhecido, mesmo assinado por uma chave publicada, → invalid (a chave é escolhida só pelo kid)', async () => {
    const v = verifier();
    expect(await v.verify(rawToken({ alg: 'RS256', kid: 'kid-inexistente' }, k1))).toEqual({ ok: false, reason: 'invalid' });
    expect(await v.verify(rawToken({ alg: 'RS256', kid: 'kid-1' }, k1))).toMatchObject({ ok: true }); // controle
  });

  it('sem kid → invalid, sem buscar chaves', async () => {
    const noKid = await new SignJWT({ iss: ISSUER, aud: [AUD], iat: 1, exp: 9_999_999_999 }).setProtectedHeader({ alg: 'RS256' }).sign(k1.privateKey);
    expect(await verifier().verify(noKid)).toEqual({ ok: false, reason: 'invalid' });
    expect(jwks.requests).toHaveLength(0);
  });

  describe('algoritmos e confusão de algoritmos', () => {
    it('alg "none" (sem assinatura) → recusado', async () => {
      const h = base64url.encode(JSON.stringify({ alg: 'none', kid: 'kid-1' }));
      const p = base64url.encode(JSON.stringify({ iss: ISSUER, aud: [AUD], iat: 1, exp: 9_999_999_999 }));
      expect((await verifier().verify(`${h}.${p}.`)).ok).toBe(false);
      expect((await verifier().verify(`${h}.${p}.AAAA`)).ok).toBe(false);
    });

    it('HS256 usando a chave pública RSA como segredo HMAC → invalid', async () => {
      const secret = new TextEncoder().encode(JSON.stringify(k1.publicJwk));
      const hs = await new SignJWT({ iss: ISSUER, aud: [AUD], iat: Math.floor(clock / 1000), exp: Math.floor(clock / 1000) + 600 })
        .setProtectedHeader({ alg: 'HS256', kid: 'kid-1' })
        .sign(secret);
      expect(await verifier().verify(hs)).toEqual({ ok: false, reason: 'invalid' });
    });

    it('ES256 com kid igual ao de uma chave publicada → invalid', async () => {
      const es = await new SignJWT({ iss: ISSUER, aud: [AUD], iat: Math.floor(clock / 1000), exp: Math.floor(clock / 1000) + 600 })
        .setProtectedHeader({ alg: 'ES256', kid: 'kid-1' })
        .sign(ec.privateKey);
      expect(await verifier().verify(es)).toEqual({ ok: false, reason: 'invalid' });
    });

    it('RS512 (assinatura válida com a chave publicada, mas fora da lista permitida) → invalid', async () => {
      const t = rawToken({ alg: 'RS512', kid: 'kid-1' }, k1, 'sha512');
      expect(await verifier().verify(t)).toEqual({ ok: false, reason: 'invalid' });
      expect((await verifier().verify(rawToken({ alg: 'RS256', kid: 'kid-1' }, k1))).ok).toBe(true); // controle
    });

    it('cabeçalho "crit" desconhecido → invalid, mesmo com assinatura válida', async () => {
      expect(await verifier().verify(rawToken({ alg: 'RS256', kid: 'kid-1', crit: ['x'], x: 1 }, k1))).toEqual({ ok: false, reason: 'invalid' });
    });
  });
});

describe('JWKS: obtenção, cache e falhas (falha fechada)', () => {
  it('busca por HTTPS fixo, sem redirecionamento, sem credenciais e com timeout', async () => {
    await verifier().verify(await sign(k1));
    expect(jwks.requests).toHaveLength(1);
    const { url, init } = jwks.requests[0]!;
    expect(url).toBe(JWKS_URL);
    expect(init.redirect).toBe('error');
    expect(init.credentials).toBe('omit');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('cache: várias verificações dentro da validade fazem uma única busca; buscas simultâneas são unificadas', async () => {
    const v = verifier();
    const t = await sign(k1);
    await Promise.all(Array.from({ length: 20 }, () => v.verify(t)));
    await v.verify(t);
    expect(jwks.requests).toHaveLength(1);
  });

  it('cache vencido → nova busca', async () => {
    const v = verifier({ jwksCacheTtlMs: 60_000 });
    await v.verify(await sign(k1));
    clock += 60_000;
    expect((await v.verify(await sign(k1))).ok).toBe(true);
    expect(jwks.requests).toHaveLength(2);
  });

  it('rotação: token com kid novo provoca uma atualização e é aceito; a chave antiga sai do conjunto', async () => {
    const v = verifier({ jwksRefreshCooldownMs: 30_000 });
    expect((await v.verify(await sign(k1))).ok).toBe(true);
    jwks.publish(k1, k2);
    clock += 30_000;
    expect((await v.verify(await sign(k2))).ok).toBe(true);
    jwks.publish(k2);
    clock += 30_000;
    await v.verify(await sign(await newKey('kid-3'))); // kid desconhecido força atualização
    expect(await v.verify(await sign(k1))).toEqual({ ok: false, reason: 'invalid' });
  });

  it('kids desconhecidos dentro do intervalo mínimo não provocam novas buscas (anti-amplificação)', async () => {
    const v = verifier({ jwksRefreshCooldownMs: 30_000 });
    await v.verify(await sign(k1));
    for (let i = 0; i < 20; i++) await v.verify(await sign(await newKey(`random-${i}`)));
    expect(jwks.requests).toHaveLength(1);
  });

  it('JWKS indisponível (erro de rede) → unavailable', async () => {
    jwks.respond = () => Promise.reject(new TypeError('fetch failed'));
    expect(await verifier().verify(await sign(k1))).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('JWKS com HTTP 500, 302 ou 404 → unavailable', async () => {
    for (const status of [500, 302, 404]) {
      jwks.respond = () => Promise.resolve(new Response('x', { status, headers: status === 302 ? { location: 'https://evil.example/' } : {} }));
      expect(await verifier().verify(await sign(k1)), String(status)).toEqual({ ok: false, reason: 'unavailable' });
    }
  });

  it('timeout da busca → unavailable dentro do prazo configurado', async () => {
    jwks.respond = (_url, init) => hang(init);
    const started = Date.now();
    expect(await verifier({ jwksTimeoutMs: 150 }).verify(await sign(k1))).toEqual({ ok: false, reason: 'unavailable' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('corpo que trava no meio também respeita o timeout', async () => {
    jwks.respond = (_url, init) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"keys":['));
              init.signal?.addEventListener('abort', () => controller.error(new Error('abort')));
            },
          }),
        ),
      );
    expect(await verifier({ jwksTimeoutMs: 150 }).verify(await sign(k1))).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('resposta acima do limite de tamanho (declarada ou em fluxo) → unavailable', async () => {
    const big = JSON.stringify({ keys: [k1.publicJwk], pad: 'x'.repeat(70_000) });
    jwks.respond = () => Promise.resolve(new Response(big, { headers: { 'content-length': String(big.length) } }));
    expect(await verifier().verify(await sign(k1))).toEqual({ ok: false, reason: 'unavailable' });
    jwks.respond = () => Promise.resolve(new Response(new Blob([big]).stream()));
    expect(await verifier().verify(await sign(k1))).toEqual({ ok: false, reason: 'unavailable' });
  });

  it.each([
    ['JSON inválido', '{keys'],
    ['sem keys', '{}'],
    ['keys não é lista', '{"keys":"x"}'],
    ['lista vazia', '{"keys":[]}'],
    ['material privado no JWKS', 'PRIVATE'],
    ['RSA sem n', 'NO_N'],
    ['kid duplicado', 'DUP'],
    ['só chaves EC (nenhuma RS256 utilizável)', 'EC_ONLY'],
    ['chave RSA fraca (1024 bits)', 'WEAK'],
  ])('JWKS malformado: %s → unavailable', async (_name, kind) => {
    let body = kind;
    if (kind === 'PRIVATE') body = JSON.stringify({ keys: [{ ...k1.publicJwk, d: 'segredo' }] });
    if (kind === 'NO_N') body = JSON.stringify({ keys: [{ ...k1.publicJwk, n: undefined }] });
    if (kind === 'DUP') body = JSON.stringify({ keys: [k1.publicJwk, k1.publicJwk] });
    if (kind === 'EC_ONLY') body = JSON.stringify({ keys: [ec.publicJwk] });
    if (kind === 'WEAK') {
      const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'jwk' });
      body = JSON.stringify({ keys: [{ ...weak, kid: 'kid-1', alg: 'RS256', use: 'sig' }] });
    }
    jwks.respond = () => Promise.resolve(new Response(body));
    expect(await verifier().verify(await sign(k1))).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('falha de atualização: chaves em cache servem até o limite de "stale"; depois, falha fechada', async () => {
    const v = verifier({ jwksCacheTtlMs: 60_000, jwksMaxStaleMs: 120_000 });
    expect((await v.verify(await sign(k1))).ok).toBe(true);
    jwks.respond = () => Promise.reject(new TypeError('fetch failed'));
    clock += 61_000;
    expect((await v.verify(await sign(k1))).ok).toBe(true); // stale dentro do limite
    clock += 120_000;
    expect(await v.verify(await sign(k1))).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('após uma falha, novas buscas esperam o intervalo de recuo (não martela a origem)', async () => {
    jwks.respond = () => Promise.reject(new TypeError('fetch failed'));
    const v = verifier();
    const t = await sign(k1);
    for (let i = 0; i < 5; i++) await v.verify(t);
    expect(jwks.requests).toHaveLength(1);
    clock += JWKS_FAILURE_BACKOFF_MS;
    jwks.respond = null;
    expect((await v.verify(t)).ok).toBe(true);
    expect(jwks.requests).toHaveLength(2);
  });

  it('JWKS inválido não substitui um cache bom (rotação maliciosa recusada)', async () => {
    const v = verifier({ jwksCacheTtlMs: 60_000 });
    await v.verify(await sign(k1));
    jwks.respond = () => Promise.resolve(Response.json({ keys: [{ ...attacker.publicJwk, d: 'x' }] }));
    clock += 61_000;
    expect((await v.verify(await sign(attacker))).ok).toBe(false);
    expect((await v.verify(await sign(k1))).ok).toBe(true);
  });
});
