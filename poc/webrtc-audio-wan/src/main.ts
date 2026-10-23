import { encode } from 'uqr';
import { PeerCall, type CallPhase, type CallStats, type IceInfo, type PeerStates, type StartMode } from './call.ts';
import { isIceMode } from './ice.ts';
import { isToken, type Role } from './protocol.ts';
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
  rejoin: $<HTMLButtonElement>('#btn-rejoin'),
  operatorHint: $<HTMLParagraphElement>('#operator-hint'),
  pairing: $<HTMLDivElement>('#pairing'),
  pairInput: $<HTMLInputElement>('#inp-pair'),
  pair: $<HTMLButtonElement>('#btn-pair'),
  inviteToken: $<HTMLSpanElement>('#invite-token'),
  inviteExpiry: $<HTMLParagraphElement>('#invite-expiry'),
  inviteIntro: $<HTMLParagraphElement>('#invite-intro'),
  newInvite: $<HTMLButtonElement>('#btn-invite'),
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
  iceMode: $<HTMLSelectElement>('#sel-ice'),
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
/**
 * Token administrativo do operador, obtido por pareamento (código de uso único exibido no terminal) no
 * listener administrativo. Só em memória: nunca localStorage/sessionStorage, URL ou log. Recarregar a
 * página exige novo código.
 */
let operatorKey: string | null = null;
/** Última sessão criada por este operador (para "Voltar à sessão"). */
let lastSessionId: string | null = null;

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
  ui.create.disabled = active || operatorKey === null;
  ui.rejoin.hidden = active || operatorKey === null || lastSessionId === null;
  ui.join.disabled = active;
  ui.sessionInput.disabled = active;
  ui.iceMode.disabled = active; // o modo vale para a chamada inteira
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
    ui.newInvite.hidden = true;
    ui.inviteToken.textContent = '';
    audio.dispose();
    setMuteButton(false);
  }
}

function renderSession(info: { sessionId: string; role: Role; epoch: number }): void {
  setField('field', 'role', info.role === 'host' ? 'anfitrião (cria a offer)' : 'convidado (responde)');
  // Só o operador (host) emite convites; o botão vale para a sessão inteira, inclusive após reentrar.
  ui.newInvite.hidden = info.role !== 'host';
  if (info.role === 'host') {
    lastSessionId = info.sessionId;
    ui.sessionCode.hidden = false;
    ui.sessionCode.textContent = `Sessão: ${info.sessionId}`;
  }
}

/**
 * Convite de uso único (somente operador). O link usa a origem PÚBLICA informada pelo servidor; sem
 * hostname público configurado, só o código aparece. O token vai no fragmento (#i=…), que não é
 * enviado ao servidor nem ao Referer. O token nunca é registrado no log.
 */
function renderInvite(invite: { token: string; expiresAt: number; publicOrigin: string | null }): void {
  ui.inviteToken.textContent = invite.token;
  ui.inviteExpiry.textContent = `Uso único · expira às ${new Date(invite.expiresAt).toLocaleTimeString('pt-BR', { hour12: false })}`;
  if (invite.publicOrigin) {
    const link = `${invite.publicOrigin}/#i=${invite.token}`;
    ui.inviteLink.href = link;
    ui.inviteLink.textContent = link;
    ui.inviteLink.hidden = false;
    renderQr(link);
    ui.qr.hidden = false;
    ui.inviteIntro.textContent = 'Abra no celular lendo o QR code ou o link (uso único):';
  } else {
    ui.inviteLink.hidden = true;
    ui.qr.hidden = true;
    ui.inviteIntro.textContent = 'Acesso público fechado (nenhum hostname configurado): use o código do convite.';
  }
  ui.invite.hidden = false;
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
    for (const key of ['codec', 'sendKbps', 'recvKbps', 'packetsSent', 'packetsReceived', 'loss', 'remoteLoss', 'jitter', 'rtt', 'pair', 'path']) {
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
  // Comprovação pelo par SELECIONADO, nunca pela configuração.
  setField('metric', 'path', stats.path === 'relay' ? 'relay (TURN) — comprovado pelo par selecionado' : stats.path === 'direct' ? 'direto (sem TURN) — comprovado pelo par selecionado' : 'indisponível');
}

function renderIce(info: IceInfo | null): void {
  setField('field', 'ice', info ? `${info.mode} · ${info.summary}${info.turnConfigured ? ' · TURN configurado (não implica uso)' : ''}` : '—');
}

function setMuteButton(muted: boolean): void {
  ui.mute.textContent = muted ? 'Reativar microfone' : 'Mutar microfone';
  ui.mute.setAttribute('aria-pressed', String(muted));
}

// ---------- ações ----------

function startCall(mode: StartMode): void {
  ui.error.hidden = true;
  ui.sessionCode.hidden = true;
  audio.init();
  const current: PeerCall = new PeerCall(
    {
      getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
      createPeerConnection: (cfg) => new RTCPeerConnection(cfg),
      createSignaling: (handlers) => new SignalingClient(signalingUrl(location), handlers),
      audioCodecs: () => RTCRtpReceiver.getCapabilities?.('audio')?.codecs ?? null,
      iceMode: isIceMode(ui.iceMode.value) ? ui.iceMode.value : 'auto',
    },
    {
      onPhase: (phase, error) => call === current && renderPhase(phase, error),
      onSession: (info) => call === current && renderSession(info),
      onInvite: (invite) => call === current && renderInvite(invite),
      onPeerStates: (s) => call === current && renderPeerStates(s),
      onLocalStream: (s) => call === current && audio.setLocal(s),
      onRemoteStream: (s) => call === current && audio.setRemote(s),
      onStats: (s) => call === current && renderStats(s),
      onLog: (m) => call === current && log(m),
      onIce: (info) => call === current && renderIce(info),
    },
  );
  call = current;
  void current.start(mode);
}

ui.create.addEventListener('click', () => {
  if (operatorKey) startCall({ kind: 'create', operatorKey });
});

ui.rejoin.addEventListener('click', () => {
  if (operatorKey && lastSessionId) startCall({ kind: 'rejoin', sessionId: lastSessionId, operatorKey });
});

ui.newInvite.addEventListener('click', () => call?.requestInvite());

ui.join.addEventListener('click', () => {
  const invite = ui.sessionInput.value.trim();
  if (!isToken(invite)) {
    ui.error.textContent = 'Convite inválido: são 43 caracteres (letras, números, "-" ou "_").';
    ui.error.hidden = false;
    return;
  }
  ui.sessionInput.value = ''; // uso único: não manter o convite na página
  startCall({ kind: 'join', invite });
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
  void navigator.clipboard?.writeText(ui.inviteLink.hidden ? (ui.inviteToken.textContent ?? '') : ui.inviteLink.href).then(
    () => log('Convite copiado.'),
    () => log('Não foi possível copiar o link.'),
  );
});

// Fechar a aba sai da sessão e libera microfone/conexões.
window.addEventListener('pagehide', () => call?.end());

// ---------- inicialização ----------

ui.env.textContent = `${location.origin} · contexto seguro: ${window.isSecureContext ? 'sim' : 'NÃO'} · sinalização: ${signalingUrl(location)}`;

// Convite via fragmento (#i=…): não vai ao servidor nem ao Referer e é removido da barra de endereço e
// do histórico (replaceState). Nunca é registrado no log. (O antigo #op= do operador foi removido no 02B.2C.)
function readInviteFromHash(): void {
  const invite = new URLSearchParams(location.hash.slice(1)).get('i');
  if (location.hash !== '') history.replaceState(null, '', location.pathname);
  if (invite === null) return;
  if (!isToken(invite)) log('Link de convite inválido ignorado.');
  else if (!(call && ACTIVE.includes(call.phase))) {
    ui.sessionInput.value = invite; // não troca o convite no meio de uma chamada
    log('Convite preenchido pelo link.');
  }
}
readInviteFromHash();
// O link também pode ser aberto numa aba que já está nesta página (só o fragmento muda).
window.addEventListener('hashchange', readInviteFromHash);

// ---------- pareamento do operador (somente no endereço administrativo, em loopback) ----------

const isLoopbackPage = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
ui.pairing.hidden = !isLoopbackPage;

function setOperator(token: string | null): void {
  operatorKey = token;
  ui.pairing.hidden = token !== null || !isLoopbackPage;
  ui.operatorHint.hidden = token !== null;
  if (call === null || !ACTIVE.includes(call.phase)) ui.create.disabled = token === null;
}

ui.pair.addEventListener('click', () => {
  const code = ui.pairInput.value;
  ui.pairInput.value = ''; // o código é de uso único; não manter na página
  ui.error.hidden = true;
  // Mesma origem, JSON e cabeçalho próprio: o servidor exige os três (bloqueia CSRF e páginas de terceiros).
  fetch('/admin/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Oryn-Admin': '1' },
    body: JSON.stringify({ code }),
    credentials: 'omit',
    cache: 'no-store',
  })
    .then(async (res) => {
      if (res.ok) {
        const body = (await res.json()) as { token?: unknown };
        if (isToken(body.token)) {
          setOperator(body.token);
          log('Operador pareado nesta página.');
          return;
        }
      }
      const message =
        res.status === 429
          ? 'Código esgotado: gere outro no terminal ("codigo" + Enter).'
          : res.status === 404 || res.status === 405 || res.status === 421
            ? 'Este endereço não é o administrativo: use a porta de administração exibida no terminal.'
            : 'Código de pareamento inválido ou expirado.';
      ui.error.textContent = message;
      ui.error.hidden = false;
    })
    .catch(() => {
      ui.error.textContent = 'Falha ao contatar o servidor para o pareamento.';
      ui.error.hidden = false;
    });
});

renderPhase('idle');
renderStats(null);
setField('field', 'mic', 'liberado');
setField('field', 'playback', 'sem áudio remoto');
