import { describe, expect, it } from 'vitest';
import {
  bitrateKbps,
  codecFor,
  concealmentPercent,
  formatCodec,
  formatNumber,
  inboundAudio,
  outboundAudio,
  packetLossPercent,
  parseFmtp,
  selectedPair,
  toEntries,
  type StatsEntry,
} from '../src/stats';

// Relatórios sintéticos no formato de RTCStatsReport (campos do W3C webrtc-stats).
const sender: StatsEntry[] = [
  {
    id: 'COT01_111',
    type: 'codec',
    timestamp: 1000,
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    payloadType: 111,
    sdpFmtpLine: 'minptime=10;useinbandfec=1',
  },
  { id: 'OT01A', type: 'outbound-rtp', timestamp: 2000, kind: 'audio', codecId: 'COT01_111', bytesSent: 8000, packetsSent: 100 },
];

const receiver: StatsEntry[] = [
  { id: 'CIT01_111', type: 'codec', timestamp: 1000, mimeType: 'audio/opus', clockRate: 48000, channels: 2, payloadType: 111 },
  {
    id: 'IT01A',
    type: 'inbound-rtp',
    timestamp: 2000,
    kind: 'audio',
    codecId: 'CIT01_111',
    bytesReceived: 7900,
    packetsReceived: 98,
    packetsLost: 2,
    jitter: 0.004,
    audioLevel: 0.12,
    totalAudioEnergy: 0.5,
    concealedSamples: 960,
    totalSamplesReceived: 96000,
    jitterBufferDelay: 2.4,
    jitterBufferEmittedCount: 96000,
  },
  { id: 'T01', type: 'transport', timestamp: 2000, selectedCandidatePairId: 'CP1' },
  { id: 'CP1', type: 'candidate-pair', timestamp: 2000, state: 'succeeded', nominated: true, currentRoundTripTime: 0.0012, localCandidateId: 'L1', remoteCandidateId: 'R1' },
  { id: 'CP2', type: 'candidate-pair', timestamp: 2000, state: 'failed', nominated: false, localCandidateId: 'L2', remoteCandidateId: 'R1' },
  { id: 'L1', type: 'local-candidate', timestamp: 2000, candidateType: 'host', protocol: 'udp', address: '192.0.2.10', port: 50000 },
  { id: 'R1', type: 'remote-candidate', timestamp: 2000, candidateType: 'host', protocol: 'udp', address: '192.0.2.10', port: 50001 },
];

describe('toEntries', () => {
  it('converte um objeto Map-like em array', () => {
    const map = new Map(sender.map((e) => [e.id, e]));
    expect(toEntries(map)).toEqual(sender);
  });
});

describe('codecFor / formatCodec', () => {
  it('resolve o codec pelo codecId do RTP', () => {
    const codec = codecFor(sender, sender[1]);
    expect(codec).toEqual({
      mimeType: 'audio/opus',
      clockRate: 48000,
      channels: 2,
      payloadType: 111,
      sdpFmtpLine: 'minptime=10;useinbandfec=1',
    });
    expect(formatCodec(codec)).toBe('audio/opus · 48000 Hz · 2 canal(is) · PT 111');
  });

  it('retorna null quando o codec não existe', () => {
    expect(codecFor(sender, { id: 'x', type: 'outbound-rtp', timestamp: 0, codecId: 'missing' })).toBeNull();
    expect(codecFor(sender, undefined)).toBeNull();
    expect(formatCodec(null)).toBe('—');
  });
});

describe('parseFmtp', () => {
  it('separa parâmetros chave=valor', () => {
    expect(parseFmtp('minptime=10;useinbandfec=1')).toEqual({ minptime: '10', useinbandfec: '1' });
    expect(parseFmtp(' stereo=0 ; sprop-stereo=0 ')).toEqual({ stereo: '0', 'sprop-stereo': '0' });
  });

  it('lida com vazio e null', () => {
    expect(parseFmtp(null)).toEqual({});
    expect(parseFmtp('')).toEqual({});
  });
});

describe('outboundAudio / inboundAudio', () => {
  it('extrai contadores e converte jitter para ms', () => {
    expect(outboundAudio(sender)).toMatchObject({ bytesSent: 8000, packetsSent: 100, timestamp: 2000 });
    const inbound = inboundAudio(receiver);
    expect(inbound).toMatchObject({ bytesReceived: 7900, packetsReceived: 98, packetsLost: 2, audioLevel: 0.12 });
    expect(inbound?.jitterMs).toBeCloseTo(4);
    expect(inbound?.jitterBufferDelayMs).toBeCloseTo(0.025);
    expect(inbound?.codec?.mimeType).toBe('audio/opus');
  });

  it('ignora RTP de vídeo e retorna null sem áudio', () => {
    const video: StatsEntry[] = [{ id: 'v', type: 'inbound-rtp', timestamp: 0, kind: 'video', bytesReceived: 1 }];
    expect(inboundAudio(video)).toBeNull();
    expect(outboundAudio([])).toBeNull();
  });

  it('aceita o campo legado mediaType', () => {
    const legacy: StatsEntry[] = [{ id: 'o', type: 'outbound-rtp', timestamp: 5, mediaType: 'audio', bytesSent: 10, packetsSent: 1 }];
    expect(outboundAudio(legacy)?.bytesSent).toBe(10);
  });
});

describe('selectedPair', () => {
  it('usa selectedCandidatePairId do transport e omite endereços', () => {
    const pair = selectedPair(receiver);
    expect(pair).toEqual({
      state: 'succeeded',
      rttMs: 1.2,
      localCandidateType: 'host',
      remoteCandidateType: 'host',
      protocol: 'udp',
    });
    expect(JSON.stringify(pair)).not.toContain('192.0.2.10');
  });

  it('recorre ao par nomeado quando não há transport', () => {
    const noTransport = receiver.filter((e) => e.type !== 'transport');
    expect(selectedPair(noTransport)?.state).toBe('succeeded');
  });

  it('retorna null sem par selecionado', () => {
    expect(selectedPair([])).toBeNull();
  });
});

describe('bitrateKbps', () => {
  it('calcula kbit/s a partir de bytes e ms', () => {
    expect(bitrateKbps(0, 0, 4000, 1000)).toBe(32);
  });

  it('retorna null para intervalo inválido ou contador regressivo', () => {
    expect(bitrateKbps(0, 1000, 100, 1000)).toBeNull();
    expect(bitrateKbps(500, 0, 100, 1000)).toBeNull();
  });
});

describe('packetLossPercent / concealmentPercent', () => {
  it('calcula perda sobre pacotes esperados', () => {
    expect(packetLossPercent(2, 98)).toBe(2);
    expect(packetLossPercent(0, 0)).toBeNull();
    expect(packetLossPercent(-3, 100)).toBe(0); // packetsLost pode ser negativo com duplicatas
  });

  it('calcula ocultação sobre amostras recebidas', () => {
    expect(concealmentPercent(960, 96000)).toBe(1);
    expect(concealmentPercent(null, 10)).toBeNull();
    expect(concealmentPercent(1, 0)).toBeNull();
  });
});

describe('formatNumber', () => {
  it('formata com sufixo e trata null', () => {
    expect(formatNumber(1.234, 1, ' ms')).toBe('1.2 ms');
    expect(formatNumber(null)).toBe('—');
  });
});
