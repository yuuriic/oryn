// Página da integração 02C: login (e-mail e senha em conta EXISTENTE; sem anônimo, sem cadastro), sala,
// chamada de voz 1:1 com o PeerCall da 02B e sinalização pelo Supabase (SupabaseSignaling).
// MVP 01: lobby com as salas da conta (listar, criar com 2 lugares, entrar e encerrar), em rooms.ts e
// rooms-view.ts; o campo de UUID ficou em "Diagnóstico".
//
// Sigilo: a senha só passa do campo para o supabase-js e o campo é limpo em seguida; a sessão de login fica
// SÓ em memória (persistSession: false: nada em localStorage); o registro em tela nunca mostra token, SDP,
// candidato ICE ou senha. A configuração aceita só a chave publicável (config.ts).

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { isUuid } from '../../supabase/functions/_shared/signal-contract.ts';
import { PeerCall, type CallPhase, type CallStats, type PeerStates } from './call.ts';
import { parseWebConfig, type WebConfig } from './config.ts';
import { DISCONNECT_KIND_MESSAGES, LobbyController, classifyDisconnect } from './rooms.ts';
import { renderLobby } from './rooms-view.ts';
import { describePair, formatCodec, formatMetric } from './stats.ts';
import { createSupabaseBackend } from './supabase-backend.ts';
import { DISCONNECT, DISCONNECT_MESSAGES, SupabaseSignaling } from './supabase-signaling.ts';

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`elemento #${id} ausente`);
  return node as T;
};

const ui = {
  configError: el<HTMLParagraphElement>('config-error'),
  login: el<HTMLElement>('login'),
  loginForm: el<HTMLFormElement>('login-form'),
  email: el<HTMLInputElement>('email'),
  password: el<HTMLInputElement>('password'),
  loginBtn: el<HTMLButtonElement>('login-btn'),
  account: el<HTMLElement>('account'),
  userLabel: el<HTMLElement>('user-label'),
  logoutBtn: el<HTMLButtonElement>('logout-btn'),
  rooms: el<HTMLDivElement>('rooms'),
  roomsError: el<HTMLParagraphElement>('rooms-error'),
  refreshBtn: el<HTMLButtonElement>('rooms-refresh-btn'),
  createForm: el<HTMLFormElement>('create-form'),
  createName: el<HTMLInputElement>('create-name'),
  createDisplay: el<HTMLInputElement>('create-display'),
  createBtn: el<HTMLButtonElement>('create-btn'),
  callRoom: el<HTMLElement>('call-room'),
  room: el<HTMLInputElement>('room'),
  joinBtn: el<HTMLButtonElement>('join-btn'),
  muteBtn: el<HTMLButtonElement>('mute-btn'),
  leaveBtn: el<HTMLButtonElement>('leave-btn'),
  listenBtn: el<HTMLButtonElement>('listen-btn'),
  error: el<HTMLParagraphElement>('error'),
  status: el<HTMLElement>('status'),
  audioContainer: el<HTMLDivElement>('audio-container'),
  log: el<HTMLOListElement>('log'),
};

const PHASES: Record<CallPhase, string> = {
  idle: 'parada',
  'requesting-mic': 'pedindo o microfone',
  'connecting-signaling': 'entrando na sala',
  'waiting-peer': 'aguardando o outro participante',
  negotiating: 'negociando',
  connected: 'conectada',
  ended: 'encerrada',
  failed: 'falhou',
};

let cfg: WebConfig;
let client: SupabaseClient;
let selfUserId: string | null = null;
let call: PeerCall | null = null;
let signaling: SupabaseSignaling | null = null;
let remoteAudio: HTMLAudioElement | null = null;
/** Sala da chamada atual (ou da última, até ela terminar) e se a chamada está em curso. */
let callRoomId: string | null = null;
let callActive = false;
let lobby: LobbyController;

function setField(name: string, value: string): void {
  const node = document.querySelector<HTMLElement>(`[data-field="${name}"]`);
  if (node) node.textContent = value;
}

function log(message: string): void {
  const item = document.createElement('li');
  item.textContent = `${new Date().toLocaleTimeString('pt-BR', { hour12: false })} ${message}`;
  ui.log.append(item);
  while (ui.log.childElementCount > 200) ui.log.firstElementChild?.remove();
  ui.log.scrollTop = ui.log.scrollHeight;
}

function showError(message: string | null): void {
  ui.error.textContent = message ?? '';
  ui.error.hidden = message === null;
}

/** Código de erro do Auth exibível: só [a-z0-9_-] curto (nunca a mensagem inteira). */
const authCode = (code: unknown): string => (typeof code === 'string' && /^[a-z0-9_-]{1,40}$/.test(code) ? code : 'erro');

// ---------- áudio remoto ----------

function setRemote(stream: MediaStream | null): void {
  if (remoteAudio) {
    remoteAudio.pause();
    remoteAudio.srcObject = null;
    remoteAudio.remove();
    remoteAudio = null;
  }
  ui.listenBtn.hidden = true;
  if (!stream) return;
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.srcObject = stream;
  ui.audioContainer.replaceChildren(audio);
  remoteAudio = audio;
  audio.play().catch(() => {
    ui.listenBtn.hidden = false; // autoplay bloqueado: o usuário libera com um clique
    log('Reprodução do áudio remoto bloqueada pelo navegador: clique em "Ouvir".');
  });
}

ui.listenBtn.addEventListener('click', () => {
  void remoteAudio?.play().then(() => (ui.listenBtn.hidden = true)).catch(() => undefined);
});

// ---------- renderização ----------

function renderPhase(phase: CallPhase, error?: string): void {
  setField('phase', PHASES[phase]);
  const active = phase !== 'idle' && phase !== 'ended' && phase !== 'failed';
  callActive = active;
  ui.joinBtn.disabled = active;
  ui.room.disabled = active;
  ui.muteBtn.disabled = !active;
  ui.leaveBtn.disabled = !active;
  if (!active) {
    ui.muteBtn.textContent = 'Mutar';
    setField('role', '—');
  }
  // O dono encerrou a sala desta chamada por aqui: o aviso do servidor pode chegar antes da resposta do
  // close_room, e a queda que ele causa não é um erro para quem encerrou.
  const closingHere = lobby?.state.busy?.kind === 'close' && lobby.state.busy.roomId === callRoomId;
  if (phase === 'failed' && error && !closingHere) {
    const code = /código (\d{4})/.exec(error)?.[1];
    const detail = code ? DISCONNECT_MESSAGES[Number(code)] : undefined;
    const shown = detail ? `${error} — ${detail}.` : error;
    showError(shown);
    if (Number(code) === DISCONNECT.session && callRoomId) void explainDisconnect(callRoomId, shown);
  }
  if (phase === 'ended' || phase === 'failed') {
    signaling = null;
    if (lobby.state.status !== 'idle') void lobby.refresh(); // contagens e estado das salas mudaram
  }
  renderRooms();
}

/** 4403: pergunta à lista de salas o motivo. Sem classificação definitiva se a consulta falhar. */
async function explainDisconnect(roomId: string, shown: string): Promise<void> {
  const user = selfUserId;
  const res = await createSupabaseBackend(client).rpc<unknown[]>('list_my_rooms', {}).catch(() => ({ data: null, error: 'erro' }));
  // Outra chamada já começou, ou houve logout/login no meio: a resposta é de outro momento.
  if (callActive || callRoomId !== roomId || selfUserId !== user) return;
  showError(`${shown} ${DISCONNECT_KIND_MESSAGES[classifyDisconnect(roomId, res)]}`);
}

function renderPeer(states: PeerStates | null): void {
  setField('peer', states ? `${states.connection} (sinalização ${states.signaling})` : '—');
  setField('ice', states ? `${states.ice}, coleta ${states.gathering}` : '—');
}

function renderStats(s: CallStats | null): void {
  if (!s) {
    for (const f of ['path', 'codec', 'rate', 'quality']) setField(f, '—');
    return;
  }
  setField('path', s.path ? `${s.path === 'relay' ? 'relay (TURN)' : 'direto'} — ${describePair(s.pair)}` : 'indeterminado');
  setField('codec', formatCodec(s.codec));
  setField('rate', `${formatMetric(s.sendKbps, 1, ' kbps')} / ${formatMetric(s.recvKbps, 1, ' kbps')}`);
  setField('quality', `${formatMetric(s.rttMs, 0, ' ms')} / ${formatMetric(s.lossPct, 1, '%')} / ${formatMetric(s.jitterMs, 1, ' ms')}`);
}

// ---------- chamada ----------

function startCall(roomInput: string): void {
  if (callActive) return; // uma chamada por vez
  showError(null);
  const roomId = roomInput.trim().toLowerCase();
  if (!isUuid(roomId)) return showError('ID da sala inválido: informe o UUID da sala.');
  if (!selfUserId) return showError('Faça login antes de entrar na chamada.');
  const userId = selfUserId;
  callRoomId = roomId;
  ui.room.value = roomId;
  ui.callRoom.textContent = lobby.state.rooms.find((r) => r.room_id === roomId)?.name ?? roomId;
  const backend = createSupabaseBackend(client);
  ui.status.hidden = false;
  ui.log.replaceChildren();

  const current: PeerCall = new PeerCall(
    {
      getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
      createPeerConnection: (c) => new RTCPeerConnection(c),
      createSignaling: (handlers) => {
        signaling = new SupabaseSignaling({ backend, roomId, selfUserId: userId, handlers, iceServers: cfg.iceServers, log: (m) => call === current && log(m) });
        return signaling;
      },
      audioCodecs: () => RTCRtpReceiver.getCapabilities?.('audio')?.codecs ?? null,
      iceMode: 'direct', // só STUN nesta etapa
    },
    {
      onPhase: (phase, error) => call === current && renderPhase(phase, error),
      onSession: () => undefined,
      onInvite: () => undefined,
      onPeerStates: (s) => {
        if (call !== current) return;
        renderPeer(s);
        setField('role', current.currentRole === 'host' ? 'iniciador (cria a offer)' : current.currentRole === 'guest' ? 'responde à offer' : '—');
      },
      onLocalStream: (s) => call === current && setField('mic', s ? (current.muted ? 'capturando (mutado)' : 'capturando') : 'liberado'),
      onRemoteStream: (s) => call === current && setRemote(s),
      onStats: (s) => call === current && renderStats(s),
      onLog: (m) => call === current && log(m),
      onIce: (info) => call === current && log(info ? `ICE: ${info.summary}.` : 'ICE: configuração descartada.'),
    },
  );
  call = current;
  callActive = true; // antes da primeira fase: um segundo clique não abre outra chamada
  renderRooms();
  void current.start({ kind: 'room' });
}

/** Encerra a chamada e espera a saída da sala (leave_room precisa do JWT ainda válido). */
async function endCall(): Promise<void> {
  const s = signaling;
  call?.end();
  await s?.closed.catch(() => undefined);
}

ui.joinBtn.addEventListener('click', () => startCall(ui.room.value));
ui.muteBtn.addEventListener('click', () => {
  if (!call) return;
  call.setMuted(!call.muted);
  ui.muteBtn.textContent = call.muted ? 'Reativar microfone' : 'Mutar';
  setField('mic', call.muted ? 'capturando (mutado)' : 'capturando');
});
ui.leaveBtn.addEventListener('click', () => void endCall());
// Fechar a aba: tenta sair da sala; se não der tempo, a sessão vence sozinha em até 90 s.
window.addEventListener('pagehide', () => call?.end());

// ---------- lobby (MVP 01) ----------

function renderRooms(): void {
  if (!lobby) return;
  const s = lobby.state;
  const busy = s.busy !== null;
  ui.rooms.replaceChildren(
    renderLobby(document, s, {
      callActive,
      activeRoomId: callActive ? callRoomId : null,
      onJoin: (roomId) => startCall(roomId),
      onClose: (roomId) => void lobby.close(roomId),
    }),
  );
  ui.roomsError.textContent = s.actionError ?? '';
  ui.roomsError.hidden = s.actionError === null;
  ui.refreshBtn.disabled = busy || s.status === 'loading';
  ui.createBtn.disabled = busy;
  ui.createName.disabled = busy;
  ui.createDisplay.disabled = busy;
}

ui.refreshBtn.addEventListener('click', () => void lobby.refresh());
ui.createForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void lobby.create(ui.createName.value, ui.createDisplay.value).then((id) => {
    if (id) ui.createName.value = '';
  });
});

// ---------- login ----------

function showLoggedIn(email: string | undefined): void {
  ui.login.hidden = true;
  ui.account.hidden = false;
  ui.userLabel.textContent = email ?? '(conta sem e-mail)';
}

function showLoggedOut(): void {
  selfUserId = null;
  lobby.reset();
  ui.account.hidden = true;
  ui.login.hidden = false;
  ui.loginBtn.disabled = false;
}

ui.loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  showError(null);
  const email = ui.email.value.trim();
  const password = ui.password.value;
  ui.password.value = ''; // a senha não fica no DOM
  ui.loginBtn.disabled = true;
  void client.auth.signInWithPassword({ email, password }).then(async ({ data, error }) => {
    ui.loginBtn.disabled = false;
    if (error || !data.session || !data.user) return showError(`Login recusado (${authCode(error?.code)}).`);
    selfUserId = data.user.id;
    // Canais privados exigem o JWT do usuário no Realtime antes da inscrição.
    await client.realtime.setAuth(data.session.access_token);
    showLoggedIn(data.user.email);
    void lobby.refresh();
  });
});

ui.logoutBtn.addEventListener('click', () => {
  void (async () => {
    await endCall();
    await client.auth.signOut({ scope: 'local' }).catch(() => undefined);
    showLoggedOut();
  })();
});

// ---------- inicialização ----------

try {
  cfg = parseWebConfig(import.meta.env as unknown as Record<string, string | undefined>);
  // persistSession false: o login vive só nesta aba; autoRefreshToken renova o JWT (o supabase-js repassa
  // o token novo ao Realtime). Nenhuma chave além da publicável.
  client = createClient(cfg.supabaseUrl, cfg.publishableKey, { auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false } });
  const backend = createSupabaseBackend(client);
  lobby = new LobbyController({
    rpc: (fn, args) => backend.rpc(fn, args),
    confirm: (message) => window.confirm(message),
    onChange: () => renderRooms(),
    // O dono encerrou a sala da própria chamada: sai dela aqui, sem esperar o aviso do servidor.
    onClosed: async (roomId) => {
      if (callActive && callRoomId === roomId) await endCall();
    },
  });
  client.auth.onAuthStateChange((event) => {
    if (event === 'TOKEN_REFRESHED') log('Token de acesso renovado.');
    if (event === 'SIGNED_OUT' && selfUserId !== null) {
      // Renovação falhou ou logout: a chamada não continua sem identidade válida.
      call?.end();
      showLoggedOut();
      showError('A sessão de login terminou. Faça login de novo.');
    }
  });
  if (cfg.defaultRoomId) ui.room.value = cfg.defaultRoomId;
  ui.login.hidden = false;
} catch (error) {
  ui.configError.textContent = `Configuração inválida: ${error instanceof Error ? error.message : 'erro'}. Veja .env.example.`;
  ui.configError.hidden = false;
}
