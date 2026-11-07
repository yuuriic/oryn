// Página da integração 02C: login (e-mail e senha em conta EXISTENTE; sem anônimo, sem cadastro), sala,
// chamada de voz em grupo (MeshCall: até 4 contas, uma conexão por par) e sinalização pelo Supabase (MeshSignaling).
// MVP 01: lobby com as salas da conta (listar, criar com 2 lugares, entrar e encerrar), em rooms.ts e
// rooms-view.ts; o campo de UUID ficou em "Diagnóstico". Chat por sala, em chat.ts e chat-view.ts, sem nenhuma
// ligação com a chamada.
//
// Sigilo: a senha só passa do campo para o supabase-js e o campo é limpo em seguida; a sessão de login é guardada
// pelo mecanismo oficial do Auth (auth-session.ts; riscos no runbook §14.6) e o ID da sala, em call-return.ts;
// o convite de sala (invites.ts) sai da URL ao carregar e fica só em memória; o registro em tela nunca mostra token, SDP,
// candidato ICE ou senha. A configuração aceita só a chave publicável (config.ts).

import { FunctionsHttpError, createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { isUuid } from '../../supabase/functions/_shared/signal-contract.ts';
import { authOptions, createAuthStorage, logout, restoreSession, type AuthStorage } from './auth-session.ts';
import type { CallPhase, CallStats, PeerStates } from './call.ts';
import { ChatController, type ChatState } from './chat.ts';
import { chatStatusText, renderChatMessages } from './chat-view.ts';
import { CallReturnController, ReturnRoomStore, type ReturnState } from './call-return.ts';
import { parseWebConfig, type WebConfig } from './config.ts';
import { ENTRY_CHECKING, ENTRY_RELEASED, ENTRY_STILL_BLOCKED, EntryGate, blockedMessage, entryErrorMessage, type EntryState } from './entry-gate.ts';
import { InviteAcceptController, InviteShareController, buildInviteLink, inviteLoginHint, takeInviteFromLocation, type InviteAcceptState, type InviteArrival, type InviteShareState } from './invites.ts';
import { MembersController, MEMBERS_LOAD_FAILED, type MembersState } from './members.ts';
import { renderMembers, renderParticipants } from './members-view.ts';
import { MeshCall, type ParticipantView } from './mesh-call.ts';
import { MeshSignaling } from './mesh-signaling.ts';
import { DISCONNECT_CHECKING, LobbyController, disconnectPhase, explainDisconnect, formatCallError, isClosingOwnCall, peerProblemNotice, type Notice } from './rooms.ts';
import { renderLobby, renderRoomNav, roomContext } from './rooms-view.ts';
import { ShellController, replaceKeepingFocus, type ShellState } from './shell.ts';
import { micLabel, otherRoomNote, voiceSummary } from './voice-view.ts';
import { SoundBus } from './sound-bus.ts';
import { SoundCache, createBrowserSoundStore } from './sound-cache.ts';
import { loadSoundPrefs, saveSoundPrefs } from './sound-prefs.ts';
import { SoundboardController, type SoundboardState } from './soundboard.ts';
import { renderSoundboard, soundboardStatus } from './soundboard-view.ts';
import { describePair, formatCodec, formatMetric } from './stats.ts';
import { createBrowserLedger, type SessionLedger } from './session-ledger.ts';
import { createSupabaseBackend } from './supabase-backend.ts';
import { DISCONNECT, DISCONNECT_MESSAGES, JOIN_LIMIT_MESSAGE } from './supabase-signaling.ts';

// Primeiro passo da página: o token do convite não fica na barra de endereço.
const takeInvite = (): InviteArrival => takeInviteFromLocation(window.location, (url) => window.history.replaceState(window.history.state, '', url));
const arrivedInvite = takeInvite();

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
  returnCall: el<HTMLElement>('return-call'),
  returnRoom: el<HTMLElement>('return-room'),
  returnBtn: el<HTMLButtonElement>('return-btn'),
  returnDismissBtn: el<HTMLButtonElement>('return-dismiss-btn'),
  inviteLoginHint: el<HTMLParagraphElement>('invite-login-hint'),
  inviteAccept: el<HTMLElement>('invite-accept'),
  inviteAcceptPending: el<HTMLElement>('invite-accept-pending'),
  inviteAccount: el<HTMLElement>('invite-account'),
  inviteAcceptForm: el<HTMLFormElement>('invite-accept-form'),
  inviteDisplay: el<HTMLInputElement>('invite-display'),
  inviteAcceptBtn: el<HTMLButtonElement>('invite-accept-btn'),
  inviteDeclineBtn: el<HTMLButtonElement>('invite-decline-btn'),
  inviteAcceptMessage: el<HTMLParagraphElement>('invite-accept-message'),
  inviteDismissBtn: el<HTMLButtonElement>('invite-dismiss-btn'),
  inviteShare: el<HTMLElement>('invite-share'),
  inviteShareRoom: el<HTMLElement>('invite-share-room'),
  inviteShareBox: el<HTMLElement>('invite-share-box'),
  inviteLink: el<HTMLInputElement>('invite-link'),
  inviteExpiry: el<HTMLElement>('invite-expiry'),
  inviteCopyBtn: el<HTMLButtonElement>('invite-copy-btn'),
  inviteNativeShareBtn: el<HTMLButtonElement>('invite-native-share-btn'),
  inviteShareStatus: el<HTMLParagraphElement>('invite-share-status'),
  inviteShareMessage: el<HTMLParagraphElement>('invite-share-message'),
  inviteNewBtn: el<HTMLButtonElement>('invite-new-btn'),
  inviteCloseBtn: el<HTMLButtonElement>('invite-close-btn'),
  entryState: el<HTMLElement>('entry-state'),
  entryMessage: el<HTMLParagraphElement>('entry-message'),
  entryGoBtn: el<HTMLButtonElement>('entry-go-btn'),
  entryRecheckBtn: el<HTMLButtonElement>('entry-recheck-btn'),
  entryCancelBtn: el<HTMLButtonElement>('entry-cancel-btn'),
  rooms: el<HTMLDivElement>('rooms'),
  roomsError: el<HTMLParagraphElement>('rooms-error'),
  refreshBtn: el<HTMLButtonElement>('rooms-refresh-btn'),
  members: el<HTMLElement>('members'),
  membersRoom: el<HTMLElement>('members-room'),
  membersStatus: el<HTMLParagraphElement>('members-status'),
  membersList: el<HTMLDivElement>('members-list'),
  membersCloseBtn: el<HTMLButtonElement>('members-close-btn'),
  participants: el<HTMLDivElement>('participants'),
  createCapacity: el<HTMLSelectElement>('create-capacity'),
  chat: el<HTMLElement>('chat'),
  chatRoom: el<HTMLElement>('chat-room'),
  chatStatus: el<HTMLParagraphElement>('chat-status'),
  chatMessages: el<HTMLDivElement>('chat-messages'),
  chatForm: el<HTMLFormElement>('chat-form'),
  chatInput: el<HTMLTextAreaElement>('chat-input'),
  chatSendBtn: el<HTMLButtonElement>('chat-send-btn'),
  chatCloseBtn: el<HTMLButtonElement>('chat-close-btn'),
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
  soundboard: el<HTMLElement>('soundboard'),
  soundboardStatus: el<HTMLParagraphElement>('soundboard-status'),
  soundboardList: el<HTMLDivElement>('soundboard-list'),
  soundVolume: el<HTMLInputElement>('sound-volume'),
  soundDisabled: el<HTMLInputElement>('sound-disabled'),
  soundForm: el<HTMLFormElement>('sound-form'),
  soundName: el<HTMLInputElement>('sound-name'),
  soundFile: el<HTMLInputElement>('sound-file'),
  soundPublishBtn: el<HTMLButtonElement>('sound-publish-btn'),
  log: el<HTMLOListElement>('log'),
  app: el<HTMLElement>('app'),
  sidebar: el<HTMLElement>('sidebar'),
  sidebarToggle: el<HTMLButtonElement>('sidebar-toggle'),
  sidebarToggleIcon: el<HTMLElement>('sidebar-toggle-icon'),
  sidebarClose: el<HTMLButtonElement>('sidebar-close'),
  shellMain: el<HTMLElement>('shell-main'),
  shellBackdrop: el<HTMLButtonElement>('shell-backdrop'),
  shellMenuBtn: el<HTMLButtonElement>('shell-menu-btn'),
  roomsHomeBtn: el<HTMLButtonElement>('rooms-home-btn'),
  roomNav: el<HTMLDivElement>('room-nav'),
  createOpenBtn: el<HTMLButtonElement>('create-open-btn'),
  accountBox: el<HTMLElement>('account-box'),
  contextTitle: el<HTMLElement>('context-title'),
  contextDetail: el<HTMLParagraphElement>('context-detail'),
  createRoom: el<HTMLElement>('create-room'),
  callPanel: el<HTMLElement>('call-panel'),
  roomsBlock: el<HTMLElement>('rooms-block'),
  callBar: el<HTMLElement>('call-bar'),
  callPhase: el<HTMLElement>('call-phase'),
  callMic: el<HTMLElement>('call-mic'),
  voiceTitle: el<HTMLElement>('voice-title'),
  voiceState: el<HTMLParagraphElement>('voice-state'),
  voiceNote: el<HTMLParagraphElement>('voice-note'),
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
let authStorage: AuthStorage;
/** O logout desta aba está em curso: o SIGNED_OUT que ele causa não é "a sessão terminou". */
let loggingOut = false;
let selfUserId: string | null = null;
let call: MeshCall | null = null;
let signaling: MeshSignaling | null = null;
/** Um elemento de áudio por participante: separados, para volume individual e deafen no futuro. */
const remoteAudio = new Map<string, HTMLAudioElement>();
/** Sala da chamada atual (ou da última, até ela terminar) e se a chamada está em curso. */
let callRoomId: string | null = null;
let callActive = false;
let lobby: LobbyController;
let callReturn: CallReturnController;
let sessionLedger: SessionLedger;
let entryGate: EntryGate;
let sweepTimer: ReturnType<typeof setTimeout> | null = null;
let inviteShare: InviteShareController;
let inviteAccept: InviteAcceptController;
let chat: ChatController;
let members: MembersController;
let soundboard: SoundboardController;
let soundCache: SoundCache;
/** Muda a cada chamada nova, logout e desconexão explicada: uma explicação de 4403 antiga não sobrescreve nada. */
let disconnectTicket = 0;
/** Último aviso de reconexão de um par: some quando o par volta ou a chamada termina. */
let lastPeerNotice: string | null = null;
/** JWT atual, lido de forma síncrona no pagehide. Fica só em memória, como a sessão de login. */
let accessToken: string | null = null;

function setField(name: string, value: string): void {
  const node = document.querySelector<HTMLElement>(`[data-field="${name}"]`);
  if (node) node.textContent = value;
  if (name === 'mic') ui.callMic.textContent = micLabel(value);
  if (name === 'phase') {
    voicePhase = value;
    renderVoice();
  }
}

/** Fase da chamada em texto, a mesma do diagnóstico. */
let voicePhase = '—';

/** Painel e barra da chamada. Só lê estado: a barra acompanha a chamada, nunca a sala selecionada. */
function renderVoice(): void {
  const room = ui.callRoom.textContent ?? '';
  const summary = voiceSummary({ active: callActive, phase: voicePhase, room });
  ui.voiceTitle.textContent = summary.title;
  ui.voiceState.textContent = summary.state;
  const note = otherRoomNote(callActive, shell.state.selectedRoomId, callRoomId, room);
  ui.voiceNote.textContent = note ?? '';
  ui.voiceNote.hidden = note === null;
  ui.callPhase.textContent = callActive ? summary.state : '';
  // O botão usado saiu da tela com a barra: o foco do teclado não pode sumir com ele.
  const focusInBar = !callActive && ui.callBar.contains(document.activeElement);
  ui.callBar.hidden = !callActive;
  if (focusInBar) ui.contextTitle.focus();
}

function log(message: string): void {
  const item = document.createElement('li');
  item.textContent = `${new Date().toLocaleTimeString('pt-BR', { hour12: false })} ${message}`;
  ui.log.append(item);
  while (ui.log.childElementCount > 200) ui.log.firstElementChild?.remove();
  ui.log.scrollTop = ui.log.scrollHeight;
}

/** Aviso da página: informação (role=status) ou erro (role=alert). Sempre como texto. */
function showNotice(notice: Notice | null): void {
  ui.error.textContent = notice?.text ?? '';
  ui.error.hidden = notice === null;
  ui.error.setAttribute('role', notice?.tone === 'info' ? 'status' : 'alert');
  ui.error.className = notice?.tone === 'info' ? 'notice' : 'error';
}

function showError(message: string | null): void {
  showNotice(message === null ? null : { tone: 'error', text: message });
}

const SESSION_ENDED: Notice = { tone: 'info', text: 'Sua sessão de login terminou. Faça login de novo.' };
const ACCOUNT_CHANGED: Notice = { tone: 'info', text: 'Outra aba entrou com outra conta: esta chamada foi encerrada.' };
const SESSION_UNVERIFIED: Notice = { tone: 'error', text: 'Não foi possível verificar seu login agora (sem conexão com o servidor). Tente recarregar ou faça login.' };

/** Código de erro do Auth exibível: só [a-z0-9_-] curto (nunca a mensagem inteira). */
const authCode = (code: unknown): string => (typeof code === 'string' && /^[a-z0-9_-]{1,40}$/.test(code) ? code : 'erro');

// ---------- áudio remoto ----------

function setRemote(session: string, stream: MediaStream | null): void {
  const current = remoteAudio.get(session);
  if (current) {
    current.pause();
    current.srcObject = null;
    current.remove();
    remoteAudio.delete(session);
  }
  if (stream) {
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.srcObject = stream;
    ui.audioContainer.append(audio);
    remoteAudio.set(session, audio);
    audio.play().catch(() => {
      ui.listenBtn.hidden = false; // autoplay bloqueado: o usuário libera com um clique
      log('Reprodução do áudio remoto bloqueada pelo navegador: clique em "Ouvir".');
    });
  }
  if (remoteAudio.size === 0) ui.listenBtn.hidden = true;
}

ui.listenBtn.addEventListener('click', () => {
  void Promise.all([...remoteAudio.values()].map((a) => a.play()))
    .then(() => (ui.listenBtn.hidden = true))
    .catch(() => undefined);
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
  if (!active) ui.muteBtn.textContent = 'Mutar';
  if (phase === 'ended' && ui.error.className === 'notice' && lastPeerNotice === ui.error.textContent) showNotice(null);
  // A entrada na sala foi aceita: é a sala para a qual a aba pode voltar depois de recarregar.
  if ((phase === 'waiting-peer' || phase === 'negotiating' || phase === 'connected') && callRoomId) callReturn.remember(callRoomId);
  // O dono encerrou a sala desta chamada por aqui: a queda que isso causa não é erro para quem encerrou.
  if (phase === 'failed' && isClosingOwnCall(lobby?.state.busy ?? null, callRoomId)) setField('phase', PHASES.ended);
  if (phase === 'failed' && error === JOIN_LIMIT_MESSAGE && callRoomId) {
    // O join_room recusou depois de a verificação liberar: quem decide é o servidor. O microfone já foi liberado.
    entryGate.blockedByServer(callRoomId);
  } else if (phase === 'failed' && error && !isClosingOwnCall(lobby?.state.busy ?? null, callRoomId)) {
    const code = Number(/código (\d{4})/.exec(error)?.[1]);
    const technical = formatCallError(error, DISCONNECT_MESSAGES[code]);
    if (code === DISCONNECT.session && callRoomId) {
      // Sem veredito ainda: aviso neutro; o motivo vem da lista de salas (o código fica no registro).
      showNotice(DISCONNECT_CHECKING);
      setField('phase', 'verificando o motivo');
      const ticket = ++disconnectTicket;
      const user = selfUserId;
      const room = callRoomId;
      void explainDisconnect(room, technical, {
        listRooms: () => createSupabaseBackend(client).rpc<unknown[]>('list_my_rooms', {}),
        isCurrent: () => ticket === disconnectTicket && !callActive && selfUserId === user,
        onKind: (kind) => {
          if (kind === 'closed' || kind === 'not-member') callReturn.forget(room);
        },
        show: (notice) => {
          showNotice(notice);
          setField('phase', PHASES[disconnectPhase(notice)]);
        },
      });
    } else {
      showNotice({ tone: 'error', text: technical });
    }
  }
  if (phase === 'ended' || phase === 'failed') {
    sessionLedger.releaseEntry(); // saiu antes de registrar a sessão, inclusive por recusa do microfone
    signaling = null;
    soundboard.leave();
    ui.participants.hidden = true;
    if (lobby.state.status !== 'idle') void lobby.refresh(); // contagens e estado das salas mudaram
  }
  renderRooms();
}

function renderSoundboardPanel(state: SoundboardState): void {
  ui.soundboard.hidden = state.status === 'closed';
  ui.soundVolume.value = String(Math.round(state.volume * 100));
  ui.soundDisabled.checked = state.disabled;
  ui.soundForm.hidden = !state.isOwner || state.status !== 'ready';
  ui.soundPublishBtn.disabled = state.publishing;
  ui.soundPublishBtn.textContent = state.publishing ? 'Publicando…' : 'Publicar';
  const status = soundboardStatus(state);
  ui.soundboardStatus.hidden = status === null;
  ui.soundboardStatus.textContent = status ?? '';
  ui.soundboardStatus.className = state.message?.tone === 'error' ? 'error' : 'muted';
  ui.soundboardList.replaceChildren(
    renderSoundboard(document, state, { onTrigger: (id) => void soundboard.trigger(id), onRemove: (id) => void soundboard.remove(id) }),
  );
}

function renderCallParticipants(list: readonly ParticipantView[], standby: boolean): void {
  soundboard.setStandby(standby);
  ui.participants.hidden = !callActive;
  ui.participants.replaceChildren(renderParticipants(document, list, standby));
  // O par voltou: o aviso de reconexão deixa de valer.
  if (lastPeerNotice !== null && ui.error.textContent === lastPeerNotice && list.every((p) => p.state === 'connected')) {
    showNotice(null);
    lastPeerNotice = null;
  }
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

/** Sempre por ação do usuário. O microfone só é pedido depois da verificação, e o join_room ainda decide a entrada. */
function startCall(roomInput: string): void {
  if (callActive || entryGate.checking) return; // uma chamada por vez
  callReturn.hide(); // entrar em qualquer chamada substitui a oferta de retorno
  disconnectTicket += 1; // explicação pendente de uma chamada anterior não aparece nesta
  showError(null);
  const roomId = roomInput.trim().toLowerCase();
  if (!isUuid(roomId)) return showError('ID da sala inválido: informe o UUID da sala.');
  if (!selfUserId) return showError('Faça login antes de entrar na chamada.');
  const userId = selfUserId;
  void entryGate.check(roomId).then((verdict) => {
    if (verdict !== 'go') return;
    if (!callActive && selfUserId === userId) beginCall(roomId, userId);
    else sessionLedger.releaseEntry();
  });
}

function beginCall(roomId: string, userId: string): void {
  callRoomId = roomId;
  ui.room.value = roomId;
  ui.callRoom.textContent = lobby.state.rooms.find((r) => r.room_id === roomId)?.name ?? roomId;
  const backend = createSupabaseBackend(client, { url: cfg.supabaseUrl, publishableKey: cfg.publishableKey, accessToken: () => accessToken });
  ui.status.hidden = false;
  ui.log.replaceChildren();

  const current: MeshCall = new MeshCall(
    {
      getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
      createPeerConnection: (c) => new RTCPeerConnection(c),
      createRoom: (events, onDisconnected) => {
        signaling = new MeshSignaling({ backend, roomId, selfUserId: userId, events, onDisconnected, iceServers: cfg.iceServers, tracker: sessionLedger.tracker(userId, roomId), log: (m) => call === current && log(m) });
        return signaling;
      },
      iceServers: cfg.iceServers,
      audioCodecs: () => RTCRtpReceiver.getCapabilities?.('audio')?.codecs ?? null,
      iceMode: 'direct', // só STUN nesta etapa
    },
    {
      onPhase: (phase, error) => call === current && renderPhase(phase, error),
      onParticipants: (list, standby) => {
        if (call === current) renderCallParticipants(list, standby);
      },
      onRemoteAudio: (session, stream) => call === current && setRemote(session, stream),
      onPeerStates: (s) => call === current && renderPeer(s),
      onLocalStream: (s) => call === current && setField('mic', s ? (current.muted ? 'capturando (mutado)' : 'capturando') : 'liberado'),
      onStats: (s) => call === current && renderStats(s),
      onLog: (m) => call === current && log(m),
      onIce: (info) => call === current && log(info ? `ICE: ${info.summary}.` : 'ICE: configuração descartada.'),
      onSound: (payload) => {
        if (call === current) soundboard.onEvent(payload);
      },
      onPeerProblem: (name, kind) => {
        if (call !== current) return;
        const notice = peerProblemNotice(name, kind);
        lastPeerNotice = notice.text;
        showNotice(notice);
      },
    },
  );
  call = current;
  callActive = true; // antes da primeira fase: um segundo clique não abre outra chamada
  soundboard.enter(roomId, userId, lobby.state.rooms.find((r) => r.room_id === roomId)?.role === 'owner');
  renderRooms();
  void current.start();
}

/** Encerra a chamada e espera a saída da sala (leave_room precisa do JWT ainda válido). */
async function endCall(): Promise<void> {
  const s = signaling;
  call?.end();
  await s?.closed.catch(() => undefined);
}

// ---------- sons ----------

ui.soundVolume.addEventListener('input', () => soundboard.setVolume(Number(ui.soundVolume.value) / 100));
ui.soundDisabled.addEventListener('change', () => soundboard.setDisabled(ui.soundDisabled.checked));
ui.soundForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const file = ui.soundFile.files?.[0];
  if (!file) return;
  void soundboard.publish(file, ui.soundName.value).then(() => {
    if (soundboard.state.message?.tone === 'info') {
      ui.soundName.value = '';
      ui.soundFile.value = '';
    }
  });
});
// O navegador só libera o áudio depois de uma interação com a página.
document.addEventListener('pointerdown', () => soundboard?.unlock());

ui.joinBtn.addEventListener('click', () => startCall(ui.room.value));
ui.muteBtn.addEventListener('click', () => {
  if (!call) return;
  call.setMuted(!call.muted);
  ui.muteBtn.textContent = call.muted ? 'Reativar microfone' : 'Mutar';
  setField('mic', call.muted ? 'capturando (mutado)' : 'capturando');
});
ui.leaveBtn.addEventListener('click', () => {
  callReturn.forget();
  void endCall();
});
// Fechar ou recarregar a aba: sai da sala por um envio que sobrevive ao descarregamento. É só melhor esforço: se ele
// não chegar, session-ledger.ts encerra a sessão quando este navegador voltar; se isso não for possível, ela vence
// sozinha em até 90 s.
window.addEventListener('pagehide', () => {
  signaling?.closeOnPageHide();
  call?.end();
});

// Volta do bfcache: o pagehide já encerrou a chamada desta página. Só atualiza o que pode ter mudado enquanto ela esteve
// guardada; nada é iniciado sozinho.
window.addEventListener('pageshow', (event) => {
  if (!event.persisted || selfUserId === null) return;
  void sweepOrphans(selfUserId);
  void lobby.refresh();
});

// ---------- sessões abandonadas e entrada bloqueada ----------

/** Encerra as órfãs deste navegador; as que ainda estão na carência são revistas depois, sem pedir nada à pessoa. */
function sweepOrphans(userId: string): Promise<unknown> {
  if (sweepTimer !== null) clearTimeout(sweepTimer);
  sweepTimer = null;
  return sessionLedger.reclaim(userId).then(({ pending }) => {
    if (pending > 0 && selfUserId === userId) sweepTimer = setTimeout(() => void sweepOrphans(userId), 10_000);
  });
}

function renderEntry(s: EntryState): void {
  ui.entryState.hidden = s.status === 'idle';
  ui.entryGoBtn.hidden = s.status !== 'released';
  ui.entryRecheckBtn.hidden = !(s.status === 'error' || (s.status === 'blocked' && !s.polling));
  ui.entryCancelBtn.hidden = s.status === 'checking';
  const text =
    s.status === 'checking'
      ? ENTRY_CHECKING
      : s.status === 'released'
        ? ENTRY_RELEASED
        : s.status === 'error'
          ? entryErrorMessage(s.code)
          : s.status === 'blocked'
            ? `${blockedMessage(s.reason, sessionLedger.supported)}${s.polling ? '' : ` ${ENTRY_STILL_BLOCKED}`}`
            : '';
  ui.entryMessage.textContent = text;
  ui.entryMessage.className = s.status === 'error' ? 'error' : 'notice';
  ui.entryMessage.setAttribute('role', s.status === 'error' ? 'alert' : 'status');
  renderRooms();
}

const entryRoom = (): string | null => {
  const s = entryGate.state;
  return s.status === 'idle' ? null : s.roomId;
};
ui.entryGoBtn.addEventListener('click', () => {
  const roomId = entryRoom();
  if (roomId) startCall(roomId);
});
ui.entryRecheckBtn.addEventListener('click', () => {
  const roomId = entryRoom();
  if (roomId) startCall(roomId);
});
ui.entryCancelBtn.addEventListener('click', () => entryGate.reset());

// ---------- retorno à chamada depois de recarregar a aba ----------

function renderReturn(state: ReturnState): void {
  ui.returnCall.hidden = state.status !== 'offer';
  if (state.status !== 'offer') return;
  ui.returnRoom.textContent = state.name;
  ui.returnBtn.disabled = state.busy;
  ui.returnDismissBtn.disabled = state.busy;
}

ui.returnBtn.addEventListener('click', () => void callReturn.accept());
ui.returnDismissBtn.addEventListener('click', () => callReturn.dismiss());

// ---------- lobby (MVP 01) ----------

function renderShell(state: ShellState): void {
  ui.app.dataset['sidebar'] = state.collapsed ? 'collapsed' : 'expanded';
  ui.app.dataset['drawer'] = state.drawerOpen ? 'open' : 'closed';
  const label = state.collapsed ? 'Expandir barra lateral' : 'Recolher barra lateral';
  ui.sidebarToggle.setAttribute('aria-expanded', String(!state.collapsed));
  ui.sidebarToggle.setAttribute('aria-label', label);
  ui.sidebarToggle.title = label;
  ui.sidebarToggleIcon.textContent = state.collapsed ? '›' : '‹';
  ui.shellMenuBtn.setAttribute('aria-expanded', String(state.drawerOpen));
  ui.shellBackdrop.hidden = !state.drawerOpen;
  ui.shellMain.inert = state.drawerOpen; // o foco fica na navegação enquanto ela cobre o conteúdo
  ui.callBar.inert = state.drawerOpen;
  renderRooms();
}

const shell = new ShellController(renderShell);

function renderRooms(): void {
  if (!lobby) return;
  const s = lobby.state;
  const busy = s.busy !== null;
  if (s.status === 'ready') shell.reconcile(s.rooms.map((r) => r.room_id));
  const { selectedRoomId } = shell.state;
  const context = roomContext(s, selectedRoomId);
  ui.contextTitle.textContent = context.title;
  ui.contextDetail.textContent = context.detail ?? '';
  ui.contextDetail.hidden = context.detail === null;
  ui.createRoom.hidden = selectedRoomId !== null;
  // Sala aberta: as ações dela vêm antes da voz. Na visão geral, a voz vem antes de uma lista que pode ser longa. A troca é
  // no DOM, para o teclado seguir a ordem da tela, e só quando muda, para não tirar o foco de quem está no bloco.
  const roomFirst = selectedRoomId !== null;
  if (roomFirst && ui.callPanel.previousElementSibling !== ui.roomsBlock) ui.callPanel.before(ui.roomsBlock);
  if (!roomFirst && ui.callPanel.nextElementSibling !== ui.roomsBlock) ui.callPanel.after(ui.roomsBlock);
  renderVoice();
  ui.app.dataset['view'] = selectedRoomId === null ? 'all' : 'room';
  if (selectedRoomId === null) ui.roomsHomeBtn.setAttribute('aria-current', 'true');
  else ui.roomsHomeBtn.removeAttribute('aria-current');
  replaceKeepingFocus(
    ui.roomNav,
    renderRoomNav(document, s, {
      selectedRoomId,
      activeRoomId: callActive ? callRoomId : null,
      onSelect: (roomId) => navigate(roomId),
    }),
  );
  replaceKeepingFocus(
    ui.rooms,
    renderLobby(document, s, {
      selectedRoomId,
      callActive: callActive || entryGate.checking,
      activeRoomId: callActive ? callRoomId : null,
      onJoin: (roomId) => startCall(roomId),
      onClose: (roomId) => void lobby.close(roomId),
      inviteBusy: inviteShare.state.busy,
      onInvite: (roomId) => void inviteShare.open(roomId),
      onRevokeInvites: (roomId) => void inviteShare.revoke(roomId, lobby.state.rooms.find((r) => r.room_id === roomId)?.name ?? ''),
      chatRoomId: chat?.state.roomId ?? null,
      onChat: openChat,
      membersRoomId: members?.state.roomId ?? null,
      onMembers: openMembers,
    }),
  );
  ui.roomsError.textContent = s.actionError ?? '';
  ui.roomsError.hidden = s.actionError === null;
  ui.refreshBtn.disabled = busy || s.status === 'loading';
  ui.createBtn.disabled = busy;
  ui.createName.disabled = busy;
  ui.createDisplay.disabled = busy;
  ui.createCapacity.disabled = busy;
}

/** Abre uma sala ou a visão geral. Só muda o que é mostrado: entrar na chamada segue sendo uma ação à parte. */
function navigate(roomId: string | null): void {
  const covering = shell.state.drawerOpen;
  shell.select(roomId);
  if (covering) ui.contextTitle.focus(); // a navegação saiu da tela, e o foco não pode sumir com ela
}

function closeDrawer(): void {
  if (!shell.state.drawerOpen) return;
  shell.closeDrawer();
  ui.shellMenuBtn.focus();
}

ui.sidebarToggle.addEventListener('click', () => shell.toggleCollapsed());
ui.sidebarClose.addEventListener('click', closeDrawer);
ui.shellBackdrop.addEventListener('click', closeDrawer);
ui.shellMenuBtn.addEventListener('click', () => {
  shell.openDrawer();
  ui.sidebarClose.focus();
});
ui.roomsHomeBtn.addEventListener('click', () => navigate(null));
ui.createOpenBtn.addEventListener('click', () => {
  shell.select(null);
  ui.createName.focus();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeDrawer();
});
// A janela cresceu com a navegação aberta: na tela grande ela não cobre mais nada.
window.matchMedia('(max-width: 768px)').addEventListener('change', (event) => {
  if (!event.matches) shell.closeDrawer();
});

ui.refreshBtn.addEventListener('click', () => void lobby.refresh());
ui.createForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void lobby.create(ui.createName.value, ui.createDisplay.value, Number(ui.createCapacity.value)).then((id) => {
    if (id) ui.createName.value = '';
  });
});

// ---------- membros da sala ----------

function openMembers(roomId: string): void {
  const room = lobby.state.rooms.find((r) => r.room_id === roomId);
  if (!room) return;
  members.open(roomId, room.name, !room.is_open);
  ui.members.scrollIntoView({ block: 'nearest' });
}

let membersRenderedRoom: string | null = null;

function renderMembersPanel(s: MembersState): void {
  ui.members.hidden = s.status === 'closed';
  ui.membersRoom.textContent = s.roomName;
  setMessage(ui.membersStatus, s.status === 'error' ? { tone: 'error', text: MEMBERS_LOAD_FAILED } : s.message);
  ui.membersList.replaceChildren(
    renderMembers(document, s, {
      canManage: members.canManage,
      onLeave: () => void members.leave(),
      onRemove: (ref) => void members.remove(ref),
    }),
  );
  if (membersRenderedRoom !== s.roomId) {
    membersRenderedRoom = s.roomId;
    renderRooms(); // o botão "Membros abertos": sem redesenhar o lobby a cada consulta
  }
}

ui.membersCloseBtn.addEventListener('click', () => members.close());

// ---------- chat por sala ----------

function openChat(roomId: string): void {
  const room = lobby.state.rooms.find((r) => r.room_id === roomId);
  if (!room) return;
  chat.open(roomId, !room.is_open);
  ui.chat.scrollIntoView({ block: 'nearest' });
}

let chatRenderedRoom: string | null = null;
let chatDeniedRefreshed = false;

function renderChat(s: ChatState): void {
  ui.chat.hidden = s.status === 'closed';
  ui.chatRoom.textContent = lobby.state.rooms.find((r) => r.room_id === s.roomId)?.name ?? '';
  setMessage(ui.chatStatus, chatStatusText(s));
  // Só desce sozinho se a pessoa já estava no fim: quem está lendo o histórico não perde o lugar.
  const box = ui.chatMessages;
  const atEnd = chatRenderedRoom !== s.roomId || box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const previousHeight = box.scrollHeight;
  const previousTop = box.scrollTop;
  const firstSeq = box.dataset['firstSeq'];
  box.replaceChildren(
    renderChatMessages(document, s, {
      onRetry: (nonce) => chat.retry(nonce),
      onDiscard: (nonce) => chat.discard(nonce),
      onLoadOlder: () => void chat.loadOlder(),
    }),
  );
  const newFirst = String(s.messages[0]?.seq ?? '');
  box.dataset['firstSeq'] = newFirst;
  if (atEnd) box.scrollTop = box.scrollHeight;
  else if (firstSeq !== newFirst) box.scrollTop = previousTop + box.scrollHeight - previousHeight; // página anterior: mantém a posição
  const roomChanged = chatRenderedRoom !== s.roomId;
  chatRenderedRoom = s.roomId;
  ui.chatForm.hidden = s.readOnly || s.status === 'denied';
  ui.chatSendBtn.disabled = s.status !== 'ready';
  if (roomChanged) renderRooms(); // o botão "Chat aberto": sem redesenhar o lobby a cada mensagem
  // Recusa do servidor: a pertença acabou. A lista de salas deixa de mostrar esta.
  if (s.status === 'denied' && !chatDeniedRefreshed) {
    chatDeniedRefreshed = true;
    void lobby.refresh();
  }
  if (s.status !== 'denied') chatDeniedRefreshed = false;
}

function submitChat(): void {
  if (chat.send(ui.chatInput.value)) ui.chatInput.value = '';
  ui.chatInput.focus();
}

ui.chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  submitChat();
});
// Enter envia e Shift+Enter quebra a linha. Durante a composição de um acento (IME), Enter é da composição.
ui.chatInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || ui.chatSendBtn.disabled) return;
  event.preventDefault();
  submitChat();
});
ui.chatCloseBtn.addEventListener('click', () => chat.close());

// ---------- convites (MVP 02) ----------

function setMessage(node: HTMLElement, message: { tone: 'info' | 'error'; text: string } | null): void {
  node.textContent = message?.text ?? '';
  node.hidden = message === null;
  node.setAttribute('role', message?.tone === 'error' ? 'alert' : 'status');
  node.className = message?.tone === 'error' ? 'error' : 'notice';
}

function renderInviteShare(s: InviteShareState): void {
  const opening = ui.inviteShare.hidden && s.roomId !== null;
  ui.inviteShare.hidden = s.roomId === null;
  ui.inviteShareRoom.textContent = lobby.state.rooms.find((r) => r.room_id === s.roomId)?.name ?? '';
  ui.inviteShareBox.hidden = s.link === null;
  ui.inviteLink.value = s.link ?? '';
  ui.inviteExpiry.textContent = s.expiresAt === null ? '' : new Date(s.expiresAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  ui.inviteNativeShareBtn.hidden = typeof navigator.share !== 'function';
  ui.inviteShareStatus.textContent = s.revoking ? 'Revogando convites…' : 'Gerando convite…';
  ui.inviteShareStatus.hidden = !s.busy;
  setMessage(ui.inviteShareMessage, s.message);
  ui.inviteNewBtn.hidden = !s.expired;
  ui.inviteCloseBtn.disabled = s.busy;
  if (opening) ui.inviteShare.scrollIntoView({ block: 'nearest' });
  renderRooms();
}

function renderInviteAccept(s: InviteAcceptState): void {
  const hint = inviteLoginHint(s);
  ui.inviteLoginHint.textContent = hint ?? '';
  ui.inviteLoginHint.hidden = hint === null;
  ui.inviteAccept.hidden = selfUserId === null || s.status === 'none';
  ui.inviteAcceptPending.hidden = s.status !== 'pending';
  ui.inviteAccount.textContent = ui.userLabel.textContent;
  const busy = s.status === 'pending' && s.busy;
  ui.inviteAcceptBtn.disabled = busy;
  ui.inviteDeclineBtn.disabled = busy;
  ui.inviteDisplay.disabled = busy;
  if (s.status !== 'pending') ui.inviteDisplay.value = '';
  if (s.status === 'result') setMessage(ui.inviteAcceptMessage, { tone: s.tone, text: s.text });
  else setMessage(ui.inviteAcceptMessage, s.status === 'pending' && s.message ? { tone: 'error', text: s.message } : null);
  ui.inviteDismissBtn.hidden = s.status !== 'result';
}

ui.inviteCopyBtn.addEventListener('click', () => void inviteShare.copy());
ui.inviteNativeShareBtn.addEventListener('click', () => void inviteShare.share());
ui.inviteNewBtn.addEventListener('click', () => {
  const { roomId } = inviteShare.state;
  if (roomId) void inviteShare.open(roomId);
});
ui.inviteCloseBtn.addEventListener('click', () => inviteShare.close());
ui.inviteAcceptForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void inviteAccept.accept(ui.inviteDisplay.value);
});
ui.inviteDeclineBtn.addEventListener('click', () => inviteAccept.decline());
ui.inviteDismissBtn.addEventListener('click', () => inviteAccept.dismiss());
// O link aberto numa aba que já está na página não recarrega: só o fragmento muda.
window.addEventListener('hashchange', () => inviteAccept?.receive(takeInvite()));

// ---------- login ----------

function showLoggedIn(email: string | undefined): void {
  ui.login.hidden = true;
  ui.account.hidden = false;
  ui.userLabel.textContent = email ?? '(conta sem e-mail)';
  ui.accountBox.title = email ?? '';
  renderInviteAccept(inviteAccept.state);
}

/** Entrada na conta, por login ou sessão restaurada. Nunca inicia chamada nem pede o microfone. */
async function enterSession(session: Session): Promise<void> {
  if (selfUserId === session.user.id) return;
  selfUserId = session.user.id;
  accessToken = session.access_token;
  // Canais privados exigem o JWT do usuário no Realtime antes da inscrição.
  await client.realtime.setAuth(session.access_token);
  showLoggedIn(session.user.email);
  void sweepOrphans(session.user.id);
  void lobby.refresh();
  void callReturn.offer();
}

/** A sessão acabou fora deste botão de logout (revogada, renovação recusada, logout ou troca de conta em outra aba). */
function endByAuth(notice: Notice): void {
  callReturn.forget();
  // O supabase-js não envia mais o token: o leave_room pela RPC receberia 401 e deixaria uma sessão fantasma.
  signaling?.closeOnPageHide();
  call?.end();
  showLoggedOut();
  showNotice(notice);
}

function showLoggedOut(): void {
  soundboard.leave();
  if (selfUserId !== null) void soundCache.purgeAccount(selfUserId);
  selfUserId = null;
  accessToken = null;
  disconnectTicket += 1;
  if (ui.error.textContent === DISCONNECT_CHECKING.text) showNotice(null); // a explicação pendente foi descartada
  if (sweepTimer !== null) clearTimeout(sweepTimer);
  sweepTimer = null;
  entryGate.reset();
  chat.close();
  members.close();
  ui.chatInput.value = '';
  lobby.reset();
  inviteShare.reset();
  callReturn.reset();
  inviteAccept.accountChanged();
  renderInviteAccept(inviteAccept.state);
  shell.reset();
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
    await enterSession(data.session);
  });
});

ui.logoutBtn.addEventListener('click', () => {
  void (async () => {
    loggingOut = true;
    callReturn.forget();
    await endCall();
    await logout(client, authStorage);
    showLoggedOut();
    loggingOut = false;
  })();
});

// ---------- inicialização ----------

try {
  cfg = parseWebConfig(import.meta.env as unknown as Record<string, string | undefined>);
  // Sessão persistida pelo Auth; autoRefreshToken renova o JWT (o supabase-js repassa o token novo ao Realtime).
  // Nenhuma chave além da publicável.
  authStorage = createAuthStorage();
  client = createClient(cfg.supabaseUrl, cfg.publishableKey, { auth: authOptions(authStorage) });
  const backend = createSupabaseBackend(client);
  sessionLedger = createBrowserLedger((sessionId) => backend.rpc('leave_room', { p_session_id: sessionId }));
  entryGate = new EntryGate({
    reclaim: () => (selfUserId ? sweepOrphans(selfUserId) : Promise.resolve()),
    heldElsewhere: (roomId) => (selfUserId ? sessionLedger.heldElsewhere(selfUserId, roomId) : Promise.resolve([])),
    reserve: (roomId) => (selfUserId ? sessionLedger.reserveEntry(selfUserId, roomId) : Promise.resolve(true)),
    release: () => sessionLedger.releaseEntry(),
    entryHeldElsewhere: (roomId) => (selfUserId ? sessionLedger.entryHeldElsewhere(selfUserId, roomId) : Promise.resolve(false)),
    roster: (roomId) => backend.rpc<unknown[]>('get_roster', { p_room_id: roomId }),
    onChange: renderEntry,
  });
  callReturn = new CallReturnController({
    store: new ReturnRoomStore(),
    listRooms: () => backend.rpc<unknown[]>('list_my_rooms', {}),
    start: (roomId) => startCall(roomId),
    notify: showNotice,
    onChange: renderReturn,
  });
  inviteShare = new InviteShareController({
    rpc: (fn, args) => backend.rpc(fn, args),
    link: (token) => buildInviteLink(window.location, token),
    copy: (link) => navigator.clipboard.writeText(link),
    share: (link) =>
      navigator.share({ title: 'Convite para uma sala do Oryn', url: link }).then(
        () => true,
        (error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError') return false;
          throw error;
        },
      ),
    confirm: (message) => window.confirm(message),
    onRevoked: () => void lobby.refresh(),
    onChange: renderInviteShare,
  });
  inviteAccept = new InviteAcceptController({
    rpc: (fn, args) => backend.rpc(fn, args),
    onMember: () => void lobby.refresh(),
    onChange: renderInviteAccept,
  });
  inviteAccept.receive(arrivedInvite);
  lobby = new LobbyController({
    rpc: (fn, args) => backend.rpc(fn, args),
    confirm: (message) => window.confirm(message),
    onChange: (state) => {
      if (state.status === 'ready') {
        inviteShare.syncRooms(state.rooms);
        chat.syncRooms(state.rooms);
        // Cobre remoção e encerramento, inclusive os ocorridos com este aparelho fora da sala.
        if (selfUserId !== null) void soundCache.retainRooms(selfUserId, new Set(state.rooms.filter((r) => r.is_open).map((r) => r.room_id)));
        const callRoom = state.rooms.find((r) => r.room_id === soundboard.state.roomId);
        if (callRoom) soundboard.setOwner(callRoom.room_id, callRoom.role === 'owner');
      }
      renderRooms();
    },
    // O dono encerrou a sala da própria chamada: sai dela aqui, sem esperar o aviso do servidor.
    onClosed: async (roomId) => {
      callReturn.forget(roomId);
      inviteShare.forget(roomId);
      if (callActive && callRoomId === roomId) await endCall();
    },
  });
  members = new MembersController({
    rpc: (fn, args) => backend.rpc(fn, args),
    confirm: (message) => window.confirm(message),
    isHidden: () => document.hidden,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    onChange: renderMembersPanel,
    // A sessão ainda vale aqui: leave_room e o aviso aos outros saem antes de a pertença acabar.
    beforeLeave: async (roomId) => {
      callReturn.forget(roomId);
      if (callActive && callRoomId === roomId) await endCall();
    },
    onLeft: (roomId) => {
      if (selfUserId !== null) void soundCache.purgeRoom(selfUserId, roomId);
      if (chat.state.roomId === roomId) chat.close();
      inviteShare.forget(roomId);
      void lobby.refresh();
    },
    onDenied: () => void lobby.refresh(),
    onChanged: () => void lobby.refresh(),
  });
  soundCache = new SoundCache(createBrowserSoundStore(), () => Date.now());
  soundboard = new SoundboardController({
    rpc: (fn, args) => backend.rpc(fn, args),
    upload: async (key, body) => !(await client.storage.from('oryn-sounds').upload(key, body, { contentType: body.type, upsert: false })).error,
    download: async (key) => {
      const { data, error } = await client.storage.from('oryn-sounds').download(key);
      return error || !data ? null : data.arrayBuffer();
    },
    invokeMedia: async (body) => {
      const { data, error } = await client.functions.invoke('sound-media', { body });
      if (!error) return { status: 200, body: (data ?? {}) as Record<string, unknown> };
      if (error instanceof FunctionsHttpError) {
        const res = error.context as Response;
        return { status: res.status, body: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
      }
      return { status: 0, body: {} };
    },
    cache: soundCache,
    bus: new SoundBus(() => new AudioContext()),
    loadPrefs: loadSoundPrefs,
    savePrefs: saveSoundPrefs,
    sessionId: () => signaling?.ownSession ?? null,
    wallNow: () => Date.now(),
    monoNow: () => performance.now(),
    isHidden: () => document.hidden,
    confirm: (message) => window.confirm(message),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    onChange: renderSoundboardPanel,
  });
  renderSoundboardPanel(soundboard.state);
  chat = new ChatController({
    rpc: (fn, args) => backend.rpc(fn, args),
    newNonce: () => crypto.randomUUID(),
    isHidden: () => document.hidden,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    onChange: renderChat,
    onRoomClosed: () => void lobby.refresh(),
  });
  client.auth.onAuthStateChange((event, session) => {
    // Sem sessão, guarda o último JWT: ainda é preciso sair da sala (ver endByAuth); showLoggedOut o descarta.
    accessToken = session?.access_token ?? accessToken;
    if (event === 'TOKEN_REFRESHED') log('Token de acesso renovado.');
    // Fora do callback: o Auth segura uma trava aqui, e as RPCs que estas saídas disparam também precisam dela.
    setTimeout(() => {
      if (event === 'SIGNED_OUT') {
        // Sessão revogada, renovação recusada ou logout em outra aba: a chamada não continua sem identidade válida.
        if (selfUserId !== null && !loggingOut) endByAuth(SESSION_ENDED);
      } else if (session && selfUserId !== null && session.user.id !== selfUserId) {
        // O armazenamento é do navegador: outra aba entrou com outra conta, e esta aba não pode seguir misturando as duas.
        endByAuth(ACCOUNT_CHANGED);
        void enterSession(session);
      } else if (event === 'SIGNED_IN' && session && selfUserId === null && !loggingOut) {
        void enterSession(session); // login feito em outra aba
      }
    });
  });
  if (cfg.defaultRoomId) ui.room.value = cfg.defaultRoomId;
  void restoreSession(client, authStorage).then(async (restored) => {
    if (restored.status === 'valid' || restored.status === 'unverified') return enterSession(restored.session);
    ui.login.hidden = false;
    if (restored.status === 'revoked') showNotice(SESSION_ENDED);
    if (restored.status === 'unavailable') showNotice(SESSION_UNVERIFIED);
  }).catch(() => {
    ui.login.hidden = false;
  });
} catch (error) {
  ui.configError.textContent = `Configuração inválida: ${error instanceof Error ? error.message : 'erro'}. Veja .env.example.`;
  ui.configError.hidden = false;
}
