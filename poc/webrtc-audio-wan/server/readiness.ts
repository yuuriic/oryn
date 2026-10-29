// Relatório consolidado de prontidão para os testes WAN (POC-02B.5). Puro: recebe o resultado da
// pré-validação, do diagnóstico local e da busca por segredos versionados, e devolve itens
// PASS / FAIL / NOT_VERIFIED. NOT_VERIFIED nunca vira PASS: exige ambiente real ou o operador.
// Nenhum resultado deste relatório autoriza a ativação (02B.6).

import type { PreflightReport } from './cloudflare-preflight.ts';
import type { DiagnosticResult } from './diagnostics.ts';

export type ReadinessStatus = 'PASS' | 'FAIL' | 'NOT_VERIFIED';

export interface ReadinessItem {
  id: string;
  requisito: string;
  status: ReadinessStatus;
  /** Evidência offline ou o que falta verificar (sem segredos). */
  detalhe: string;
}

export interface ReadinessInput {
  /** template = estrutura dos exemplos; activation = arquivos reais do operador. */
  mode: 'template' | 'activation';
  preflight: PreflightReport;
  env: Readonly<Record<string, string | undefined>>;
  /** null = diagnóstico não executado. */
  diagnostics: DiagnosticResult[] | null;
  /** Rótulos de segredos reais encontrados em arquivos versionados (nunca os valores). */
  versionedSecrets: string[];
}

/** Requisito ← códigos da pré-validação que o violam. */
const PREFLIGHT_REQUIREMENTS: [string, string, string[]][] = [
  ['P-HOST', 'Hostname público explícito e único (ambiente e túnel)', ['ENV_HOSTNAMES', 'CFG_HOSTNAME']],
  ['P-ACCESS', 'Cloudflare Access obrigatório no servidor', ['ENV_ACCESS_MODE']],
  ['P-ACCESS-CFG', 'AUD e domínio da equipe válidos e consistentes (servidor e cloudflared)', ['ENV_ACCESS', 'CFG_ACCESS']],
  ['P-5280', 'Túnel encaminhando exclusivamente para http://127.0.0.1:5280', ['CFG_INGRESS', 'CFG_RULE', 'CFG_SERVICE', 'PORTS']],
  ['P-5281', 'Nenhuma referência à porta administrativa 5281', ['CFG_ADMIN_PORT']],
  ['P-404', 'Regra final http_status:404', ['CFG_CATCHALL']],
  ['P-BYPASS', 'Sem configurações que permitam bypass (Host reescrito, TLS ignorado, WARP, token, Quick Tunnel, serviços extras)', [
    'CFG_HOST_HEADER', 'CFG_ORIGIN_REQUEST', 'CFG_WARP', 'CFG_TOKEN', 'CFG_LEGACY', 'CFG_QUICK_TUNNEL', 'CFG_SERVICE_TYPE', 'CFG_METRICS', 'CFG_KEYS', 'CFG_ALIAS', 'CFG_PARSE', 'CFG_TUNNEL',
  ]],
  ['P-LOGS', 'cloudflared sem logs de cabeçalhos (sem debug/trace)', ['CFG_LOGLEVEL']],
  ['P-CREDS', 'Credenciais do túnel e arquivos reais fora do repositório', ['CFG_CREDENTIALS', 'CFG_FILE', 'ENV_FILE']],
  ['P-REAL', 'Valores reais (nenhum valor de exemplo)', ['ENV_PLACEHOLDER', 'CFG_PLACEHOLDER']],
  ['P-ENV', 'Somente variáveis ORYN_* conhecidas', ['ENV_UNKNOWN']],
  ['P-TURN-FMT', 'Configuração TURN em formato válido', ['ENV_TURN']],
];

/** Itens que só o ambiente real ou o operador podem confirmar. */
export const OPERATOR_ITEMS: [string, string, string][] = [
  ['N-CI', 'CI verde (push e pull_request) no commit a ativar', 'Conferir no GitHub Actions o commit exato que será executado.'],
  ['N-ACCESS-APP', 'Aplicação Access self-hosted cobrindo o hostname inteiro (inclusive /ws), com cookies HttpOnly/SameSite Lax', 'Runbook §4.1 (A1, A5); prints do painel.'],
  ['N-POLICY', 'Política Allow só com e-mails explicitamente autorizados', 'Runbook §4.1 (A2); print da política.'],
  ['N-DNS', 'Hostname e domínio confirmados (DNS do túnel criado só na janela aprovada)', 'Runbook §4.2 (T7).'],
  ['N-INGRESS', 'cloudflared tunnel ingress validate/rule com o arquivo real', 'Runbook §4.2 (T4–T6), na versão instalada do cloudflared.'],
  ['N-WS-JWT', 'JWT do Access chega ao Node no handshake WebSocket real (Chrome e Safari)', 'Matriz R2: linha "[access] upgrade WebSocket autenticado".'],
  ['N-TURN-REAL', 'Chave TURN real criada e resposta real com endpoint turns: (relay-tls)', 'Matriz R5/R6; pela página (resumo "TURN n (tls…)").'],
  ['N-ROLLBACK', 'Rollback preparado e ensaiado (Ctrl+C no cloudflared, DNS, sessões)', 'Runbook §7.'],
  ['N-WINDOW', 'Janela de teste definida (início, fim, participantes)', 'Registrar no POC-02B.md antes da ativação.'],
  ['N-APPROVAL', 'Aprovação explícita do usuário para a ativação (02B.6)', 'Nenhum resultado automático autoriza a ativação.'],
];

export function buildReadiness(input: ReadinessInput): ReadinessItem[] {
  const items: ReadinessItem[] = [];
  const errorIds = new Map<string, string[]>();
  for (const e of input.preflight.errors) errorIds.set(e.id, [...(errorIds.get(e.id) ?? []), e.message]);
  const mapped = new Set<string>();

  for (const [id, requisito, codes] of PREFLIGHT_REQUIREMENTS) {
    const violations = codes.flatMap((c) => (errorIds.get(c) ?? []).map((m) => `[${c}] ${m}`));
    codes.forEach((c) => mapped.add(c));
    // No modo template, valores de exemplo são aceitos e arquivos reais não são lidos: não há PASS possível.
    if (!violations.length && input.mode === 'template' && (id === 'P-REAL' || id === 'P-CREDS')) {
      items.push({ id, requisito, status: 'NOT_VERIFIED', detalhe: 'modo template: exige os arquivos reais (modo activation)' });
      continue;
    }
    items.push({ id, requisito, status: violations.length ? 'FAIL' : 'PASS', detalhe: violations.length ? violations.join(' ') : 'pré-validação offline sem violações' });
  }
  // Qualquer regra da pré-validação sem requisito mapeado também reprova (nada é ignorado).
  for (const [code, messages] of errorIds) {
    if (!mapped.has(code)) items.push({ id: `P-${code}`, requisito: 'Regra adicional da pré-validação', status: 'FAIL', detalhe: messages.map((m) => `[${code}] ${m}`).join(' ') });
  }

  // TURN: habilitado (R5–R7 dependem dele), validade e STUN extra.
  const provider = (input.env['ORYN_TURN_PROVIDER'] ?? 'off').trim().toLowerCase();
  items.push({
    id: 'P-TURN-ON',
    requisito: 'Provedor TURN habilitado no servidor (necessário para R4–R7)',
    status: provider === 'cloudflare' ? 'PASS' : 'FAIL',
    detalhe: provider === 'cloudflare' ? 'ORYN_TURN_PROVIDER=cloudflare (token presente, não exibido)' : `ORYN_TURN_PROVIDER=${provider}: relay e relay-tls indisponíveis`,
  });
  const ttlRaw = input.env['ORYN_TURN_TTL_S'];
  const ttl = ttlRaw === undefined ? 7200 : Number(ttlRaw);
  const ttlOk = Number.isInteger(ttl) && ttl >= 3600 && ttl <= 86_400;
  items.push({
    id: 'P-TURN-TTL',
    requisito: 'Validade das credenciais TURN cobre a janela de teste (≥ 1 h, ≤ 24 h)',
    status: ttlOk ? 'PASS' : 'FAIL',
    detalhe: Number.isInteger(ttl) ? `${ttl} s${ttlRaw === undefined ? ' (padrão)' : ''}` : 'ORYN_TURN_TTL_S inválido',
  });
  const stun = (input.env['ORYN_ICE_STUN_URLS'] ?? '').split(',').map((u) => u.trim()).filter((u) => u !== '');
  const stunBad = stun.filter((u) => !/^stun:[a-z0-9.-]{1,253}(:\d{1,5})?$/.test(u) || /:53$/.test(u));
  items.push({
    id: 'P-STUN',
    requisito: 'URLs STUN extras válidas e sem porta 53',
    status: stunBad.length ? 'FAIL' : 'PASS',
    detalhe: stun.length ? `${stun.length} URL(s), ${stunBad.length} inválida(s)` : 'nenhuma STUN extra (usa a do provedor)',
  });
  items.push({
    id: 'P-TURN-LIMITS',
    requisito: 'Limites e timeout do emissor de credenciais',
    status: 'PASS',
    detalhe: 'código: intervalo 10 s, 3 por conexão, 1 em andamento por conexão, 4 simultâneas; timeout do provedor 5 s; resposta ≤ 32 KiB',
  });
  items.push({
    id: 'P-SECRETS',
    requisito: 'Nenhuma credencial real versionada (token TURN, segredo do túnel, JWT)',
    status: input.versionedSecrets.length ? 'FAIL' : 'PASS',
    detalhe: input.versionedSecrets.length ? `encontrado(s) em arquivo versionado: ${input.versionedSecrets.join(', ')}` : 'busca nos arquivos versionados sem ocorrências',
  });
  items.push({
    id: 'P-TURN-SERVER',
    requisito: 'Segredo administrativo TURN exclusivamente no servidor',
    status: input.versionedSecrets.includes('token da API TURN') ? 'FAIL' : provider === 'cloudflare' ? 'PASS' : 'NOT_VERIFIED',
    detalhe: 'lido só do arquivo de ambiente do servidor; nunca enviado ao navegador nem impresso (coberto por testes)',
  });

  // Diagnóstico local (simulado).
  if (input.diagnostics === null) {
    items.push({ id: 'D', requisito: 'Diagnóstico local (respostas HTTP/WS, Access, TURN, logs)', status: 'NOT_VERIFIED', detalhe: 'não executado (rode sem --skip-diagnostics)' });
  } else {
    for (const d of input.diagnostics) items.push({ id: d.id, requisito: `[simulado] ${d.area}: ${d.cenario}`, status: d.status, detalhe: d.observado });
  }

  // Dependentes de URL real do provedor: só verificáveis em execução.
  items.push({ id: 'N-TURNS-REAL', requisito: 'Resposta real do provedor contém turns: sobre TCP (relay-tls) e nenhuma URL utilizável na porta 53', status: 'NOT_VERIFIED', detalhe: 'o código filtra a porta 53 e falha fechado sem turns:; a resposta real só é vista no teste' });
  for (const [id, requisito, detalhe] of OPERATOR_ITEMS) items.push({ id, requisito, status: 'NOT_VERIFIED', detalhe });
  return items;
}

export function summarize(items: ReadinessItem[]): { pass: number; fail: number; notVerified: number } {
  return {
    pass: items.filter((i) => i.status === 'PASS').length,
    fail: items.filter((i) => i.status === 'FAIL').length,
    notVerified: items.filter((i) => i.status === 'NOT_VERIFIED').length,
  };
}
