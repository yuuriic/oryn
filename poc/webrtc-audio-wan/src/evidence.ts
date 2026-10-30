// Evidência SANITIZADA de conectividade por participante (POC-02B.5), para os testes WAN reais.
// Puro (sem DOM): montado na página a partir do que ela já exibe e validado antes de sair dela; o mesmo
// validador roda no `pnpm evidence:check` sobre os arquivos coletados.
//
// Nunca contém: IPs, tokens Access, cookies, credenciais TURN, chaves administrativas, SDP, candidatos
// ICE, e-mails, conteúdo de mensagens ou de áudio. Dado ausente = "indisponível" (nunca inventado).

import type { IceMode } from './ice.ts';
import { isIceMode } from './ice.ts';
import { mediaPath, type PairInfo } from './stats.ts';

export const EVIDENCE_FORMAT = 'oryn-poc-02b-evidencia/1';
export const UNAVAILABLE = 'indisponível';
/** Campos que só o operador pode avaliar (combinando os dois lados e o roteiro de segurança). */
export const OPERATOR_PENDING = 'pendente (operador)';
const OPERATOR_VALUES = [OPERATOR_PENDING, 'aprovado', 'reprovado', 'não se aplica'] as const;

type Maybe<T> = T | typeof UNAVAILABLE;

export interface ParticipantEvidence {
  formato: typeof EVIDENCE_FORMAT;
  /** Prefixo efêmero da sessão (4 caracteres), nunca o identificador completo. */
  sessao: Maybe<string>;
  papel: Maybe<'anfitrião' | 'convidado'>;
  /** Só família e versão principal (ex.: "Safari 18"), nunca o user agent completo. */
  navegador: Maybe<string>;
  plataforma: Maybe<string>;
  modoIce: IceMode;
  estadoIce: Maybe<string>;
  estadoConexao: Maybe<string>;
  parSelecionado: Maybe<{
    local: Maybe<string>;
    remoto: Maybe<string>;
    protocolo: Maybe<string>;
    relayProtocol: Maybe<string>;
    estado: string;
  }>;
  /** Comprovado pelo par selecionado; nunca pela configuração. */
  caminho: Maybe<'relay' | 'direto'>;
  turnConfigurado: Maybe<'sim' | 'não'>;
  rttMs: Maybe<number>;
  rttFonte: Maybe<'rtcp' | 'ice'>;
  jitterMs: Maybe<number>;
  perdaRecebidoPct: Maybe<number>;
  perdaEnviadoPct: Maybe<number>;
  pacotesEnviados: Maybe<number>;
  pacotesRecebidos: Maybe<number>;
  audio: {
    /** Áudio chegando NESTE lado (pacotes recebidos e nível acima do limiar). */
    recebidoNesteLado: Maybe<'sim' | 'não'>;
    /** Exige as evidências dos DOIS lados e a escuta humana: preenchido pelo operador. */
    bidirecional: (typeof OPERATOR_VALUES)[number];
  };
  /** Roteiro de segurança do cenário (Access, convites, administração pelo túnel): operador. */
  seguranca: (typeof OPERATOR_VALUES)[number];
  timestamp: string;
}

export interface EvidenceInput {
  sessionId: string | null;
  role: 'host' | 'guest' | null;
  userAgent: string;
  iceMode: IceMode;
  iceState: string | null;
  connectionState: string | null;
  pair: PairInfo | null;
  turnConfigured: boolean | null;
  rttMs: number | null;
  rttSource: 'rtcp' | 'ice' | null;
  jitterMs: number | null;
  lossPct: number | null;
  remoteLossPct: number | null;
  packetsSent: number | null;
  packetsReceived: number | null;
  /** Maior nível de áudio remoto observado (0–1), ou null. */
  remoteLevelMax: number | null;
  now: Date;
}

/** Nível mínimo para considerar que há áudio chegando (mesmo limiar do E2E). */
export const AUDIO_LEVEL_THRESHOLD = 0.001;

const num = (v: number | null, digits = 1): Maybe<number> =>
  v === null || !Number.isFinite(v) ? UNAVAILABLE : Number(v.toFixed(digits));
const str = (v: string | null | undefined): Maybe<string> => (v ? v : UNAVAILABLE);

/** "Chrome 155", "Edge 155", "Safari 18", "Firefox 140"; sem o user agent completo. */
export function browserFamily(ua: string): { navegador: Maybe<string>; plataforma: Maybe<string> } {
  const pick = (re: RegExp): string | null => re.exec(ua)?.[1] ?? null;
  let navegador: string | null = null;
  const edge = pick(/Edg(?:A|iOS)?\/(\d+)/);
  const chromeIos = pick(/CriOS\/(\d+)/);
  const chrome = pick(/Chrome\/(\d+)/);
  const firefox = pick(/(?:Firefox|FxiOS)\/(\d+)/);
  const safari = /Safari\//.test(ua) ? pick(/Version\/(\d+)/) : null;
  if (edge) navegador = `Edge ${edge}`;
  else if (chromeIos) navegador = `Chrome ${chromeIos} (iOS)`;
  else if (firefox) navegador = `Firefox ${firefox}`;
  else if (chrome) navegador = `Chrome ${chrome}`;
  else if (safari) navegador = `Safari ${safari}`;
  const plataforma = /iPhone/.test(ua)
    ? 'iPhone (iOS)'
    : /iPad/.test(ua)
      ? 'iPad (iOS)'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X/.test(ua)
            ? 'macOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : null;
  return { navegador: str(navegador), plataforma: str(plataforma) };
}

export function buildEvidence(input: EvidenceInput): ParticipantEvidence {
  const { navegador, plataforma } = browserFamily(input.userAgent);
  const path = mediaPath(input.pair);
  const received =
    input.packetsReceived === null && input.remoteLevelMax === null
      ? UNAVAILABLE
      : (input.packetsReceived ?? 0) > 0 && (input.remoteLevelMax ?? 0) > AUDIO_LEVEL_THRESHOLD
        ? 'sim'
        : 'não';
  return {
    formato: EVIDENCE_FORMAT,
    sessao: input.sessionId ? `${input.sessionId.slice(0, 4)}…` : UNAVAILABLE,
    papel: input.role === 'host' ? 'anfitrião' : input.role === 'guest' ? 'convidado' : UNAVAILABLE,
    navegador,
    plataforma,
    modoIce: input.iceMode,
    estadoIce: str(input.iceState),
    estadoConexao: str(input.connectionState),
    parSelecionado: input.pair
      ? {
          local: str(input.pair.localCandidateType),
          remoto: str(input.pair.remoteCandidateType),
          protocolo: str(input.pair.protocol),
          relayProtocol: str(input.pair.relayProtocol),
          estado: input.pair.state,
        }
      : UNAVAILABLE,
    caminho: path === 'relay' ? 'relay' : path === 'direct' ? 'direto' : UNAVAILABLE,
    turnConfigurado: input.turnConfigured === null ? UNAVAILABLE : input.turnConfigured ? 'sim' : 'não',
    rttMs: num(input.rttMs),
    rttFonte: input.rttSource ?? UNAVAILABLE,
    jitterMs: num(input.jitterMs),
    perdaRecebidoPct: num(input.lossPct, 2),
    perdaEnviadoPct: num(input.remoteLossPct, 2),
    pacotesEnviados: num(input.packetsSent, 0),
    pacotesRecebidos: num(input.packetsReceived, 0),
    audio: { recebidoNesteLado: received, bidirecional: OPERATOR_PENDING },
    seguranca: OPERATOR_PENDING,
    timestamp: input.now.toISOString(),
  };
}

// ---------- validação (sanitização) ----------

const SENSITIVE: [string, RegExp][] = [
  ['endereço IPv4', /\b(?:\d{1,3}\.){3}\d{1,3}\b/],
  // 4+ grupos ou "::" (um horário ISO como 21:02:54 tem só 3 grupos e não casa).
  ['endereço IPv6', /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b|[0-9a-f]{0,4}::(?:[0-9a-f]{1,4}(?::|\b))*/i],
  ['JWT', /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/],
  ['token longo (convite, chave ou credencial)', /[A-Za-z0-9_-]{40,}/],
  ['e-mail', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['candidato ICE ou SDP', /candidate:|a=fingerprint|a=ice-ufrag|a=ice-pwd|\bv=0\b/i],
  ['cookie ou cabeçalho de sessão', /CF_Authorization|Cf-Access-Jwt-Assertion|CF_Binding|cookie/i],
  ['URL STUN/TURN', /\b(?:stun|turns?):/i],
];
const FORBIDDEN_KEYS = /^(username|credential|password|token|jwt|cookie|authorization|apiToken|secret|email|ip|address|url|sdp|candidate)$/i;

/** Rótulos dos padrões sensíveis encontrados no texto (nunca devolve o trecho encontrado). */
export function findSensitive(text: string): string[] {
  return SENSITIVE.filter(([, re]) => re.test(text)).map(([label]) => label);
}

function* keysOf(value: unknown): Generator<string> {
  if (Array.isArray(value)) for (const v of value) yield* keysOf(v);
  else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      yield k;
      yield* keysOf(v);
    }
  }
}

const isMaybeNumber = (v: unknown): boolean => v === UNAVAILABLE || (typeof v === 'number' && Number.isFinite(v));
const oneOf = (v: unknown, values: readonly unknown[]): boolean => values.includes(v);

/** Lista de problemas; vazia = evidência no formato e sanitizada. */
export function validateEvidence(value: unknown): string[] {
  const problems: string[] = [];
  const text = JSON.stringify(value) ?? '';
  for (const label of findSensitive(text)) problems.push(`contém ${label}`);
  for (const key of keysOf(value)) if (FORBIDDEN_KEYS.test(key)) problems.push(`campo proibido "${key}"`);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [...problems, 'não é um objeto'];
  const e = value as Record<string, unknown>;
  if (e['formato'] !== EVIDENCE_FORMAT) problems.push('formato desconhecido');
  if (!(e['sessao'] === UNAVAILABLE || (typeof e['sessao'] === 'string' && /^[A-Za-z0-9_-]{4}…$/.test(e['sessao'])))) problems.push('sessao deve ser só o prefixo de 4 caracteres');
  if (!oneOf(e['papel'], ['anfitrião', 'convidado', UNAVAILABLE])) problems.push('papel inválido');
  if (!isIceMode(e['modoIce'])) problems.push('modoIce inválido');
  if (!oneOf(e['caminho'], ['relay', 'direto', UNAVAILABLE])) problems.push('caminho inválido');
  for (const k of ['rttMs', 'jitterMs', 'perdaRecebidoPct', 'perdaEnviadoPct', 'pacotesEnviados', 'pacotesRecebidos']) {
    if (!isMaybeNumber(e[k])) problems.push(`${k} deve ser número ou "${UNAVAILABLE}"`);
  }
  const audio = e['audio'] as Record<string, unknown> | undefined;
  if (!audio || !oneOf(audio['recebidoNesteLado'], ['sim', 'não', UNAVAILABLE]) || !oneOf(audio['bidirecional'], OPERATOR_VALUES)) problems.push('audio inválido');
  if (!oneOf(e['seguranca'], OPERATOR_VALUES)) problems.push('seguranca inválida');
  if (typeof e['timestamp'] !== 'string' || Number.isNaN(Date.parse(e['timestamp']))) problems.push('timestamp inválido');
  // Coerência: "relay" exige par selecionado com candidato relay (nunca inferido da configuração).
  const pair = e['parSelecionado'] as Record<string, unknown> | string | undefined;
  if (e['caminho'] === 'relay' && (typeof pair !== 'object' || (pair['local'] !== 'relay' && pair['remoto'] !== 'relay'))) {
    problems.push('caminho "relay" sem candidato relay no par selecionado');
  }
  if (typeof pair === 'object' && pair !== null && pair['relayProtocol'] !== UNAVAILABLE && pair['local'] !== 'relay') {
    problems.push('relayProtocol só se aplica a candidato local relay');
  }
  return [...new Set(problems)];
}
