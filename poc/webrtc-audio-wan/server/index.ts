// Inicia o servidor da POC-02B (baseline copiado da POC-02A).
// Uso: node server/index.ts [--http-port=5280]
//
// Escuta SOMENTE em 127.0.0.1 (HTTP, sem TLS local e sem CA). Não há opção de bind público.
//
// Admissão (02B.2B): a cada início é gerada uma chave EFÊMERA de operador (256 bits). Só o hash fica
// em memória; a chave aparece uma única vez neste terminal, no link do operador (#op=…). O
// fragmento da URL não é enviado ao servidor nem ao Referer, e a página o remove da barra de endereço.
//
// Hostnames públicos (para o túnel, incremento futuro): variável ORYN_PUBLIC_HOSTNAMES, lista
// separada por vírgulas de nomes DNS exatos. Ausente = nenhum acesso público (fechado por padrão).

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashToken, newToken } from './admission.ts';
import { portArg } from './cli.ts';
import { startServer } from './server.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const distDir = join(root, 'dist');
const httpPort = portArg('http-port', 5280);
const publicHostnames = (process.env['ORYN_PUBLIC_HOSTNAMES'] ?? '')
  .split(',')
  .map((h) => h.trim())
  .filter((h) => h !== '');

const operatorKey = newToken();
const server = await startServer({ distDir, httpPort, operatorKeyHash: hashToken(operatorKey), publicHostnames });
const local = server.httpOrigin.replace('127.0.0.1', 'localhost');

console.log('\nOryn POC-02B — servidor de sinalização (não transporta mídia)');
console.log(`  Escutando somente em: ${local}`);
console.log(`  Acesso público:       ${server.publicOrigin ? `${server.publicOrigin} (Host/Origin permitidos)` : 'FECHADO (nenhum hostname público configurado)'}`);
console.log('\n  Link do OPERADOR (abra só neste computador; não compartilhe; vale até encerrar o servidor):');
console.log(`  ${local}/#op=${operatorKey}`);
console.log('\nCtrl+C para encerrar.\n');

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
