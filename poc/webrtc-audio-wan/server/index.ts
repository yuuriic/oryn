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

import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatPairingCode } from './admin-auth.ts';
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

const server = await startServer({ distDir, httpPort, adminPort, publicHostnames });
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
