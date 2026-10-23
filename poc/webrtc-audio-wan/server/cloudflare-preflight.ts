// Pré-validação OFFLINE da integração Cloudflare (POC-02B.3B): confere a configuração do cloudflared
// (túnel nomeado, gerenciado localmente) e o ambiente do servidor (ORYN_*) ANTES de qualquer ativação.
//
// - Não acessa a rede, não inicia o cloudflared, não altera nada.
// - Nunca imprime segredos: o segredo do túnel não é lido além de checar presença e coerência; a AUD tag
//   aparece mascarada. Mensagens de erro descrevem a regra violada, não o conteúdo.
// - Modo "template": valida a ESTRUTURA dos exemplos versionados (valores de exemplo permitidos).
//   Modo "activation": exige valores reais e confere arquivos locais (credenciais fora do repositório).

import { isAbsolute, relative, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { resolveAccessConfig } from './access.ts';
import { CloudflareTurnProvider } from './turn.ts';
import { validatePublicHostname } from './server.ts';

export type PreflightMode = 'template' | 'activation';

export interface PreflightInput {
  mode: PreflightMode;
  /** Conteúdo do config.yml do cloudflared (não é impresso). */
  configText: string;
  /** Variáveis ORYN_* do servidor (de um arquivo de ambiente, nunca de argumentos). */
  env: Readonly<Record<string, string | undefined>>;
  /** Raiz do repositório git: credenciais e configuração real precisam ficar fora dela. */
  repoRoot: string;
  /** Caminho do config.yml (para checar se está fora do repositório no modo activation). */
  configPath: string;
  /** Caminho do arquivo de ambiente, se houver. */
  envPath?: string;
  signalPort: number;
  adminPort: number;
  /** Lê um arquivo local (credenciais do túnel); null se ausente/ilegível. Injetável nos testes. */
  readFile: (path: string) => string | null;
  /** true se o caminho estiver versionado ou não ignorado pelo git (injetável nos testes). */
  isTrackedOrUnignored: (path: string) => boolean;
}

export interface Finding {
  id: string;
  message: string;
}

export interface PreflightReport {
  ok: boolean;
  errors: Finding[];
  /** Resumo sem segredos (hostname, equipe, AUD mascarada, serviço). */
  summary: Record<string, string>;
}

/** Valores dos exemplos versionados: aceitos no modo template, recusados na ativação. */
export const TEMPLATE_VALUES = {
  tunnel: '00000000-0000-0000-0000-000000000000',
  hostname: 'oryn-poc.example.com',
  team: 'oryn-example',
  aud: '0'.repeat(64),
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOP_LEVEL_ALLOWED = new Set([
  'tunnel',
  'credentials-file',
  'ingress',
  'originRequest',
  'loglevel',
  'transport-loglevel',
  'protocol',
  'metrics',
  'no-autoupdate',
  'logfile',
  'retries',
  'grace-period',
]);
/** Chaves de originRequest aceitas (as demais são recusadas por serem desnecessárias ou perigosas). */
const ORIGIN_REQUEST_ALLOWED = new Set([
  'access',
  'connectTimeout',
  'tcpKeepAlive',
  'keepAliveConnections',
  'keepAliveTimeout',
  'noHappyEyeballs',
  'disableChunkedEncoding',
  'http2Origin',
]);
const RULE_ALLOWED = new Set(['hostname', 'service', 'originRequest']);
const QUIET_LOGLEVELS = new Set(['info', 'warn', 'error', 'fatal']);
const RESERVED_SUFFIXES = ['.example', '.example.com', '.example.net', '.example.org', '.test', '.invalid', '.localhost', '.local', '.trycloudflare.com'];

export const maskAud = (aud: string): string => (aud.length > 8 ? `${aud.slice(0, 6)}…(${aud.length})` : '(inválida)');

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Percorre todos os valores (chaves e escalares) para detectar referências indevidas. */
function* scalars(value: unknown, path = ''): Generator<{ path: string; value: string }> {
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) yield* scalars(v, `${path}[${i}]`);
  } else if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      yield { path: `${path}.${k}`, value: k };
      yield* scalars(v, `${path}.${k}`);
    }
  } else if (value !== null && value !== undefined) {
    yield { path, value: String(value) };
  }
}

export function preflight(input: PreflightInput): PreflightReport {
  const errors: Finding[] = [];
  const summary: Record<string, string> = { modo: input.mode };
  const fail = (id: string, message: string): void => {
    errors.push({ id, message });
  };
  const activation = input.mode === 'activation';

  // ---------- portas ----------
  if (input.signalPort === input.adminPort) fail('PORTS', 'Porta de sinalização e administrativa iguais.');

  // ---------- ambiente do servidor (ORYN_*) ----------
  const env = input.env;
  const hostnamesRaw = (env['ORYN_PUBLIC_HOSTNAMES'] ?? '').split(',').map((h) => h.trim()).filter((h) => h !== '');
  let hostname: string | null = null;
  if (hostnamesRaw.length !== 1) {
    fail('ENV_HOSTNAMES', 'ORYN_PUBLIC_HOSTNAMES deve conter exatamente um hostname.');
  } else {
    try {
      hostname = validatePublicHostname(hostnamesRaw[0]!);
      summary['hostname'] = hostname;
    } catch {
      fail('ENV_HOSTNAMES', 'ORYN_PUBLIC_HOSTNAMES contém um hostname inválido (sem curingas, IPs, portas ou localhost).');
    }
  }
  if (hostname && activation && (hostname === TEMPLATE_VALUES.hostname || RESERVED_SUFFIXES.some((s) => hostname!.endsWith(s)))) {
    fail('ENV_PLACEHOLDER', 'ORYN_PUBLIC_HOSTNAMES ainda usa um domínio de exemplo/reservado ou de Quick Tunnel.');
  }

  if ((env['ORYN_ACCESS_MODE'] ?? '').trim().toLowerCase() !== 'required') {
    fail('ENV_ACCESS_MODE', 'ORYN_ACCESS_MODE deve ser "required" para exposição.');
  }
  let team: string | null = null;
  let aud: string | null = null;
  try {
    const num = (name: string): number | undefined => {
      const raw = env[name];
      if (raw === undefined || raw.trim() === '') return undefined;
      if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} deve ser inteiro`);
      return Number(raw);
    };
    const optional = {
      jwksTimeoutMs: num('ORYN_ACCESS_JWKS_TIMEOUT_MS'),
      jwksMaxBytes: num('ORYN_ACCESS_JWKS_MAX_BYTES'),
      jwksCacheTtlMs: num('ORYN_ACCESS_JWKS_CACHE_TTL_MS'),
      jwksMaxStaleMs: num('ORYN_ACCESS_JWKS_MAX_STALE_MS'),
      jwksRefreshCooldownMs: num('ORYN_ACCESS_JWKS_COOLDOWN_MS'),
      clockToleranceSec: num('ORYN_ACCESS_CLOCK_TOLERANCE_S'),
    };
    const resolved = resolveAccessConfig({
      teamDomain: env['ORYN_ACCESS_TEAM_DOMAIN'] ?? '',
      audience: env['ORYN_ACCESS_AUD'] ?? '',
      ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)),
    });
    team = resolved.issuer.replace('https://', '').replace('.cloudflareaccess.com', '');
    aud = resolved.audience;
    summary['equipe Access'] = `${team}.cloudflareaccess.com`;
    summary['AUD tag'] = maskAud(aud);
    summary['JWKS'] = resolved.jwksUrl;
  } catch {
    fail('ENV_ACCESS', 'ORYN_ACCESS_TEAM_DOMAIN/ORYN_ACCESS_AUD (ou parâmetros opcionais) ausentes ou inválidos.');
  }
  if (activation && team === TEMPLATE_VALUES.team) fail('ENV_PLACEHOLDER', 'ORYN_ACCESS_TEAM_DOMAIN ainda é o valor de exemplo.');
  if (activation && aud !== null && /^(.)\1{63}$/.test(aud)) fail('ENV_PLACEHOLDER', 'ORYN_ACCESS_AUD ainda é um valor de exemplo (caractere repetido).');
  // STUN/TURN (02B.4): formato conferido sem imprimir o token.
  const turnProvider = (env['ORYN_TURN_PROVIDER'] ?? 'off').trim().toLowerCase();
  if (turnProvider === 'cloudflare') {
    try {
      new CloudflareTurnProvider({ keyId: (env['ORYN_TURN_KEY_ID'] ?? '').trim(), apiToken: (env['ORYN_TURN_API_TOKEN'] ?? '').trim() });
      summary['TURN'] = 'cloudflare (token presente, não exibido)';
    } catch {
      fail('ENV_TURN', 'ORYN_TURN_KEY_ID/ORYN_TURN_API_TOKEN ausentes ou em formato inválido.');
    }
  } else if (turnProvider === 'off') {
    summary['TURN'] = 'desligado';
    if (env['ORYN_TURN_KEY_ID'] !== undefined || env['ORYN_TURN_API_TOKEN'] !== undefined) fail('ENV_TURN', 'ORYN_TURN_PROVIDER=off com credenciais TURN definidas.');
  } else {
    fail('ENV_TURN', 'ORYN_TURN_PROVIDER deve ser "cloudflare" ou "off".');
  }
  const unknownEnv = Object.keys(env).filter(
    (k) =>
      k.startsWith('ORYN_') &&
      !['ORYN_PUBLIC_HOSTNAMES', 'ORYN_TURN_PROVIDER', 'ORYN_TURN_KEY_ID', 'ORYN_TURN_API_TOKEN', 'ORYN_TURN_TTL_S', 'ORYN_ICE_STUN_URLS'].includes(k) &&
      !k.startsWith('ORYN_ACCESS_'),
  );
  if (unknownEnv.length > 0) fail('ENV_UNKNOWN', `Variáveis ORYN_* desconhecidas: ${unknownEnv.join(', ')}.`);
  if (activation && input.envPath && input.isTrackedOrUnignored(input.envPath)) {
    fail('ENV_FILE', 'O arquivo de ambiente real está versionado ou não é ignorado pelo git.');
  }

  // ---------- config.yml do cloudflared ----------
  const doc = parseDocument(input.configText, { uniqueKeys: true, merge: false, prettyErrors: false });
  if (doc.errors.length > 0) {
    fail('CFG_PARSE', 'config.yml não é YAML válido (ou tem chaves duplicadas).');
    return { ok: false, errors, summary };
  }
  let usesAliases = false;
  // Âncoras/aliases dificultam a revisão (uma regra pode "herdar" outra): recusados.
  if (/(^|\s)[&*][A-Za-z0-9_-]/m.test(input.configText) || /<<\s*:/.test(input.configText)) usesAliases = true;
  if (usesAliases) fail('CFG_ALIAS', 'config.yml não pode usar âncoras, aliases ou merge keys.');
  let cfg: unknown;
  try {
    cfg = doc.toJS({ maxAliasCount: 0 });
  } catch {
    if (!usesAliases) fail('CFG_ALIAS', 'config.yml não pode usar âncoras, aliases ou merge keys.');
    return { ok: false, errors, summary };
  }
  if (!isRecord(cfg)) {
    fail('CFG_PARSE', 'config.yml precisa ser um mapa YAML.');
    return { ok: false, errors, summary };
  }

  for (const key of Object.keys(cfg)) {
    if (key === 'token' || key === 'token-file') fail('CFG_TOKEN', 'Túnel gerenciado remotamente (token) não é aceito: use túnel nomeado gerenciado localmente.');
    else if (key === 'warp-routing') fail('CFG_WARP', 'warp-routing não pode estar presente (expõe a rede privada).');
    else if (key === 'url' || key === 'hello-world' || key === 'bastion' || key.startsWith('proxy-')) fail('CFG_LEGACY', `Modo legado "${key}" não é aceito: use apenas ingress.`);
    else if (!TOP_LEVEL_ALLOWED.has(key)) fail('CFG_KEYS', `Chave de topo não permitida: "${key}".`);
  }

  // Túnel nomeado e credenciais (Quick Tunnel não tem nenhum dos dois).
  const tunnel = typeof cfg['tunnel'] === 'string' ? cfg['tunnel'].trim().toLowerCase() : '';
  if (!UUID.test(tunnel)) fail('CFG_TUNNEL', 'tunnel deve ser o UUID de um túnel nomeado (Quick Tunnel não é aceito).');
  else if (activation && tunnel === TEMPLATE_VALUES.tunnel) fail('CFG_PLACEHOLDER', 'tunnel ainda é o UUID de exemplo.');
  const credentials = typeof cfg['credentials-file'] === 'string' ? cfg['credentials-file'] : '';
  if (credentials === '') {
    fail('CFG_CREDENTIALS', 'credentials-file ausente.');
  } else if (activation) {
    if (!isAbsolute(credentials)) fail('CFG_CREDENTIALS', 'credentials-file deve ser um caminho absoluto.');
    else if (isInside(credentials, input.repoRoot)) fail('CFG_CREDENTIALS', 'credentials-file está dentro do repositório.');
    else {
      const raw = input.readFile(credentials);
      let parsed: unknown = null;
      try {
        parsed = raw === null ? null : JSON.parse(raw);
      } catch {
        parsed = null;
      }
      if (!isRecord(parsed)) fail('CFG_CREDENTIALS', 'credentials-file ausente, ilegível ou não é JSON.');
      else {
        if (typeof parsed['TunnelSecret'] !== 'string' || parsed['TunnelSecret'] === '') fail('CFG_CREDENTIALS', 'credentials-file sem TunnelSecret.');
        if (typeof parsed['TunnelID'] !== 'string' || parsed['TunnelID'].toLowerCase() !== tunnel) {
          fail('CFG_CREDENTIALS', 'TunnelID do credentials-file não corresponde ao tunnel do config.yml.');
        }
      }
    }
  }
  if (activation && isInside(input.configPath, input.repoRoot) && input.isTrackedOrUnignored(input.configPath)) {
    fail('CFG_FILE', 'O config.yml real está versionado ou não é ignorado pelo git (mantenha-o fora do repositório).');
  }

  // Logs do cloudflared: debug/trace registram cabeçalhos (inclusive o JWT do Access).
  for (const key of ['loglevel', 'transport-loglevel']) {
    const level = cfg[key];
    if (level !== undefined && !QUIET_LOGLEVELS.has(String(level).toLowerCase())) {
      fail('CFG_LOGLEVEL', `${key} "${String(level)}" registra cabeçalhos (JWT): use info, warn, error ou fatal.`);
    }
  }
  if (cfg['metrics'] !== undefined) {
    const m = String(cfg['metrics']);
    if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/.test(m)) fail('CFG_METRICS', 'metrics deve escutar só em loopback (127.0.0.1:porta).');
  }

  // Ingress: exatamente [regra do hostname público → sinalização, catch-all 404].
  const ingress = cfg['ingress'];
  const expectedService = `http://127.0.0.1:${input.signalPort}`;
  summary['serviço'] = expectedService;
  if (!Array.isArray(ingress) || ingress.length !== 2) {
    fail('CFG_INGRESS', 'ingress deve ter exatamente duas regras: o hostname público e o catch-all http_status:404.');
  }
  const rules = Array.isArray(ingress) ? ingress : [];
  const first = rules[0];
  const last = rules.at(-1);
  const topOrigin = isRecord(cfg['originRequest']) ? cfg['originRequest'] : {};

  if (rules.length > 0 && isRecord(first)) {
    for (const k of Object.keys(first)) if (!RULE_ALLOWED.has(k)) fail('CFG_RULE', `Regra do hostname com chave não permitida: "${k}" (ex.: path restringiria a cobertura).`);
    const ruleHost = typeof first['hostname'] === 'string' ? first['hostname'].trim().toLowerCase() : '';
    if (ruleHost.includes('*')) fail('CFG_HOSTNAME', 'A regra não pode usar curinga.');
    if (ruleHost === '' || ruleHost !== hostname) fail('CFG_HOSTNAME', 'O hostname da regra deve ser exatamente o de ORYN_PUBLIC_HOSTNAMES.');
    if (first['service'] !== expectedService) fail('CFG_SERVICE', `O serviço da regra deve ser exatamente ${expectedService}.`);
    const ruleOrigin = isRecord(first['originRequest']) ? first['originRequest'] : {};
    const origin: Record<string, unknown> = { ...topOrigin, ...ruleOrigin };
    for (const k of Object.keys(origin)) {
      if (k === 'httpHostHeader') fail('CFG_HOST_HEADER', 'httpHostHeader não pode ser definido: o Host público original deve ser preservado.');
      else if (!ORIGIN_REQUEST_ALLOWED.has(k)) fail('CFG_ORIGIN_REQUEST', `originRequest.${k} não é permitido nesta POC.`);
    }
    const access = origin['access'];
    if (!isRecord(access) || access['required'] !== true) {
      fail('CFG_ACCESS', 'originRequest.access.required deve ser true (o cloudflared também valida o JWT).');
    } else {
      if (team === null || access['teamName'] !== team) fail('CFG_ACCESS', 'originRequest.access.teamName deve ser a equipe de ORYN_ACCESS_TEAM_DOMAIN.');
      const tags = access['audTag'];
      if (!Array.isArray(tags) || tags.length !== 1 || aud === null || String(tags[0]).toLowerCase() !== aud) {
        fail('CFG_ACCESS', 'originRequest.access.audTag deve conter só a AUD tag de ORYN_ACCESS_AUD.');
      }
      for (const k of Object.keys(access)) if (!['required', 'teamName', 'audTag'].includes(k)) fail('CFG_ACCESS', `originRequest.access.${k} não é permitido.`);
    }
  } else if (rules.length > 0) {
    fail('CFG_RULE', 'A primeira regra do ingress precisa ser um mapa.');
  }

  if (rules.length > 0) {
    const catchAll = isRecord(last) && Object.keys(last).length === 1 && last['service'] === 'http_status:404';
    if (!catchAll) fail('CFG_CATCHALL', 'A última regra deve ser apenas "service: http_status:404" (sem hostname, path ou outras chaves).');
  }

  // Nenhuma referência à porta administrativa nem a outros serviços, em qualquer lugar do arquivo.
  const adminRef = new RegExp(`(^|[^0-9])${input.adminPort}([^0-9]|$)`);
  for (const { value } of scalars(cfg)) {
    if (adminRef.test(value)) {
      fail('CFG_ADMIN_PORT', `O config.yml referencia a porta administrativa ${input.adminPort}.`);
      break;
    }
  }
  for (const { value } of scalars(cfg)) {
    if (/^(ssh|rdp|tcp|smb|unix|unix\+tls|https?_status|hello_world|bastion|socks)/i.test(value) && value !== 'http_status:404') {
      fail('CFG_SERVICE_TYPE', 'O config.yml contém um tipo de serviço não permitido (ssh, rdp, tcp, unix, bastion, hello_world…).');
      break;
    }
  }
  if (/trycloudflare\.com/i.test(input.configText)) fail('CFG_QUICK_TUNNEL', 'Quick Tunnel (trycloudflare.com) não é aceito.');

  return { ok: errors.length === 0, errors, summary };
}
