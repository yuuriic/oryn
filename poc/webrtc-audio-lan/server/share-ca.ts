// Disponibiliza TEMPORARIAMENTE o certificado público da CA para download no celular.
// Uso: node server/share-ca.ts --ip=<IP-DA-LAN> [--port=5181] [--minutes=5]
//
// É HTTP simples porque o celular ainda não confia na CA. Um atacante na mesma rede poderia
// trocar o arquivo; por isso o usuário DEVE conferir o SHA-256 exibido aqui com o mostrado pelo
// celular antes de confiar. Alternativa sem rede: copiar o arquivo por cabo USB.

import { readFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { CA_CERT, defaultCertDir, isPrivateOrLoopbackIPv4, pemFingerprint } from './certs.ts';
import { argValue, portArg } from './cli.ts';

const ip = argValue('ip');
const dir = argValue('cert-dir') ?? defaultCertDir();
const port = portArg('port', 5181);
const minutes = Math.min(15, Math.max(1, Number(argValue('minutes') ?? 5)));

if (!ip || !isPrivateOrLoopbackIPv4(ip)) {
  console.error('Informe --ip=<IP-DA-LAN> (o mesmo usado em "pnpm certs").');
  process.exit(1);
}

const pem = readFileSync(join(dir, CA_CERT), 'utf8');
const fingerprint = pemFingerprint(pem);

const server = http.createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET' || new URL(req.url ?? '/', 'http://x').pathname !== `/${CA_CERT}`) {
    res.writeHead(404).end();
    return;
  }
  // Apenas o certificado público. Nenhuma chave privada existe ou é servida aqui.
  res.writeHead(200, {
    'Content-Type': 'application/x-x509-ca-cert',
    'Content-Disposition': `attachment; filename="${CA_CERT}"`,
  });
  res.end(pem);
  console.log('Certificado da CA baixado por um dispositivo da rede.');
});

server.listen(port, ip, () => {
  console.log(`
Download temporário da CA (encerra em ${minutes} min ou com Ctrl+C):
  http://${ip}:${port}/${CA_CERT}

ANTES de confiar no celular, confira que o SHA-256 exibido pelo celular é exatamente:
  ${fingerprint}
`);
});

setTimeout(() => {
  console.log('Tempo esgotado; download encerrado.');
  server.close(() => process.exit(0));
  server.closeAllConnections();
}, minutes * 60_000).unref();

process.on('SIGINT', () => server.close(() => process.exit(0)));
