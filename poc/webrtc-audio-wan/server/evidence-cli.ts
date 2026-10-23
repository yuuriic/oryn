// Validação OFFLINE das evidências sanitizadas coletadas nos testes WAN (POC-02B.5).
// Uso: node server/evidence-cli.ts <evidência-A.json> [<evidência-B.json> ...]
//
// - Confere formato e sanitização (sem IPs, tokens, cookies, credenciais, e-mails, SDP/candidatos).
// - Nunca imprime o conteúdo encontrado: só o rótulo da regra violada.
// - Com dois ou mais arquivos, confere se pertencem à mesma sessão (prefixo) e se há os dois papéis.
// Saída: 0 = todas válidas; 1 = alguma inválida; 2 = uso incorreto.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { validateEvidence } from '../src/evidence.ts';

const files = process.argv.slice(2).filter((a) => a !== '--');
if (files.length === 0) {
  console.error('Uso: node server/evidence-cli.ts <evidência.json> [...]');
  process.exit(2);
}

let failed = false;
const parsed: Record<string, unknown>[] = [];
console.log('\nOryn POC-02B — validação de evidências (offline)');
for (const file of files) {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    console.log(`  FALHA  ${basename(file)}: ilegível ou não é JSON`);
    failed = true;
    continue;
  }
  const problems = validateEvidence(value);
  if (problems.length > 0) {
    failed = true;
    console.log(`  FALHA  ${basename(file)}: ${problems.join('; ')}`);
  } else {
    parsed.push(value as Record<string, unknown>);
    const e = value as Record<string, unknown>;
    console.log(`  OK     ${basename(file)}: ${String(e['papel'])}, ${String(e['navegador'])}, modo ${String(e['modoIce'])}, caminho ${String(e['caminho'])}`);
  }
}

if (parsed.length >= 2) {
  const sessions = new Set(parsed.map((e) => e['sessao']));
  const roles = new Set(parsed.map((e) => e['papel']));
  const coherent = sessions.size === 1 && !sessions.has('indisponível') && roles.has('anfitrião') && roles.has('convidado');
  console.log(`  ${coherent ? 'OK   ' : 'AVISO'}  par: ${coherent ? 'mesma sessão, os dois papéis presentes' : 'sessões diferentes ou papel ausente'}`);
}
console.log(failed ? '\nRESULTADO: evidência(s) inválida(s) — corrigir antes de arquivar.' : '\nRESULTADO: evidências válidas e sanitizadas.');
process.exit(failed ? 1 : 0);
