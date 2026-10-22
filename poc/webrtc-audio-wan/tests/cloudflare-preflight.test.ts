// Pré-validação offline da integração Cloudflare (02B.3B): config.yml do cloudflared + ambiente do servidor.
// Nada de rede, nada de cloudflared; valores fictícios.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { preflight, type PreflightInput } from '../server/cloudflare-preflight.ts';

const REPO = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const OUTSIDE = mkdtempSync(join(tmpdir(), 'oryn-preflight-'));
afterAll(() => rmSync(OUTSIDE, { recursive: true, force: true }));

const TUNNEL = '6f1d2c3b-4a59-4e8f-9a7b-1c2d3e4f5a6b';
const HOST = 'sinal.oryn-validacao.net';
const TEAM = 'oryn-lab';
const AUD = '4f2a9c1e7b3d5f60817293a4b5c6d7e8f9a0b1c2d3e4f5061728394a5b6c7d8e';
const SECRET = 'U0VHUkVETy1ETy1UVU5FTC1OVU5DQS1JTVBSRVNTTw==';
const CREDS = join(OUTSIDE, `${TUNNEL}.json`);
const CREDS_JSON = JSON.stringify({ AccountTag: 'conta', TunnelSecret: SECRET, TunnelID: TUNNEL });

type Cfg = Record<string, unknown>;
const validConfig = (): Cfg => ({
  tunnel: TUNNEL,
  'credentials-file': CREDS,
  loglevel: 'info',
  ingress: [
    { hostname: HOST, service: 'http://127.0.0.1:5280', originRequest: { access: { required: true, teamName: TEAM, audTag: [AUD] } } },
    { service: 'http_status:404' },
  ],
});
const validEnv = (): Record<string, string> => ({
  ORYN_PUBLIC_HOSTNAMES: HOST,
  ORYN_ACCESS_MODE: 'required',
  ORYN_ACCESS_TEAM_DOMAIN: `${TEAM}.cloudflareaccess.com`,
  ORYN_ACCESS_AUD: AUD,
});

function run(overrides: Partial<PreflightInput> & { cfg?: Cfg } = {}) {
  const { cfg, ...rest } = overrides;
  return preflight({
    mode: 'activation',
    configText: stringify(cfg ?? validConfig()),
    env: validEnv(),
    repoRoot: REPO,
    configPath: join(OUTSIDE, 'config.yml'),
    envPath: join(OUTSIDE, 'server.env'),
    signalPort: 5280,
    adminPort: 5281,
    readFile: (p) => (resolve(p) === resolve(CREDS) ? CREDS_JSON : null),
    isTrackedOrUnignored: () => false,
    ...rest,
  });
}
const ids = (r: ReturnType<typeof run>) => [...new Set(r.errors.map((e) => e.id))];
const rule = (cfg: Cfg) => (cfg['ingress'] as Cfg[])[0]!;
const origin = (cfg: Cfg) => rule(cfg)['originRequest'] as Cfg;

describe('configuração válida', () => {
  it('passa; o resumo não contém o segredo do túnel nem a AUD completa', () => {
    const r = run();
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    const printed = JSON.stringify(r);
    expect(printed).not.toContain(SECRET);
    expect(printed).not.toContain(AUD);
    expect(r.summary['AUD tag']).toBe('4f2a9c…(64)');
    expect(r.summary['serviço']).toBe('http://127.0.0.1:5280');
  });

  it('access no originRequest de topo também vale', () => {
    const cfg = validConfig();
    cfg['originRequest'] = { access: origin(cfg)['access'] };
    delete rule(cfg)['originRequest'];
    expect(run({ cfg }).ok).toBe(true);
  });
});

describe('roteamento e fronteira (config.yml)', () => {
  const cases: [string, (c: Cfg) => void, string[]][] = [
    ['serviço apontado para a porta administrativa', (c) => (rule(c)['service'] = 'http://127.0.0.1:5281'), ['CFG_SERVICE', 'CFG_ADMIN_PORT']],
    ['regra extra para a porta administrativa', (c) => (c['ingress'] as Cfg[]).splice(1, 0, { hostname: HOST, path: '/admin', service: 'http://127.0.0.1:5281' }), ['CFG_INGRESS', 'CFG_ADMIN_PORT']],
    ['porta administrativa em qualquer outro campo', (c) => (c['metrics'] = '127.0.0.1:5281'), ['CFG_ADMIN_PORT']],
    ['sem catch-all', (c) => (c['ingress'] as Cfg[]).pop(), ['CFG_INGRESS', 'CFG_CATCHALL']],
    ['catch-all com outro status', (c) => ((c['ingress'] as Cfg[])[1] = { service: 'http_status:503' }), ['CFG_CATCHALL']],
    ['catch-all com hostname', (c) => ((c['ingress'] as Cfg[])[1] = { hostname: 'x.oryn-validacao.net', service: 'http_status:404' }), ['CFG_CATCHALL']],
    ['catch-all servindo a aplicação', (c) => ((c['ingress'] as Cfg[])[1] = { service: 'http://127.0.0.1:5280' }), ['CFG_CATCHALL']],
    ['hostname diferente do ambiente', (c) => (rule(c)['hostname'] = 'outro.oryn-validacao.net'), ['CFG_HOSTNAME']],
    ['hostname com curinga', (c) => (rule(c)['hostname'] = '*.oryn-validacao.net'), ['CFG_HOSTNAME']],
    ['regra com path (cobertura parcial)', (c) => (rule(c)['path'] = '^/ws$'), ['CFG_RULE']],
    ['serviço em localhost (não o literal)', (c) => (rule(c)['service'] = 'http://localhost:5280'), ['CFG_SERVICE']],
    ['serviço https', (c) => (rule(c)['service'] = 'https://127.0.0.1:5280'), ['CFG_SERVICE']],
    ['serviço em outra porta', (c) => (rule(c)['service'] = 'http://127.0.0.1:8080'), ['CFG_SERVICE']],
    ['Host reescrito (httpHostHeader na regra)', (c) => (origin(c)['httpHostHeader'] = 'localhost:5280'), ['CFG_HOST_HEADER']],
    ['Host reescrito (httpHostHeader no topo)', (c) => (c['originRequest'] = { httpHostHeader: 'localhost' }), ['CFG_HOST_HEADER']],
    ['noTLSVerify', (c) => (origin(c)['noTLSVerify'] = true), ['CFG_ORIGIN_REQUEST']],
    ['proxyType socks', (c) => (origin(c)['proxyType'] = 'socks'), ['CFG_ORIGIN_REQUEST']],
    ['sem validação do Access no cloudflared', (c) => delete origin(c)['access'], ['CFG_ACCESS']],
    ['access.required falso', (c) => ((origin(c)['access'] as Cfg)['required'] = false), ['CFG_ACCESS']],
    ['equipe diferente', (c) => ((origin(c)['access'] as Cfg)['teamName'] = 'outra-equipe'), ['CFG_ACCESS']],
    ['AUD de outra aplicação', (c) => ((origin(c)['access'] as Cfg)['audTag'] = ['b'.repeat(64)]), ['CFG_ACCESS']],
    ['AUD extra (outra aplicação aceita)', (c) => ((origin(c)['access'] as Cfg)['audTag'] = [AUD, 'b'.repeat(64)]), ['CFG_ACCESS']],
    ['loglevel debug (registra o JWT)', (c) => (c['loglevel'] = 'debug'), ['CFG_LOGLEVEL']],
    ['transport-loglevel trace', (c) => (c['transport-loglevel'] = 'trace'), ['CFG_LOGLEVEL']],
    ['métricas fora do loopback', (c) => (c['metrics'] = '0.0.0.0:2000'), ['CFG_METRICS']],
    ['warp-routing', (c) => (c['warp-routing'] = { enabled: true }), ['CFG_WARP']],
    ['token no arquivo (túnel remoto)', (c) => (c['token'] = 'eyJ…'), ['CFG_TOKEN']],
    ['modo legado url', (c) => (c['url'] = 'http://127.0.0.1:5280'), ['CFG_LEGACY']],
    ['chave de topo desconhecida', (c) => (c['autoupdate-freq'] = '1h'), ['CFG_KEYS']],
    ['Quick Tunnel (sem túnel nomeado)', (c) => delete c['tunnel'], ['CFG_TUNNEL']],
    ['serviço ssh', (c) => (c['ingress'] as Cfg[]).splice(1, 0, { hostname: 'ssh.oryn-validacao.net', service: 'ssh://127.0.0.1:22' }), ['CFG_SERVICE_TYPE']],
  ];

  it.each(cases)('%s → recusado', (_name, mutate, expected) => {
    const cfg = validConfig();
    mutate(cfg);
    const r = run({ cfg });
    expect(r.ok).toBe(false);
    for (const id of expected) expect(ids(r), id).toContain(id);
  });

  it('hostname de Quick Tunnel em qualquer lugar → recusado', () => {
    const cfg = validConfig();
    rule(cfg)['hostname'] = 'abc.trycloudflare.com';
    const r = run({ cfg, env: { ...validEnv(), ORYN_PUBLIC_HOSTNAMES: 'abc.trycloudflare.com' } });
    expect(ids(r)).toEqual(expect.arrayContaining(['CFG_QUICK_TUNNEL', 'ENV_PLACEHOLDER']));
  });

  it('YAML inválido, chaves duplicadas, âncoras e aliases → recusados sem ecoar o conteúdo', () => {
    for (const text of ['ingress: [', `tunnel: ${TUNNEL}\ntunnel: ${TUNNEL}\n`]) {
      const r = run({ configText: text } as Partial<PreflightInput>);
      expect(ids(r)).toContain('CFG_PARSE');
    }
    const aliased = `tunnel: ${TUNNEL}\ncredentials-file: ${CREDS}\nx: &a\n  access: {required: true}\ningress:\n  - hostname: ${HOST}\n    service: http://127.0.0.1:5280\n    originRequest: *a\n  - service: http_status:404\n`;
    expect(ids(run({ configText: aliased } as Partial<PreflightInput>))).toContain('CFG_ALIAS');
  });
});

describe('credenciais e arquivos', () => {
  it.each([
    ['credentials-file dentro do repositório', { 'credentials-file': join(REPO, `${TUNNEL}.json`) }],
    ['credentials-file relativo', { 'credentials-file': `${TUNNEL}.json` }],
    ['credentials-file ausente', { 'credentials-file': undefined }],
  ])('%s → recusado', (_name, patch) => {
    const cfg: Cfg = { ...validConfig(), ...patch };
    if (patch['credentials-file'] === undefined) delete cfg['credentials-file'];
    // Arquivo "legível e válido" em qualquer caminho: a recusa vem da regra de localização, não da leitura.
    const r = run({ cfg, readFile: () => CREDS_JSON });
    expect(ids(r)).toContain('CFG_CREDENTIALS');
    expect(r.errors.find((e) => e.id === 'CFG_CREDENTIALS')!.message).not.toMatch(/ilegível/);
  });

  it('credenciais ilegíveis, sem segredo ou de outro túnel → recusadas, sem imprimir o segredo', () => {
    const variants = [null, '{x', JSON.stringify({ TunnelID: TUNNEL }), JSON.stringify({ TunnelID: '00000000-1111-2222-3333-444444444444', TunnelSecret: SECRET })];
    for (const content of variants) {
      const r = run({ readFile: () => content });
      expect(ids(r)).toContain('CFG_CREDENTIALS');
      expect(JSON.stringify(r)).not.toContain(SECRET);
    }
  });

  it('config.yml ou arquivo de ambiente real versionado/não ignorado → recusado', () => {
    const r = run({ configPath: join(REPO, 'config.yml'), isTrackedOrUnignored: () => true });
    expect(ids(r)).toEqual(expect.arrayContaining(['CFG_FILE', 'ENV_FILE']));
  });

  it('UUID de exemplo → recusado na ativação', () => {
    const cfg = validConfig();
    cfg['tunnel'] = '00000000-0000-0000-0000-000000000000';
    expect(ids(run({ cfg }))).toContain('CFG_PLACEHOLDER');
  });
});

describe('ambiente do servidor', () => {
  it.each([
    ['Access desligado', { ORYN_ACCESS_MODE: 'off' }, 'ENV_ACCESS_MODE'],
    ['sem modo do Access', { ORYN_ACCESS_MODE: undefined }, 'ENV_ACCESS_MODE'],
    ['sem domínio da equipe', { ORYN_ACCESS_TEAM_DOMAIN: undefined }, 'ENV_ACCESS'],
    ['domínio de chaves arbitrário', { ORYN_ACCESS_TEAM_DOMAIN: 'evil.example.com' }, 'ENV_ACCESS'],
    ['sem AUD', { ORYN_ACCESS_AUD: undefined }, 'ENV_ACCESS'],
    ['parâmetro opcional inválido', { ORYN_ACCESS_JWKS_TIMEOUT_MS: '3s' }, 'ENV_ACCESS'],
    ['dois hostnames', { ORYN_PUBLIC_HOSTNAMES: `${HOST},outro.oryn-validacao.net` }, 'ENV_HOSTNAMES'],
    ['hostname ausente', { ORYN_PUBLIC_HOSTNAMES: undefined }, 'ENV_HOSTNAMES'],
    ['hostname com curinga', { ORYN_PUBLIC_HOSTNAMES: '*.oryn-validacao.net' }, 'ENV_HOSTNAMES'],
    ['hostname de exemplo', { ORYN_PUBLIC_HOSTNAMES: 'oryn-poc.example.com' }, 'ENV_PLACEHOLDER'],
    ['AUD de exemplo', { ORYN_ACCESS_AUD: '0'.repeat(64) }, 'ENV_PLACEHOLDER'],
    ['equipe de exemplo', { ORYN_ACCESS_TEAM_DOMAIN: 'oryn-example.cloudflareaccess.com' }, 'ENV_PLACEHOLDER'],
    ['variável ORYN desconhecida', { ORYN_ADMIN_PORT: '5281' }, 'ENV_UNKNOWN'],
  ])('%s → recusado', (_name, patch, id) => {
    const env: Record<string, string | undefined> = { ...validEnv(), ...patch };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    expect(ids(run({ env }))).toContain(id);
  });

  it('portas de sinalização e administrativa iguais → recusado', () => {
    expect(ids(run({ adminPort: 5280 }))).toContain('PORTS');
  });
});

describe('CLI (processo real, sem rede)', () => {
  const cli = fileURLToPath(new URL('../server/preflight-cli.ts', import.meta.url));
  const exec = (args: string[]) => {
    const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 20_000 });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const example = (f: string) => fileURLToPath(new URL(`../cloudflare/${f}`, import.meta.url));

  it('os modelos versionados são estruturalmente válidos (modo template)', () => {
    const r = exec([`--config=${example('config.example.yml')}`, `--env-file=${example('server.env.example')}`, '--mode=template']);
    expect(r.out).toContain('RESULTADO: OK');
    expect(r.status).toBe(0);
  });

  it('os modelos versionados NÃO servem para ativação (valores de exemplo)', () => {
    const r = exec([`--config=${example('config.example.yml')}`, `--env-file=${example('server.env.example')}`]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('NÃO ativar');
    expect(r.out).toContain('[ENV_PLACEHOLDER]');
    expect(r.out).toContain('[CFG_PLACEHOLDER]');
  });

  it('configuração real fora do repositório: OK, sem imprimir segredo nem AUD completa', () => {
    writeFileSync(CREDS, CREDS_JSON);
    const cfgPath = join(OUTSIDE, 'config.yml');
    const envPath = join(OUTSIDE, 'server.env');
    writeFileSync(cfgPath, stringify(validConfig()));
    writeFileSync(envPath, Object.entries(validEnv()).map(([k, v]) => `${k}=${v}`).join('\n'));
    const r = exec([`--config=${cfgPath}`, `--env-file=${envPath}`]);
    expect(r.out).toContain('RESULTADO: OK');
    expect(r.status).toBe(0);
    expect(r.out).not.toContain(SECRET);
    expect(r.out).not.toContain(AUD);
  });

  it('recusa argumentos desconhecidos (nada sensível pela linha de comando) e exige os arquivos', () => {
    expect(exec([`--aud=${AUD}`]).status).toBe(2);
    expect(exec(['--token=eyJ']).status).toBe(2);
    expect(exec([]).status).toBe(2);
  });
});
