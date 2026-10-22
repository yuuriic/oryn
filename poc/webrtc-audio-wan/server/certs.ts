// Certificados locais para o HTTPS da LAN, gerados com OpenSSL (sem serviços externos).
//
// Modelo de confiança:
// - Uma CA própria e descartável, com nameConstraints que só permitem o IP da LAN (e "localhost").
//   Mesmo que a CA vaze, ela não consegue emitir certificados válidos para outros sites.
// - pathlen:0 (não emite sub-CAs) e validade curta (30 dias por padrão).
// - A chave privada da CA é apagada logo após emitir o certificado do servidor.
// - Os arquivos ficam fora do repositório. Nada é instalado em nenhum repositório de confiança:
//   instalar a CA no celular é um passo manual, autorizado pelo usuário.

import { execFileSync } from 'node:child_process';
import { X509Certificate, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';

export const CA_CERT = 'oryn-poc-ca.crt';
export const SERVER_CERT = 'server.crt';
export const SERVER_KEY = 'server.key';

/** Pasta padrão, fora do repositório. */
export function defaultCertDir(): string {
  const base = process.env['LOCALAPPDATA'] ?? join(homedir(), '.local', 'share');
  return join(base, 'oryn-poc-wan', 'certs');
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export function isIPv4(value: string): boolean {
  return IPV4.test(value);
}

/** Faixas privadas (RFC 1918) e loopback, as únicas aceitas para esta POC local. */
export function isPrivateOrLoopbackIPv4(ip: string): boolean {
  if (!isIPv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** IPv4 privados das interfaces de rede, para ajudar a escolher o IP da LAN. */
export function lanCandidates(): { iface: string; address: string }[] {
  const out: { iface: string; address: string }[] = [];
  for (const [iface, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && isPrivateOrLoopbackIPv4(a.address)) out.push({ iface, address: a.address });
    }
  }
  return out;
}

/** Arquivo de configuração do OpenSSL com as extensões da CA e do servidor. */
export function opensslConfig(ip: string): string {
  if (!isPrivateOrLoopbackIPv4(ip)) throw new Error(`IP inválido para a POC (use um IPv4 privado): ${ip}`);
  return [
    '[req]',
    'distinguished_name = dn',
    'prompt = no',
    '[dn]',
    'CN = Oryn POC-02B',
    '[v3_ca]',
    'basicConstraints = critical, CA:TRUE, pathlen:0',
    'keyUsage = critical, keyCertSign, cRLSign',
    'subjectKeyIdentifier = hash',
    // Só pode certificar este IP (máscara /32) e "localhost"; qualquer outro nome é rejeitado.
    `nameConstraints = critical, permitted;IP:${ip}/255.255.255.255, permitted;DNS:localhost`,
    '[v3_server]',
    'basicConstraints = critical, CA:FALSE',
    'keyUsage = critical, digitalSignature',
    'extendedKeyUsage = serverAuth',
    'subjectKeyIdentifier = hash',
    'authorityKeyIdentifier = keyid:always',
    `subjectAltName = IP:${ip}, DNS:localhost`,
    '',
  ].join('\n');
}

/** Localiza o OpenSSL: ORYN_OPENSSL, PATH ou o OpenSSL do Git for Windows. */
export function findOpenssl(): string {
  const candidates = [
    process.env['ORYN_OPENSSL'],
    'openssl',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    try {
      execFileSync(c, ['version'], { stdio: 'ignore' });
      return c;
    } catch {
      // tenta o próximo
    }
  }
  throw new Error('OpenSSL não encontrado. Instale o Git for Windows ou defina ORYN_OPENSSL.');
}

export interface GeneratedCerts {
  dir: string;
  caCertPath: string;
  serverCertPath: string;
  serverKeyPath: string;
  caFingerprintSha256: string;
  validTo: string;
}

export interface GenerateOptions {
  ip: string;
  dir: string;
  days?: number;
  /** Somente para testes: mantém ca.key para provar que nameConstraints bloqueia outros IPs. */
  keepCaKey?: boolean;
}

/** Executa o OpenSSL com argumentos em array (sem shell). */
function run(openssl: string, args: string[]): void {
  execFileSync(openssl, args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

export function generateCertificates(options: GenerateOptions): GeneratedCerts {
  const { ip, dir } = options;
  const days = String(options.days ?? 30);
  const openssl = findOpenssl();
  mkdirSync(dir, { recursive: true });

  const cnf = join(dir, 'openssl.cnf');
  const caKey = join(dir, 'ca.key');
  const caCert = join(dir, CA_CERT);
  const serverKey = join(dir, SERVER_KEY);
  const serverCsr = join(dir, 'server.csr');
  const serverCert = join(dir, SERVER_CERT);
  writeFileSync(cnf, opensslConfig(ip));

  try {
    const stamp = new Date().toISOString().slice(0, 10);
    run(openssl, ['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', caKey]);
    run(openssl, [
      'req', '-x509', '-new', '-key', caKey, '-sha256', '-days', days, '-config', cnf, '-extensions', 'v3_ca',
      '-subj', `/CN=Oryn POC-02B Local CA ${stamp}`, '-out', caCert,
    ]);
    run(openssl, ['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', serverKey]);
    run(openssl, ['req', '-new', '-key', serverKey, '-config', cnf, '-subj', '/CN=Oryn POC-02B', '-out', serverCsr]);
    run(openssl, [
      'x509', '-req', '-in', serverCsr, '-CA', caCert, '-CAkey', caKey, '-CAcreateserial', '-sha256',
      '-days', days, '-extfile', cnf, '-extensions', 'v3_server', '-out', serverCert,
    ]);
  } finally {
    rmSync(serverCsr, { force: true });
    rmSync(join(dir, 'oryn-poc-ca.srl'), { force: true });
    if (!options.keepCaKey) rmSync(caKey, { force: true });
  }

  const ca = new X509Certificate(readFileSync(caCert));
  const server = new X509Certificate(readFileSync(serverCert));
  return {
    dir,
    caCertPath: caCert,
    serverCertPath: serverCert,
    serverKeyPath: serverKey,
    caFingerprintSha256: ca.fingerprint256,
    validTo: server.validTo,
  };
}

export interface CertCheck {
  ok: boolean;
  problems: string[];
  caFingerprintSha256: string | null;
  validTo: string | null;
}

/** Verifica se os certificados existentes servem para o IP informado (usado na partida do servidor). */
export function checkCertificates(dir: string, ip: string, now = new Date()): CertCheck {
  const problems: string[] = [];
  const paths = [join(dir, CA_CERT), join(dir, SERVER_CERT), join(dir, SERVER_KEY)];
  const missing = paths.filter((p) => !existsSync(p));
  if (missing.length > 0) return { ok: false, problems: [`Arquivos ausentes em ${dir}`], caFingerprintSha256: null, validTo: null };

  const ca = new X509Certificate(readFileSync(paths[0]!));
  const server = new X509Certificate(readFileSync(paths[1]!));
  if (!server.checkIssued(ca) || !server.verify(ca.publicKey)) problems.push('Certificado do servidor não foi emitido pela CA local.');
  if (!server.checkIP(ip)) problems.push(`Certificado do servidor não cobre o IP ${ip} (gere novamente com --ip=${ip}).`);
  if (new Date(server.validTo) <= now || new Date(ca.validTo) <= now) problems.push('Certificado expirado.');
  if (new Date(server.validFrom) > now) problems.push('Certificado ainda não é válido (relógio do sistema?).');
  return { ok: problems.length === 0, problems, caFingerprintSha256: ca.fingerprint256, validTo: server.validTo };
}

/** SHA-256 de um certificado PEM no formato exibido por Android/iOS (pares hex separados por ':'). */
export function pemFingerprint(pem: string): string {
  return new X509Certificate(pem).fingerprint256;
}

/** Hash curto do conteúdo, útil para conferir arquivos sem exibir o certificado inteiro. */
export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}
