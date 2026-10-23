// Diagnóstico operacional LOCAL (POC-02B.5): `pnpm diagnose`. Nenhuma rede pública, nenhum túnel real,
// nenhuma credencial real; só portas efêmeras em 127.0.0.1. Saída 0 = todos PASS; 1 = alguma FAIL.
import { runDiagnostics } from './diagnostics.ts';

const results = await runDiagnostics();
console.log('\nOryn POC-02B — diagnóstico local (simulado; não substitui os testes reais)');
for (const r of results) console.log(`  ${r.status.padEnd(4)} ${r.id.padEnd(5)} [${r.area}] ${r.cenario} — ${r.observado}`);
const failed = results.filter((r) => r.status === 'FAIL').length;
console.log(`\nRESULTADO: ${results.length - failed} PASS, ${failed} FAIL.`);
process.exit(failed > 0 ? 1 : 0);
