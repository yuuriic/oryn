// Página da integração 02C: cadastro/login por e-mail, identidade global, sala,
// chamada de voz em grupo (MeshCall: até 5 contas, uma conexão por par, com volume individual em voice-mix.ts) e sinalização pelo Supabase (MeshSignaling).
// MVP 01: lobby com as salas da conta (listar, criar com 2 lugares, entrar e encerrar), em rooms.ts e
// rooms-view.ts; o campo de UUID ficou em "Diagnóstico". Chat por sala, em chat.ts e chat-view.ts, sem nenhuma
// ligação com a chamada.
//
// Sigilo: a senha só passa do campo para o supabase-js e o campo é limpo em seguida; a sessão de login é guardada
// pelo mecanismo oficial do Auth (auth-session.ts; riscos no runbook §14.6) e o ID da sala, em call-return.ts;
// o convite de sala (invites.ts) sai da URL ao carregar e fica só em memória; o registro em tela nunca mostra token, SDP,
// candidato ICE ou senha. A configuração aceita só a chave publicável (config.ts).

import { FunctionsHttpError, createClient, type Session, type SupabaseClient, type User } from '@supabase/supabase-js';
import {
  LINK_INVALID, NAME_ERROR, PASSWORD_CHANGED, PASSWORD_CHANGED_PARTIAL, RECOVERY_CANCELLED, RECOVERY_EXPIRED,
  abandonRecovery, accountName, openRecovery, recoveryAuthOptions, recoveryRedirect, registerAccount, requestPasswordReset,
  saveAccountName, saveNewPassword, takeAuthLink, type RecoveryTokens,
} from './identity.ts';
import { isUuid } from '../../supabase/functions/_shared/signal-contract.ts';
import { authOptions, createAuthStorage, logout, restoreSession, type AuthStorage } from './auth-session.ts';
import type { CallPhase, CallStats, PeerStates } from './call.ts';
import { ChatController, type ChatState } from './chat.ts';
import { ChannelsController, defaultChannel, isChannelName, renderChannelNav, type ChannelKind } from './channels.ts';
import { DraftBook, draftKey } from './drafts.ts';
import { incomingLabel } from './incoming-audio.ts';
import { formatPhoneBR, passwordChecks, validateLogin, validateSignup, type SignupErrors, type SignupField, type SignupInput } from './auth-form.ts';
import { chatStatusText, renderChatMessages } from './chat-view.ts';
import { CallReturnController, ReturnRoomStore, type ReturnState } from './call-return.ts';
import { parseWebConfig, publicLocation, type WebConfig } from './config.ts';
import { ENTRY_CHECKING, ENTRY_RELEASED, ENTRY_STILL_BLOCKED, EntryGate, blockedMessage, entryErrorMessage, type EntryState } from './entry-gate.ts';
import { InviteAcceptController, InviteShareController, buildInviteLink, inviteLoginHint, takeInviteFromLocation, type InviteAcceptState, type InviteArrival, type InviteShareState } from './invites.ts';
import { MembersController, MEMBERS_LOAD_FAILED, type MembersState } from './members.ts';
import { renderMembers, renderParticipants, volumeButtonLabel } from './members-view.ts';
import { MeshCall, type ParticipantView } from './mesh-call.ts';
import { MeshSignaling } from './mesh-signaling.ts';
import { DISCONNECT_CHECKING, LobbyController, disconnectPhase, explainDisconnect, formatCallError, isClosingOwnCall, peerProblemNotice, type Notice } from './rooms.ts';
import { renderLobby, renderRoomNav, roomContext, type ContextChannel } from './rooms-view.ts';
import { ShellController, replaceKeepingFocus, type ShellState } from './shell.ts';
import { callBarStatus, callBarTitle, micLabel, otherRoomNote, voiceSummary } from './voice-view.ts';
import { SoundBus } from './sound-bus.ts';
import { SoundCache, createBrowserSoundStore } from './sound-cache.ts';
import { loadSoundPrefs, saveSoundPrefs } from './sound-prefs.ts';
import { SoundboardController, type SoundboardState } from './soundboard.ts';
import { renderSoundboard, soundboardStatus } from './soundboard-view.ts';
import { describePair, formatCodec, formatMetric } from './stats.ts';
import { VoiceMix, placeMenu } from './voice-mix.ts';
import { VoicePrefs, browserPrefStorage } from './voice-prefs.ts';
import { createBrowserLedger, type SessionLedger } from './session-ledger.ts';
import { createSupabaseBackend } from './supabase-backend.ts';
import { DISCONNECT, DISCONNECT_MESSAGES, JOIN_LIMIT_MESSAGE } from './supabase-signaling.ts';

// Primeiro passo da página: o token do convite não fica na barra de endereço.
const takeInvite = (): InviteArrival => takeInviteFromLocation(window.location, (url) => window.history.replaceState(window.history.state, '', url));
const arrivedInvite = takeInvite();
// Confirmação ou recuperação de senha: as credenciais saem da URL aqui; os tokens de recuperação ficam só em memória.
const authLink = takeAuthLink(window.location, (url) => window.history.replaceState(window.history.state, '', url));

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`elemento #${id} ausente`);
  return node as T;
};

const ui = {
  configError: el<HTMLParagraphElement>('config-error'),
  login: el<HTMLElement>('login'),
  loginTitle: el<HTMLElement>('login-title'),
  loginForm: el<HTMLFormElement>('login-form'),
  email: el<HTMLInputElement>('email'),
  password: el<HTMLInputElement>('password'),
  loginBtn: el<HTMLButtonElement>('login-btn'),
  signupOpen: el<HTMLButtonElement>('signup-open-btn'),
  signupForm: el<HTMLFormElement>('signup-form'),
  signupName: el<HTMLInputElement>('signup-name'),
  signupEmail: el<HTMLInputElement>('signup-email'),
  signupPassword: el<HTMLInputElement>('signup-password'),
  signupBtn: el<HTMLButtonElement>('signup-btn'),
  signupCancel: el<HTMLButtonElement>('signup-cancel-btn'),
  signupStatus: el<HTMLElement>('signup-status'),
  authTabs: el<HTMLElement>('auth-tabs'),
  authTabLogin: el<HTMLButtonElement>('auth-tab-login'),
  loginSubtitle: el<HTMLElement>('login-subtitle'),
  authGoogle: el<HTMLElement>('auth-google'),
  googleBtn: el<HTMLButtonElement>('google-btn'),
  emailError: el<HTMLElement>('email-error'),
  passwordError: el<HTMLElement>('password-error'),
  signupPhone: el<HTMLInputElement>('signup-phone'),
  signupConfirm: el<HTMLInputElement>('signup-confirm'),
  signupRules: el<HTMLElement>('signup-rules'),
  signupNameError: el<HTMLElement>('signup-name-error'),
  signupEmailError: el<HTMLElement>('signup-email-error'),
  signupPhoneError: el<HTMLElement>('signup-phone-error'),
  signupPasswordError: el<HTMLElement>('signup-password-error'),
  signupConfirmError: el<HTMLElement>('signup-confirm-error'),
  forgotOpen: el<HTMLButtonElement>('forgot-open-btn'),
  forgotForm: el<HTMLFormElement>('forgot-form'),
  forgotEmail: el<HTMLInputElement>('forgot-email'),
  forgotBtn: el<HTMLButtonElement>('forgot-btn'),
  forgotCancel: el<HTMLButtonElement>('forgot-cancel-btn'),
  resetForm: el<HTMLFormElement>('reset-form'),
  resetPassword: el<HTMLInputElement>('reset-password'),
  resetConfirm: el<HTMLInputElement>('reset-confirm'),
  resetBtn: el<HTMLButtonElement>('reset-btn'),
  resetCancel: el<HTMLButtonElement>('reset-cancel-btn'),
  profileOpen: el<HTMLButtonElement>('profile-open-btn'),
  profilePanel: el<HTMLDialogElement>('profile-panel'),
  profileClose: el<HTMLButtonElement>('profile-close-btn'),
  profileForm: el<HTMLFormElement>('profile-form'),
  profileName: el<HTMLInputElement>('profile-name'),
  profileSave: el<HTMLButtonElement>('profile-save-btn'),
  profileStatus: el<HTMLElement>('profile-status'),
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
  inviteIdentityText: el<HTMLElement>('invite-identity-text'),
  inviteProfileBtn: el<HTMLButtonElement>('invite-profile-btn'),
  inviteAcceptBtn: el<HTMLButtonElement>('invite-accept-btn'),
  inviteDeclineBtn: el<HTMLButtonElement>('invite-decline-btn'),
  inviteAcceptMessage: el<HTMLParagraphElement>('invite-accept-message'),
  inviteDismissBtn: el<HTMLButtonElement>('invite-dismiss-btn'),
  inviteShare: el<HTMLDialogElement>('invite-share'),
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
  createDialog: el<HTMLDialogElement>('create-dialog'),
  createCloseBtn: el<HTMLButtonElement>('create-close-btn'),
  createMissingName: el<HTMLElement>('create-missing-name'),
  createError: el<HTMLParagraphElement>('create-error'),
  createEmptyBtn: el<HTMLButtonElement>('create-empty-btn'),
  createProfileBtn: el<HTMLButtonElement>('create-profile-btn'),
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
  soundToggleBtn: el<HTMLButtonElement>('sound-toggle-btn'),
  soundCloseBtn: el<HTMLButtonElement>('sound-close-btn'),
  incomingBtn: el<HTMLButtonElement>('incoming-btn'),
  voiceMenu: el<HTMLDivElement>('voice-menu'),
  voiceMenuName: el<HTMLElement>('voice-menu-name'),
  voiceMenuValue: el<HTMLOutputElement>('voice-menu-value'),
  voiceMenuVolume: el<HTMLInputElement>('voice-menu-volume'),
  voiceMenuMute: el<HTMLButtonElement>('voice-menu-mute'),
  voiceMenuClose: el<HTMLButtonElement>('voice-menu-close'),
  createCancelBtn: el<HTMLButtonElement>('create-cancel-btn'),
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
  sidebarRoom: el<HTMLElement>('sidebar-room'),
  sidebarRoomDetail: el<HTMLElement>('sidebar-room-detail'),
  sidebarHint: el<HTMLElement>('sidebar-hint'),
  roomNav: el<HTMLDivElement>('room-nav'),
  channelNav: el<HTMLElement>('channel-nav'),
  channelList: el<HTMLDivElement>('channel-list'),
  channelCreateForm: el<HTMLFormElement>('channel-create-form'),
  channelCreateName: el<HTMLInputElement>('channel-create-name'),
  channelKindText: el<HTMLInputElement>('channel-kind-text'),
  channelKindVoice: el<HTMLInputElement>('channel-kind-voice'),
  channelCreateBtn: el<HTMLButtonElement>('channel-create-btn'),
  channelDialog: el<HTMLDialogElement>('channel-dialog'),
  channelCloseBtn: el<HTMLButtonElement>('channel-close-btn'),
  channelCancelBtn: el<HTMLButtonElement>('channel-cancel-btn'),
  channelCreateError: el<HTMLParagraphElement>('channel-create-error'),
  createOpenBtn: el<HTMLButtonElement>('create-open-btn'),
  accountBox: el<HTMLElement>('account-box'),
  contextTitle: el<HTMLElement>('context-title'),
  contextDetail: el<HTMLParagraphElement>('context-detail'),
  callPanel: el<HTMLElement>('call-panel'),
  roomsBlock: el<HTMLElement>('rooms-block'),
  contextActions: el<HTMLElement>('context-actions'),
  callBar: el<HTMLElement>('call-bar'),
  callPhase: el<HTMLElement>('call-phase'),
  callMic: el<HTMLElement>('call-mic'),
  callNotice: el<HTMLParagraphElement>('call-notice'),
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
/** Não entrar com o usuário em cache antes de restoreSession confirmar os metadados atuais. */
let restoringAuth = true;
let selfUserId: string | null = null;
let call: MeshCall | null = null;
let signaling: MeshSignaling | null = null;
/**
 * Um elemento de áudio por sessão remota, com o volume individual de cada pessoa (por conta e participant_ref, neste
 * aparelho) composto com o áudio recebido silenciado. Nada disso é o mudo do microfone nem vai para os outros.
 */
const voiceMix = new VoiceMix<HTMLAudioElement>(new VoicePrefs(browserPrefStorage()));
const incoming = voiceMix.incoming;
/** Menu de volume aberto: de quem (a sessão muda numa reconexão; a referência, não). */
let voiceMenu: { session: string; ref: string; displayName: string } | null = null;
/** Painel de sons aberto pelo botão da barra. Só apresentação: o soundboard segue o da chamada. */
let soundsOpen = false;
/** Sala da chamada atual (ou da última, até ela terminar) e se a chamada está em curso. */
let callRoomId: string | null = null;
/** Canal de voz da chamada (0900). `null`: a voz padrão da sala, pelo caminho antigo. */
let callChannelId: string | null = null;
/** Canal pedido na entrada em curso: os botões "Entrar agora" e "Verificar de novo" repetem o mesmo canal. */
let entryChannelId: string | null = null;
let callActive = false;
let lobby: LobbyController;
let callReturn: CallReturnController;
let sessionLedger: SessionLedger;
let entryGate: EntryGate;
let sweepTimer: ReturnType<typeof setTimeout> | null = null;
let inviteShare: InviteShareController;
let inviteAccept: InviteAcceptController;
let chat: ChatController;
let channels: ChannelsController;
let members: MembersController;
let soundboard: SoundboardController;
let soundCache: SoundCache;
/** Muda a cada chamada nova, logout e desconexão explicada: uma explicação de 4403 antiga não sobrescreve nada. */
let disconnectTicket = 0;
/** Último aviso de reconexão de um par: some quando o par volta ou a chamada termina. */
let lastPeerNotice: string | null = null;
/** JWT atual, lido de forma síncrona no pagehide. Fica só em memória, como a sessão de login. */
let accessToken: string | null = null;
let currentUser: User | null = null;
let globalName: string | null = null;
let identityTimer: ReturnType<typeof setInterval> | null = null;
let identityTicket = 0;
let identityReading = false;

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
/** Fase da chamada como estado, para os textos resumidos da barra. */
let callPhaseNow: CallPhase = 'idle';
/**
 * Canal que ocupa o centro na sala selecionada. Independente da chamada: abrir Texto durante a chamada não a encerra, e a
 * barra continua mostrando a voz conectada. Texto: o chat no centro e os membros ao lado. Voz: o palco no centro e o chat
 * ao lado.
 */
let centerKind: ChannelKind = 'text';
/** Canal de voz do palco, quando o centro é Voz. `null`: a voz padrão da sala. */
let selectedVoiceId: string | null = null;
/** Rascunhos por canal (só em memória) e a chave do canal cujo rascunho está no campo agora. */
const drafts = new DraftBook();
let draftAt: string | null = null;
/** Botão que abriu o modal de criação, para devolver o foco a ele ao fechar. */
let createOpener: HTMLElement | null = null;
/** Seção ("+" de Texto ou de Voz) que abriu a criação de canal: o foco volta ao "+" dela, mesmo redesenhado. */
let channelOpenerKind: ChannelKind | null = null;
/** Canal com o menu de opções ("⋯") aberto na lateral: sobrevive ao redesenho periódico da lista. */
let channelMenuOpen: string | null = null;
/** Salas com "Gerenciar sala" aberto, para o redesenho da lista não recolhê-lo. */
const adminOpen = new Set<string>();

/** Painel e barra da chamada. Só lê estado: a barra acompanha a chamada, nunca a sala selecionada. */
function renderVoice(): void {
  // Os canais podem chegar depois da entrada: a barra ganha o nome da voz assim que a lista da sala da chamada estiver pronta.
  if (callActive && callRoomId !== null && channels?.state.roomId === callRoomId && channels.state.status === 'ready') {
    ui.callRoom.textContent = callIdentity(callRoomId, callChannelId);
  }
  const room = ui.callRoom.textContent ?? '';
  const summary = voiceSummary({ active: callActive, phase: voicePhase, room });
  ui.voiceTitle.textContent = summary.title;
  ui.voiceState.textContent = summary.state;
  const note = otherRoomNote(callActive, shell.state.selectedRoomId, callRoomId, room);
  ui.voiceNote.textContent = note ?? '';
  ui.voiceNote.hidden = note === null;
  // Barra: só estados resumidos ("Em chamada", "Reconectando…"); a fase técnica fica no diagnóstico.
  const reconnecting = shownParticipants.list.some((p) => p.state === 'reconnecting');
  ui.callPhase.textContent = callActive ? callBarStatus(callPhaseNow, reconnecting) : '';
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
  const current = voiceMix.detach(session);
  if (current) {
    current.pause();
    current.srcObject = null;
    current.remove();
  }
  if (stream) {
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.srcObject = stream;
    voiceMix.attach(session, audio); // volume e silenciamentos (o geral e o desta pessoa) antes de tocar
    ui.audioContainer.append(audio);
    audio.play().catch(() => {
      ui.listenBtn.hidden = false; // autoplay bloqueado: o usuário libera com um clique
      log('Reprodução do áudio remoto bloqueada pelo navegador: clique em "Ouvir".');
    });
  }
  if (voiceMix.size === 0) ui.listenBtn.hidden = true;
}

ui.listenBtn.addEventListener('click', () => {
  void Promise.all([...voiceMix.values()].map((a) => a.play()))
    .then(() => (ui.listenBtn.hidden = true))
    .catch(() => undefined);
});

// ---------- renderização ----------

function renderPhase(phase: CallPhase, error?: string): void {
  callPhaseNow = phase;
  const active = phase !== 'idle' && phase !== 'ended' && phase !== 'failed';
  callActive = active;
  setField('phase', PHASES[phase]);
  ui.joinBtn.disabled = active;
  ui.room.disabled = active;
  ui.muteBtn.disabled = !active;
  ui.leaveBtn.disabled = !active;
  ui.incomingBtn.disabled = !active;
  if (!active) {
    ui.muteBtn.textContent = 'Mutar';
    ui.muteBtn.dataset['muted'] = 'false';
    incoming.reset(voiceMix.values()); // a próxima chamada começa ouvindo (o volume de cada pessoa continua guardado)
    closeVoiceMenu(false);
    renderIncoming();
    if (soundsOpen) setSoundsOpen(false, false); // sair da chamada fecha o painel de sons
  }
  if (!active) setCallNotice(null); // o aviso de um participante vale só durante a chamada
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
  // Quem está em cada voz mudou (entrou, saiu ou caiu): a lista de canais não espera a próxima consulta.
  if ((phase === 'waiting-peer' || phase === 'ended' || phase === 'failed') && channels?.state.status === 'ready') void channels.refresh();
  renderRooms();
}

/** Sons da sala, no palco, abaixo dos participantes: aparecem com o soundboard da chamada e somem com ele. Recolher o
 * catálogo pelo título é só apresentação (o <details> nativo). */
/** Sons da sala num painel flutuante acima da barra, aberto pelo botão "Sons da sala". Abrir e fechar é só apresentação:
 * o soundboard (lista, volume, desativação local) continua o mesmo, aberto ou fechado. */
function renderSoundboardPanel(state: SoundboardState): void {
  const available = state.status !== 'closed';
  if (!available) soundsOpen = false;
  // O painel sumiu com a chamada: o foco do teclado não pode sumir com ele.
  const focusLost = !(available && soundsOpen) && ui.soundboard.contains(document.activeElement);
  ui.soundboard.hidden = !available || !soundsOpen;
  ui.soundToggleBtn.disabled = !available;
  ui.soundToggleBtn.setAttribute('aria-expanded', String(available && soundsOpen));
  if (focusLost) (available ? ui.soundToggleBtn : ui.contextTitle).focus();
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

/** Últimos participantes recebidos: o próprio cartão muda com o mudo sem esperar a malha. */
let shownParticipants: { list: readonly ParticipantView[]; standby: boolean } = { list: [], standby: false };

/** Só apresentação: papel e lotação vêm da lista de salas, o mudo vem da chamada. */
function drawParticipants(): void {
  const { list, standby } = shownParticipants;
  const room = lobby?.state.rooms.find((r) => r.room_id === callRoomId);
  const stage = {
    owner: room?.role === 'owner',
    muted: call?.muted ?? false,
    freeSlots: Math.max(0, (room?.max_members ?? 0) - 1 - list.length),
    voice: (ref: string) => voiceMix.pref(ref),
  };
  // O palco tem botões de volume: o redesenho devolve o foco ao botão da MESMA pessoa (a ordem pode mudar), ou ao título.
  const active = document.activeElement;
  const focused = active instanceof HTMLButtonElement && ui.participants.contains(active) ? (active.dataset['session'] ?? null) : null;
  ui.participants.replaceChildren(renderParticipants(document, list, standby, stage));
  markVoiceMenuButton();
  if (focused !== null) (volumeButton(focused) ?? ui.contextTitle).focus();
}

function renderCallParticipants(list: readonly ParticipantView[], standby: boolean): void {
  soundboard.setStandby(standby);
  ui.participants.hidden = !callActive;
  shownParticipants = { list, standby };
  voiceMix.setParticipants(list);
  syncVoiceMenu();
  drawParticipants();
  // O par voltou: o aviso de reconexão deixa de valer.
  if (lastPeerNotice !== null && list.every((p) => p.state === 'connected')) setCallNotice(null);
  renderVoice(); // "Reconectando…" na barra acompanha os participantes
}

// ---------- volume de cada participante ----------

/**
 * Abre o menu de volume de um participante. `at`: o ponto do clique direito; sem ele (teclado, toque, botão), junto ao
 * botão "Volume de …" do cartão. O foco vai para a barra de volume.
 */
function openVoiceMenu(session: string, at?: { x: number; y: number }): void {
  const p = shownParticipants.list.find((x) => x.session === session);
  if (!p || !callActive || shownParticipants.standby) return;
  if (voiceMenu !== null && voiceMenu.session !== session) closeVoiceMenu(false);
  voiceMenu = { session: p.session, ref: p.ref, displayName: p.displayName };
  renderVoiceMenu();
  ui.voiceMenu.hidden = false;
  const button = volumeButton(session);
  const rect = button?.getBoundingClientRect();
  const point = at ?? (rect ? { x: rect.left, y: rect.bottom + 4 } : { x: 16, y: 16 });
  const pos = placeMenu(point, { width: ui.voiceMenu.offsetWidth, height: ui.voiceMenu.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
  // Posição por propriedades CSS (CSSOM): a CSP não aceita estilo em linha no HTML.
  ui.voiceMenu.style.setProperty('--voice-menu-x', `${pos.left}px`);
  ui.voiceMenu.style.setProperty('--voice-menu-y', `${pos.top}px`);
  button?.setAttribute('aria-expanded', 'true');
  ui.voiceMenuVolume.focus();
}

/** Fecha o menu. `restoreFocus`: o foco volta ao botão de volume do mesmo participante (o cartão pode ter sido redesenhado). */
function closeVoiceMenu(restoreFocus: boolean): void {
  if (voiceMenu === null) return;
  const session = voiceMenu.session;
  voiceMenu = null;
  const hadFocus = ui.voiceMenu.contains(document.activeElement);
  ui.voiceMenu.hidden = true;
  const button = volumeButton(session);
  button?.setAttribute('aria-expanded', 'false');
  // O foco estava no menu, que sumiu: não pode se perder com ele.
  if (restoreFocus || hadFocus) (button ?? ui.contextTitle).focus();
}

function volumeButton(session: string): HTMLButtonElement | null {
  return [...ui.participants.querySelectorAll<HTMLButtonElement>('button.participant-volume')].find((b) => b.dataset['session'] === session) ?? null;
}

/** Estado do menu a partir da preferência guardada: barra, porcentagem e o botão de silenciar. */
function renderVoiceMenu(): void {
  if (voiceMenu === null) return;
  const pref = voiceMix.pref(voiceMenu.ref);
  const pct = Math.round(pref.volume * 100);
  ui.voiceMenuName.textContent = voiceMenu.displayName;
  ui.voiceMenuVolume.value = String(pct);
  ui.voiceMenuVolume.setAttribute('aria-valuetext', `${pct}%${pref.muted ? ', silenciado para você' : ''}`);
  ui.voiceMenuVolume.setAttribute('aria-label', volumeButtonLabel(voiceMenu.displayName));
  ui.voiceMenuValue.textContent = `${pct}%`;
  ui.voiceMenuMute.textContent = pref.muted ? 'Ativar para mim' : 'Silenciar para mim';
  ui.voiceMenuMute.setAttribute('aria-pressed', String(pref.muted));
  ui.voiceMenu.dataset['muted'] = String(pref.muted);
}

/** A lista mudou: quem reconectou segue com o menu (nova sessão, mesma pessoa); quem saiu fecha o menu. */
function syncVoiceMenu(): void {
  if (voiceMenu === null) return;
  const ref = voiceMenu.ref;
  const p = shownParticipants.standby ? undefined : shownParticipants.list.find((x) => x.ref === ref);
  if (!p) return closeVoiceMenu(false);
  voiceMenu = { session: p.session, ref: p.ref, displayName: p.displayName };
  renderVoiceMenu();
}

/** O palco foi redesenhado: o botão de quem está com o menu aberto continua marcado como expandido. */
function markVoiceMenuButton(): void {
  if (voiceMenu !== null) volumeButton(voiceMenu.session)?.setAttribute('aria-expanded', 'true');
}

ui.participants.addEventListener('click', (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('button.participant-volume');
  const session = button?.dataset['session'];
  if (!session) return;
  if (voiceMenu?.session === session) closeVoiceMenu(true);
  else openVoiceMenu(session);
});
// Clique direito no cartão (ou a tecla de menu, ou o toque longo onde o sistema o converte): o menu de volume, não o do navegador.
ui.participants.addEventListener('contextmenu', (event) => {
  const card = (event.target as Element).closest<HTMLElement>('li[data-session]');
  const session = card?.dataset['session'];
  if (!session) return;
  event.preventDefault();
  // Pela tecla de menu não há ponteiro (coordenadas 0): o menu abre junto ao botão do cartão.
  openVoiceMenu(session, event.clientX === 0 && event.clientY === 0 ? undefined : { x: event.clientX, y: event.clientY });
});
ui.voiceMenuVolume.addEventListener('input', () => {
  if (voiceMenu === null) return;
  voiceMix.setVolume(voiceMenu.ref, Number(ui.voiceMenuVolume.value));
  renderVoiceMenu();
  drawParticipants(); // o cartão mostra "Volume 40%" fora do padrão
});
ui.voiceMenuMute.addEventListener('click', () => {
  if (voiceMenu === null) return;
  voiceMix.setMuted(voiceMenu.ref, !voiceMix.pref(voiceMenu.ref).muted);
  renderVoiceMenu();
  drawParticipants();
});
ui.voiceMenuClose.addEventListener('click', () => closeVoiceMenu(true));
// Clique fora fecha (o botão do próprio cartão alterna, pelo clique acima).
document.addEventListener('pointerdown', (event) => {
  if (voiceMenu === null) return;
  const target = event.target as Element;
  if (ui.voiceMenu.contains(target) || target.closest?.('button.participant-volume')) return;
  closeVoiceMenu(false);
});
// O foco saiu do menu pelo teclado (Tab além do último controle): fecha sem puxar o foco de volta.
ui.voiceMenu.addEventListener('focusout', (event) => {
  const next = event.relatedTarget as Node | null;
  if (voiceMenu !== null && next !== null && !ui.voiceMenu.contains(next) && !(next as Element).closest?.('button.participant-volume')) closeVoiceMenu(false);
});
// Menu ancorado a um ponto: a janela mudou, o ponto perdeu o sentido. No celular é uma folha fixa embaixo, e a barra de
// endereço que aparece ou some ao rolar também dispara resize: ali o menu fica.
window.addEventListener('resize', () => {
  if (!window.matchMedia('(max-width: 560px)').matches) closeVoiceMenu(false);
});

/** Aviso de um participante (queda ou volta), na região da barra da chamada, sempre como texto. */
function setCallNotice(notice: Notice | null): void {
  lastPeerNotice = notice?.text ?? null;
  ui.callNotice.textContent = notice?.text ?? '';
  ui.callNotice.hidden = notice === null;
  ui.callNotice.className = notice?.tone === 'error' ? 'call-bar-notice error' : 'call-bar-notice';
  ui.callNotice.setAttribute('role', notice?.tone === 'error' ? 'alert' : 'status');
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

/** Sempre por ação do usuário. O microfone só é pedido depois da verificação, e o servidor (join_room ou
 * join_voice_channel) ainda decide a entrada. Sem canal: a voz padrão da sala. */
function startCall(roomInput: string, channelId: string | null = null): void {
  if (callActive || entryGate.checking) return; // uma chamada por vez
  callReturn.hide(); // entrar em qualquer chamada substitui a oferta de retorno
  disconnectTicket += 1; // explicação pendente de uma chamada anterior não aparece nesta
  showError(null);
  const roomId = roomInput.trim().toLowerCase();
  if (!isUuid(roomId)) return showError('ID da sala inválido: informe o UUID da sala.');
  if (channelId !== null && !isUuid(channelId)) return showError('Canal de voz inválido.');
  if (!selfUserId) return showError('Faça login antes de entrar na chamada.');
  const userId = selfUserId;
  entryChannelId = channelId;
  // Entrar numa voz da sala em tela abre o palco dela: a entrada e o pedido do microfone aparecem ali e na barra.
  if (shell.state.selectedRoomId === roomId) showVoice(roomId, channelId);
  void entryGate.check(roomId).then((verdict) => {
    if (verdict !== 'go') return;
    if (!callActive && selfUserId === userId) beginCall(roomId, userId, channelId);
    else sessionLedger.releaseEntry();
  });
}

function beginCall(roomId: string, userId: string, channelId: string | null = null): void {
  callRoomId = roomId;
  callChannelId = channelId;
  ui.room.value = roomId;
  ui.callRoom.textContent = callIdentity(roomId, channelId);
  const backend = createSupabaseBackend(client, { url: cfg.supabaseUrl, publishableKey: cfg.publishableKey, accessToken: () => accessToken });
  ui.status.hidden = false;
  ui.log.replaceChildren();

  const current: MeshCall = new MeshCall(
    {
      getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
      createPeerConnection: (c) => new RTCPeerConnection(c),
      createRoom: (events, onDisconnected) => {
        signaling = new MeshSignaling({ backend, roomId, channelId, selfUserId: userId, events, onDisconnected, iceServers: cfg.iceServers, tracker: sessionLedger.tracker(userId, roomId), log: (m) => call === current && log(m) });
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
        setCallNotice(peerProblemNotice(name, kind)); // na barra da chamada, não no aviso da página
      },
    },
  );
  call = current;
  callActive = true; // antes da primeira fase: um segundo clique não abre outra chamada
  soundboard.enter(roomId, userId, lobby.state.rooms.find((r) => r.room_id === roomId)?.role === 'owner');
  renderRooms();
  void current.start();
}

/** Canal de voz conectado e a sala dele, para a barra. Sem canal escolhido, a voz padrão da sala. */
function callIdentity(roomId: string, channelId: string | null): string {
  const roomName = lobby.state.rooms.find((r) => r.room_id === roomId)?.name ?? roomId;
  const voices = channels.state.roomId === roomId ? channels.state.channels : [];
  const voice = channelId === null ? defaultChannel(voices, 'voice') : voices.find((c) => c.channel_id === channelId);
  return callBarTitle(voice?.name ?? null, roomName);
}

/** Encerra a chamada e espera a saída da sala (leave_room precisa do JWT ainda válido). */
async function endCall(): Promise<void> {
  const s = signaling;
  call?.end();
  await s?.closed.catch(() => undefined);
}

// ---------- sons ----------

/** Abre ou fecha o painel de sons. Ao abrir, o foco vai para dentro dele; ao fechar pelo teclado, volta ao botão. */
function setSoundsOpen(open: boolean, restoreFocus = true): void {
  soundsOpen = open;
  renderSoundboardPanel(soundboard.state);
  if (open) ui.soundCloseBtn.focus();
  else if (restoreFocus && !ui.soundToggleBtn.disabled) ui.soundToggleBtn.focus();
}

ui.soundToggleBtn.addEventListener('click', () => setSoundsOpen(!soundsOpen));
ui.soundCloseBtn.addEventListener('click', () => setSoundsOpen(false));
// Clique fora do painel (e fora do botão que o abre) fecha; tocar um som, dentro dele, não fecha.
document.addEventListener('pointerdown', (event) => {
  if (!soundsOpen) return;
  const target = event.target as Node;
  if (ui.soundboard.contains(target) || ui.soundToggleBtn.contains(target)) return;
  setSoundsOpen(false, false);
});

/** Botão do áudio recebido: nome, estado (aria-pressed) e ícone acompanham o controle local. */
function renderIncoming(): void {
  ui.incomingBtn.textContent = incomingLabel(incoming.muted);
  ui.incomingBtn.setAttribute('aria-pressed', String(incoming.muted));
  ui.incomingBtn.dataset['muted'] = String(incoming.muted);
}

// Silencia ou restaura só o que chega dos outros, neste aparelho. Não mexe no microfone nem na conexão.
ui.incomingBtn.addEventListener('click', () => {
  incoming.toggle(voiceMix.values());
  renderIncoming();
});

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
  ui.muteBtn.dataset['muted'] = String(call.muted); // só o ícone: o texto segue sendo o nome do botão
  if (!ui.participants.hidden) drawParticipants();
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
  if (roomId) startCall(roomId, entryChannelId);
});
ui.entryRecheckBtn.addEventListener('click', () => {
  const roomId = entryRoom();
  if (roomId) startCall(roomId, entryChannelId);
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
  const label = state.collapsed ? 'Mostrar canais' : 'Recolher canais';
  ui.sidebarToggle.setAttribute('aria-expanded', String(!state.collapsed));
  ui.sidebarToggle.setAttribute('aria-label', label);
  ui.sidebarToggle.title = label;
  ui.sidebarToggleIcon.textContent = state.collapsed ? '›' : '‹';
  ui.shellMenuBtn.setAttribute('aria-expanded', String(state.drawerOpen));
  ui.shellBackdrop.hidden = !state.drawerOpen;
  ui.shellMain.inert = state.drawerOpen; // o foco fica na navegação enquanto ela cobre o conteúdo
  ui.callBar.inert = state.drawerOpen; // o painel de sons mora na barra: fica inerte com ela
  renderRooms();
}

const shell = new ShellController(renderShell);

function renderRooms(): void {
  if (!lobby) return;
  const s = lobby.state;
  const busy = s.busy !== null;
  if (s.status === 'ready') shell.reconcile(s.rooms.map((r) => r.room_id));
  const { selectedRoomId } = shell.state;
  const context = roomContext(s, selectedRoomId, callActive ? callRoomId : null, selectedRoomId === null ? null : centerChannel(selectedRoomId));
  ui.contextTitle.textContent = context.title;
  ui.contextDetail.textContent = context.detail ?? '';
  ui.contextDetail.hidden = context.detail === null;
  ui.contextDetail.dataset['inCall'] = String(callActive && selectedRoomId !== null && callRoomId === selectedRoomId); // só o ponto verde
  const noRooms = s.status === 'ready' && s.rooms.length === 0;
  ui.createEmptyBtn.hidden = selectedRoomId !== null || !noRooms; // sem nenhuma sala, o convite à primeira
  // Sala aberta: as ações dela vêm antes da voz. Na visão geral, a voz vem antes de uma lista que pode ser longa. A troca é
  // no DOM, para o teclado seguir a ordem da tela, e só quando muda, para não tirar o foco de quem está no bloco.
  // Na sala aberta, as ações dela ficam no cabeçalho, ao lado do nome, e a voz ocupa o centro.
  const roomFirst = selectedRoomId !== null;
  if (roomFirst && ui.roomsBlock.parentElement !== ui.contextActions) ui.contextActions.prepend(ui.roomsBlock);
  if (!roomFirst && ui.callPanel.nextElementSibling !== ui.roomsBlock) ui.callPanel.after(ui.roomsBlock);
  renderVoice();
  ui.app.dataset['view'] = selectedRoomId === null ? 'all' : 'room';
  // Cabeçalho da lateral contextual: a sala selecionada (nome e papel/lotação) ou a marca, na visão geral.
  const selectedRoom = selectedRoomId === null ? undefined : s.rooms.find((r) => r.room_id === selectedRoomId);
  ui.sidebarRoom.textContent = selectedRoom?.name ?? 'Oryn';
  ui.sidebarRoomDetail.textContent = selectedRoom
    ? `${selectedRoom.role === 'owner' ? 'dono' : 'membro'} · ${selectedRoom.member_count}/${selectedRoom.max_members}${selectedRoom.is_open ? '' : ' · encerrada'}`
    : 'Stay close. Play on.';
  if (selectedRoom) ui.sidebarRoomDetail.removeAttribute('lang');
  else ui.sidebarRoomDetail.setAttribute('lang', 'en');
  ui.sidebarHint.hidden = selectedRoom !== undefined;
  // O canal do centro define a composição: Texto (chat no centro, membros ao lado) ou Voz (palco e sons, chat ao lado).
  ui.app.dataset['channel'] = selectedRoomId === null ? 'none' : centerKind;
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
  renderChannels();
  replaceKeepingFocus(
    ui.rooms,
    renderLobby(document, s, {
      selectedRoomId,
      callActive: callActive || entryGate.checking,
      activeRoomId: callActive ? callRoomId : null,
      // Na sala aberta, "Entrar na chamada" entra na voz que está no palco (ou na padrão).
      onJoin: (roomId) => startCall(roomId, roomId === selectedRoomId && centerKind === 'voice' ? selectedVoiceId : null),
      onClose: (roomId) => void lobby.close(roomId),
      inviteBusy: inviteShare.state.busy,
      onInvite: (roomId) => void inviteShare.open(roomId),
      onRevokeInvites: (roomId) => void inviteShare.revoke(roomId, lobby.state.rooms.find((r) => r.room_id === roomId)?.name ?? ''),
      chatRoomId: chat?.state.roomId ?? null,
      // Em Texto, o chat é o centro (vem pelos canais). Na visão geral e em Voz, a pílula abre o chat sob demanda.
      ...(selectedRoomId === null || centerKind === 'voice' ? { onChat: openChat } : {}),
      membersRoomId: members?.state.roomId ?? null,
      onMembers: openMembers,
      adminOpenRoomIds: adminOpen,
      onAdminToggle: (roomId, open) => void (open ? adminOpen.add(roomId) : adminOpen.delete(roomId)),
    }),
  );
  // Com o modal aberto, o erro (da criação) aparece nele, e não atrás da camada.
  const inDialog = ui.createDialog.open;
  ui.roomsError.textContent = inDialog ? '' : s.actionError ?? '';
  ui.roomsError.hidden = inDialog || s.actionError === null;
  ui.createError.textContent = inDialog ? s.actionError ?? '' : '';
  ui.createError.hidden = !inDialog || s.actionError === null;
  ui.refreshBtn.disabled = busy || s.status === 'loading';
  ui.createName.disabled = busy;
  ui.createCapacity.disabled = busy;
  ui.createProfileBtn.disabled = busy;
  // Envio em curso: o modal não fecha (o resultado sempre aparece nele) e não há segundo envio.
  ui.createCancelBtn.disabled = busy;
  ui.createCloseBtn.disabled = busy;
  renderCreateIdentity();
}

/** O criador entra com o nome global do perfil (o mesmo de convites, membros, voz e chat). Sem ele, a criação
 * espera: o caminho é definir o nome no Perfil, nunca digitar outro nome só para esta sala. */
function renderCreateIdentity(): void {
  const busy = lobby?.state.busy != null;
  ui.createBtn.disabled = busy || globalName === null;
  ui.createMissingName.hidden = globalName !== null;
}

/** Linha "Você entra como…" da criação e do convite. O nome entra como texto, nunca como HTML. */
function identityNote(target: HTMLElement, button: HTMLButtonElement, missing: string): void {
  target.replaceChildren(
    ...(globalName === null
      ? [document.createTextNode(missing)]
      : [document.createTextNode('Você entra como '), Object.assign(document.createElement('strong'), { textContent: globalName }), document.createTextNode('.')]),
  );
  button.textContent = globalName === null ? 'Definir nome' : 'Alterar no perfil';
}

// ---------- canais do espaço (I-2) ----------

/** Canais do espaço selecionado, na barra lateral. Só o dono de um espaço aberto vê criar e arquivar (o servidor confere). */
function renderChannels(): void {
  if (!channels) return;
  const roomId = shell.state.selectedRoomId;
  const room = roomId === null ? undefined : lobby.state.rooms.find((r) => r.room_id === roomId);
  const s = channels.state;
  ui.channelNav.hidden = !room || s.roomId !== room.room_id;
  if (!room || s.roomId !== room.room_id) {
    ui.channelList.replaceChildren();
    if (ui.channelDialog.open && !channelCreating()) closeChannelCreate(false); // a sala do modal saiu da tela
    return;
  }
  const canManage = room.role === 'owner' && room.is_open;
  if (ui.channelDialog.open && !canManage && !channelCreating()) closeChannelCreate(false); // a permissão mudou
  renderChannelDialog();
  // Chat aberto neste espaço sem canal escolhido = o texto padrão (RPCs antigas, mesmas mensagens).
  const textId = centerKind === 'text' && chat?.state.status !== 'closed' && chat?.state.roomId === room.room_id
    ? chat.state.channelId ?? defaultChannel(s.channels, 'text')?.channel_id ?? null : null;
  const voiceId = callActive && callRoomId === room.room_id ? callChannelId ?? defaultChannel(s.channels, 'voice')?.channel_id ?? null : null;
  const shownVoiceId = centerKind === 'voice' ? selectedVoiceId ?? defaultChannel(s.channels, 'voice')?.channel_id ?? null : null;
  // Com o modal aberto, a mensagem da criação aparece nele, e não repetida na lista.
  const navState = ui.channelDialog.open && s.message?.tone === 'error' ? { ...s, message: null } : s;
  replaceKeepingFocus(
    ui.channelList,
    renderChannelNav(document, navState, {
      canManage,
      closed: !room.is_open,
      openTextId: textId,
      activeVoiceId: voiceId,
      selectedVoiceId: shownVoiceId,
      callBusy: callActive || entryGate.checking,
      onOpenText: (channelId) => openChannelChat(room.room_id, channelId),
      onJoinVoice: (channelId) => {
        closeDrawer(); // na tela estreita, a chamada aparece no lugar da navegação
        startCall(room.room_id, channelId);
      },
      onOpenVoice: (channelId) => {
        closeDrawer();
        showVoice(room.room_id, defaultChannel(s.channels, 'voice')?.channel_id === channelId ? null : channelId);
        ui.contextTitle.focus();
      },
      onArchive: (channelId) => void channels.archive(channelId).finally(() => { channelMenuOpen = null; }),
      onCreate: (kind) => openChannelCreate(kind),
      openMenuId: channelMenuOpen,
      onMenuToggle: (channelId, open) => { channelMenuOpen = open ? channelId : channelMenuOpen === channelId ? null : channelMenuOpen; },
    }),
  );
}

/** Canal do centro para o cabeçalho, quando a lista da sala já chegou. Ocupação da voz: uma vez por conta. */
function centerChannel(roomId: string): ContextChannel | null {
  if (!channels || channels.state.roomId !== roomId || channels.state.status !== 'ready') return null;
  const list = channels.state.channels;
  if (centerKind === 'text') {
    const id = chat?.state.roomId === roomId ? chat.state.channelId : null;
    const c = id === null ? defaultChannel(list, 'text') : list.find((x) => x.channel_id === id);
    return c ? { kind: 'text', name: c.name } : null;
  }
  const c = selectedVoiceId === null ? defaultChannel(list, 'voice') : list.find((x) => x.channel_id === selectedVoiceId);
  if (!c) return null;
  const inVoice = new Set((channels.state.participants[c.channel_id] ?? []).map((p) => p.participant_ref)).size;
  return { kind: 'voice', name: c.name, inVoice };
}

/**
 * Centro em Texto: o chat do canal no centro e os membros da sala ao lado. A chamada em curso continua, e a barra segue
 * mostrando a voz conectada. Sem canal: o texto padrão da sala.
 */
function showText(roomId: string, channelId: string | null = null): void {
  const room = lobby.state.rooms.find((r) => r.room_id === roomId);
  if (!room) return;
  centerKind = 'text';
  // Não troca o chat com mensagem pendente, que sumiria da tela; o mesmo canal não reabre.
  const sameChat = chat.state.status !== 'closed' && chat.state.roomId === roomId && chat.state.channelId === channelId;
  if (!sameChat && (chat.state.status === 'closed' || chat.state.roomId === roomId || chat.state.pending.length === 0)) chat.open(roomId, !room.is_open, channelId);
  // Membros ao lado só onde há coluna para eles (tela larga); fora dela, abrem sob demanda pela pílula "Membros".
  if (sidePanelFits()) {
    if (members.state.status === 'closed' || members.state.roomId !== roomId) members.open(roomId, room.name, !room.is_open);
  } else if (members.state.status !== 'closed' && members.state.roomId !== roomId) {
    members.close(); // painel de outra sala não fica embaixo do chat
  }
  renderRooms();
}

/** Há coluna para o painel contextual (chat ou membros ao lado do centro): só na tela larga. */
const sidePanelFits = (): boolean => window.matchMedia('(min-width: 1200px)').matches;
/** Celular: a lateral de canais é uma gaveta ao lado da barra global. */
const drawerLayout = (): boolean => window.matchMedia('(max-width: 768px)').matches;

/** Centro em Voz: o palco (participantes e sons) no centro e o chat da sala ao lado. Não entra na chamada sozinho. */
function showVoice(roomId: string, channelId: string | null): void {
  const room = lobby.state.rooms.find((r) => r.room_id === roomId);
  if (!room) return;
  centerKind = 'voice';
  selectedVoiceId = channelId;
  if (members.state.status !== 'closed') members.close(); // em Voz, o painel ao lado é o chat
  if (sidePanelFits()) {
    if (chat.state.status === 'closed' || (chat.state.roomId !== roomId && chat.state.pending.length === 0)) chat.open(roomId, !room.is_open);
  } else if (chat.state.status !== 'closed' && chat.state.pending.length === 0) {
    chat.close(); // sem coluna ao lado: o chat abre sob demanda pela pílula "Chat"; o rascunho fica guardado no canal
  }
  renderRooms();
}

/** Abre o chat de um canal de texto no centro. O canal padrão usa o caminho antigo da sala: as mensagens são as mesmas. */
function openChannelChat(roomId: string, channelId: string): void {
  const target = defaultChannel(channels.state.channels, 'text')?.channel_id === channelId ? null : channelId;
  showText(roomId, target);
  closeDrawer();
  ui.chat.scrollIntoView({ block: 'nearest' });
  ui.chatInput.focus({ preventScroll: true });
}

// ---------- criação de canal (modal) ----------

const channelCreating = (): boolean => channels?.state.busy === 'create';
const channelKindChosen = (): ChannelKind => (ui.channelKindVoice.checked ? 'voice' : 'text');

/** Botão, campo e erro do modal, a partir do estado dos canais. O nome precisa ser válido para enviar. */
function renderChannelDialog(): void {
  if (!ui.channelDialog.open) return;
  const busy = channelCreating();
  ui.channelCreateBtn.disabled = busy || !isChannelName(ui.channelCreateName.value);
  ui.channelCreateBtn.textContent = busy ? 'Criando…' : 'Criar canal';
  ui.channelCancelBtn.disabled = busy;
  ui.channelCloseBtn.disabled = busy;
  ui.channelKindText.disabled = busy;
  ui.channelKindVoice.disabled = busy;
  ui.channelDialog.dataset['kind'] = channelKindChosen();
  const message = channels.state.message;
  setMessage(ui.channelCreateError, message?.tone === 'error' ? message : null);
}

/** Abre o modal com o tipo da seção do "+", nome vazio e foco no nome. */
function openChannelCreate(kind: ChannelKind): void {
  if (ui.channelDialog.open || channels.state.status !== 'ready') return;
  if (shell.state.drawerOpen) shell.closeDrawer(); // o modal mora no conteúdo, inerte com a gaveta aberta
  channelOpenerKind = kind;
  ui.channelCreateName.value = '';
  ui.channelKindText.checked = kind === 'text';
  ui.channelKindVoice.checked = kind === 'voice';
  channels.dismissMessage();
  ui.channelDialog.hidden = false;
  ui.channelDialog.showModal();
  renderChannelDialog();
  renderChannels();
  ui.channelCreateName.focus();
}

/** Fecha sem criar (nunca durante o envio) e devolve o foco ao "+" de origem, mesmo depois de a lista ser redesenhada. */
function closeChannelCreate(restoreFocus = true): void {
  if (!ui.channelDialog.open || channelCreating()) return;
  ui.channelDialog.close();
  ui.channelDialog.hidden = true;
  channels.dismissMessage();
  const kind = channelOpenerKind;
  channelOpenerKind = null;
  renderChannels();
  if (!restoreFocus) return;
  // Na tela estreita, o "+" fica na gaveta fechada e não recebe foco: então o "Menu", que leva de volta a ele.
  const plus = kind === null ? null : ui.channelList.querySelector<HTMLButtonElement>(`[data-create-kind="${kind}"]`);
  plus?.focus();
  if (plus && document.activeElement === plus) return;
  ui.shellMenuBtn.focus();
  if (document.activeElement !== ui.shellMenuBtn) ui.contextTitle.focus();
}

ui.channelCreateName.addEventListener('input', renderChannelDialog);
ui.channelKindText.addEventListener('change', renderChannelDialog);
ui.channelKindVoice.addEventListener('change', renderChannelDialog);
ui.channelCancelBtn.addEventListener('click', () => closeChannelCreate());
ui.channelCloseBtn.addEventListener('click', () => closeChannelCreate());
// Escape (cancel nativo): fecha pelo mesmo caminho; durante o envio, nada acontece.
ui.channelDialog.addEventListener('cancel', (event) => { event.preventDefault(); closeChannelCreate(); });
ui.channelDialog.addEventListener('close', () => { ui.channelDialog.hidden = true; });
ui.channelDialog.addEventListener('click', (event) => {
  if (event.target !== ui.channelDialog) return;
  const r = ui.channelDialog.getBoundingClientRect();
  if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeChannelCreate();
});
// Tab circula só dentro do modal, como no "Criar sala".
ui.channelDialog.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return;
  const items = [...ui.channelDialog.querySelectorAll<HTMLElement>('button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])')]
    .filter((n) => !(n as HTMLButtonElement).disabled && n.offsetParent !== null && !(n instanceof HTMLInputElement && n.type === 'radio' && !n.checked));
  if (items.length === 0) return;
  const first = items[0]!;
  const last = items[items.length - 1]!;
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});

ui.channelCreateForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!ui.channelDialog.open || ui.channelCreateBtn.disabled || channelCreating()) return; // um envio por vez, nome válido
  const kind = channelKindChosen();
  const roomId = channels.state.roomId;
  void channels.create(ui.channelCreateName.value, kind).then((id) => {
    if (id === null) {
      // Erro (permissão, nome repetido, limite, rede): o modal segue aberto, com o nome e o tipo preenchidos.
      renderChannelDialog();
      ui.channelCreateName.focus();
      return;
    }
    channels.dismissMessage();
    closeChannelCreate(false);
    // O canal aparece na seção dele. Texto: já abre no centro. Voz: fica na lista, para entrar quando quiser.
    if (kind === 'text' && roomId !== null && channels.state.roomId === roomId) openChannelChat(roomId, id);
    else ui.channelList.querySelector<HTMLButtonElement>('[data-create-kind="voice"]')?.focus();
  });
});

/** Abre uma sala ou a visão geral. Só muda o que é mostrado: entrar na chamada segue sendo uma ação à parte. Abrir uma
 * sala mostra o canal de texto padrão dela; a chamada em curso, de qualquer sala, continua. */
function navigate(roomId: string | null): void {
  if (roomId === null) channels?.close();
  else channels?.open(roomId);
  const covering = shell.state.drawerOpen;
  const room = roomId === null ? undefined : lobby.state.rooms.find((r) => r.room_id === roomId);
  const changed = roomId !== shell.state.selectedRoomId;
  shell.select(roomId);
  if (room && changed) {
    selectedVoiceId = null;
    showText(room.room_id); // texto padrão, com os membros ao lado
  } else if (roomId === null && members.state.status !== 'closed') {
    members.close(); // na visão geral não há painel de membros de uma sala
  }
  // Celular: escolher uma sala na barra global abre a gaveta de canais dela (a barra global segue visível e com o foco).
  if (room && drawerLayout()) {
    shell.openDrawer();
    return;
  }
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
// ---------- criação de sala (modal) ----------

const creating = (): boolean => lobby?.state.busy?.kind === 'create';

/** Abre o modal limpo, com foco no nome da sala. Todo botão "Criar sala" chega aqui. */
function openCreate(opener: HTMLElement): void {
  if (ui.createDialog.open) return;
  // Gaveta aberta (tela estreita): o conteúdo, onde o modal mora, fica inerte. Fecha a gaveta antes, como o Perfil;
  // ao fechar o modal, o foco volta ao "Menu", o controle visível que leva de volta à navegação.
  if (shell.state.drawerOpen) {
    shell.closeDrawer();
    opener = ui.shellMenuBtn;
  }
  createOpener = opener;
  ui.createName.value = '';
  ui.createCapacity.value = '2';
  lobby.clearActionError(); // erro antigo de outra ação não aparece no modal novo
  ui.createDialog.hidden = false;
  ui.createDialog.showModal();
  renderRooms();
  ui.createName.focus();
}

/** Fecha sem criar. Nunca durante o envio: o resultado precisa aparecer no modal. */
function closeCreate(restoreFocus = true): void {
  if (!ui.createDialog.open || creating()) return;
  ui.createDialog.close();
  ui.createDialog.hidden = true;
  lobby.clearActionError(); // o erro da criação não fica para trás, na página
  renderRooms();
  const opener = createOpener;
  createOpener = null;
  if (!restoreFocus) return;
  // O botão de origem pode ter sumido (ex.: o do estado vazio); então o foco vai para o título da tela.
  if (opener?.isConnected && !opener.closest('[hidden]') && opener.offsetParent !== null) opener.focus();
  else ui.contextTitle.focus();
}

ui.createOpenBtn.addEventListener('click', () => openCreate(ui.createOpenBtn));
ui.createEmptyBtn.addEventListener('click', () => openCreate(ui.createEmptyBtn));
ui.createCancelBtn.addEventListener('click', () => closeCreate());
ui.createCloseBtn.addEventListener('click', () => closeCreate());
// Escape (cancel nativo): fecha pelo mesmo caminho; durante o envio, nada acontece.
ui.createDialog.addEventListener('cancel', (event) => { event.preventDefault(); closeCreate(); });
// Fechamento forçado pelo navegador (ex.: Escape repetido): o estado acompanha, e um erro volta para a página.
ui.createDialog.addEventListener('close', () => { ui.createDialog.hidden = true; renderRooms(); });
// Clique na camada escura, fora da caixa: fecha só sem envio em andamento.
ui.createDialog.addEventListener('click', (event) => {
  if (event.target !== ui.createDialog) return;
  const r = ui.createDialog.getBoundingClientRect();
  const outside = event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom;
  if (outside) closeCreate();
});
// Tab circula só dentro do modal (o modal nativo deixaria o foco escapar para a barra do navegador).
ui.createDialog.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return;
  const items = [...ui.createDialog.querySelectorAll<HTMLElement>('button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])')]
    .filter((n) => !(n as HTMLButtonElement).disabled && n.offsetParent !== null);
  if (items.length === 0) return;
  const first = items[0]!;
  const last = items[items.length - 1]!;
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
// Sem nome global: o Perfil fica fora deste modal (o mesmo painel de sempre).
ui.createProfileBtn.addEventListener('click', () => { closeCreate(false); ui.profileOpen.click(); });

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (ui.profilePanel.open || ui.createDialog.open || ui.channelDialog.open || ui.inviteShare.open) return; // o cancel nativo fecha a camada
  if (voiceMenu !== null) return closeVoiceMenu(true); // Escape fecha o volume e devolve o foco ao cartão
  if (soundsOpen && !shell.state.drawerOpen) return setSoundsOpen(false); // Escape fecha os sons e devolve o foco
  closeDrawer();
});
// A janela cresceu com a navegação aberta: na tela grande ela não cobre mais nada.
window.matchMedia('(max-width: 768px)').addEventListener('change', (event) => {
  if (!event.matches) shell.closeDrawer();
});
// A janela ganhou a coluna do painel contextual: membros (Texto) ou chat (Voz) voltam para o lado, sem mudar o centro.
window.matchMedia('(min-width: 1200px)').addEventListener('change', (event) => {
  const roomId = shell.state.selectedRoomId;
  if (!event.matches || roomId === null || !lobby) return;
  if (centerKind === 'text') showText(roomId, chat.state.roomId === roomId ? chat.state.channelId : null);
  else showVoice(roomId, selectedVoiceId);
});

ui.refreshBtn.addEventListener('click', () => void lobby.refresh());
ui.createForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (globalName === null || creating()) return; // sem nome não cria; com envio em curso, não repete (Enter duplo)
  // p_display_name segue no contrato do create_room: vira o nome legado da sala, e a leitura prefere o global.
  void lobby.create(ui.createName.value, globalName, Number(ui.createCapacity.value)).then((id) => {
    if (!id) return ui.createName.focus(); // erro (permissão, limite, rede) fica no modal, que segue aberto
    closeCreate(false);
    navigate(id); // a sala nova fica em destaque; entrar na chamada segue sendo uma ação à parte
    ui.contextTitle.focus(); // o foco acompanha a sala criada, cujo nome está no título
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
let chatRenderedChannel: string | null = null;
let chatDeniedRefreshed = false;

function renderChat(s: ChatState): void {
  // Rascunho por canal: ao trocar de canal (ou de sala), o texto digitado fica no canal de origem e o campo recebe o do
  // destino. O que foi escrito para um canal nunca sai em outro.
  const key = s.status === 'closed' ? null : draftKey(s.roomId, s.channelId);
  if (key !== draftAt) {
    ui.chatInput.value = drafts.switch(draftAt, key, ui.chatInput.value);
    draftAt = key;
  }
  ui.chat.hidden = s.status === 'closed';
  const chatRoomName = lobby.state.rooms.find((r) => r.room_id === s.roomId)?.name ?? '';
  const chatChannel = channels?.state.roomId === s.roomId
    ? s.channelId === null ? defaultChannel(channels.state.channels, 'text') : channels.state.channels.find((c) => c.channel_id === s.channelId)
    : undefined;
  // Só o canal: a sala já está no cabeçalho e na lateral. Sem a lista de canais ainda, o nome da sala.
  ui.chatRoom.textContent = chatChannel ? `#${chatChannel.name}` : chatRoomName;
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
  const channelChanged = chatRenderedChannel !== s.channelId;
  chatRenderedChannel = s.channelId;
  if (roomChanged || channelChanged) renderRooms(); // "Chat aberto" e o canal em destaque: sem redesenhar a cada mensagem
  // Recusa do servidor: a pertença acabou. A lista de salas deixa de mostrar esta.
  if (s.status === 'denied' && !chatDeniedRefreshed) {
    chatDeniedRefreshed = true;
    void lobby.refresh();
  }
  if (s.status !== 'denied') chatDeniedRefreshed = false;
}

function submitChat(): void {
  if (chat.send(ui.chatInput.value)) {
    ui.chatInput.value = '';
    drafts.clear(draftAt); // enviado ao canal do campo: o rascunho dele acabou
  }
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

/** Convite num único modal centralizado (o mesmo controlador de sempre). Abrir fecha o menu "⋮" de onde veio; fechar
 * devolve o foco a ele. Nada é inserido no fluxo da página, então ela não pula nem duplica o convite. */
function renderInviteShare(s: InviteShareState): void {
  const show = s.roomId !== null;
  if (s.roomId !== null && !ui.inviteShare.open) {
    adminOpen.delete(s.roomId); // o menu "Gerenciar sala" não fica aberto atrás do modal
    if (shell.state.drawerOpen) shell.closeDrawer(); // o modal mora no conteúdo, inerte com a gaveta aberta
    ui.inviteShare.hidden = false;
    ui.inviteShare.showModal();
    // Ao abrir, o link ainda está sendo gerado e o Fechar fica desabilitado: o foco vai para o título do modal.
    document.getElementById('invite-share-title')?.focus();
  } else if (!show && ui.inviteShare.open) {
    ui.inviteShare.close();
  }
  if (!show) ui.inviteShare.hidden = true;
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
  renderRooms();
}

function renderInviteAccept(s: InviteAcceptState): void {
  const hint = inviteLoginHint(s);
  ui.inviteLoginHint.textContent = hint ?? '';
  ui.inviteLoginHint.hidden = hint === null;
  ui.inviteAccept.hidden = selfUserId === null || s.status === 'none';
  ui.inviteAcceptPending.hidden = s.status !== 'pending';
  ui.inviteAccount.textContent = ui.accountBox.title || ui.userLabel.textContent; // a conta (e-mail); o nome vai na linha abaixo
  const busy = s.status === 'pending' && s.busy;
  // Sem nome global o convite não é recusado nem consumido: espera nesta aba até o nome ser salvo no Perfil.
  ui.inviteAcceptBtn.disabled = busy || globalName === null;
  ui.inviteDeclineBtn.disabled = busy;
  ui.inviteProfileBtn.disabled = busy;
  identityNote(ui.inviteIdentityText, ui.inviteProfileBtn, 'Defina seu nome no perfil para aceitar. O convite continua nesta aba.');
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
// Escape (cancel nativo): fecha pelo controlador, que não fecha durante a geração ou a revogação.
ui.inviteShare.addEventListener('cancel', (event) => { event.preventDefault(); inviteShare.close(); });
// Fechou (pelo controlador ou forçado pelo navegador): estado e foco acompanham; o foco volta ao "⋮" da sala.
ui.inviteShare.addEventListener('close', () => {
  ui.inviteShare.hidden = true;
  if (inviteShare.state.roomId !== null) inviteShare.close();
  const menu = document.querySelector<HTMLElement>('.context-actions #rooms .room-admin > summary, #rooms .room-admin > summary');
  if (menu && menu.offsetParent !== null) menu.focus();
  else ui.contextTitle.focus();
});
ui.inviteAcceptForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (globalName === null) return; // o botão já fica desabilitado; Enter também não aceita sem nome
  void inviteAccept.accept(globalName); // p_display_name do redeem_room_invite: vira o nome legado; a leitura prefere o global
});
ui.inviteProfileBtn.addEventListener('click', () => ui.profileOpen.click()); // mesmo painel e regras do Perfil
ui.inviteDeclineBtn.addEventListener('click', () => inviteAccept.decline());
ui.inviteDismissBtn.addEventListener('click', () => inviteAccept.dismiss());
// O link aberto numa aba que já está na página não recarrega: só o fragmento muda.
window.addEventListener('hashchange', () => inviteAccept?.receive(takeInvite()));

// ---------- login ----------

function showLoggedIn(email: string | undefined): void {
  ui.login.hidden = true;
  ui.account.hidden = false;
  ui.userLabel.textContent = globalName ?? email ?? '(conta sem e-mail)';
  ui.accountBox.title = email ?? '';
  renderInviteAccept(inviteAccept.state);
}

/** Entrada na conta, por login ou sessão restaurada. Nunca inicia chamada nem pede o microfone. */
async function enterSession(session: Session): Promise<void> {
  if (selfUserId === session.user.id) { applyIdentity(session.user); return; }
  selfUserId = session.user.id;
  voiceMix.setAccount(selfUserId); // o volume de cada pessoa é desta conta
  currentUser = session.user;
  applyIdentity(session.user);
  const ticket = ++identityTicket;
  identityTimer = setInterval(() => void refreshIdentity(ticket), 15_000);
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
  identityTicket += 1;
  if (identityTimer !== null) clearInterval(identityTimer);
  identityTimer = null;
  identityReading = false;
  currentUser = null;
  globalName = null;
  ui.profileSave.disabled = false;
  ui.profileName.value = '';
  renderCreateIdentity();
  closeProfile();
  soundboard.leave();
  if (selfUserId !== null) void soundCache.purgeAccount(selfUserId);
  selfUserId = null;
  voiceMix.setAccount(null);
  accessToken = null;
  disconnectTicket += 1;
  if (ui.error.textContent === DISCONNECT_CHECKING.text) showNotice(null); // a explicação pendente foi descartada
  if (sweepTimer !== null) clearTimeout(sweepTimer);
  sweepTimer = null;
  entryGate.reset();
  chat.close();
  members.close();
  channels.close();
  callChannelId = null;
  entryChannelId = null;
  ui.channelCreateName.value = '';
  ui.chatInput.value = '';
  drafts.reset(); // nada do que foi digitado sobrevive à saída da conta
  draftAt = null;
  centerKind = 'text';
  selectedVoiceId = null;
  if (ui.channelDialog.open) ui.channelDialog.close(); // logout fecha a criação de canal, mesmo com envio em curso
  ui.channelDialog.hidden = true;
  channelOpenerKind = null;
  setCallNotice(null);
  lobby.reset();
  inviteShare.reset();
  callReturn.reset();
  inviteAccept.accountChanged();
  renderInviteAccept(inviteAccept.state);
  if (ui.createDialog.open) ui.createDialog.close(); // logout fecha a criação, mesmo com envio em curso
  ui.createDialog.hidden = true;
  createOpener = null;
  adminOpen.clear();
  shell.reset();
  ui.account.hidden = true;
  ui.login.hidden = false;
  ui.loginBtn.disabled = false;
}

function applyIdentity(user: User): void {
  if (user.id !== selfUserId) return;
  const previous = globalName;
  currentUser = user;
  globalName = accountName(user);
  ui.userLabel.textContent = globalName ?? user.email ?? '(conta sem e-mail)';
  // Conta identificada: o nome deixa de ser uma escolha independente por sala.
  renderCreateIdentity();
  if (inviteAccept) renderInviteAccept(inviteAccept.state); // nome salvo no Perfil libera o convite pendente
  if (previous !== globalName) void chat?.refreshNames();
}

async function refreshIdentity(ticket: number): Promise<void> {
  if (identityReading || document.hidden || ticket !== identityTicket || !selfUserId || ui.profileSave.disabled) return;
  identityReading = true;
  try {
    const { data, error } = await client.auth.getUser();
    if (!error && data.user && ticket === identityTicket) applyIdentity(data.user);
  } catch { /* A identidade não derruba a chamada em caso de rede indisponível. */ }
  finally { if (ticket === identityTicket) identityReading = false; }
}

function closeProfile(): void {
  if (ui.profilePanel.open) ui.profilePanel.close();
  ui.profilePanel.hidden = true;
  ui.profileOpen.setAttribute('aria-expanded', 'false');
}
ui.profileOpen.addEventListener('click', () => {
  closeDrawer();
  ui.profileName.value = globalName ?? '';
  setMessage(ui.profileStatus, globalName ? null : { tone: 'info', text: 'Escolha seu nome global. Seus nomes atuais por sala continuam até você salvar.' });
  ui.profilePanel.hidden = false;
  ui.profilePanel.showModal();
  ui.profileOpen.setAttribute('aria-expanded', 'true');
  ui.profileName.focus();
});
ui.createProfileBtn.addEventListener('click', () => ui.profileOpen.click()); // mesmo painel e regras do Perfil
ui.profileClose.addEventListener('click', closeProfile);
ui.profilePanel.addEventListener('cancel', (event) => { event.preventDefault(); closeProfile(); });
ui.profilePanel.addEventListener('close', () => { ui.profilePanel.hidden = true; ui.profileOpen.setAttribute('aria-expanded', 'false'); });
ui.profileForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!currentUser || ui.profileSave.disabled) return;
  const userId = currentUser.id;
  const ticket = ++identityTicket;
  identityReading = false;
  if (identityTimer !== null) clearInterval(identityTimer);
  identityTimer = setInterval(() => void refreshIdentity(ticket), 15_000);
  ui.profileSave.disabled = true;
  void saveAccountName(client.auth, ui.profileName.value).then((result) => {
    if (ticket !== identityTicket || userId !== selfUserId) return;
    ui.profileSave.disabled = false;
    if (result.error) return setMessage(ui.profileStatus, { tone: 'error', text: result.error });
    applyIdentity(result.user!);
    ui.profileName.value = globalName ?? '';
    setMessage(ui.profileStatus, { tone: 'info', text: 'Nome salvo. As outras telas serão atualizadas automaticamente.' });
  });
});

type LoginMode = 'login' | 'signup' | 'forgot' | 'reset';
const LOGIN_TITLES: Record<LoginMode, string> = { login: 'Bem-vindo de volta!', signup: 'Crie sua conta', forgot: 'Recuperar senha', reset: 'Criar nova senha' };
const LOGIN_SUBTITLES: Record<LoginMode, string> = {
  login: 'Entre para voltar às suas salas.',
  signup: 'Leva menos de um minuto. Seu nome aparece para o seu grupo.',
  forgot: 'Enviaremos um link para você criar uma nova senha.',
  reset: 'Escolha a nova senha da sua conta.',
};
/** Um formulário por vez no cartão de acesso; os campos de senha sempre saem limpos e ocultos. As abas valem para
 * Entrar e Criar conta; recuperar e redefinir a senha usam o mesmo cartão, sem elas. */
function loginMode(mode: LoginMode): void {
  ui.loginTitle.textContent = LOGIN_TITLES[mode];
  ui.loginSubtitle.textContent = LOGIN_SUBTITLES[mode];
  ui.loginForm.hidden = mode !== 'login';
  ui.signupForm.hidden = mode !== 'signup';
  ui.forgotForm.hidden = mode !== 'forgot';
  ui.resetForm.hidden = mode !== 'reset';
  ui.authTabs.hidden = mode === 'forgot' || mode === 'reset';
  for (const [tab, selected] of [[ui.authTabLogin, mode === 'login'], [ui.signupOpen, mode === 'signup']] as const) {
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  ui.forgotOpen.hidden = mode !== 'login';
  ui.signupPassword.value = '';
  ui.signupConfirm.value = '';
  ui.resetPassword.value = '';
  ui.resetConfirm.value = '';
  hideAllPasswords();
  clearFieldErrors();
  signupTouched = false;
  renderPasswordRules();
  ({ login: ui.email, signup: ui.signupName, forgot: ui.forgotEmail, reset: ui.resetPassword })[mode].focus();
}

// ---------- formulários de acesso: erros por campo, senha visível, requisitos e telefone ----------

/** Depois da primeira tentativa de envio, os erros do cadastro acompanham a digitação. */
let signupTouched = false;

const SIGNUP_FIELDS: { field: SignupField; input: () => HTMLInputElement; error: () => HTMLElement }[] = [
  { field: 'name', input: () => ui.signupName, error: () => ui.signupNameError },
  { field: 'email', input: () => ui.signupEmail, error: () => ui.signupEmailError },
  { field: 'phone', input: () => ui.signupPhone, error: () => ui.signupPhoneError },
  { field: 'password', input: () => ui.signupPassword, error: () => ui.signupPasswordError },
  { field: 'confirmation', input: () => ui.signupConfirm, error: () => ui.signupConfirmError },
];

/** Erro junto do campo, como texto fixo; o campo fica marcado como inválido para leitores de tela. */
function fieldError(input: HTMLInputElement, node: HTMLElement, text: string | undefined): void {
  node.textContent = text ?? '';
  node.hidden = text === undefined;
  if (text === undefined) input.removeAttribute('aria-invalid');
  else input.setAttribute('aria-invalid', 'true');
}

function clearFieldErrors(): void {
  fieldError(ui.email, ui.emailError, undefined);
  fieldError(ui.password, ui.passwordError, undefined);
  for (const f of SIGNUP_FIELDS) fieldError(f.input(), f.error(), undefined);
}

const signupInput = (): SignupInput => ({
  name: ui.signupName.value, email: ui.signupEmail.value, phone: ui.signupPhone.value,
  password: ui.signupPassword.value, confirmation: ui.signupConfirm.value,
});

function showSignupErrors(errors: SignupErrors): void {
  for (const f of SIGNUP_FIELDS) fieldError(f.input(), f.error(), errors[f.field]);
}

/** Requisitos da senha: o estado aparece no ícone e no texto escondido para leitores de tela, não só na cor. */
function renderPasswordRules(): void {
  const checks = passwordChecks(ui.signupPassword.value, ui.signupConfirm.value);
  for (const item of ui.signupRules.querySelectorAll<HTMLElement>('[data-rule]')) {
    const met = checks[item.dataset['rule'] as keyof typeof checks] === true;
    item.dataset['met'] = String(met);
    item.setAttribute('aria-label', `${item.textContent ?? ''}: ${met ? 'atendido' : 'pendente'}`);
  }
}

function hideAllPasswords(): void {
  for (const button of ui.login.querySelectorAll<HTMLButtonElement>('[data-reveal]')) setPasswordVisible(button, false);
}

function setPasswordVisible(button: HTMLButtonElement, visible: boolean): void {
  const input = document.getElementById(button.dataset['reveal'] ?? '');
  if (!(input instanceof HTMLInputElement)) return;
  input.type = visible ? 'text' : 'password';
  button.setAttribute('aria-pressed', String(visible));
  const what = button.getAttribute('aria-label')?.includes('confirmação') ? 'confirmação da senha' : 'senha';
  button.setAttribute('aria-label', `${visible ? 'Ocultar' : 'Mostrar'} ${what}`);
}

// Mostrar/ocultar senha: um ouvinte para todos os botões; o foco continua no botão.
ui.login.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-reveal]');
  if (button) setPasswordVisible(button, button.getAttribute('aria-pressed') !== 'true');
});

// Abas: setas trocam entre Entrar e Criar conta (padrão de abas do WAI-ARIA).
ui.authTabs.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
  event.preventDefault();
  const toSignup = ui.signupForm.hidden;
  (toSignup ? ui.signupOpen : ui.authTabLogin).click();
  (toSignup ? ui.signupOpen : ui.authTabLogin).focus();
});
ui.authTabLogin.addEventListener('click', () => {
  if (!ui.loginForm.hidden) return;
  setMessage(ui.signupStatus, null);
  loginMode('login');
  ui.authTabLogin.focus();
});

ui.signupPhone.addEventListener('input', () => {
  const formatted = formatPhoneBR(ui.signupPhone.value);
  if (formatted !== ui.signupPhone.value) ui.signupPhone.value = formatted;
});
for (const input of [ui.signupPassword, ui.signupConfirm]) input.addEventListener('input', renderPasswordRules);
ui.signupForm.addEventListener('input', () => {
  if (signupTouched) showSignupErrors(validateSignup(signupInput()));
});

ui.googleBtn.addEventListener('click', () => {
  // Só em builds de revisão (VITE_ORYN_AUTH_GOOGLE=preview): nenhum fluxo OAuth é iniciado.
  setMessage(ui.signupStatus, { tone: 'info', text: 'Entrar com Google ainda não está disponível: depende da configuração do provedor.' });
});

ui.signupOpen.addEventListener('click', () => {
  if (!ui.signupForm.hidden) return;
  setMessage(ui.signupStatus, null); // aviso de outro fluxo (ex.: link de recuperação enviado) não vale para o cadastro
  loginMode('signup');
});
ui.signupCancel.addEventListener('click', () => loginMode('login'));
ui.signupForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (ui.signupBtn.disabled) return;
  // Validação antes do envio: erros junto dos campos, foco no primeiro. O telefone é conferido, mas não sai daqui.
  signupTouched = true;
  const errors = validateSignup(signupInput());
  showSignupErrors(errors);
  const first = SIGNUP_FIELDS.find((f) => errors[f.field] !== undefined);
  if (first) return first.input().focus();
  const password = ui.signupPassword.value;
  ui.signupPassword.value = '';
  ui.signupConfirm.value = '';
  renderPasswordRules();
  ui.signupBtn.disabled = true;
  ui.signupCancel.disabled = true;
  void registerAccount(client.auth, ui.signupEmail.value, password, ui.signupName.value).then(async (result) => {
    ui.signupBtn.disabled = false;
    ui.signupCancel.disabled = false;
    if (result.kind === 'signed-in') { loginMode('login'); await enterSession(result.session); return; }
    const text = result.kind === 'invalid' ? NAME_ERROR : result.kind === 'failed' ? 'Não foi possível criar a conta. Confira os dados e a disponibilidade do cadastro.' : 'Confira seu e-mail para confirmar a conta. Depois, volte e entre com sua senha.';
    setMessage(ui.signupStatus, { tone: result.kind === 'confirm' ? 'info' : 'error', text });
    if (result.kind === 'confirm') { ui.email.value = ui.signupEmail.value.trim(); loginMode('login'); }
  });
});
if (authLink.kind === 'notice') setMessage(ui.signupStatus, authLink.notice);

// ---------- recuperação de senha ----------

ui.forgotOpen.addEventListener('click', () => {
  ui.forgotEmail.value = ui.email.value.trim();
  setMessage(ui.signupStatus, null);
  loginMode('forgot');
});
ui.forgotCancel.addEventListener('click', () => loginMode('login'));
ui.forgotForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (ui.forgotBtn.disabled) return;
  ui.forgotBtn.disabled = true;
  ui.forgotCancel.disabled = true;
  void requestPasswordReset(client.auth, ui.forgotEmail.value, recoveryRedirect(publicLocation(window.location, cfg.publicOrigin))).then((notice) => {
    ui.forgotBtn.disabled = false;
    ui.forgotCancel.disabled = false;
    setMessage(ui.signupStatus, notice);
    if (notice.tone === 'info') { ui.email.value = ui.forgotEmail.value.trim(); loginMode('login'); }
  });
});

/** Cliente temporário da recuperação: nunca grava sessão nem entra na conta desta aba. */
let recovery: SupabaseClient | null = null;

async function beginRecovery(tokens: RecoveryTokens): Promise<void> {
  ui.login.hidden = false;
  loginMode('reset');
  ui.resetBtn.disabled = true;
  setMessage(ui.signupStatus, { tone: 'info', text: 'Conferindo o link de recuperação…' });
  recovery = createClient(cfg.supabaseUrl, cfg.publishableKey, { auth: recoveryAuthOptions() });
  if (!(await openRecovery(recovery.auth, tokens))) return finishRecovery({ tone: 'error', text: LINK_INVALID });
  ui.resetBtn.disabled = false;
  setMessage(ui.signupStatus, { tone: 'info', text: 'Link confirmado. Defina a nova senha.' });
  ui.resetPassword.focus();
}

/** Fim da recuperação, com ou sem troca: volta ao login e só então restaura a sessão desta aba, se houver. */
function finishRecovery(notice: { tone: 'info' | 'error'; text: string }): void {
  recovery = null;
  ui.resetBtn.disabled = false;
  ui.resetCancel.disabled = false;
  loginMode('login');
  setMessage(ui.signupStatus, notice);
  restoreLogin();
}

ui.resetForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (ui.resetBtn.disabled || recovery === null) return;
  const auth = recovery.auth;
  const password = ui.resetPassword.value;
  const confirmation = ui.resetConfirm.value;
  ui.resetPassword.value = ''; // a senha não fica no DOM
  ui.resetConfirm.value = '';
  ui.resetBtn.disabled = true;
  ui.resetCancel.disabled = true;
  void saveNewPassword(auth, password, confirmation).then((result) => {
    if (result.kind === 'retry') {
      ui.resetBtn.disabled = false;
      ui.resetCancel.disabled = false;
      setMessage(ui.signupStatus, { tone: 'error', text: result.text });
      ui.resetPassword.focus();
      return;
    }
    if (result.kind === 'expired') return finishRecovery({ tone: 'error', text: RECOVERY_EXPIRED });
    finishRecovery({ tone: 'info', text: result.signedOut ? PASSWORD_CHANGED : PASSWORD_CHANGED_PARTIAL });
  });
});
ui.resetCancel.addEventListener('click', () => {
  if (recovery === null) return;
  ui.resetCancel.disabled = true;
  void abandonRecovery(recovery.auth).then(() => finishRecovery({ tone: 'info', text: RECOVERY_CANCELLED }));
});

ui.loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  showError(null);
  // Preenchimento e formato do e-mail antes de ir ao Auth; o resto quem decide é o servidor.
  const invalid = validateLogin(ui.email.value, ui.password.value);
  fieldError(ui.email, ui.emailError, invalid.email);
  fieldError(ui.password, ui.passwordError, invalid.password);
  if (invalid.email !== undefined) return ui.email.focus();
  if (invalid.password !== undefined) return ui.password.focus();
  const email = ui.email.value.trim();
  const password = ui.password.value;
  ui.password.value = ''; // a senha não fica no DOM
  ui.loginBtn.disabled = true;
  void client.auth.signInWithPassword({ email, password }).then(async ({ data, error }) => {
    ui.loginBtn.disabled = false;
    if (error || !data.session || !data.user) {
      // No próprio cartão, com texto fixo: nunca a mensagem do Auth, que pode conter dados da conta.
      const code = authCode(error?.code);
      const text = code === 'invalid_credentials' ? 'E-mail ou senha incorretos.'
        : code === 'email_not_confirmed' ? 'Confirme seu e-mail pelo link que enviamos antes de entrar.'
          : `Não foi possível entrar agora (${code}). Tente de novo.`;
      setMessage(ui.signupStatus, { tone: 'error', text });
      return ui.password.focus();
    }
    setMessage(ui.signupStatus, null);
    loginMode('login');
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

function restoreLogin(): void {
  void restoreSession(client, authStorage).then(async (restored) => {
    restoringAuth = false;
    if (restored.status === 'valid' || restored.status === 'unverified') return enterSession(restored.session);
    ui.login.hidden = false;
    if (restored.status === 'revoked') showNotice(SESSION_ENDED);
    if (restored.status === 'unavailable') showNotice(SESSION_UNVERIFIED);
  }).catch(() => {
    restoringAuth = false;
    ui.login.hidden = false;
  });
}

try {
  cfg = parseWebConfig(import.meta.env as unknown as Record<string, string | undefined>);
  ui.authGoogle.hidden = cfg.googleAuth !== 'preview'; // oculto até o fluxo OAuth ser autorizado e configurado
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
    link: (token) => buildInviteLink(publicLocation(window.location, cfg.publicOrigin), token),
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
  channels = new ChannelsController({
    rpc: (fn, args) => backend.rpc(fn, args),
    confirm: (message) => window.confirm(message),
    isHidden: () => document.hidden,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    onChange: () => {
      renderRooms(); // inclui renderChannels; o cabeçalho usa o nome do canal e a ocupação da voz
      if (chat.state.status !== 'closed') renderChat(chat.state); // o título do chat usa o nome do canal
    },
    // Canal arquivado com o chat aberto nele: volta para o texto padrão do espaço (o histórico segue legível na lista).
    // Voz arquivada no palco: o palco volta para a voz padrão.
    onChannelGone: (channelId) => {
      if (selectedVoiceId === channelId) selectedVoiceId = null;
      const { roomId } = chat.state;
      const room = lobby.state.rooms.find((r) => r.room_id === roomId);
      if (room && chat.state.channelId === channelId && chat.state.pending.length === 0) chat.open(room.room_id, !room.is_open, null);
    },
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
      } else if (event === 'USER_UPDATED' && session?.user.id === selfUserId) {
        applyIdentity(session.user);
      } else if (session && selfUserId !== null && session.user.id !== selfUserId) {
        // O armazenamento é do navegador: outra aba entrou com outra conta, e esta aba não pode seguir misturando as duas.
        endByAuth(ACCOUNT_CHANGED);
        void enterSession(session);
      } else if (event === 'SIGNED_IN' && session && selfUserId === null && !loggingOut && !restoringAuth) {
        void enterSession(session); // login feito em outra aba
      }
    });
  });
  if (cfg.defaultRoomId) ui.room.value = cfg.defaultRoomId;
  // Com link de recuperação, a sessão guardada só é restaurada depois: o link nunca entra na conta desta aba.
  if (authLink.kind === 'recovery') void beginRecovery(authLink.tokens);
  else restoreLogin();
} catch (error) {
  ui.configError.textContent = `Configuração inválida: ${error instanceof Error ? error.message : 'erro'}. Veja .env.example.`;
  ui.configError.hidden = false;
}
