// Inicia o servidor da POC-02B (baseline copiado da POC-02A).
// Uso: node server/index.ts --ip=<IP-DA-LAN> [--http-port=5280] [--https-port=5543] [--cert-dir=...] [--no-https]

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CA_CERT, SERVER_CERT, SERVER_KEY, checkCertificates, defaultCertDir, isPrivateOrLoopbackIPv4, lanCandidates } from './certs.ts';
import { argValue, hasFlag, portArg } from './cli.ts';
import { startServer } from './server.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const distDir = join(root, 'dist');
const httpPort = portArg('http-port', 5280);
const httpsPort = portArg('https-port', 5543);
const certDir = argValue('cert-dir') ?? defaultCertDir();
const noHttps = hasFlag('no-https');

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

let httpsOptions;
if (!noHttps) {
  const ip = argValue('ip');
  if (!ip) {
    const list = lanCandidates()
      .map((c) => `  --ip=${c.address}   (${c.iface})`)
      .join('\n');
    fail(`Informe o IP da LAN do computador, o mesmo usado em "pnpm certs":\n${list || '  (nenhum IPv4 privado encontrado)'}\nOu use --no-https para testar só no PC.`);
  }
  if (!isPrivateOrLoopbackIPv4(ip)) fail(`IP inválido: ${ip}. Use um IPv4 privado da sua rede local.`);
  const check = checkCertificates(certDir, ip);
  if (!check.ok) fail(`Certificados não utilizáveis:\n  - ${check.problems.join('\n  - ')}\nGere com: pnpm certs -- --ip=${ip}`);
  httpsOptions = {
    host: ip,
    port: httpsPort,
    key: readFileSync(join(certDir, SERVER_KEY)),
    cert: readFileSync(join(certDir, SERVER_CERT)),
  };
  console.log(`CA local: ${join(certDir, CA_CERT)}`);
  console.log(`SHA-256 da CA: ${check.caFingerprintSha256}`);
  console.log(`Certificado do servidor válido até: ${check.validTo}`);
}

const server = await startServer({ distDir, httpPort, ...(httpsOptions ? { https: httpsOptions } : {}) });

console.log('\nOryn POC-02B — servidor de sinalização (não transporta mídia)');
console.log(`  PC (este computador): ${server.httpOrigin.replace('127.0.0.1', 'localhost')}`);
if (server.httpsOrigin) console.log(`  Celular (mesma rede):  ${server.httpsOrigin}`);
console.log('Ctrl+C para encerrar.\n');

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  console.log('\nEncerrando sessões e conexões…');
  await server.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
