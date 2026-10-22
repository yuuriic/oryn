import { LoopbackSession, type PeerId, type PeerStates, type SessionPhase, type StatsSample } from './session';
import { formatCodec, formatNumber, parseFmtp } from './stats';
import { MetricsAccumulator } from './summary';

const $ = <T extends HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Elemento ausente: ${selector}`);
  return el;
};

const ui = {
  start: $<HTMLButtonElement>('#btn-start'),
  mute: $<HTMLButtonElement>('#btn-mute'),
  stop: $<HTMLButtonElement>('#btn-stop'),
  listen: $<HTMLInputElement>('#chk-listen'),
  volume: $<HTMLInputElement>('#rng-volume'),
  phase: $<HTMLParagraphElement>('#phase'),
  error: $<HTMLParagraphElement>('#error'),
  codec: $<HTMLParagraphElement>('#codec'),
  codecFmtp: $<HTMLParagraphElement>('#codec-fmtp'),
  meterLocal: $<HTMLMeterElement>('#meter-local'),
  meterRemote: $<HTMLMeterElement>('#meter-remote'),
  summaryBtn: $<HTMLButtonElement>('#btn-summary'),
  summary: $<HTMLTextAreaElement>('#summary'),
  log: $<HTMLOListElement>('#log'),
  audioContainer: $<HTMLDivElement>('#audio-container'),
};

const PHASE_LABEL: Record<SessionPhase, string> = {
  idle: 'ocioso',
  requesting_permission: 'aguardando permissão do microfone…',
  negotiating: 'negociando SDP/ICE…',
  connected: 'conectado — áudio fluindo de A para B',
  failed: 'falhou',
  closed: 'encerrado',
};

const MAX_LOG_LINES = 200;

let session: LoopbackSession | null = null;
let accumulator = new MetricsAccumulator();
let muted = false;
let meterFrame: number | null = null;
let codecText = '—';

function log(message: string): void {
  const li = document.createElement('li');
  const time = new Date().toLocaleTimeString('pt-BR', { hour12: false });
  li.textContent = `[${time}] ${message}`;
  ui.log.append(li);
  while (ui.log.childElementCount > MAX_LOG_LINES) ui.log.firstElementChild?.remove();
  ui.log.scrollTop = ui.log.scrollHeight;
}

function setMetric(key: string, text: string, raw?: number | null): void {
  const cell = document.querySelector<HTMLTableCellElement>(`[data-metric="${key}"]`);
  if (!cell) return;
  cell.textContent = text;
  if (raw !== undefined) cell.dataset['raw'] = raw === null ? '' : String(raw);
}

function renderPhase(phase: SessionPhase): void {
  ui.phase.textContent = `Estado: ${PHASE_LABEL[phase]}`;
  ui.phase.dataset['phase'] = phase;

  const active = phase === 'requesting_permission' || phase === 'negotiating' || phase === 'connected';
  ui.start.disabled = active;
  ui.stop.disabled = !active;
  ui.mute.disabled = phase !== 'connected';
  ui.listen.disabled = phase !== 'connected';
  ui.volume.disabled = phase !== 'connected';
  ui.summaryBtn.disabled = accumulator.summary().samples === 0;
  if (!active) {
    ui.listen.checked = false;
    setMuteButton(false);
  }
}

function setMuteButton(value: boolean): void {
  muted = value;
  ui.mute.textContent = value ? 'Reativar microfone' : 'Mutar microfone';
  ui.mute.setAttribute('aria-pressed', String(value));
}

function renderPeerStates(peer: PeerId, states: PeerStates): void {
  for (const [key, value] of Object.entries(states)) {
    const cell = document.querySelector(`[data-peer="${peer}"][data-key="${key}"]`);
    if (cell) cell.textContent = value;
  }
}

function renderStats(sample: StatsSample): void {
  const { point, outbound, inbound, pair, codec } = sample;
  accumulator.add(point);
  ui.summaryBtn.disabled = false;

  const nextCodec = formatCodec(codec);
  if (nextCodec !== codecText) {
    codecText = nextCodec;
    ui.codec.textContent = nextCodec;
    const fmtp = parseFmtp(codec?.sdpFmtpLine ?? null);
    ui.codecFmtp.textContent = Object.entries(fmtp)
      .map(([k, v]) => `${k}=${v}`)
      .join(' · ');
    if (codec) log(`Codec negociado: ${nextCodec}`);
  }

  setMetric('sendKbps', formatNumber(point.sendKbps, 1, ' kbit/s'), point.sendKbps);
  setMetric('recvKbps', formatNumber(point.recvKbps, 1, ' kbit/s'), point.recvKbps);
  setMetric('packets', `${outbound?.packetsSent ?? '—'} / ${inbound?.packetsReceived ?? '—'}`, inbound?.packetsReceived ?? null);
  setMetric(
    'loss',
    `${formatNumber(point.lossPct, 2, ' %')} (${inbound?.packetsLost ?? '—'} pacotes)`,
    point.lossPct,
  );
  setMetric('jitter', formatNumber(point.jitterMs, 1, ' ms'), point.jitterMs);
  setMetric('jbDelay', formatNumber(inbound?.jitterBufferDelayMs ?? null, 1, ' ms'), inbound?.jitterBufferDelayMs ?? null);
  setMetric('rtt', formatNumber(point.rttMs, 2, ' ms'), point.rttMs);
  setMetric('conceal', formatNumber(point.concealPct, 2, ' %'), point.concealPct);
  setMetric('remoteRmsPeak', formatNumber(point.remoteRmsPeak, 4), point.remoteRmsPeak);
  setMetric('audioLevel', formatNumber(point.audioLevel, 4), point.audioLevel);
  setMetric(
    'pair',
    pair
      ? `${pair.state} · ${pair.localCandidateType ?? '?'} ↔ ${pair.remoteCandidateType ?? '?'} · ${pair.protocol ?? '?'}`
      : '—',
  );
  setMetric('elapsed', formatNumber(point.elapsedS, 0, ' s'), point.elapsedS);
}

function renderMeters(): void {
  if (!session) return;
  const { local, remote } = session.levels();
  ui.meterLocal.value = local;
  ui.meterRemote.value = remote;
  ui.meterRemote.dataset['raw'] = remote.toFixed(5);
  meterFrame = requestAnimationFrame(renderMeters);
}

function stopMeters(): void {
  if (meterFrame !== null) cancelAnimationFrame(meterFrame);
  meterFrame = null;
  ui.meterLocal.value = 0;
  ui.meterRemote.value = 0;
}

function resetView(): void {
  accumulator = new MetricsAccumulator();
  codecText = '—';
  ui.codec.textContent = '—';
  ui.codecFmtp.textContent = '';
  ui.summary.value = '';
  ui.error.hidden = true;
  ui.error.textContent = '';
  document.querySelectorAll<HTMLElement>('[data-metric], [data-peer]').forEach((cell) => {
    cell.textContent = '—';
    delete cell.dataset['raw'];
  });
}

ui.start.addEventListener('click', () => {
  resetView();
  const current = new LoopbackSession(
    { audioContainer: ui.audioContainer },
    {
      onPhase(phase, error) {
        if (session !== current) return;
        renderPhase(phase);
        if (error) {
          ui.error.textContent = error.message;
          ui.error.dataset['code'] = error.code;
          ui.error.hidden = false;
        }
        if (phase === 'connected') renderMeters();
        if (phase === 'failed' || phase === 'closed') stopMeters();
      },
      onPeerStates: (peer, states) => session === current && renderPeerStates(peer, states),
      onStats: (sample) => session === current && renderStats(sample),
      onLog: (message) => session === current && log(message),
    },
  );
  session = current;
  log('Iniciando sessão loopback…');
  void current.start();
});

ui.stop.addEventListener('click', () => {
  session?.close();
});

ui.mute.addEventListener('click', () => {
  if (!session) return;
  setMuteButton(!muted);
  session.setMuted(muted);
});

const applyListening = (): void => {
  session?.setListening(ui.listen.checked, Number(ui.volume.value));
};
ui.listen.addEventListener('change', applyListening);
ui.volume.addEventListener('input', applyListening);

ui.summaryBtn.addEventListener('click', () => {
  ui.summary.value = JSON.stringify(
    {
      poc: 'POC-01A',
      generatedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      codec: codecText,
      codecFmtp: ui.codecFmtp.textContent,
      ...accumulator.summary(),
    },
    null,
    2,
  );
});

// Fechar a aba encerra captura e conexões explicitamente.
window.addEventListener('pagehide', () => session?.close());

renderPhase('idle');
