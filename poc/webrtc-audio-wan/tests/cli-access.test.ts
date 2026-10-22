// Configuração do Cloudflare Access pelo ambiente (02B.3A), no processo real (server/index.ts).
// Só casos que falham ANTES de qualquer busca de chaves: nenhuma rede pública é usada.
import { spawnSync } from 'node:child_process';
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
  ])('%s → não inicia', (_name, env, message) => {
    const r = run(env);
    expect(r.status).not.toBe(0);
    expect(r.output).toMatch(message);
    expect(r.output).not.toContain('Código de pareamento');
  });
});
