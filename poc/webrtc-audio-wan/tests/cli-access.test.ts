// Configuração do Cloudflare Access pelo ambiente (02B.3A), no processo real (server/index.ts).
// Só casos que falham ANTES de qualquer busca de chaves: nenhuma rede pública é usada.
import { spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { AUD, TEAM } from './helpers/access.ts';
import { fakeDist } from './helpers/ws-client.ts';

const entry = fileURLToPath(new URL('../server/index.ts', import.meta.url));
const dist = fakeDist();
afterAll(() => rmSync(dist, { recursive: true, force: true }));

function run(env: Record<string, string>): { status: number | null; output: string } {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ORYN_')));
  const r = spawnSync(process.execPath, [entry, '--http-port=0', '--admin-port=0', `--dist-dir=${dist}`], {
    env: { ...base, ...env },
    input: '',
    encoding: 'utf8',
    timeout: 15_000,
  });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

describe('servidor real: configuração do Access (falha fechada)', () => {
  it.each([
    ['hostname público sem Access', { ORYN_PUBLIC_HOSTNAMES: 'oryn-poc.example.com' }, /exigem Cloudflare Access/],
    ['hostname público com Access desligado explicitamente', { ORYN_PUBLIC_HOSTNAMES: 'oryn-poc.example.com', ORYN_ACCESS_MODE: 'off' }, /exigem Cloudflare Access/],
    ['modo desconhecido', { ORYN_ACCESS_MODE: 'optional' }, /"required" ou "off"/],
    ['Access desligado com variáveis do Access definidas', { ORYN_ACCESS_AUD: AUD }, /configuração ambígua/],
    ['Access obrigatório sem domínio da equipe', { ORYN_ACCESS_MODE: 'required', ORYN_ACCESS_AUD: AUD }, /teamDomain/],
    ['Access obrigatório sem audiência', { ORYN_ACCESS_MODE: 'required', ORYN_ACCESS_TEAM_DOMAIN: TEAM }, /audience/],
    ['domínio de chaves arbitrário', { ORYN_ACCESS_MODE: 'required', ORYN_ACCESS_TEAM_DOMAIN: 'evil.example.com', ORYN_ACCESS_AUD: AUD }, /teamDomain/],
    ['timeout não numérico', { ORYN_ACCESS_MODE: 'required', ORYN_ACCESS_TEAM_DOMAIN: TEAM, ORYN_ACCESS_AUD: AUD, ORYN_ACCESS_JWKS_TIMEOUT_MS: '3s' }, /inteiro/],
    ['timeout fora da faixa', { ORYN_ACCESS_MODE: 'required', ORYN_ACCESS_TEAM_DOMAIN: TEAM, ORYN_ACCESS_AUD: AUD, ORYN_ACCESS_JWKS_TIMEOUT_MS: '0' }, /jwksTimeoutMs/],
    // STUN/TURN (02B.4)
    ['provedor TURN desconhecido', { ORYN_TURN_PROVIDER: 'twilio' }, /"cloudflare" ou "off"/],
    ['TURN desligado com credenciais definidas', { ORYN_TURN_KEY_ID: 'turnkey0123456789' }, /configuração ambígua/],
    ['TURN cloudflare sem token', { ORYN_TURN_PROVIDER: 'cloudflare', ORYN_TURN_KEY_ID: 'turnkey0123456789' }, /ORYN_TURN_API_TOKEN inválido/],
    ['TURN cloudflare com id inválido', { ORYN_TURN_PROVIDER: 'cloudflare', ORYN_TURN_KEY_ID: 'x', ORYN_TURN_API_TOKEN: 'TOKEN-0123456789abcdef' }, /ORYN_TURN_KEY_ID inválido/],
    ['validade TURN não numérica', { ORYN_TURN_TTL_S: '2h' }, /ORYN_TURN_TTL_S/],
    ['validade TURN fora da faixa', { ORYN_TURN_TTL_S: '60' }, /ttlSec/],
    ['STUN extra inválido', { ORYN_ICE_STUN_URLS: 'stun:x.example:53' }, /STUN/],
  ])('%s → não inicia', (_name, env, message) => {
    const r = run(env);
    expect(r.status).not.toBe(0);
    expect(r.output).toMatch(message);
    expect(r.output).not.toContain('Código de pareamento');
  });
});

describe('servidor real: TURN configurado (sem rede: credenciais só são pedidas sob demanda)', () => {
  it('inicia com o provedor cloudflare, mostra o modo no banner e nunca imprime o token', async () => {
    const TOKEN = 'TOKEN-SECRETO-0123456789abcdef';
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ORYN_')));
    const child = spawn(process.execPath, [entry, '--http-port=0', '--admin-port=0', `--dist-dir=${dist}`], {
      env: { ...base, ORYN_TURN_PROVIDER: 'cloudflare', ORYN_TURN_KEY_ID: 'turnkey0123456789', ORYN_TURN_API_TOKEN: TOKEN, ORYN_TURN_TTL_S: '3600' },
    });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (out += d));
    try {
      await new Promise<void>((resolve, reject) => {
        const started = Date.now();
        const tick = () => (out.includes('Código de pareamento') ? resolve() : Date.now() - started > 10_000 ? reject(new Error(out)) : setTimeout(tick, 20));
        tick();
      });
      expect(out).toMatch(/TURN:\s+cloudflare \(credenciais temporárias, validade 60 min\)/);
      expect(out).not.toContain(TOKEN);
      expect(out).not.toContain('turnkey0123456789');
    } finally {
      child.kill();
    }
  });
});
