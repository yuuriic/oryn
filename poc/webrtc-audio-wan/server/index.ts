// Inicia o servidor da POC-02B (baseline copiado da POC-02A).
// Uso: node server/index.ts [--http-port=5280]
//
// Escuta SOMENTE em 127.0.0.1 (HTTP, sem TLS local e sem CA). Não há opção de bind público:
// o acesso externo será feito por um túnel HTTPS público em incremento futuro.

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { portArg } from './cli.ts';
import { startServer } from './server.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const distDir = join(root, 'dist');
const httpPort = portArg('http-port', 5280);

const server = await startServer({ distDir, httpPort });

console.log('\nOryn POC-02B — servidor de sinalização (não transporta mídia)');
console.log(`  Somente neste computador: ${server.httpOrigin.replace('127.0.0.1', 'localhost')}`);
console.log('  Sem acesso pela rede: o túnel público ainda não foi implementado.');
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
