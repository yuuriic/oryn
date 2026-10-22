// Funções puras sobre o resultado de RTCPeerConnection.getStats().
// Recebem arrays de objetos simples para que possam ser testadas fora do navegador.

export interface StatsEntry {
  id: string;
  type: string;
  timestamp: number;
  [key: string]: unknown;
}

export interface CodecInfo {
  mimeType: string;
  clockRate: number | null;
  channels: number | null;
  payloadType: number | null;
  sdpFmtpLine: string | null;
}

export interface PairInfo {
  state: string;
  rttMs: number | null;
  localCandidateType: string | null;
  remoteCandidateType: string | null;
  protocol: string | null;
}

export interface OutboundSnapshot {
  timestamp: number;
  bytesSent: number;
  packetsSent: number;
  codec: CodecInfo | null;
}

export interface InboundSnapshot {
  timestamp: number;
  bytesReceived: number;
  packetsReceived: number;
  packetsLost: number;
  jitterMs: number | null;
  audioLevel: number | null;
  totalAudioEnergy: number | null;
  concealedSamples: number | null;
  totalSamplesReceived: number | null;
  jitterBufferDelayMs: number | null;
  codec: CodecInfo | null;
}

function num(entry: StatsEntry | undefined, key: string): number | null {
  const value = entry?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(entry: StatsEntry | undefined, key: string): string | null {
  const value = entry?.[key];
  return typeof value === 'string' ? value : null;
}

/** Converte o RTCStatsReport (Map-like) em array; isolado para os testes não dependerem do DOM. */
export function toEntries(report: { forEach(cb: (value: unknown) => void): void }): StatsEntry[] {
  const out: StatsEntry[] = [];
  report.forEach((value) => out.push(value as StatsEntry));
  return out;
}

function byId(entries: StatsEntry[], id: string | null): StatsEntry | undefined {
  return id === null ? undefined : entries.find((e) => e.id === id);
}

function rtpEntry(entries: StatsEntry[], type: 'outbound-rtp' | 'inbound-rtp'): StatsEntry | undefined {
  return entries.find((e) => e.type === type && (e['kind'] ?? e['mediaType']) === 'audio');
}

export function codecFor(entries: StatsEntry[], rtp: StatsEntry | undefined): CodecInfo | null {
  const codec = byId(entries, str(rtp, 'codecId'));
  const mimeType = str(codec, 'mimeType');
  if (!codec || !mimeType) return null;
  return {
    mimeType,
    clockRate: num(codec, 'clockRate'),
    channels: num(codec, 'channels'),
    payloadType: num(codec, 'payloadType'),
    sdpFmtpLine: str(codec, 'sdpFmtpLine'),
  };
}

/** "minptime=10;useinbandfec=1" → { minptime: "10", useinbandfec: "1" } */
export function parseFmtp(line: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!line) return out;
  for (const part of line.split(';')) {
    const [rawKey, ...rest] = part.split('=');
    const key = rawKey?.trim();
    if (key) out[key] = rest.join('=').trim();
  }
  return out;
}

export function formatCodec(codec: CodecInfo | null): string {
  if (!codec) return '—';
  const parts = [codec.mimeType];
  if (codec.clockRate !== null) parts.push(`${codec.clockRate} Hz`);
  if (codec.channels !== null) parts.push(`${codec.channels} canal(is)`);
  if (codec.payloadType !== null) parts.push(`PT ${codec.payloadType}`);
  return parts.join(' · ');
}

export function outboundAudio(entries: StatsEntry[]): OutboundSnapshot | null {
  const rtp = rtpEntry(entries, 'outbound-rtp');
  if (!rtp) return null;
  return {
    timestamp: rtp.timestamp,
    bytesSent: num(rtp, 'bytesSent') ?? 0,
    packetsSent: num(rtp, 'packetsSent') ?? 0,
    codec: codecFor(entries, rtp),
  };
}

export function inboundAudio(entries: StatsEntry[]): InboundSnapshot | null {
  const rtp = rtpEntry(entries, 'inbound-rtp');
  if (!rtp) return null;
  const jitter = num(rtp, 'jitter');
  const bufferDelay = num(rtp, 'jitterBufferDelay');
  const emitted = num(rtp, 'jitterBufferEmittedCount');
  return {
    timestamp: rtp.timestamp,
    bytesReceived: num(rtp, 'bytesReceived') ?? 0,
    packetsReceived: num(rtp, 'packetsReceived') ?? 0,
    packetsLost: num(rtp, 'packetsLost') ?? 0,
    jitterMs: jitter === null ? null : jitter * 1000,
    audioLevel: num(rtp, 'audioLevel'),
    totalAudioEnergy: num(rtp, 'totalAudioEnergy'),
    concealedSamples: num(rtp, 'concealedSamples'),
    totalSamplesReceived: num(rtp, 'totalSamplesReceived'),
    jitterBufferDelayMs:
      bufferDelay !== null && emitted !== null && emitted > 0 ? (bufferDelay / emitted) * 1000 : null,
    codec: codecFor(entries, rtp),
  };
}

/** Par de candidatos selecionado, sem endereços ou portas. */
export function selectedPair(entries: StatsEntry[]): PairInfo | null {
  const transport = entries.find((e) => e.type === 'transport');
  let pair = byId(entries, str(transport, 'selectedCandidatePairId'));
  pair ??= entries.find(
    (e) => e.type === 'candidate-pair' && e['nominated'] === true && e['state'] === 'succeeded',
  );
  if (!pair) return null;
  const local = byId(entries, str(pair, 'localCandidateId'));
  const remote = byId(entries, str(pair, 'remoteCandidateId'));
  const rtt = num(pair, 'currentRoundTripTime');
  return {
    state: str(pair, 'state') ?? 'desconhecido',
    rttMs: rtt === null ? null : rtt * 1000,
    localCandidateType: str(local, 'candidateType'),
    remoteCandidateType: str(remote, 'candidateType'),
    protocol: str(local, 'protocol'),
  };
}

/** Taxa em kbit/s entre duas amostras; null quando não há intervalo válido. */
export function bitrateKbps(
  prevBytes: number,
  prevTimestampMs: number,
  bytes: number,
  timestampMs: number,
): number | null {
  const dt = timestampMs - prevTimestampMs;
  const db = bytes - prevBytes;
  if (dt <= 0 || db < 0) return null;
  return (db * 8) / dt; // bits por ms = kbit/s
}

/** Perda acumulada em %, seguindo a definição de packetsLost do inbound-rtp. */
export function packetLossPercent(packetsLost: number, packetsReceived: number): number | null {
  const lost = Math.max(0, packetsLost);
  const total = lost + packetsReceived;
  if (total <= 0) return null;
  return (lost / total) * 100;
}

/** Fração de amostras ocultadas (PLC) sobre o total recebido. */
export function concealmentPercent(
  concealed: number | null,
  totalSamples: number | null,
): number | null {
  if (concealed === null || totalSamples === null || totalSamples <= 0) return null;
  return (concealed / totalSamples) * 100;
}

export function formatNumber(value: number | null, digits = 1, suffix = ''): string {
  return value === null ? '—' : `${value.toFixed(digits)}${suffix}`;
}
