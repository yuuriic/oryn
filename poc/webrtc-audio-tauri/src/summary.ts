// Copiado de poc/webrtc-audio-browser/src/summary.ts (POC-01A, ed589bd). POCs isoladas: sem import cruzado.
// Agregação das amostras periódicas para o resumo exportável (sem SDP, IPs ou áudio).

export interface MetricPoint {
  elapsedS: number;
  sendKbps: number | null;
  recvKbps: number | null;
  rttMs: number | null;
  jitterMs: number | null;
  lossPct: number | null;
  concealPct: number | null;
  /** audioLevel do inbound-rtp; no Chrome é pós-volume/mute do elemento de saída. */
  audioLevel: number | null;
  /** Pico de RMS (0–1) do microfone local desde a amostra anterior. */
  localRmsPeak: number | null;
  /** Pico de RMS (0–1) do áudio recebido, medido no track antes do playout. */
  remoteRmsPeak: number | null;
  packetsReceived: number;
}

interface Series {
  count: number;
  sum: number;
  min: number;
  max: number;
}

export interface SeriesSummary {
  samples: number;
  avg: number | null;
  min: number | null;
  max: number | null;
}

const KEYS = ['sendKbps', 'recvKbps', 'rttMs', 'jitterMs', 'audioLevel', 'remoteRmsPeak'] as const;
type SeriesKey = (typeof KEYS)[number];

export interface MetricsSummary {
  durationS: number;
  samples: number;
  packetsReceived: number;
  /** Amostras em que o áudio recebido (RMS no track) superou o limiar. */
  samplesWithAudio: number;
  /** Amostras em que o audioLevel do getStats superou o limiar. */
  samplesWithAudioLevel: number;
  finalLossPct: number | null;
  finalConcealPct: number | null;
  series: Record<SeriesKey, SeriesSummary>;
}

const round = (value: number | null, digits = 3): number | null =>
  value === null ? null : Number(value.toFixed(digits));

/** Limiar (0–1) acima do qual a amostra conta como "com áudio". */
export const AUDIO_PRESENT_THRESHOLD = 0.001;

export class MetricsAccumulator {
  private readonly series = new Map<SeriesKey, Series>();
  private samples = 0;
  private samplesWithAudio = 0;
  private samplesWithAudioLevel = 0;
  private last: MetricPoint | null = null;

  add(point: MetricPoint): void {
    this.samples += 1;
    this.last = point;
    if (point.remoteRmsPeak !== null && point.remoteRmsPeak > AUDIO_PRESENT_THRESHOLD) {
      this.samplesWithAudio += 1;
    }
    if (point.audioLevel !== null && point.audioLevel > AUDIO_PRESENT_THRESHOLD) {
      this.samplesWithAudioLevel += 1;
    }
    for (const key of KEYS) {
      const value = point[key];
      if (value === null || !Number.isFinite(value)) continue;
      const s = this.series.get(key);
      if (!s) {
        this.series.set(key, { count: 1, sum: value, min: value, max: value });
      } else {
        s.count += 1;
        s.sum += value;
        s.min = Math.min(s.min, value);
        s.max = Math.max(s.max, value);
      }
    }
  }

  summary(): MetricsSummary {
    const series = {} as Record<SeriesKey, SeriesSummary>;
    for (const key of KEYS) {
      const s = this.series.get(key);
      series[key] = s
        ? { samples: s.count, avg: round(s.sum / s.count), min: round(s.min), max: round(s.max) }
        : { samples: 0, avg: null, min: null, max: null };
    }
    return {
      durationS: round(this.last?.elapsedS ?? 0, 1) ?? 0,
      samples: this.samples,
      packetsReceived: this.last?.packetsReceived ?? 0,
      samplesWithAudio: this.samplesWithAudio,
      samplesWithAudioLevel: this.samplesWithAudioLevel,
      finalLossPct: round(this.last?.lossPct ?? null),
      finalConcealPct: round(this.last?.concealPct ?? null),
      series,
    };
  }
}
