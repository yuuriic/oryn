import { describe, expect, it } from 'vitest';
import { MetricsAccumulator, type MetricPoint } from '../src/summary';

const point = (overrides: Partial<MetricPoint>): MetricPoint => ({
  elapsedS: 0,
  sendKbps: null,
  recvKbps: null,
  rttMs: null,
  jitterMs: null,
  lossPct: null,
  concealPct: null,
  audioLevel: null,
  localRmsPeak: null,
  remoteRmsPeak: null,
  packetsReceived: 0,
  ...overrides,
});

describe('MetricsAccumulator', () => {
  it('resume vazio sem amostras', () => {
    const summary = new MetricsAccumulator().summary();
    expect(summary.samples).toBe(0);
    expect(summary.series.recvKbps).toEqual({ samples: 0, avg: null, min: null, max: null });
    expect(summary.finalLossPct).toBeNull();
  });

  it('calcula média, mínimo e máximo ignorando nulos', () => {
    const acc = new MetricsAccumulator();
    acc.add(point({ elapsedS: 1, recvKbps: null, audioLevel: 0, remoteRmsPeak: 0 }));
    acc.add(point({ elapsedS: 2, recvKbps: 30, audioLevel: 0.2, remoteRmsPeak: 0.05, packetsReceived: 50, lossPct: 0 }));
    acc.add(point({ elapsedS: 3, recvKbps: 40, audioLevel: 0.0005, remoteRmsPeak: 0.07, packetsReceived: 100, lossPct: 1.5, concealPct: 0.2 }));
    const summary = acc.summary();

    expect(summary.samples).toBe(3);
    expect(summary.durationS).toBe(3);
    expect(summary.packetsReceived).toBe(100);
    expect(summary.series.recvKbps).toEqual({ samples: 2, avg: 35, min: 30, max: 40 });
    expect(summary.samplesWithAudio).toBe(2); // RMS no track: 0.05 e 0.07
    expect(summary.samplesWithAudioLevel).toBe(1); // 0 e 0.0005 ficam abaixo do limiar
    expect(summary.series.remoteRmsPeak).toEqual({ samples: 3, avg: 0.04, min: 0, max: 0.07 });
    expect(summary.finalLossPct).toBe(1.5);
    expect(summary.finalConcealPct).toBe(0.2);
  });
});
