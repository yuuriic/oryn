// Prontidão WAN (02B.5): mapeamento PASS/FAIL/NOT_VERIFIED, nada de operador vira PASS, diagnóstico local
// simulado e CLI consolidada (sem rede, sem túnel, sem credenciais reais).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import type { PreflightReport } from '../server/cloudflare-preflight.ts';
import { runDiagnostics } from '../server/diagnostics.ts';
import { repoRoot, trackedContains, trackedHasJwt } from '../server/preflight-io.ts';
import { OPERATOR_ITEMS, buildReadiness, summarize, type ReadinessInput } from '../server/readiness.ts';

const okPreflight: PreflightReport = { ok: true, errors: [], summary: {} };
const input = (over: Partial<ReadinessInput> = {}): ReadinessInput => ({
  mode: 'activation',
  preflight: okPreflight,
  env: { ORYN_TURN_PROVIDER: 'cloudflare', ORYN_TURN_TTL_S: '7200' },
  diagnostics: [],
  versionedSecrets: [],
  ...over,
});
const status = (items: ReturnType<typeof buildReadiness>, id: string) => items.find((i) => i.id === id)?.status;

describe('buildReadiness', () => {
  it('pré-validação limpa + TURN habilitado → nenhum FAIL; itens do operador sempre NOT_VERIFIED', () => {
    const items = buildReadiness(input());
    expect(summarize(items).fail).toBe(0);
    for (const [id] of OPERATOR_ITEMS) expect(status(items, id), id).toBe('NOT_VERIFIED');
    expect(status(items, 'N-TURNS-REAL')).toBe('NOT_VERIFIED');
    expect(items.filter((i) => i.id.startsWith('N-')).every((i) => i.status === 'NOT_VERIFIED')).toBe(true);
  });

  it.each([
    ['CFG_ADMIN_PORT', 'P-5281'],
    ['CFG_CATCHALL', 'P-404'],
    ['CFG_SERVICE', 'P-5280'],
    ['CFG_HOST_HEADER', 'P-BYPASS'],
    ['ENV_ACCESS_MODE', 'P-ACCESS'],
    ['CFG_ACCESS', 'P-ACCESS-CFG'],
    ['ENV_HOSTNAMES', 'P-HOST'],
    ['CFG_LOGLEVEL', 'P-LOGS'],
    ['CFG_CREDENTIALS', 'P-CREDS'],
    ['ENV_PLACEHOLDER', 'P-REAL'],
    ['ENV_TURN', 'P-TURN-FMT'],
  ])('violação %s → %s FAIL', (code, id) => {
    const items = buildReadiness(input({ preflight: { ok: false, errors: [{ id: code, message: 'violação' }], summary: {} } }));
    expect(status(items, id)).toBe('FAIL');
  });

  it('regra da pré-validação sem requisito mapeado também reprova', () => {
    const items = buildReadiness(input({ preflight: { ok: false, errors: [{ id: 'CFG_NOVA', message: 'x' }], summary: {} } }));
    expect(status(items, 'P-CFG_NOVA')).toBe('FAIL');
  });

  it('modo template: valores reais e credenciais ficam NOT_VERIFIED (nunca PASS)', () => {
    const items = buildReadiness(input({ mode: 'template' }));
    expect(status(items, 'P-REAL')).toBe('NOT_VERIFIED');
    expect(status(items, 'P-CREDS')).toBe('NOT_VERIFIED');
  });

  it('TURN desligado, validade curta e STUN na porta 53 → FAIL', () => {
    const items = buildReadiness(input({ env: { ORYN_TURN_PROVIDER: 'off', ORYN_TURN_TTL_S: '600', ORYN_ICE_STUN_URLS: 'stun:x.example:53' } }));
    expect(status(items, 'P-TURN-ON')).toBe('FAIL');
    expect(status(items, 'P-TURN-TTL')).toBe('FAIL');
    expect(status(items, 'P-STUN')).toBe('FAIL');
    expect(status(items, 'P-TURN-SERVER')).toBe('NOT_VERIFIED');
  });

  it('segredo real versionado → FAIL (e o segredo TURN deixa de estar "só no servidor")', () => {
    const items = buildReadiness(input({ versionedSecrets: ['token da API TURN'] }));
    expect(status(items, 'P-SECRETS')).toBe('FAIL');
    expect(status(items, 'P-TURN-SERVER')).toBe('FAIL');
  });

  it('diagnóstico não executado → NOT_VERIFIED; diagnóstico com falha → FAIL', () => {
    expect(status(buildReadiness(input({ diagnostics: null })), 'D')).toBe('NOT_VERIFIED');
    const items = buildReadiness(input({ diagnostics: [{ id: 'D-A1', area: 'Access HTTP', cenario: 'x', status: 'FAIL', observado: 'HTTP 200' }] }));
    expect(status(items, 'D-A1')).toBe('FAIL');
  });
});

describe('diagnóstico local (simulado, sem rede)', () => {
  it('todos os cenários passam com o código atual', async () => {
    const results = await runDiagnostics();
    expect(results.length).toBeGreaterThanOrEqual(24);
    expect(results.filter((r) => r.status === 'FAIL')).toEqual([]);
  }, 30_000);
});

describe('busca de segredos versionados (git, padrão pela entrada padrão)', () => {
  it('encontra texto versionado, ignora texto inexistente e não acha JWT literal no repositório', () => {
    const root = repoRoot();
    expect(trackedContains(root, '@oryn/poc-webrtc-audio-wan')).toBe(true);
    expect(trackedContains(root, `inexistente-${Date.now()}-${Math.random()}`)).toBe(false);
    expect(trackedHasJwt(root)).toBe(false);
  });
});

describe('CLI readiness', () => {
  const cli = fileURLToPath(new URL('../server/readiness-cli.ts', import.meta.url));
  const example = (f: string) => fileURLToPath(new URL(`../cloudflare/${f}`, import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'oryn-readiness-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const exec = (args: string[]) => {
    const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 60_000 });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it('modelos versionados (template): TURN desligado → FAIL; nunca afirma autorização', () => {
    const r = exec([`--config=${example('config.example.yml')}`, `--env-file=${example('server.env.example')}`, '--mode=template', '--skip-diagnostics']);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/FAIL\s+P-TURN-ON/);
    expect(r.out).toMatch(/NOT_VERIFIED\s+N-APPROVAL/);
    expect(r.out).toContain('NÃO ativar');
  });

  it('configuração real fictícia fora do repositório, TURN habilitado → sem FAIL, sem imprimir segredos; JSON gerado', () => {
    const TUNNEL = '6f1d2c3b-4a59-4e8f-9a7b-1c2d3e4f5a6b';
    const SECRET = 'U0VHUkVETy1ETy1UVU5FTC1GSUNUSUNJTw==';
    const TOKEN = 'TOKEN-TURN-FICTICIO-0123456789';
    const AUD = '4f2a9c1e7b3d5f60817293a4b5c6d7e8f9a0b1c2d3e4f5061728394a5b6c7d8e';
    const creds = join(dir, `${TUNNEL}.json`);
    writeFileSync(creds, JSON.stringify({ AccountTag: 'conta', TunnelSecret: SECRET, TunnelID: TUNNEL }));
    const cfg = join(dir, 'config.yml');
    writeFileSync(cfg, stringify({
      tunnel: TUNNEL,
      'credentials-file': creds,
      loglevel: 'info',
      ingress: [
        { hostname: 'sinal.oryn-validacao.net', service: 'http://127.0.0.1:5280', originRequest: { access: { required: true, teamName: 'oryn-lab', audTag: [AUD] } } },
        { service: 'http_status:404' },
      ],
    }));
    const env = join(dir, 'server.env');
    writeFileSync(env, [
      'ORYN_PUBLIC_HOSTNAMES=sinal.oryn-validacao.net',
      'ORYN_ACCESS_MODE=required',
      'ORYN_ACCESS_TEAM_DOMAIN=oryn-lab.cloudflareaccess.com',
      `ORYN_ACCESS_AUD=${AUD}`,
      'ORYN_TURN_PROVIDER=cloudflare',
      'ORYN_TURN_KEY_ID=turnkey0123456789',
      `ORYN_TURN_API_TOKEN=${TOKEN}`,
    ].join('\n'));
    const json = join(dir, 'readiness.json');
    const r = exec([`--config=${cfg}`, `--env-file=${env}`, '--skip-diagnostics', `--json=${json}`]);
    expect(r.out).toContain('nenhum FAIL');
    expect(r.status).toBe(0);
    for (const secret of [SECRET, TOKEN, AUD]) expect(r.out).not.toContain(secret);
    expect(r.out).toMatch(/NOT_VERIFIED\s+N-APPROVAL/);
    const saved = readFileSync(json, 'utf8');
    for (const secret of [SECRET, TOKEN, AUD]) expect(saved).not.toContain(secret);
    expect(JSON.parse(saved).totais.fail).toBe(0);
  });

  it('recusa argumentos com valores sensíveis', () => {
    expect(exec(['--token=abc']).status).toBe(2);
  });
});
