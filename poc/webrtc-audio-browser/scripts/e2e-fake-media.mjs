// Teste funcional automatizado da POC-01A.
//
// Usa o Chrome/Edge instalado com dispositivo de mídia FALSO do Chromium
// (--use-fake-device-for-media-stream gera um tom sintético). Isso valida o pipeline
// WebRTC (captura → codificação → ICE/DTLS → recepção → decodificação), mas NÃO
// substitui o teste manual com microfone real, saída de áudio e percepção humana.
//
// Uso: pnpm e2e [--channel=chrome|msedge] [--headed]
// Saída: JSON com resultados agregados (sem SDP, candidatos ou endereços).

import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const channel = arg('channel', 'chrome');
const headless = !process.argv.includes('--headed');

const AUDIO_THRESHOLD = 0.001;
const results = { channel, headless, startedAt: new Date().toISOString(), checks: [], scenarios: {} };

function check(name, ok, detail) {
  results.checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
}

// Instrumentação exclusiva do teste: guarda referências a streams e peer connections
// criados pela página para verificar o cleanup depois de "Encerrar".
function instrument() {
  window.__e2e = { streams: [], pcs: [] };
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const stream = await gum(constraints);
    window.__e2e.streams.push(stream);
    return stream;
  };
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Native {
    constructor(...args) {
      super(...args);
      window.__e2e.pcs.push(this);
    }
  };
}

const readMetric = (page, key) =>
  page.$eval(`[data-metric="${key}"]`, (el) => (el.dataset.raw === '' || el.dataset.raw === undefined ? null : Number(el.dataset.raw)));
const peerState = (page, peer, key) => page.$eval(`[data-peer="${peer}"][data-key="${key}"]`, (el) => el.textContent);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Máximo de uma métrica (data-raw) amostrada a cada 250 ms durante durationMs. */
async function sampleMetricMax(page, key, durationMs) {
  let max = null;
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    const v = await readMetric(page, key);
    if (v !== null) max = max === null ? v : Math.max(max, v);
    await wait(250);
  }
  return max;
}

/** Média do nível remoto (Web Audio RMS) amostrado em intervalos curtos. */
async function sampleRemoteRms(page, durationMs) {
  const values = [];
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    values.push(await page.$eval('[data-testid="meter-remote"]', (el) => Number(el.dataset.raw ?? 0)));
    await wait(100);
  }
  return { avg: values.reduce((a, b) => a + b, 0) / values.length, max: Math.max(...values), n: values.length };
}

async function happyPath(server) {
  const browser = await chromium.launch({
    channel,
    headless,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const context = await browser.newContext();
  await context.addInitScript(instrument);
  const page = await context.newPage();

  const consoleMessages = [];
  page.on('console', (msg) => consoleMessages.push(msg.text()));
  page.on('pageerror', (err) => consoleMessages.push(`pageerror: ${err.message}`));

  await page.goto(server);
  results.browserVersion = browser.version();
  results.userAgent = await page.evaluate(() => navigator.userAgent);

  const t0 = Date.now();
  await page.click('[data-testid="btn-start"]');
  await page.waitForSelector('[data-testid="phase"][data-phase="connected"]', { timeout: 15000 });
  results.scenarios.connectMs = Date.now() - t0;
  check('fase "connected" alcançada', true);

  for (const peer of ['A', 'B']) {
    check(`connectionState ${peer} = connected`, (await peerState(page, peer, 'connection')) === 'connected');
    check(`iceConnectionState ${peer} conectado`, ['connected', 'completed'].includes(await peerState(page, peer, 'ice')));
  }

  await wait(6000);
  const codec = await page.textContent('[data-testid="codec"]');
  const fmtp = await page.textContent('[data-testid="codec-fmtp"]');
  results.scenarios.codec = codec;
  results.scenarios.codecFmtp = fmtp;
  check('codec negociado é Opus', /audio\/opus/i.test(codec ?? ''), codec);

  const active = {
    recvKbps: await readMetric(page, 'recvKbps'),
    sendKbps: await readMetric(page, 'sendKbps'),
    packetsReceived: await readMetric(page, 'packets'),
    rttMs: await readMetric(page, 'rtt'),
    jitterMs: await readMetric(page, 'jitter'),
    lossPct: await readMetric(page, 'loss'),
    remoteRmsPeakMax: await sampleMetricMax(page, 'remoteRmsPeak', 3000),
    audioLevelMaxWithOutputMuted: await sampleMetricMax(page, 'audioLevel', 2000),
    remoteRms: await sampleRemoteRms(page, 1500),
  };
  results.scenarios.active = active;
  check('pacotes recebidos > 0', active.packetsReceived > 0, active.packetsReceived);
  check('taxa recebida > 0', active.recvKbps > 0, active.recvKbps);
  check('pico RMS recebido (track) > limiar', active.remoteRmsPeakMax > AUDIO_THRESHOLD, active.remoteRmsPeakMax);
  check('medidor RMS recebido (rAF) > limiar', active.remoteRms.max > AUDIO_THRESHOLD, active.remoteRms);

  // Mute: track.enabled = false — o envio continua com silêncio, sem renegociar.
  const packetsBeforeMute = active.packetsReceived;
  await page.click('[data-testid="btn-mute"]');
  await wait(4000);
  const muted = {
    remoteRmsPeakMax: await sampleMetricMax(page, 'remoteRmsPeak', 3000),
    packetsReceived: await readMetric(page, 'packets'),
    remoteRms: await sampleRemoteRms(page, 1500),
    connectionA: await peerState(page, 'A', 'connection'),
    connectionB: await peerState(page, 'B', 'connection'),
    signalingA: await peerState(page, 'A', 'signaling'),
  };
  results.scenarios.muted = muted;
  check('mutado: pico RMS recebido ≈ 0', muted.remoteRmsPeakMax !== null && muted.remoteRmsPeakMax <= AUDIO_THRESHOLD, muted.remoteRmsPeakMax);
  check('mutado: RMS recebido ≈ 0', muted.remoteRms.max <= AUDIO_THRESHOLD, muted.remoteRms);
  check('mutado: conexão mantida', muted.connectionA === 'connected' && muted.connectionB === 'connected');
  check('mutado: pacotes continuam chegando', muted.packetsReceived > packetsBeforeMute, {
    before: packetsBeforeMute,
    after: muted.packetsReceived,
  });

  await page.click('[data-testid="btn-mute"]');
  await wait(4000);
  const unmuted = { remoteRmsPeakMax: await sampleMetricMax(page, 'remoteRmsPeak', 3000) };
  check('reativado: pico RMS recebido volta acima do limiar', unmuted.remoteRmsPeakMax > AUDIO_THRESHOLD, unmuted.remoteRmsPeakMax);

  // Saída ligada: o <audio> passa a tocar (dispositivo de saída do sistema/headless).
  await page.check('[data-testid="chk-listen"]');
  await wait(1000);
  unmuted.audioLevelMaxWithOutputOn = await sampleMetricMax(page, 'audioLevel', 3000);
  unmuted.audioElement = await page.$eval('audio', (a) => ({ paused: a.paused, muted: a.muted, volume: a.volume }));
  results.scenarios.unmuted = unmuted;
  check('saída ligada: <audio> tocando e sem mute', !unmuted.audioElement.paused && !unmuted.audioElement.muted);
  check('saída ligada: audioLevel (getStats) > limiar', unmuted.audioLevelMaxWithOutputOn > AUDIO_THRESHOLD, unmuted.audioLevelMaxWithOutputOn);

  await page.click('[data-testid="btn-summary"]');
  const summary = JSON.parse(await page.inputValue('[data-testid="summary"]'));
  delete summary.userAgent; // já registrado em results.userAgent
  results.scenarios.summary = summary;
  check('resumo: amostras com áudio recebido > 0', summary.samplesWithAudio > 0, summary.samplesWithAudio);
  check('resumo: perda final = 0 % (loopback)', summary.finalLossPct === 0, summary.finalLossPct);

  await page.click('[data-testid="btn-stop"]');
  await page.waitForSelector('[data-testid="phase"][data-phase="closed"]', { timeout: 5000 });
  await wait(500);
  const cleanup = await page.evaluate(() => ({
    streams: window.__e2e.streams.length,
    tracks: window.__e2e.streams.flatMap((s) => s.getTracks().map((t) => t.readyState)),
    pcs: window.__e2e.pcs.map((pc) => ({ connection: pc.connectionState, signaling: pc.signalingState })),
    audioElements: document.querySelectorAll('audio').length,
  }));
  const metricsBefore = await readMetric(page, 'elapsed');
  await wait(2500);
  const metricsAfter = await readMetric(page, 'elapsed');
  cleanup.statsStoppedAfterClose = metricsBefore === metricsAfter;
  results.scenarios.cleanup = cleanup;
  check('cleanup: todas as tracks em "ended"', cleanup.tracks.length > 0 && cleanup.tracks.every((s) => s === 'ended'), cleanup.tracks);
  check('cleanup: 2 peer connections fechadas', cleanup.pcs.length === 2 && cleanup.pcs.every((p) => p.signaling === 'closed'), cleanup.pcs);
  check('cleanup: elemento <audio> removido', cleanup.audioElements === 0);
  check('cleanup: coleta de getStats interrompida', cleanup.statsStoppedAfterClose);

  // Reinício após encerrar (recursos novos, sem vazamento de estado).
  await page.click('[data-testid="btn-start"]');
  await page.waitForSelector('[data-testid="phase"][data-phase="connected"]', { timeout: 15000 });
  check('reinício após encerrar conecta novamente', true);
  await page.click('[data-testid="btn-stop"]');
  await page.waitForSelector('[data-testid="phase"][data-phase="closed"]', { timeout: 5000 });

  const logText = await page.textContent('[data-testid="log"]');
  check('nenhuma falha de addIceCandidate', !/addIceCandidate falhou/.test(logText ?? ''));
  results.scenarios.candidateQueue = [...(logText ?? '').matchAll(/(\w): descrição remota aplicada; (\d+) candidato/g)].map(
    (m) => `${m[1]}:${m[2]}`,
  );
  const leakPatterns =[/a=candidate/i, /a=fingerprint/i, /ice-ufrag/i, /\bv=0\b/, /\b\d{1,3}(\.\d{1,3}){3}\b/, /\.local\b/];
  const leaks = leakPatterns.filter((re) => re.test(logText ?? '') || consoleMessages.some((m) => re.test(m)));
  check('log/console sem SDP, candidatos ou IPs', leaks.length === 0, leaks.map(String));
  const cspViolations = consoleMessages.filter((m) => /Content Security Policy/i.test(m));
  check('sem violações de CSP no console', cspViolations.length === 0, cspViolations);
  results.consoleMessageCount = consoleMessages.length;

  await browser.close();
}

async function permissionDenied(server) {
  // Sem --use-fake-ui-for-media-stream e sem conceder permissão: o Chromium nega.
  const browser = await chromium.launch({ channel, headless, args: ['--use-fake-device-for-media-stream'] });
  const context = await browser.newContext({ permissions: [] });
  const page = await context.newPage();
  await page.goto(server);
  await page.click('[data-testid="btn-start"]');
  await page.waitForSelector('[data-testid="phase"][data-phase="failed"]', { timeout: 10000 });
  const code = await page.$eval('[data-testid="error"]', (el) => el.dataset.code);
  const message = await page.textContent('[data-testid="error"]');
  results.scenarios.permissionDenied = { code, message };
  check('permissão negada é tratada', code === 'permission-denied', code);
  check('botão Iniciar reabilitado após falha', await page.isEnabled('[data-testid="btn-start"]'));
  await browser.close();
}

const server = await createServer({ root, logLevel: 'error', server: { host: 'localhost', port: 5173, strictPort: true } });
await server.listen();
const url = 'http://localhost:5173/';
let exitCode = 0;
try {
  await happyPath(url);
  await permissionDenied(url);
} catch (error) {
  results.fatal = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  exitCode = 1;
} finally {
  await server.close();
}

results.passed = results.checks.filter((c) => c.ok).length;
results.failed = results.checks.filter((c) => !c.ok).length;
if (results.failed > 0) exitCode = 1;
console.log(JSON.stringify(results, null, 2));
process.exit(exitCode);
