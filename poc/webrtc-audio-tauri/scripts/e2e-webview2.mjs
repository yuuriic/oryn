// Teste funcional automatizado da POC-01B dentro do WebView2 do aplicativo Tauri compilado.
//
// Como funciona:
// - Inicia o .exe de release com WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS contendo uma porta de
//   depuração remota (CDP) e, no cenário principal, o dispositivo de mídia FALSO do Chromium.
//   Essas flags existem apenas durante o teste; o aplicativo não as configura.
// - Conecta o Playwright ao WebView2 via CDP e exercita a interface real.
// - Minimiza, restaura e fecha a janela via Win32 (PowerShell), de fora do aplicativo.
//
// O microfone falso valida o pipeline WebRTC no WebView2, mas NÃO substitui o teste manual com
// microfone real, diálogo de permissão real, saída de áudio e percepção humana.
//
// Uso: pnpm e2e:webview2 [--exe=caminho] [--skip-prompt]
// Saída: JSON com resultados agregados (sem SDP, candidatos ou endereços).

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runPowerShell, toHandle } from './powershell.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const exe = arg('exe', `${root}src-tauri/target/release/oryn-poc-webrtc-audio-tauri.exe`);
const skipPrompt = process.argv.includes('--skip-prompt');
const scratch = arg('artifacts', null); // diretório opcional para capturas de tela (fora do repositório)

const AUDIO_THRESHOLD = 0.001;
const results = { exe: exe.replace(root, ''), startedAt: new Date().toISOString(), checks: [], scenarios: {} };
const check = (name, ok, detail) => results.checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Win32 via PowerShell ----------
// Valores variáveis vão por $env:ORYN_PS_* (ver scripts/powershell.mjs); o texto dos scripts é fixo.

const WIN32 = `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c); [DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h); [DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(System.IntPtr h, System.Text.StringBuilder s, int n);';`;

// Atenção: Process.MainWindowHandle muda para a janela oculta "Tao Thread Event Target" depois que a
// janela é minimizada. Por isso o handle da "Tauri Window" é capturado uma vez, na abertura, e reutilizado.
function appWindow(pid) {
  const out = runPowerShell(
    `${WIN32} $h=(Get-Process -Id ([int]$env:ORYN_PS_PID)).MainWindowHandle; $c=New-Object Text.StringBuilder 64; [W.U]::GetClassName($h,$c,64) | Out-Null; "$h|$c"`,
    { PID: toHandle(pid) },
  );
  const [hwnd, cls] = out.split('|');
  if (cls !== 'Tauri Window') throw new Error(`Janela principal inesperada: classe "${cls}"`);
  return toHandle(hwnd);
}

function showWindow(hwnd, cmd) {
  // 6 = SW_MINIMIZE, 9 = SW_RESTORE
  return runPowerShell(
    `${WIN32} $h=[IntPtr][long]$env:ORYN_PS_HWND; [W.U]::ShowWindow($h, [int]$env:ORYN_PS_CMD) | Out-Null; [W.U]::IsIconic($h)`,
    { HWND: toHandle(hwnd), CMD: toHandle(cmd) },
  );
}

function closeWindow(hwnd) {
  // WM_CLOSE (0x10), equivalente ao botão X da janela.
  runPowerShell(
    `${WIN32} [W.U]::PostMessage([IntPtr][long]$env:ORYN_PS_HWND, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null`,
    { HWND: toHandle(hwnd) },
  );
}

function webviewProcessCount() {
  // Processos msedgewebview2 que usam a pasta de dados deste aplicativo.
  return Number(
    runPowerShell(
      `@(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like '*dev.oryn.poc.webrtcaudio*' }).Count`,
    ),
  );
}

// Captura apenas o retângulo da janela do aplicativo (inclui diálogos sobrepostos a ela),
// nunca a área de trabalho inteira. O caminho de destino é passado como dado ($env:ORYN_PS_FILE).
function screenshot(file, hwnd) {
  runPowerShell(
    `Add-Type -AssemblyName System.Drawing; Add-Type -Namespace W -Name R -MemberDefinition '[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; } [DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr h, out RECT r);'; $r=New-Object W.R+RECT; [W.R]::GetWindowRect([IntPtr][long]$env:ORYN_PS_HWND, [ref]$r) | Out-Null; $w=$r.R-$r.L; $h=$r.B-$r.T; $bmp=New-Object System.Drawing.Bitmap $w,$h; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($r.L,$r.T,0,0,$bmp.Size); $bmp.Save($env:ORYN_PS_FILE); $g.Dispose(); $bmp.Dispose()`,
    { HWND: toHandle(hwnd), FILE: file },
  );
}

// ---------- Aplicativo ----------

async function launchApp(port, extraArgs) {
  const child = spawn(exe, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: [`--remote-debugging-port=${port}`, ...extraArgs].join(' ') },
    stdio: 'ignore',
  });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  const deadline = Date.now() + 30000;
  let browser;
  while (!browser) {
    if (Date.now() > deadline) throw new Error('CDP do WebView2 não respondeu em 30 s');
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      await wait(500);
    }
  }
  let page;
  while (!page) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('http://tauri.localhost'));
    if (!page) {
      if (Date.now() > deadline) throw new Error('Página do aplicativo não encontrada via CDP');
      await wait(300);
    }
  }
  await page.waitForSelector('[data-testid="btn-start"]');
  return { child, exited, browser, page, hwnd: appWindow(child.pid) };
}

// Instrumentação exclusiva do teste (aplicada com reload): guarda streams e peer connections.
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

const readMetric = (page, key) =>
  page.$eval(`[data-metric="${key}"]`, (el) => (el.dataset.raw === '' || el.dataset.raw === undefined ? null : Number(el.dataset.raw)));
const text = (page, sel) => page.textContent(sel).then((t) => (t ?? '').trim());
const peerState = (page, peer, key) => text(page, `[data-peer="${peer}"][data-key="${key}"]`);

async function sampleMetricMax(page, key, ms) {
  let max = null;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await readMetric(page, key);
    if (v !== null) max = max === null ? v : Math.max(max, v);
    await wait(250);
  }
  return max;
}

async function mainScenario() {
  const app = await launchApp(9333, ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']);
  const { page } = app;
  const consoleMessages = [];
  page.on('console', (m) => consoleMessages.push(m.text()));
  page.on('pageerror', (e) => consoleMessages.push(`pageerror: ${e.message}`));
  await page.context().addInitScript(instrument);
  const documentResponse = await page.reload();
  await page.waitForSelector('[data-testid="btn-start"]');
  // CSP efetivamente entregue pelo Tauri (cabeçalho do documento servido por tauri.localhost).
  const cspHeader = (await documentResponse?.allHeaders())?.['content-security-policy'] ?? '';
  const mediaSrc = /media-src [^;]*/.exec(cspHeader)?.[0] ?? '(ausente)';
  results.scenarios.cspMediaSrc = mediaSrc;
  check("CSP entregue: media-src somente 'self'", mediaSrc === "media-src 'self'", mediaSrc);
  check("CSP entregue: script-src sem 'unsafe-inline'/'unsafe-eval'", /script-src 'self'/.test(cspHeader) && !/unsafe-(inline|eval)/.test(cspHeader), /script-src [^;]*/.exec(cspHeader)?.[0]);
  await wait(500);

  const env = {
    engine: await text(page, '[data-testid="env-engine"]'),
    origin: await text(page, '[data-env="origin"]'),
    secure: await text(page, '[data-env="secure"]'),
    opus: await text(page, '[data-testid="env-opus"]'),
    codecs: await text(page, '[data-env="codecs"]'),
    permissionBefore: await text(page, '[data-testid="env-permission"]'),
    userAgent: await page.evaluate(() => navigator.userAgent),
    brands: await page.evaluate(() => navigator.userAgentData?.brands?.map((b) => `${b.brand} ${b.version}`) ?? null),
    fullVersion: await page.evaluate(async () => {
      const d = await navigator.userAgentData?.getHighEntropyValues?.(['fullVersionList']);
      return d?.fullVersionList?.map((b) => `${b.brand} ${b.version}`) ?? null;
    }),
    pid: app.child.pid,
  };
  results.scenarios.env = env;
  check('motor identificado como WebView2', env.engine.startsWith('WebView2'), env.engine);
  check('origem do app é http://tauri.localhost', env.origin === 'http://tauri.localhost', env.origin);
  check('contexto seguro (getUserMedia permitido)', env.secure === 'true', env.secure);
  check('Opus anunciado em RTCRtpSender.getCapabilities', env.opus.startsWith('sim'), env.opus);

  const t0 = Date.now();
  await page.click('[data-testid="btn-start"]');
  await page.waitForSelector('[data-testid="phase"][data-phase="connected"]', { timeout: 15000 });
  results.scenarios.connectMs = Date.now() - t0;
  check('fase "connected" alcançada no WebView2', true);
  for (const peer of ['A', 'B']) {
    check(`connectionState ${peer} = connected`, (await peerState(page, peer, 'connection')) === 'connected');
  }

  await wait(5000);
  const active = {
    codec: await text(page, '[data-testid="codec"]'),
    fmtp: await text(page, '[data-testid="codec-fmtp"]'),
    packetsReceived: await readMetric(page, 'packets'),
    recvKbps: await readMetric(page, 'recvKbps'),
    remoteRmsPeakMax: await sampleMetricMax(page, 'remoteRmsPeak', 3000),
    audioLevelWithOutputMuted: await sampleMetricMax(page, 'audioLevel', 1500),
    audioContext: await text(page, '[data-testid="diag-audioctx"]'),
    playback: await text(page, '[data-testid="diag-playback"]'),
    permissionAfter: await text(page, '[data-testid="env-permission"]'),
  };
  results.scenarios.active = active;
  check('codec negociado é Opus', /audio\/opus/i.test(active.codec), `${active.codec} | ${active.fmtp}`);
  check('pacotes recebidos > 0', active.packetsReceived > 0, active.packetsReceived);
  check('pico RMS recebido > limiar', active.remoteRmsPeakMax > AUDIO_THRESHOLD, active.remoteRmsPeakMax);
  check('AudioContext "running" após o clique', active.audioContext === 'running', active.audioContext);
  check('autoplay do <audio> mudo permitido (play() resolvido)', active.playback.startsWith('tocando'), active.playback);

  // Mute
  const before = active.packetsReceived;
  await page.click('[data-testid="btn-mute"]');
  await wait(3500);
  const muted = {
    remoteRmsPeakMax: await sampleMetricMax(page, 'remoteRmsPeak', 2500),
    packetsReceived: await readMetric(page, 'packets'),
    connA: await peerState(page, 'A', 'connection'),
    connB: await peerState(page, 'B', 'connection'),
    track: await text(page, '[data-testid="diag-track"]'),
  };
  results.scenarios.muted = muted;
  check('mutado: pico RMS recebido = 0', muted.remoteRmsPeakMax !== null && muted.remoteRmsPeakMax <= AUDIO_THRESHOLD, muted.remoteRmsPeakMax);
  check('mutado: conexão mantida', muted.connA === 'connected' && muted.connB === 'connected');
  check('mutado: pacotes continuam chegando', muted.packetsReceived > before, { before, after: muted.packetsReceived });
  await page.click('[data-testid="btn-mute"]');
  await wait(3000);
  const unmutedPeak = await sampleMetricMax(page, 'remoteRmsPeak', 2500);
  check('reativado: pico RMS recebido volta', unmutedPeak > AUDIO_THRESHOLD, unmutedPeak);

  // Saída ligada
  await page.check('[data-testid="chk-listen"]');
  await wait(1000);
  const output = {
    audioLevelMax: await sampleMetricMax(page, 'audioLevel', 3000),
    playback: await text(page, '[data-testid="diag-playback"]'),
  };
  results.scenarios.outputOn = output;
  check('saída ligada: audioLevel (getStats) > limiar', output.audioLevelMax > AUDIO_THRESHOLD, output.audioLevelMax);

  // Minimização (saída ligada): observa visibilidade, timers e fluxo de áudio enquanto minimizado.
  const pid = app.child.pid;
  const hwnd = app.hwnd;
  const gapBefore = await text(page, '[data-testid="diag-maxgap"]');
  const pktBeforeMin = await readMetric(page, 'packets');
  const beforeMinimize = {
    visibility: await text(page, '[data-testid="diag-visibility"]'),
    focus: await text(page, '[data-diag="focus"]'),
  };
  const isIconic = showWindow(hwnd, 6);
  const minimized = { beforeMinimize, isIconic, samples: [] };
  const minStart = Date.now();
  while (Date.now() - minStart < 10000) {
    await wait(1000);
    minimized.samples.push({
      t: Math.round((Date.now() - minStart) / 1000),
      visibility: await text(page, '[data-testid="diag-visibility"]'),
      focus: await text(page, '[data-diag="focus"]'),
      audioCtx: await text(page, '[data-testid="diag-audioctx"]'),
      packets: await readMetric(page, 'packets'),
      rmsPeak: await readMetric(page, 'remoteRmsPeak'),
      gap: await readMetric(page, 'gap'),
    });
  }
  const pktAfterMin = await readMetric(page, 'packets');
  minimized.restoredIconic = showWindow(hwnd, 9);
  await wait(1500);
  minimized.gapMaxBefore = gapBefore;
  minimized.gapMaxAfter = await text(page, '[data-testid="diag-maxgap"]');
  minimized.packets = { before: pktBeforeMin, after: pktAfterMin };
  minimized.lifecycleLog = (await text(page, '[data-testid="log"]'))
    .split(/(?=\[\d{2}:\d{2}:\d{2}\])/)
    .filter((l) => /Ciclo de vida|AudioContext: state/.test(l))
    .map((l) => l.replace(/^\[[\d:]+\]\s*/, ''));
  minimized.connAfterRestore = await peerState(page, 'A', 'connection');
  results.scenarios.minimized = minimized;
  check('minimizar: janela ficou iconic', isIconic === 'True', isIconic);
  check('minimizado: pacotes continuam chegando', pktAfterMin - pktBeforeMin > 300, minimized.packets);
  check(
    'minimizado: áudio recebido continua (pico RMS > limiar em alguma amostra)',
    minimized.samples.some((s) => s.rmsPeak > AUDIO_THRESHOLD),
  );
  check('restaurar: janela deixou de ser iconic', minimized.restoredIconic === 'False', minimized.restoredIconic);
  check('restaurado: conexão mantida', minimized.connAfterRestore === 'connected', minimized.connAfterRestore);

  // Encerrar
  await page.click('[data-testid="btn-stop"]');
  await page.waitForSelector('[data-testid="phase"][data-phase="closed"]', { timeout: 5000 });
  await wait(500);
  const cleanup = await page.evaluate(() => ({
    tracks: window.__e2e.streams.flatMap((s) => s.getTracks().map((t) => t.readyState)),
    pcs: window.__e2e.pcs.map((pc) => pc.signalingState),
    audioElements: document.querySelectorAll('audio').length,
  }));
  results.scenarios.cleanup = cleanup;
  check('encerrar: tracks em "ended"', cleanup.tracks.length > 0 && cleanup.tracks.every((s) => s === 'ended'), cleanup.tracks);
  check('encerrar: peer connections fechadas', cleanup.pcs.length === 2 && cleanup.pcs.every((s) => s === 'closed'), cleanup.pcs);
  check('encerrar: <audio> removido', cleanup.audioElements === 0);

  await page.click('[data-testid="btn-summary"]');
  const summary = JSON.parse(await page.inputValue('[data-testid="summary"]'));
  delete summary.userAgent;
  results.scenarios.summary = summary;

  const logText = await text(page, '[data-testid="log"]');
  const leaks = [/a=candidate/i, /a=fingerprint/i, /ice-ufrag/i, /\bv=0\b/, /\b\d{1,3}(\.\d{1,3}){3}\b/, /\.local\b/].filter(
    (re) => re.test(logText) || consoleMessages.some((m) => re.test(m)),
  );
  check('log/console sem SDP, candidatos ou IPs', leaks.length === 0, leaks.map(String));
  const csp = consoleMessages.filter((m) => /Content Security Policy/i.test(m));
  check('sem violações de CSP', csp.length === 0, csp);
  results.scenarios.trackSettingsLog = logText.match(/Track local:[^[]*/)?.[0]?.trim() ?? null;

  // Reinicia e fecha a JANELA com a chamada ativa: o processo e o WebView2 devem terminar.
  await page.click('[data-testid="btn-start"]');
  await page.waitForSelector('[data-testid="phase"][data-phase="connected"]', { timeout: 15000 });
  const wvBefore = webviewProcessCount();
  await app.browser.close().catch(() => undefined); // desconecta o CDP, não fecha o app
  const tClose = Date.now();
  closeWindow(hwnd);
  const code = await Promise.race([app.exited, wait(10000).then(() => 'timeout')]);
  await wait(2000);
  const closeResult = { exitCode: code, closeMs: Date.now() - tClose - 2000, webviewProcsBefore: wvBefore, webviewProcsAfter: webviewProcessCount() };
  results.scenarios.windowClose = closeResult;
  check('fechar janela com chamada ativa: processo termina', code !== 'timeout', closeResult);
  check('fechar janela: processos WebView2 do app encerrados', closeResult.webviewProcsAfter === 0, closeResult);
  if (code === 'timeout') app.child.kill();
}

async function permissionPromptScenario() {
  // Sem --use-fake-ui-for-media-stream: observa o comportamento padrão de permissão do WebView2/Tauri.
  const app = await launchApp(9334, ['--use-fake-device-for-media-stream']);
  const { page } = app;
  const permissionBefore = await text(page, '[data-testid="env-permission"]');
  await page.click('[data-testid="btn-start"]');
  await wait(6000);
  const observed = {
    permissionBefore,
    phaseAfter6s: await page.$eval('[data-testid="phase"]', (el) => el.dataset.phase),
    error: await text(page, '[data-testid="error"]'),
    permissionAfter: await text(page, '[data-testid="env-permission"]'),
  };
  if (scratch) {
    observed.screenshot = `${scratch}/webview2-permission.png`;
    screenshot(observed.screenshot, app.hwnd);
  }
  results.scenarios.permissionPrompt = observed;
  await app.browser.close().catch(() => undefined);
  app.child.kill();
  await Promise.race([app.exited, wait(5000)]);
}

if (!existsSync(exe)) {
  console.error(`Executável não encontrado: ${exe}. Rode "pnpm tauri:build" antes.`);
  process.exit(2);
}

let exitCode = 0;
try {
  await mainScenario();
  if (!skipPrompt) await permissionPromptScenario();
} catch (error) {
  results.fatal = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  exitCode = 1;
}
results.passed = results.checks.filter((c) => c.ok).length;
results.failed = results.checks.filter((c) => !c.ok).length;
if (results.failed > 0) exitCode = 1;
console.log(JSON.stringify(results, null, 2));
process.exit(exitCode);
