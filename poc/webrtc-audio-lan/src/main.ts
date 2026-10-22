import { encode } from 'uqr';
import { PeerCall, type CallPhase, type CallStats, type PeerStates } from './call.ts';
import { isSessionId, type Role } from './protocol.ts';
import { SignalingClient, signalingUrl } from './signaling-client.ts';
import { describePair, formatCodec, formatMetric, parseFmtp } from './stats.ts';

const $ = <T extends HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Elemento ausente: ${selector}`);
  return el;
};

const ui = {
  env: $<HTMLParagraphElement>('[data-testid="env"]'),
  create: $<HTMLButtonElement>('#btn-create'),
  join: $<HTMLButtonElement>('#btn-join'),
  sessionInput: $<HTMLInputElement>('#inp-session'),
  invite: $<HTMLDivElement>('#invite'),
  qr: $<HTMLDivElement>('#qr'),
  inviteLink: $<HTMLAnchorElement>('#invite-link'),
  copy: $<HTMLButtonElement>('#btn-copy'),
  sessionCode: $<HTMLParagraphElement>('#session-code'),
  mute: $<HTMLButtonElement>('#btn-mute'),
  listen: $<HTMLInputElement>('#chk-listen'),
  volume: $<HTMLInputElement>('#rng-volume'),
  end: $<HTMLButtonElement>('#btn-end'),
  phase: $<HTMLParagraphElement>('#phase'),
  error: $<HTMLParagraphElement>('#error'),
  meterLocal: $<HTMLMeterElement>('#meter-local'),
  meterRemote: $<HTMLMeterElement>('#meter-remote'),
  log: $<HTMLOListElement>('#log'),
  audioContainer: $<HTMLDivElement>('#audio-container'),
};

const PHASE_LABEL: Record<CallPhase, string> = {
  idle: 'ocioso',
  'requesting-mic': 'aguardando permissão do microfone…',
  'connecting-signaling': 'conectando à sinalização…',
  'waiting-peer': 'aguardando o outro participante…',
  negotiating: 'negociando conexão WebRTC…',
  connected: 'conectado — áudio nos dois sentidos',
  ended: 'chamada encerrada',
  failed: 'falhou',
};

const ACTIVE: readonly CallPhase[] = ['requesting-mic', 'connecting-signaling', 'waiting-peer', 'negotiating', 'connected'];

let call: PeerCall | null = null;
let httpsOrigin: string | null = null;

// ---------- log em memória ----------

function log(message: string): void {
  const li = document.createElement('li');
  li.textContent = `[${new Date().toLocaleTimeString('pt-BR', { hour12: false })}] ${message}`;
  ui.log.append(li);
  while (ui.log.childElementCount > 200) ui.log.firstElementChild?.remove();
  ui.log.scrollTop = ui.log.scrollHeight;
}

const setField = (attr: string, key: string, text: string, raw?: number | null): void => {
  const el = document.querySelector<HTMLElement>(`[data-${attr}="${key}"]`);
  if (!el) return;
  el.textContent = text;
  if (raw !== undefined) el.dataset['raw'] = raw === null ? '' : String(raw);
};

// ---------- áudio local/remoto: saída e medidores ----------

class AudioMonitor {
  private ctx: AudioContext | null = null;
  private local: AnalyserNode | null = null;
  private remote: AnalyserNode | null = null;
  private el: HTMLAudioElement | null = null;
  private frame: number | null = null;
  private readonly buffer = new Float32Array(2048);

  /** Criado no gesto do usuário (evita bloqueio de autoplay). */
  init(): void {
    this.ctx ??= new AudioContext();
    this.frame ??= requestAnimationFrame(this.tick);
  }

  setLocal(stream: MediaStream | null): void {
    this.local?.disconnect();
    this.local = stream ? this.analyse(stream) : null;
    setField('field', 'mic', stream ? (call?.muted ? 'capturando (mutado)' : 'capturando') : 'liberado');
  }

  setRemote(stream: MediaStream | null): void {
    this.remote?.disconnect();
    this.remote = null;
    if (this.el) {
      this.el.pause();
      this.el.srcObject = null;
      this.el.remove();
      this.el = null;
    }
    if (!stream) {
      setField('field', 'playback', 'sem áudio remoto');
      return;
    }
    const el = document.createElement('audio');
    el.autoplay = true;
    el.dataset['testid'] = 'remote-audio';
    el.srcObject = stream;
    ui.audioContainer.replaceChildren(el);
    this.el = el;
    this.applyOutput();
    el.play().then(
      () => this.applyOutput(),
      (e: unknown) => setField('field', 'playback', `bloqueada (${e instanceof Error ? e.name : 'erro'})`),
    );
    // O <audio> precisa estar tocando (mesmo mudo) para o Chrome entregar o áudio remoto ao Web Audio.
    this.remote = this.analyse(stream);
  }

  applyOutput(): void {
    if (!this.el) return;
    this.el.muted = !ui.listen.checked;
    this.el.volume = Number(ui.volume.value);
    if (ui.listen.checked) {
      void this.ctx?.resume();
      if (this.el.paused) void this.el.play().catch(() => undefined);
    }
    setField('field', 'playback', this.el.paused ? 'pausada' : this.el.muted ? 'tocando (sem som — "Ouvir" desligado)' : `tocando (volume ${Math.round(this.el.volume * 100)}%)`);
  }

  dispose(): void {
    this.setRemote(null);
    this.setLocal(null);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    ui.meterLocal.value = 0;
    ui.meterRemote.value = 0;
    ui.meterRemote.dataset['raw'] = '0';
  }

  private analyse(stream: MediaStream): AnalyserNode | null {
    if (!this.ctx) return null;
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 2048;
    this.ctx.createMediaStreamSource(stream).connect(analyser); // só medição, sem reprodução
    return analyser;
  }

  private rms(node: AnalyserNode | null): number {
    if (!node) return 0;
    node.getFloatTimeDomainData(this.buffer);
    let sum = 0;
    for (const v of this.buffer) sum += v * v;
    return Math.sqrt(sum / this.buffer.length);
  }

  private readonly tick = (): void => {
    ui.meterLocal.value = this.rms(this.local);
    const remote = this.rms(this.remote);
    ui.meterRemote.value = remote;
    ui.meterRemote.dataset['raw'] = remote.toFixed(5);
    this.frame = requestAnimationFrame(this.tick);
  };
}

const audio = new AudioMonitor();

// ---------- renderização ----------

function renderPhase(phase: CallPhase, error?: string): void {
  ui.phase.textContent = `Estado: ${PHASE_LABEL[phase]}`;
  ui.phase.dataset['phase'] = phase;
  const active = ACTIVE.includes(phase);
  ui.create.disabled = active;
  ui.join.disabled = active;
  ui.sessionInput.disabled = active;
  ui.end.disabled = !active;
  ui.mute.disabled = !active || phase === 'requesting-mic';
  ui.listen.disabled = !active;
  ui.volume.disabled = !active;
  setField('field', 'signaling', active && phase !== 'requesting-mic' && phase !== 'connecting-signaling' ? 'conectada' : phase === 'connecting-signaling' ? 'conectando…' : 'desconectada');
  if (error) {
    ui.error.textContent = error;
    ui.error.hidden = false;
  }
  if (!active) {
    ui.invite.hidden = true;
    audio.dispose();
    setMuteButton(false);
  }
}

function renderSession(info: { sessionId: string; role: Role; epoch: number }): void {
  setField('field', 'role', info.role === 'host' ? 'anfitrião (cria a offer)' : 'convidado (responde)');
  ui.sessionCode.hidden = false;
  ui.sessionCode.textContent = `Sessão: ${info.sessionId}`;
  if (info.role === 'host' && httpsOrigin) {
    const link = `${httpsOrigin}/#s=${info.sessionId}`;
    ui.inviteLink.href = link;
    ui.inviteLink.textContent = link;
    renderQr(link);
    ui.invite.hidden = false;
  }
}

function renderQr(text: string): void {
  const { data } = encode(text, { ecc: 'M' });
  const size = data.length;
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', `-2 -2 ${size + 4} ${size + 4}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  let d = '';
  data.forEach((row, y) => row.forEach((on, x) => on && (d += `M${x} ${y}h1v1h-1z`)));
  const path = document.createElementNS(svgNs, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000');
  svg.append(path);
  ui.qr.replaceChildren(svg);
}

function renderPeerStates(states: PeerStates | null): void {
  for (const key of ['connection', 'ice', 'gathering', 'signaling'] as const) {
    setField('peer', key, states ? states[key] : '—');
  }
}

function renderStats(stats: CallStats | null): void {
  if (!stats) {
    for (const key of ['codec', 'sendKbps', 'recvKbps', 'packetsSent', 'packetsReceived', 'loss', 'remoteLoss', 'jitter', 'rtt', 'pair']) {
      setField('metric', key, 'indisponível', null);
    }
    return;
  }
  const fmtp = parseFmtp(stats.codec?.sdpFmtpLine ?? null);
  const fmtpText = Object.entries(fmtp).map(([k, v]) => `${k}=${v}`).join(';');
  setField('metric', 'codec', stats.codec ? `${formatCodec(stats.codec)}${fmtpText ? ` · ${fmtpText}` : ''}` : 'indisponível');
  setField('metric', 'sendKbps', formatMetric(stats.sendKbps, 1, ' kbit/s'), stats.sendKbps);
  setField('metric', 'recvKbps', formatMetric(stats.recvKbps, 1, ' kbit/s'), stats.recvKbps);
  setField('metric', 'packetsSent', formatMetric(stats.packetsSent, 0), stats.packetsSent);
  setField('metric', 'packetsReceived', formatMetric(stats.packetsReceived, 0), stats.packetsReceived);
  setField('metric', 'loss', stats.lossPct === null ? 'indisponível' : `${formatMetric(stats.lossPct, 2, ' %')} (${stats.packetsLost ?? '?'} pacotes)`, stats.lossPct);
  setField('metric', 'remoteLoss', formatMetric(stats.remoteLossPct, 2, ' %'), stats.remoteLossPct);
  setField('metric', 'jitter', formatMetric(stats.jitterMs, 1, ' ms'), stats.jitterMs);
  setField('metric', 'rtt', stats.rttMs === null ? 'indisponível' : `${formatMetric(stats.rttMs, 1, ' ms')} (${stats.rttSource === 'rtcp' ? 'RTCP' : 'ICE'})`, stats.rttMs);
  setField('metric', 'pair', describePair(stats.pair));
}

function setMuteButton(muted: boolean): void {
  ui.mute.textContent = muted ? 'Reativar microfone' : 'Mutar microfone';
  ui.mute.setAttribute('aria-pressed', String(muted));
}

// ---------- ações ----------

function startCall(mode: { kind: 'create' } | { kind: 'join'; sessionId: string }): void {
  ui.error.hidden = true;
  ui.sessionCode.hidden = true;
  audio.init();
  const current: PeerCall = new PeerCall(
    {
      getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
      createPeerConnection: (cfg) => new RTCPeerConnection(cfg),
      createSignaling: (handlers) => new SignalingClient(signalingUrl(location), handlers),
      audioCodecs: () => RTCRtpReceiver.getCapabilities?.('audio')?.codecs ?? null,
    },
    {
      onPhase: (phase, error) => call === current && renderPhase(phase, error),
      onSession: (info) => call === current && renderSession(info),
      onPeerStates: (s) => call === current && renderPeerStates(s),
      onLocalStream: (s) => call === current && audio.setLocal(s),
      onRemoteStream: (s) => call === current && audio.setRemote(s),
      onStats: (s) => call === current && renderStats(s),
      onLog: (m) => call === current && log(m),
    },
  );
  call = current;
  void current.start(mode);
}

ui.create.addEventListener('click', () => startCall({ kind: 'create' }));

ui.join.addEventListener('click', () => {
  const sessionId = ui.sessionInput.value.trim();
  if (!isSessionId(sessionId)) {
    ui.error.textContent = 'Código de sessão inválido: são 22 caracteres (letras, números, "-" ou "_").';
    ui.error.hidden = false;
    return;
  }
  startCall({ kind: 'join', sessionId });
});

ui.end.addEventListener('click', () => call?.end());

ui.mute.addEventListener('click', () => {
  if (!call) return;
  call.setMuted(!call.muted);
  setMuteButton(call.muted);
  setField('field', 'mic', call.muted ? 'capturando (mutado)' : 'capturando');
});

ui.listen.addEventListener('change', () => audio.applyOutput());
ui.volume.addEventListener('input', () => audio.applyOutput());

ui.copy.addEventListener('click', () => {
  void navigator.clipboard?.writeText(ui.inviteLink.href).then(
    () => log('Link copiado.'),
    () => log('Não foi possível copiar o link.'),
  );
});

// Fechar a aba sai da sessão e libera microfone/conexões.
window.addEventListener('pagehide', () => call?.end());

// ---------- inicialização ----------

ui.env.textContent = `${location.origin} · contexto seguro: ${window.isSecureContext ? 'sim' : 'NÃO'} · sinalização: ${signalingUrl(location)}`;

// Convite via fragmento (#s=...): não vai para o servidor nem para o Referer. Removido da barra de endereço.
function readInviteFromHash(): void {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('s');
  if (!fromHash) return;
  history.replaceState(null, '', location.pathname);
  if (!isSessionId(fromHash)) {
    log('Link de convite com código inválido ignorado.');
    return;
  }
  if (call && ACTIVE.includes(call.phase)) return; // não troca o código no meio de uma chamada
  ui.sessionInput.value = fromHash;
  log('Código de sessão preenchido pelo link de convite.');
}
readInviteFromHash();
// O link também pode ser aberto numa aba que já está nesta página (só o fragmento muda).
window.addEventListener('hashchange', readInviteFromHash);

// O endereço HTTPS da LAN só é fornecido ao navegador local (para montar o convite).
if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
  fetch('/api/info')
    .then((r) => (r.ok ? r.json() : null))
    .then((info: { httpsOrigin?: string | null } | null) => {
      httpsOrigin = info?.httpsOrigin ?? null;
      if (!httpsOrigin) log('HTTPS da LAN desativado: o convite para o celular não está disponível.');
    })
    .catch(() => undefined);
}

renderPhase('idle');
renderStats(null);
setField('field', 'mic', 'liberado');
setField('field', 'playback', 'sem áudio remoto');
