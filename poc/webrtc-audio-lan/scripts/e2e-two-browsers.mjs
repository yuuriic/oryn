// Teste funcional com DOIS navegadores reais em processos separados (Chrome = A, Edge = B),
// cada um com microfone FALSO do Chromium (tom sintético), sinalização pelo servidor real e
// WebRTC real entre eles. Roda no próprio PC via http://localhost (contexto seguro).
//
// Não substitui o teste manual PC ↔ celular por HTTPS na LAN: aqui não há celular, Wi-Fi,
// certificado no dispositivo nem microfone/alto-falante reais.
//
// Uso: pnpm build && pnpm e2e [--headed]

import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { startServer } from '../server/server.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const headless = !process.argv.includes('--headed');
const THRESHOLD = 0.001;
const results = { startedAt: new Date().toISOString(), checks: [], observed: {} };
const check = (name, ok, detail) => results.checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const serverLogs = [];

// Instrumentação exclusiva do teste: guarda streams e peer connections para verificar o cleanup.
function instrument() {
  window.__e2e = { streams: [], pcs: [] };
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => {
    const s = await gum(c);
    window.__e2e.streams.push(s);
    return s;
  };
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Native {
    constructor(...a) {
      super(...a);
      window.__e2e.pcs.push(this);
    }
  };
}

async function openParticipant(channel, url, label) {
  const browser = await chromium.launch({
    channel,
    headless,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext();
  await context.addInitScript(instrument);
  const page = await context.newPage();
  const consoleMessages = [];
  page.on('console', (m) => consoleMessages.push(m.text()));
  page.on('pageerror', (e) => consoleMessages.push(`pageerror: ${e.message}`));
  await page.goto(url);
  return { browser, page, consoleMessages, label, version: browser.version() };
}

const phaseOf = (p) => p.page.$eval('[data-testid="phase"]', (el) => el.dataset.phase);
const waitPhase = (p, phase, timeout = 15000) => p.page.waitForSelector(`[data-testid="phase"][data-phase="${phase}"]`, { timeout });
const text = (p, sel) => p.page.textContent(sel).then((t) => (t ?? '').trim());
const raw = (p, key) =>
  p.page.$eval(`[data-metric="${key}"]`, (el) => (el.dataset.raw === '' || el.dataset.raw === undefined ? null : Number(el.dataset.raw)));

async function remoteRmsMax(p, ms) {
  let max = 0;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    max = Math.max(max, await p.page.$eval('[data-testid="meter-remote"]', (el) => Number(el.dataset.raw ?? 0)));
    await wait(100);
  }
  return max;
}

async function snapshot(p) {
  return {
    codec: await text(p, '[data-testid="codec"]'),
    packetsSent: await raw(p, 'packetsSent'),
    packetsReceived: await raw(p, 'packetsReceived'),
    sendKbps: await raw(p, 'sendKbps'),
    recvKbps: await raw(p, 'recvKbps'),
    rttMs: await raw(p, 'rtt'),
    rttText: await text(p, '[data-metric="rtt"]'),
    jitterMs: await raw(p, 'jitter'),
    lossPct: await raw(p, 'loss'),
    remoteLossPct: await raw(p, 'remoteLoss'),
    pair: await text(p, '[data-testid="pair"]'),
    signaling: await text(p, '[data-testid="signaling"]'),
    mic: await text(p, '[data-testid="mic"]'),
  };
}

const cleanupState = (p) =>
  p.page.evaluate(() => ({
    tracks: window.__e2e.streams.flatMap((s) => s.getTracks().map((t) => t.readyState)),
    pcs: window.__e2e.pcs.map((pc) => pc.signalingState),
    audioElements: document.querySelectorAll('audio').length,
  }));

const server = await startServer({ distDir: join(root, 'dist'), httpPort: 0, log: (l) => serverLogs.push(l) });
const base = server.httpOrigin.replace('127.0.0.1', 'localhost');
const opened = [];
let exitCode = 0;

try {
  const A = await openParticipant('chrome', base, 'A (Chrome)');
  const B = await openParticipant('msedge', base, 'B (Edge)');
  opened.push(A, B);
  results.observed.browsers = { A: A.version, B: B.version };

  // A cria a sessão; B entra pelo link com o código no fragmento.
  await A.page.click('[data-testid="btn-create"]');
  await waitPhase(A, 'waiting-peer');
  const sessionId = (await text(A, '[data-testid="session-code"]')).replace('Sessão: ', '');
  check('A criou sessão com ID de 22 caracteres', /^[A-Za-z0-9_-]{22}$/.test(sessionId));
  await B.page.goto(`${base}/#s=${sessionId}`);
  check('link de convite preenche o código e limpa o fragmento', (await B.page.inputValue('[data-testid="inp-session"]')) === sessionId && !B.page.url().includes('#'));
  const t0 = Date.now();
  await B.page.click('[data-testid="btn-join"]');
  await Promise.all([waitPhase(A, 'connected'), waitPhase(B, 'connected')]);
  results.observed.connectMs = Date.now() - t0;
  check('A e B conectados (connectionState connected)', (await text(A, '[data-testid="pc-connection"]')) === 'connected' && (await text(B, '[data-testid="pc-connection"]')) === 'connected');

  await wait(5000);
  const a = await snapshot(A);
  const b = await snapshot(B);
  results.observed.A = a;
  results.observed.B = b;
  check('codec Opus nos dois lados', /audio\/opus/.test(a.codec) && /audio\/opus/.test(b.codec), { A: a.codec, B: b.codec });
  check('A envia e recebe pacotes', a.packetsSent > 0 && a.packetsReceived > 0, { sent: a.packetsSent, received: a.packetsReceived });
  check('B envia e recebe pacotes', b.packetsSent > 0 && b.packetsReceived > 0, { sent: b.packetsSent, received: b.packetsReceived });
  check('par ICE identificado sem endereços', /host|srflx|prflx|relay/.test(a.pair) && !/\d+\.\d+\.\d+\.\d+/.test(a.pair + b.pair), { A: a.pair, B: b.pair });

  const rmsA = await remoteRmsMax(A, 2500);
  const rmsB = await remoteRmsMax(B, 2500);
  results.observed.rmsBothOn = { AhearsB: rmsA, BhearsA: rmsB };
  check('áudio B → A (RMS recebido por A > limiar)', rmsA > THRESHOLD, rmsA);
  check('áudio A → B (RMS recebido por B > limiar)', rmsB > THRESHOLD, rmsB);

  // Mute independente.
  await A.page.click('[data-testid="btn-mute"]');
  await wait(1500);
  const muteA = { BhearsA: await remoteRmsMax(B, 2500), AhearsB: await remoteRmsMax(A, 2500), connA: await text(A, '[data-testid="pc-connection"]') };
  results.observed.muteA = muteA;
  check('A mutado: B não recebe sinal de A', muteA.BhearsA <= THRESHOLD, muteA.BhearsA);
  check('A mutado: A continua recebendo B', muteA.AhearsB > THRESHOLD, muteA.AhearsB);
  check('A mutado: conexão mantida', muteA.connA === 'connected');
  await A.page.click('[data-testid="btn-mute"]');
  await B.page.click('[data-testid="btn-mute"]');
  await wait(1500);
  const muteB = { AhearsB: await remoteRmsMax(A, 2500), BhearsA: await remoteRmsMax(B, 2500) };
  results.observed.muteB = muteB;
  check('B mutado (A reativado): A não recebe sinal de B', muteB.AhearsB <= THRESHOLD, muteB.AhearsB);
  check('B mutado (A reativado): B volta a receber A', muteB.BhearsA > THRESHOLD, muteB.BhearsA);
  await B.page.click('[data-testid="btn-mute"]');

  // Saída de áudio ligada em A.
  await A.page.check('[data-testid="chk-listen"]');
  await wait(500);
  const playback = await text(A, '[data-testid="playback"]');
  results.observed.playbackA = playback;
  check('A: reprodução ligada ("tocando (volume …)")', /^tocando \(volume/.test(playback), playback);

  // Terceiro participante é recusado.
  const C = await openParticipant('chrome', `${base}/#s=${sessionId}`, 'C (Chrome)');
  opened.push(C);
  await C.page.click('[data-testid="btn-join"]');
  await waitPhase(C, 'failed');
  const cError = await text(C, '[data-testid="error"]');
  check('terceiro participante recusado (sessão cheia)', /dois participantes/.test(cError), cError);
  check('terceiro participante: microfone liberado', (await cleanupState(C)).tracks.every((t) => t === 'ended'));
  check('A e B seguem conectados após a recusa', (await phaseOf(A)) === 'connected' && (await phaseOf(B)) === 'connected');

  // A encerra: libera tudo; B perde o par e volta a aguardar.
  await A.page.click('[data-testid="btn-end"]');
  await waitPhase(A, 'ended');
  await waitPhase(B, 'waiting-peer');
  await wait(500);
  const cleanA = await cleanupState(A);
  const cleanB = await cleanupState(B);
  results.observed.cleanupAfterAEnds = { A: cleanA, B: cleanB };
  check('A encerrou: tracks ended, peer closed, <audio> removido', cleanA.tracks.every((t) => t === 'ended') && cleanA.pcs.every((s) => s === 'closed') && cleanA.audioElements === 0, cleanA);
  check('B perdeu o par: peer closed, microfone ainda ativo', cleanB.pcs.every((s) => s === 'closed') && cleanB.tracks.every((t) => t === 'live'), cleanB);
  check('A: métricas exibem "indisponível" após encerrar', (await text(A, '[data-testid="packets-sent"]')) === 'indisponível');

  // A volta à mesma sessão (vira host do novo par) e o áudio retoma nos dois sentidos.
  await A.page.fill('[data-testid="inp-session"]', sessionId);
  await A.page.click('[data-testid="btn-join"]');
  await Promise.all([waitPhase(A, 'connected'), waitPhase(B, 'connected')]);
  await wait(2000);
  const rejoin = { AhearsB: await remoteRmsMax(A, 2000), BhearsA: await remoteRmsMax(B, 2000) };
  results.observed.rejoin = rejoin;
  check('reentrada na mesma sessão: áudio nos dois sentidos de novo', rejoin.AhearsB > THRESHOLD && rejoin.BhearsA > THRESHOLD, rejoin);

  // Fim: ambos encerram; o servidor fica sem sessões.
  await B.page.click('[data-testid="btn-end"]');
  await waitPhase(B, 'ended');
  await A.page.click('[data-testid="btn-end"]');
  await waitPhase(A, 'ended');
  await wait(300);
  const finalA = await cleanupState(A);
  const finalB = await cleanupState(B);
  check('final: todas as tracks ended e peers closed (A e B)', [...finalA.tracks, ...finalB.tracks].every((t) => t === 'ended') && [...finalA.pcs, ...finalB.pcs].every((s) => s === 'closed'), { A: finalA, B: finalB });
  check('servidor sem sessões ativas', server.registry.sessionCount === 0, server.registry.sessionCount);

  // Privacidade e CSP.
  const pageLogs = [await text(A, '[data-testid="log"]'), await text(B, '[data-testid="log"]')].join('\n');
  const consoles = [...A.consoleMessages, ...B.consoleMessages, ...C.consoleMessages].join('\n');
  const leaks = [/a=candidate/i, /a=fingerprint/i, /ice-ufrag/i, /\bv=0\b/, /\b\d{1,3}(\.\d{1,3}){3}\b/, /\.local\b/].filter(
    (re) => re.test(pageLogs) || re.test(consoles) || re.test(serverLogs.join('\n')),
  );
  check('logs (páginas, console, servidor) sem SDP, candidatos ou IPs', leaks.length === 0, leaks.map(String));
  check('logs do servidor sem o ID completo da sessão', !serverLogs.join('\n').includes(sessionId));
  const csp = consoles.split('\n').filter((m) => /Content Security Policy/i.test(m));
  check('sem violações de CSP', csp.length === 0, csp);
  results.observed.serverLogLines = serverLogs.length;
} catch (error) {
  results.fatal = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  exitCode = 1;
} finally {
  for (const p of opened) await p.browser.close().catch(() => undefined);
  await server.close();
}

results.passed = results.checks.filter((c) => c.ok).length;
results.failed = results.checks.filter((c) => !c.ok).length;
if (results.failed > 0) exitCode = 1;
console.log(JSON.stringify(results, null, 2));
process.exit(exitCode);
