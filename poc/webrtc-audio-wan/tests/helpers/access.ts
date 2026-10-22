// Emissor Cloudflare Access FALSO para testes (02B.3A): chaves geradas localmente a cada execução,
// tokens assinados localmente e JWKS servido por um transporte em memória. Nenhuma rede pública,
// nenhuma credencial real.
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK, type JWTPayload } from 'jose';
import type { AccessConfig, JwksFetch } from '../../server/access.ts';

export const TEAM = 'oryn-test.cloudflareaccess.com';
export const ISSUER = `https://${TEAM}`;
export const JWKS_URL = `${ISSUER}/cdn-cgi/access/certs`;
export const AUD = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

export interface TestKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
}

export async function newKey(kid: string, alg: 'RS256' | 'ES256' = 'RS256', modulusLength = 2048): Promise<TestKey> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true, ...(alg === 'RS256' ? { modulusLength } : {}) });
  return { kid, privateKey, publicJwk: { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' } };
}

/** Token no formato do Access: RS256, kid, iss, aud (lista), iat, exp. */
export async function token(
  key: TestKey,
  options: { claims?: Record<string, unknown>; header?: Record<string, unknown>; expiresInSec?: number; nowMs?: number } = {},
): Promise<string> {
  const now = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const claims: Record<string, unknown> = {
    iss: ISSUER,
    aud: [AUD],
    sub: 'test-user-id',
    email: 'convidado@example.com',
    iat: now,
    nbf: now,
    exp: now + (options.expiresInSec ?? 600),
    ...options.claims,
  };
  return new SignJWT(claims as JWTPayload)
    .setProtectedHeader({ alg: 'RS256', kid: key.kid, ...options.header } as { alg: string })
    .sign(key.privateKey);
}

/** Transporte JWKS em memória: o teste controla as chaves publicadas e falhas; conta as buscas. */
export class FakeJwks {
  keys: JWK[] = [];
  /** Substitui a resposta (falhas, corpo malformado, atraso). */
  respond: ((url: string, init: RequestInit) => Promise<Response>) | null = null;
  requests: { url: string; init: RequestInit }[] = [];

  readonly fetch: JwksFetch = (url, init) => {
    this.requests.push({ url, init });
    if (url !== JWKS_URL) return Promise.reject(new Error(`URL inesperada: ${url}`));
    if (this.respond) return this.respond(url, init);
    return Promise.resolve(Response.json({ keys: this.keys, public_cert: { kid: 'x', cert: '-' } }));
  };

  publish(...keys: TestKey[]): void {
    this.keys = keys.map((k) => k.publicJwk);
  }
}

/** Resposta que só termina quando o sinal é abortado (simula JWKS travado). */
export function hang(init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('abort')));
  });
}

/**
 * Emissor pronto para testes de servidor: uma chave publicada, um JWT válido por 1 h e a configuração
 * do servidor (accessFetch em memória). O proxy de túnel dos testes injeta esse JWT, como a borda faria.
 */
export async function testIssuer(): Promise<{ jwks: FakeJwks; key: TestKey; jwt: string; server: { access: AccessConfig; accessFetch: JwksFetch } }> {
  const jwks = new FakeJwks();
  const key = await newKey('kid-test');
  jwks.publish(key);
  const jwt = await token(key, { expiresInSec: 3600 });
  return { jwks, key, jwt, server: { access: accessConfig(), accessFetch: jwks.fetch } };
}

export function accessConfig(overrides: Partial<AccessConfig> = {}): AccessConfig {
  return { teamDomain: TEAM, audience: AUD, ...overrides };
}
