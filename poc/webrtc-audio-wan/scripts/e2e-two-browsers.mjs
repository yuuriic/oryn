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
import { createServer } from 'node:http';
import { join } from 'node:path';
import { formatPairingCode } from '../server/admin-auth.ts';
import { startServer } from '../server/server.ts';
import { SimulatedTurnProvider } from '../server/turn.ts';

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

// Dois listeners (02B.2C): sinalização (convidados) e administrativo (operador), portas distintas.
const server = await startServer({ distDir: join(root, 'dist'), httpPort: 0, adminPort: 0, log: (l) => serverLogs.push(l) });
const base = server.httpOrigin.replace('127.0.0.1', 'localhost');
const adminBase = server.adminOrigin.replace('127.0.0.1', 'localhost');
const opened = [];
let exitCode = 0;

try {
  // A = operador (endereço administrativo); B = convidado (endereço de sinalização).
  const A = await openParticipant('chrome', adminBase, 'A (Chrome, operador)');
  const B = await openParticipant('msedge', base, 'B (Edge, convidado)');
  opened.push(A, B);
  results.observed.browsers = { A: A.version, B: B.version };
  check('sem pareamento, "Criar sessão" fica desabilitado (A e B)', !(await A.page.isEnabled('[data-testid="btn-create"]')) && !(await B.page.isEnabled('[data-testid="btn-create"]')));

  // Código de pareamento como o terminal exibiria (só o código; o token nunca sai do servidor por aqui).
  const { code } = server.adminAuth.issuePairingCode();

  // Separação: o mesmo código digitado no endereço de sinalização não autoriza nada nem é consumido.
  await B.page.fill('[data-testid="inp-pair"]', formatPairingCode(code));
  await B.page.click('[data-testid="btn-pair"]');
  await B.page.waitForSelector('[data-testid="error"]:not([hidden])');
  check('pareamento pelo endereço de sinalização recusado ("não é o administrativo")', /não é o administrativo/.test(await text(B, '[data-testid="error"]')));
  check('após a recusa, B continua sem "Criar sessão" e o código segue válido', !(await B.page.isEnabled('[data-testid="btn-create"]')) && server.adminAuth.pairingPending);

  // CSRF: página maliciosa em OUTRA origem local (outra porta, sem a CSP da POC), aberta no navegador de B.
  const evil = createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>evil</title>'));
  await new Promise((r) => evil.listen(0, '127.0.0.1', r));
  const evilPage = await B.page.context().newPage();
  await evilPage.goto(`http://localhost:${evil.address().port}/`);
  const csrf = await evilPage.evaluate(async ({ url, code }) => {
    const out = {};
    try {
      await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Oryn-Admin': '1' }, body: JSON.stringify({ code }) });
      out.preflight = 'resolvido';
    } catch (e) {
      out.preflight = e.name;
    }
    try {
      const simple = await fetch(url, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ code }) });
      out.simple = simple.type;
    } catch (e) {
      out.simple = e.name;
    }
    return out;
  }, { url: `${adminBase}/admin/pair`, code });
  await evilPage.close();
  evil.close();
  check('CSRF: fetch com cabeçalhos do pareamento de outra origem falha (TypeError)', csrf.preflight === 'TypeError', csrf);
  check('CSRF: POST simples (no-cors) é opaco e não consome o código', csrf.simple === 'opaque' && server.adminAuth.pairingPending, csrf);

  // Pareamento legítimo no endereço administrativo (código digitado em minúsculas, com hífen).
  await A.page.fill('[data-testid="inp-pair"]', formatPairingCode(code).toLowerCase());
  const [pairResponse] = await Promise.all([
    A.page.waitForResponse((r) => r.url().endsWith('/admin/pair')),
    A.page.click('[data-testid="btn-pair"]'),
  ]);
  const operatorToken = (await pairResponse.json()).token;
  await A.page.waitForSelector('[data-testid="btn-create"]:enabled');
  check('operador pareado: "Criar sessão" habilitado, formulário oculto e campo limpo',
    (await A.page.isHidden('[data-testid="pairing"]')) && (await A.page.inputValue('[data-testid="inp-pair"]')) === '');
  const stored = await A.page.evaluate(() => JSON.stringify({ url: location.href, local: { ...localStorage }, session: { ...sessionStorage }, history: history.length }));
  check('token administrativo fora da URL e do armazenamento do navegador', /^[A-Za-z0-9_-]{43}$/.test(operatorToken) && !stored.includes(operatorToken), stored);
  check('código de pareamento consumido (uso único)', !server.adminAuth.pairingPending);

  // A cria a sessão e recebe um convite de uso único; B entra pelo link #i=.
  await A.page.click('[data-testid="btn-create"]');
  await waitPhase(A, 'waiting-peer');
  const sessionId = (await text(A, '[data-testid="session-code"]')).replace('Sessão: ', '');
  check('A criou sessão com ID de 22 caracteres', /^[A-Za-z0-9_-]{22}$/.test(sessionId));
  const invite = await text(A, '[data-testid="invite-token"]');
  check('convite de 43 caracteres; sem hostname público, sem link nem QR', /^[A-Za-z0-9_-]{43}$/.test(invite) && (await A.page.isHidden('[data-testid="invite-link"]')));
  await B.page.goto(`${base}/#i=${invite}`);
  check('link de convite preenche o campo e limpa o fragmento', (await B.page.inputValue('[data-testid="inp-session"]')) === invite && !B.page.url().includes('#'));
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

  // Terceiro participante reutiliza o convite: recusado (uso único).
  const C = await openParticipant('chrome', `${base}/#i=${invite}`, 'C (Chrome)');
  opened.push(C);
  await C.page.click('[data-testid="btn-join"]');
  await waitPhase(C, 'failed');
  const cError = await text(C, '[data-testid="error"]');
  check('terceiro participante recusado (convite de uso único já usado)', /Convite inválido/.test(cError), cError);
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

  // Reentrada do operador: "Voltar à sessão" (chave em memória + ID da sessão).
  check('"Voltar à sessão" disponível ao operador após encerrar', await A.page.isVisible('[data-testid="btn-rejoin"]'));
  await A.page.click('[data-testid="btn-rejoin"]');
  await Promise.all([waitPhase(A, 'connected'), waitPhase(B, 'connected')]);
  await wait(2000);
  const rejoin = { AhearsB: await remoteRmsMax(A, 2000), BhearsA: await remoteRmsMax(B, 2000) };
  results.observed.rejoin = rejoin;
  check('reentrada do operador: áudio nos dois sentidos de novo', rejoin.AhearsB > THRESHOLD && rejoin.BhearsA > THRESHOLD, rejoin);

  // Reentrada do convidado: B sai; o operador emite um NOVO convite; B volta com ele.
  await B.page.click('[data-testid="btn-end"]');
  await waitPhase(B, 'ended');
  await waitPhase(A, 'waiting-peer');
  await A.page.click('[data-testid="btn-invite"]');
  await A.page.waitForFunction((old) => {
    const t = document.querySelector('[data-testid="invite-token"]')?.textContent ?? '';
    return t.length === 43 && t !== old;
  }, invite);
  const invite2 = await text(A, '[data-testid="invite-token"]');
  check('novo convite emitido e diferente do anterior', /^[A-Za-z0-9_-]{43}$/.test(invite2) && invite2 !== invite);
  await B.page.goto(`${base}/#i=${invite2}`);
  await B.page.click('[data-testid="btn-join"]');
  await Promise.all([waitPhase(A, 'connected'), waitPhase(B, 'connected')]);
  await wait(1500);
  const guestBack = { AhearsB: await remoteRmsMax(A, 2000), BhearsA: await remoteRmsMax(B, 2000) };
  results.observed.guestRejoin = guestBack;
  check('reentrada do convidado com novo convite: áudio nos dois sentidos', guestBack.AhearsB > THRESHOLD && guestBack.BhearsA > THRESHOLD, guestBack);

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
  check('nenhum convite pendente no servidor', server.admission.activeInvites === 0, server.admission.activeInvites);

  // Privacidade e CSP.
  const pageLogs = [await text(A, '[data-testid="log"]'), await text(B, '[data-testid="log"]'), await text(C, '[data-testid="log"]')].join('\n');
  const consoles = [...A.consoleMessages, ...B.consoleMessages, ...C.consoleMessages].join('\n');
  const leaks = [/a=candidate/i, /a=fingerprint/i, /ice-ufrag/i, /\bv=0\b/, /\b\d{1,3}(\.\d{1,3}){3}\b/, /\.local\b/].filter(
    (re) => re.test(pageLogs) || re.test(consoles) || re.test(serverLogs.join('\n')),
  );
  check('logs (páginas, console, servidor) sem SDP, candidatos ou IPs', leaks.length === 0, leaks.map(String));
  check('logs do servidor sem o ID completo da sessão', !serverLogs.join('\n').includes(sessionId));
  const everything = [pageLogs, consoles, serverLogs.join('\n')].join('\n');
  check('token administrativo, código de pareamento e convites ausentes de logs, console e servidor', ![operatorToken, code, formatPairingCode(code), invite, invite2].some((sec) => everything.includes(sec)));
  const csp = consoles.split('\n').filter((m) => /Content Security Policy/i.test(m));
  check('sem violações de CSP', csp.length === 0, csp);
  results.observed.serverLogLines = serverLogs.length;

  // ---------- Modos ICE (02B.4), testáveis localmente ----------
  // Não há servidor TURN real: relay/relay-tls NÃO são comprovados aqui. Verifica-se a falha fechada e a
  // ausência de fallback, e que "TURN configurado" não é confundido com caminho relay.
  const pcCount = (p) => p.page.evaluate(() => window.__e2e.pcs.length);
  const iceInfo = (p) => text(p, '[data-testid="ice-info"]');
  const pathOf = (p) => text(p, '[data-testid="media-path"]');
  const startHosting = async (p, mode) => {
    const previous = await text(p, '[data-testid="invite-token"]');
    await p.page.selectOption('[data-testid="ice-mode"]', mode);
    await p.page.click('[data-testid="btn-create"]');
    await waitPhase(p, 'waiting-peer');
    // Espera o convite NOVO (o anterior, já usado, pode continuar na tela por um instante).
    await p.page.waitForFunction((old) => {
      const t = document.querySelector('[data-testid="invite-token"]')?.textContent?.trim() ?? '';
      return t.length === 43 && t !== old;
    }, previous);
    return text(p, '[data-testid="invite-token"]');
  };
  const joinWith = async (p, origin, inviteToken, mode) => {
    // Página nova a cada cenário: só trocar o fragmento (#i=) NÃO recarrega a página e manteria o log e
    // o estado da chamada anterior.
    await p.page.goto('about:blank');
    await p.page.goto(`${origin}/#i=${inviteToken}`);
    await p.page.selectOption('[data-testid="ice-mode"]', mode);
    await p.page.click('[data-testid="btn-join"]');
  };
  const endBoth = async (...ps) => {
    for (const p of ps) {
      if (await p.page.isEnabled('[data-testid="btn-end"]')) {
        await p.page.click('[data-testid="btn-end"]');
        await waitPhase(p, 'ended');
      }
    }
  };

  // 1) relay-tls sem TURN no servidor (servidor principal, sem provedor): falha fechada, sem RTCPeerConnection.
  const inviteTls = await startHosting(A, 'auto');
  await joinWith(B, base, inviteTls, 'relay-tls');
  await waitPhase(B, 'failed');
  check('relay-tls sem TURN no servidor: falha fechada com mensagem clara', /TURN indisponível/.test(await text(B, '[data-testid="error"]')));
  check('relay-tls sem TURN: nenhuma RTCPeerConnection criada nesta página (sem fallback)', (await pcCount(B)) === 0, await pcCount(B));
  await endBoth(A);

  // Servidor 2: provedor TURN SIMULADO anunciando um TURN inalcançável (porta local fechada).
  const probe = createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const deadPort = probe.address().port;
  await new Promise((r) => probe.close(r));
  const turnLogs = [];
  const sim = new SimulatedTurnProvider({ turnUrls: [`turn:127.0.0.1:${deadPort}?transport=udp`, `turns:127.0.0.1:${deadPort}?transport=tcp`] });
  const server2 = await startServer({ distDir: join(root, 'dist'), httpPort: 0, adminPort: 0, ice: { provider: sim }, log: (l) => turnLogs.push(l) });
  try {
    const base2 = server2.httpOrigin.replace('127.0.0.1', 'localhost');
    const admin2 = server2.adminOrigin.replace('127.0.0.1', 'localhost');
    await A.page.goto(admin2);
    const code2 = server2.adminAuth.issuePairingCode().code;
    await A.page.fill('[data-testid="inp-pair"]', code2);
    await A.page.click('[data-testid="btn-pair"]');
    await A.page.waitForSelector('[data-testid="btn-create"]:enabled');

    // 2) A em auto (TURN configurado) + B em direct: conectam pelo par direto; o caminho é "direto", não relay.
    const inviteAuto = await startHosting(A, 'auto');
    await joinWith(B, base2, inviteAuto, 'direct');
    await Promise.all([waitPhase(A, 'connected'), waitPhase(B, 'connected')]);
    await wait(2500);
    const autoInfo = await iceInfo(A);
    const directInfo = await iceInfo(B);
    results.observed.iceAutoDirect = { A: { info: autoInfo, path: await pathOf(A), pair: await text(A, '[data-testid="pair"]') }, B: { info: directInfo, path: await pathOf(B) } };
    check('auto: TURN configurado é exibido como configuração, não como uso', /^auto · STUN 0 · TURN 2 \(tls, udp\) · TURN configurado \(não implica uso\)$/.test(autoInfo), autoInfo);
    check('direct: somente STUN (nenhum TURN)', /^direct · STUN 0 · TURN 0$/.test(directInfo), directInfo);
    check('caminho comprovado pelo par selecionado: direto nos dois lados (TURN inalcançável não é inferido)', /^direto/.test(await pathOf(A)) && /^direto/.test(await pathOf(B)) && !/relay/.test(await text(A, '[data-testid="pair"]')), results.observed.iceAutoDirect);
    await endBoth(B, A);

    // 3) relay com TURN inalcançável: não conecta e não cai para candidatos diretos.
    // Os dois lados têm o mesmo prazo de negociação (20 s): o primeiro a vencer falha e o outro volta a
    // aguardar. O que importa é que NENHUM conecta e que B nunca usa candidatos diretos.
    const inviteRelay = await startHosting(A, 'auto');
    const relayStart = Date.now();
    await joinWith(B, base2, inviteRelay, 'relay');
    await Promise.race([waitPhase(A, 'failed', 40_000), waitPhase(B, 'failed', 40_000)]);
    await wait(300);
    const relayLog = await text(B, '[data-testid="log"]');
    const relayPolicy = await B.page.evaluate(() => window.__e2e.pcs.map((pc) => pc.getConfiguration().iceTransportPolicy));
    results.observed.iceRelay = {
      endedAfterMs: Date.now() - relayStart,
      phases: { A: await phaseOf(A), B: await phaseOf(B) },
      errorA: await text(A, '[data-testid="error"]'),
      errorB: await text(B, '[data-testid="error"]'),
      policy: relayPolicy,
    };
    check('relay com TURN inalcançável: nenhum lado conecta; a tentativa termina por prazo', !/connectionState = connected/.test(relayLog) && /negociação esgotado/.test(results.observed.iceRelay.errorA + results.observed.iceRelay.errorB), results.observed.iceRelay);
    check('relay: única RTCPeerConnection de B com iceTransportPolicy "relay"', relayPolicy.length === 1 && relayPolicy[0] === 'relay', relayPolicy);
    check('relay: nenhum candidato local host/srflx e nenhum par selecionado em B (sem fallback)', !/Candidato local: (host|srflx|prflx)/.test(relayLog) && !/Par ICE selecionado/.test(relayLog));
    await endBoth(B, A);

    // Segredos do modo ICE: credenciais simuladas nunca nas páginas, consoles ou logs do servidor.
    const iceText = [await text(A, '[data-testid="log"]'), relayLog, ...A.consoleMessages, ...B.consoleMessages, turnLogs.join('\n')].join('\n');
    check('credenciais TURN (usernames) ausentes de páginas, consoles e logs', sim.issued.length > 0 && !sim.issued.some((u) => iceText.includes(u)), { emitidas: sim.issued.length });
    check('credenciais TURN revogadas ao fim das conexões', sim.revoked.length >= 1, { emitidas: sim.issued.length, revogadas: sim.revoked.length });
  } finally {
    await server2.close();
  }
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
