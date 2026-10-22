// Gera a CA local e o certificado do servidor para o IP da LAN.
// Uso: node server/certs-cli.ts --ip=<IP-DA-LAN> [--cert-dir=...] [--days=30]
// Não instala nada em repositórios de confiança: a instalação no celular é manual.

import { existsSync } from 'node:fs';
import { CA_CERT, defaultCertDir, generateCertificates, isPrivateOrLoopbackIPv4, lanCandidates } from './certs.ts';
import { argValue, hasFlag } from './cli.ts';
import { join } from 'node:path';

const ip = argValue('ip');
const dir = argValue('cert-dir') ?? defaultCertDir();
const days = Number(argValue('days') ?? 30);

if (!ip || !isPrivateOrLoopbackIPv4(ip)) {
  const list = lanCandidates()
    .map((c) => `  pnpm certs -- --ip=${c.address}   (${c.iface})`)
    .join('\n');
  console.error(`\nInforme o IPv4 privado do computador na rede Wi-Fi/Ethernet usada pelo celular:\n${list || '  (nenhum IPv4 privado encontrado)'}\n`);
  process.exit(1);
}
if (!Number.isInteger(days) || days < 1 || days > 90) {
  console.error('--days deve estar entre 1 e 90.');
  process.exit(1);
}
if (existsSync(join(dir, CA_CERT)) && !hasFlag('force')) {
  console.error(`\nJá existem certificados em ${dir}.\nUse --force para substituí-los (será preciso instalar a nova CA no celular).\n`);
  process.exit(1);
}

const result = generateCertificates({ ip, dir, days });
console.log(`
Certificados gerados em: ${result.dir}
  CA (pública, para instalar no celular): ${result.caCertPath}
  Certificado do servidor:                ${result.serverCertPath}
  Chave do servidor (privada):            ${result.serverKeyPath}
  Válido até:                             ${result.validTo}

SHA-256 da CA (confira no celular após instalar):
  ${result.caFingerprintSha256}

A chave privada da CA foi apagada. A CA só pode certificar ${ip} e "localhost" (nameConstraints).
Nada foi instalado neste computador nem no celular.
`);
