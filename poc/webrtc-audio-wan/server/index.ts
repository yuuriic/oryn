// Inicia o servidor da POC-02B (baseline copiado da POC-02A).
// Uso: node server/index.ts [--http-port=5280] [--admin-port=5281] [--dist-dir=caminho]
//
// Dois listeners, SOMENTE em 127.0.0.1 (HTTP, sem TLS local e sem CA):
// - sinalização (padrão 5280): alvo do futuro túnel; sem capacidade administrativa;
// - administrativo (padrão 5281): só para o operador neste PC; NUNCA deve ser alvo do túnel.
//
// Autorização do operador (02B.2C): o terminal mostra apenas um CÓDIGO DE PAREAMENTO curto, de uso
// único e com validade curta. A página administrativa troca o código por um token que fica só em
// memória no navegador. O token nunca é impresso, registrado ou persistido. Digite "codigo" + Enter
// para gerar um novo código (por exemplo, após recarregar a página do operador); o token anterior é revogado.
//
// Hostnames públicos (para o túnel, incremento futuro): variável ORYN_PUBLIC_HOSTNAMES, lista
// separada por vírgulas de nomes DNS exatos. Ausente = nenhum acesso público (fechado por padrão).
//
// Cloudflare Access (02B.3A), obrigatório quando há hostnames públicos:
//   ORYN_ACCESS_MODE=required | off   (off só é aceito sem hostnames públicos; padrão: off)
//   ORYN_ACCESS_TEAM_DOMAIN=<equipe>.cloudflareaccess.com   (define iss e a URL das chaves)
//   ORYN_ACCESS_AUD=<AUD tag, 64 hex>
//   Opcionais (ms): ORYN_ACCESS_JWKS_TIMEOUT_MS, ORYN_ACCESS_JWKS_CACHE_TTL_MS, ORYN_ACCESS_JWKS_MAX_STALE_MS,
//   ORYN_ACCESS_JWKS_COOLDOWN_MS; ORYN_ACCESS_JWKS_MAX_BYTES; ORYN_ACCESS_CLOCK_TOLERANCE_S.
// Nenhum desses valores é segredo; mesmo assim, não versionar configurações reais.
//
// STUN/TURN (02B.4):
//   ORYN_TURN_PROVIDER=cloudflare | off   (padrão: off; modos relay/relay-tls falham fechados)
//   ORYN_TURN_KEY_ID=<id da chave TURN>
//   ORYN_TURN_API_TOKEN=<token da API TURN>   ← SEGREDO: só em arquivo de ambiente fora do repositório
//   ORYN_TURN_TTL_S=7200                      (validade das credenciais temporárias, 600–86400)
//   ORYN_ICE_STUN_URLS=stun:host:porta,...    (STUN extra para auto/direct; padrão: nenhum)
// O token nunca é impresso, registrado ou enviado ao navegador.

import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AccessConfig } from './access.ts';
import { formatPairingCode } from './admin-auth.ts';
import { CloudflareTurnProvider, type TurnProvider } from './turn.ts';
import { argValue, portArg } from './cli.ts';
import { startServer } from './server.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const distDir = argValue('dist-dir') ?? join(root, 'dist');
const httpPort = portArg('http-port', 5280);
const adminPort = portArg('admin-port', 5281);
const publicHostnames = (process.env['ORYN_PUBLIC_HOSTNAMES'] ?? '')
  .split(',')
  .map((h) => h.trim())
  .filter((h) => h !== '');

/** Lê a configuração do Access do ambiente. Valores inválidos ou incompletos impedem a partida. */
function accessFromEnv(env: NodeJS.ProcessEnv): AccessConfig | undefined {
  const mode = (env['ORYN_ACCESS_MODE'] ?? 'off').trim().toLowerCase();
  if (mode === 'off') {
    const stray = Object.keys(env).filter((k) => k.startsWith('ORYN_ACCESS_') && k !== 'ORYN_ACCESS_MODE');
    if (stray.length > 0) throw new Error(`ORYN_ACCESS_MODE=off com variáveis do Access definidas (${stray.join(', ')}): configuração ambígua.`);
    return undefined;
  }
  if (mode !== 'required') throw new Error('ORYN_ACCESS_MODE deve ser "required" ou "off".');
  const num = (name: string): number | undefined => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return undefined;
    if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} deve ser um inteiro.`);
    return Number(raw);
  };
  const config: AccessConfig = { teamDomain: env['ORYN_ACCESS_TEAM_DOMAIN'] ?? '', audience: env['ORYN_ACCESS_AUD'] ?? '' };
  const optional: [keyof AccessConfig, string][] = [
    ['jwksTimeoutMs', 'ORYN_ACCESS_JWKS_TIMEOUT_MS'],
    ['jwksCacheTtlMs', 'ORYN_ACCESS_JWKS_CACHE_TTL_MS'],
    ['jwksMaxStaleMs', 'ORYN_ACCESS_JWKS_MAX_STALE_MS'],
    ['jwksRefreshCooldownMs', 'ORYN_ACCESS_JWKS_COOLDOWN_MS'],
    ['jwksMaxBytes', 'ORYN_ACCESS_JWKS_MAX_BYTES'],
    ['clockToleranceSec', 'ORYN_ACCESS_CLOCK_TOLERANCE_S'],
  ];
  for (const [key, name] of optional) {
    const v = num(name);
    if (v !== undefined) Object.assign(config, { [key]: v });
  }
  return config;
}

/** Lê a configuração STUN/TURN do ambiente. Inválida ou ambígua impede a partida. */
function iceFromEnv(env: NodeJS.ProcessEnv): { provider: TurnProvider | null; stunUrls: string[]; ttlSec?: number } {
  const providerName = (env['ORYN_TURN_PROVIDER'] ?? 'off').trim().toLowerCase();
  const stunUrls = (env['ORYN_ICE_STUN_URLS'] ?? '').split(',').map((u) => u.trim()).filter((u) => u !== '');
  const ttlRaw = env['ORYN_TURN_TTL_S'];
  if (ttlRaw !== undefined && !/^\d+$/.test(ttlRaw.trim())) throw new Error('ORYN_TURN_TTL_S deve ser um inteiro.');
  const ttl = ttlRaw === undefined ? {} : { ttlSec: Number(ttlRaw) };
  if (providerName === 'off') {
    const stray = ['ORYN_TURN_KEY_ID', 'ORYN_TURN_API_TOKEN'].filter((k) => env[k] !== undefined);
    if (stray.length > 0) throw new Error(`ORYN_TURN_PROVIDER=off com ${stray.join(', ')} definido(s): configuração ambígua.`);
    return { provider: null, stunUrls, ...ttl };
  }
  if (providerName !== 'cloudflare') throw new Error('ORYN_TURN_PROVIDER deve ser "cloudflare" ou "off".');
  return {
    provider: new CloudflareTurnProvider({ keyId: (env['ORYN_TURN_KEY_ID'] ?? '').trim(), apiToken: (env['ORYN_TURN_API_TOKEN'] ?? '').trim() }),
    stunUrls,
    ...ttl,
  };
}

const access = accessFromEnv(process.env);
const ice = iceFromEnv(process.env);
const server = await startServer({ distDir, httpPort, adminPort, publicHostnames, ice, ...(access ? { access } : {}) });
const local = (origin: string): string => origin.replace('127.0.0.1', 'localhost');

const showPairingCode = (): void => {
  const { code, expiresAt } = server.adminAuth.issuePairingCode();
  const until = new Date(expiresAt).toLocaleTimeString('pt-BR', { hour12: false });
  console.log(`\n  Código de pareamento do operador: ${formatPairingCode(code)}  (uso único; expira às ${until})`);
  console.log('  Digite-o na página administrativa. Para gerar outro: "codigo" + Enter.\n');
};

console.log('\nOryn POC-02B — servidor de sinalização (não transporta mídia)');
console.log(`  Sinalização (alvo do túnel):     ${local(server.httpOrigin)}`);
console.log(`  Administração (só neste PC):     ${local(server.adminOrigin!)}`);
console.log(`  Acesso público:                  ${server.publicOrigin ? `${server.publicOrigin} (Host/Origin permitidos)` : 'FECHADO (nenhum hostname público configurado)'}`);
console.log(`  Cloudflare Access (sinalização): ${access ? `OBRIGATÓRIO (equipe ${access.teamDomain.trim().toLowerCase()})` : 'DESLIGADO (somente uso local)'}`);
console.log(`  TURN:                            ${ice.provider ? `${ice.provider.name} (credenciais temporárias, validade ${Math.round((ice.ttlSec ?? 7200) / 60)} min)` : 'DESLIGADO (relay/relay-tls indisponíveis)'}`);
console.log(`  STUN local extra:                ${ice.stunUrls.length ? `${ice.stunUrls.length} URL(s)` : 'nenhum'}`);
showPairingCode();
console.log('Ctrl+C para encerrar.\n');

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (line.trim().toLowerCase() === 'codigo') {
    server.adminAuth.revokeAll(); // novo pareamento: a sessão administrativa anterior deixa de valer
    showPairingCode();
  }
});

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  console.log('\nEncerrando sessões e conexões…');
  input.close();
  await server.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
