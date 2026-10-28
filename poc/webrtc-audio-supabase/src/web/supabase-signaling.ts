// Sinalização do PeerCall pelo backend Supabase validado na C2 (02C, integração). Implementa `SignalingLike`
// emulando as mensagens do servidor WebSocket da POC-02B a partir de:
// - RPCs da 0200 (join_room, get_roster, touch_session, ack_signals, leave_room), com o JWT do usuário;
// - canal PRIVADO `oryn:s:{sessão}` (só o dono da sessão recebe; nenhum cliente publica em `oryn:*`):
//     `hello`/`bye` (controle, publicados pelo banco) e `signal` (envelope publicado pela Edge Function);
// - Edge Function `signal` para SDP e ICE (nunca Broadcast do cliente), com sendSignal (mesmo client_msg_id
//   nas retentativas) e SignalReceiver (duplicatas, ordem por seq, epoch, acks).
//
// Decisões (aprovadas para a integração):
// - 1:1: o primeiro participante de OUTRA conta vira o par; outras sessões são ignoradas até ele sair.
// - Iniciador (host = cria a offer) e pair_epoch DETERMINÍSTICOS, funções só dos dois session_id: os dois
//   lados chegam ao mesmo valor sem contador local. Cada entrada na sala cria uma sessão nova, então um novo
//   par sempre tem epoch novo (salvo colisão de hash, inofensiva: sinais são filtrados pela sessão do par).
// - Candidatos ICE um a um, por uma fila serial (preserva a ordem de envio) com limite de taxa próprio,
//   abaixo do limite do banco (40 por sessão em 10 s).
// - Só STUN: a configuração ICE é respondida localmente, sem credenciais.
//
// Segurança: o adaptador só usa o JWT do usuário (via backend) e nunca registra SDP, candidatos, tokens ou
// e-mails; os logs citam códigos curtos. O remetente de um sinal vem do servidor (envelope), nunca do cliente.

import { isUuid, parseSignalRequest, type SignalEnvelope, type SignalRequest } from '../../supabase/functions/_shared/signal-contract.ts';
import { parseControlEvent, parseRosterEntry, type RosterEntry } from '../contracts.ts';
import { SignalReceiver } from '../signal-receiver.ts';
import { sendSignal, type SendOptions, type TransportResponse } from '../signal-sender.ts';
import type { SignalingLike } from './call.ts';
import type { IceServerConfig } from './ice.ts';
import type { ClientMessage, Role, ServerMessage, SignalPayload, SignalingHandlers } from './protocol.ts';

// ---------- backend (injetado: supabase-js em produção, fake nos testes) ----------

export interface RpcResult<T> {
  data: T | null;
  /** Mensagem de erro do PostgREST/Postgres (as RPCs da 0200 devolvem códigos curtos, ex. "not-member"). */
  error: string | null;
}

export interface ChannelHandlers {
  onBroadcast(event: string, payload: unknown): void;
  /** Mudança de estado DEPOIS da inscrição: CHANNEL_ERROR/TIMED_OUT (o cliente tenta de novo) ou CLOSED. */
  onStatus(status: 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED'): void;
}

export interface ChannelHandle {
  close(): Promise<void>;
}

export interface RoomBackend {
  rpc<T>(fn: string, args: Record<string, unknown>): Promise<RpcResult<T>>;
  /** Chama a Edge Function `signal` com o JWT do usuário. Lança em falha de rede. */
  invokeSignal(request: SignalRequest): Promise<TransportResponse>;
  /** Assina o tópico privado; resolve quando SUBSCRIBED, rejeita se a entrada for recusada. */
  openChannel(topic: string, handlers: ChannelHandlers): Promise<ChannelHandle>;
}

// ---------- regras determinísticas ----------

/** O iniciador (cria a offer) é a sessão de menor session_id. Os dois lados chegam à mesma conclusão. */
export const isInitiator = (self: string, peer: string): boolean => self < peer;

/** pair_epoch do par: FNV-1a 32 bits de "menor|maior", em 1..2^31-1. Simétrico e sem estado. */
export function pairEpoch(a: string, b: string): number {
  const text = a < b ? `${a}|${b}` : `${b}|${a}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % 0x7ffffffe) + 1;
}

/** Limite de taxa por janela deslizante (o banco recusa a partir de 40 sinais por sessão em 10 s). */
export class RateWindow {
  private readonly stamps: number[] = [];
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  constructor(max: number, windowMs: number, now: () => number) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
  }
  /** Espera necessária (ms) antes do próximo envio; 0 = pode enviar já (e o envio é registrado). */
  take(): number {
    const t = this.now();
    while (this.stamps.length && t - this.stamps[0]! >= this.windowMs) this.stamps.shift();
    if (this.stamps.length >= this.max) return this.windowMs - (t - this.stamps[0]!);
    this.stamps.push(t);
    return 0;
  }
}

// ---------- tradução de payload (PeerCall ⇄ contrato da Edge Function) ----------

export function toRequestPayload(p: SignalPayload): Pick<SignalRequest, 'kind' | 'payload'> {
  if (p.kind === 'offer' || p.kind === 'answer') return { kind: p.kind, payload: { sdp: p.sdp } };
  if (p.candidate === null) return { kind: 'end-of-candidates', payload: {} };
  const c = p.candidate;
  return {
    kind: 'candidate',
    payload: { candidate: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex, ...(c.usernameFragment != null ? { usernameFragment: c.usernameFragment } : {}) } },
  };
}

export function fromEnvelope(env: SignalEnvelope): SignalPayload | null {
  const p = env.payload as Record<string, unknown>;
  switch (env.kind) {
    case 'offer':
    case 'answer':
      return { kind: env.kind, sdp: p['sdp'] as string };
    case 'candidate':
      return { kind: 'candidate', candidate: p['candidate'] as Extract<SignalPayload, { kind: 'candidate' }>['candidate'] };
    case 'end-of-candidates':
      return { kind: 'candidate', candidate: null };
    case 'restart-request':
      return null; // renegociação não implementada (o PeerCall não reinicia ICE): só registrado
  }
}

// ---------- mensagens exibíveis (códigos curtos; nunca valores) ----------

/** Códigos de desconexão entregues ao PeerCall (onDisconnected). */
export const DISCONNECT = { auth: 4401, session: 4403, heartbeat: 4408, channel: 4500 } as const;

export const DISCONNECT_MESSAGES: Record<number, string> = {
  [DISCONNECT.auth]: 'autenticação recusada pelo servidor (faça login de novo)',
  [DISCONNECT.session]: 'a sessão na sala deixou de valer',
  [DISCONNECT.heartbeat]: 'o batimento da sessão falhou repetidamente',
  [DISCONNECT.channel]: 'o canal privado foi fechado pelo servidor',
};

const JOIN_ERRORS: Record<string, string> = {
  'not-member': 'Esta conta não é membro da sala informada.',
  'limit-reached': 'Esta conta já tem 2 sessões abertas na sala: feche a outra aba ou aguarde até 90 s.',
  'invalid-argument': 'Identificador de sala inválido.',
  unauthorized: 'Login recusado pelo servidor.',
};

/** Código curto para log: só [a-z0-9-], no máximo 40 caracteres (mensagens longas do servidor viram "erro"). */
export const shortCode = (message: string | null | undefined): string => {
  const m = (message ?? '').trim();
  return /^[a-z0-9-]{1,40}$/.test(m) ? m : 'erro';
};

// ---------- adaptador ----------

export interface SupabaseSignalingOptions {
  backend: RoomBackend;
  roomId: string;
  /** auth.uid() do usuário logado: sinais da PRÓPRIA conta (outra aba) nunca viram par. */
  selfUserId: string;
  handlers: SignalingHandlers;
  iceServers: IceServerConfig[];
  log?: (message: string) => void;
  now?: () => number;
  randomUUID?: () => string;
  heartbeatMs?: number;
  tickMs?: number;
  ackMs?: number;
  rateMax?: number;
  rateWindowMs?: number;
  maxQueue?: number;
  sendOptions?: SendOptions;
}

interface Outgoing {
  request: SignalRequest;
  peer: string;
}

type State = 'new' | 'connecting' | 'open' | 'closed';

export class SupabaseSignaling implements SignalingLike {
  private state: State = 'new';
  private sessionId: string | null = null;
  private peer: string | null = null;
  private channel: ChannelHandle | null = null;
  private receiver: SignalReceiver | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private queue: Outgoing[] = [];
  private pumping = false;
  private heartbeatFailures = 0;
  private discovery: Promise<void> = Promise.resolve();
  /**
   * Eventos recebidos antes de a descoberta inicial emitir `session`: guardados e reaplicados depois, para o
   * PeerCall nunca ver `peer-joined`/`signal` antes de `session`.
   */
  private early: { event: string; payload: unknown }[] | null = [];
  /** Esperas em curso (limite de taxa e backoff das retentativas): canceladas em close(), sem timer pendente. */
  private readonly waits = new Set<{ timer: ReturnType<typeof setTimeout>; resolve: () => void }>();
  private readonly sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (this.isClosed()) return resolve();
      const entry = {
        timer: setTimeout(() => {
          this.waits.delete(entry);
          resolve();
        }, ms),
        resolve,
      };
      this.waits.add(entry);
    });
  private readonly rate: RateWindow;
  private readonly o: Required<Omit<SupabaseSignalingOptions, 'sendOptions'>> & { sendOptions: SendOptions };
  /** Resolvida quando close() terminou (leave_room e remoção do canal). */
  closed: Promise<void> = Promise.resolve();
  /** Contadores para diagnóstico e testes (sem dados sensíveis). */
  readonly counters = { sent: 0, sendFailed: 0, delivered: 0, duplicates: 0, ignored: 0, acked: 0, dropped: 0 };

  constructor(options: SupabaseSignalingOptions) {
    this.o = {
      log: () => undefined,
      now: Date.now,
      randomUUID: () => crypto.randomUUID(),
      heartbeatMs: 30_000,
      tickMs: 500,
      ackMs: 1_000,
      rateMax: 30,
      rateWindowMs: 10_000,
      maxQueue: 64,
      sendOptions: {},
      ...options,
    };
    this.rate = new RateWindow(this.o.rateMax, this.o.rateWindowMs, this.o.now);
  }

  get session(): string | null {
    return this.sessionId;
  }
  get currentPeer(): string | null {
    return this.peer;
  }
  get queued(): number {
    return this.queue.length;
  }

  // ---- SignalingLike ----

  async connect(): Promise<void> {
    if (this.state !== 'new') throw new Error('Sinalização já iniciada.');
    if (!isUuid(this.o.roomId)) throw new Error(JOIN_ERRORS['invalid-argument']);
    this.state = 'connecting';

    const joined = await this.o.backend.rpc<{ session_id: string; topic: string }[]>('join_room', { p_room_id: this.o.roomId });
    const sid = joined.data?.[0]?.session_id;
    if (joined.error || !isUuid(sid)) {
      this.state = 'closed';
      const code = shortCode(joined.error);
      throw new Error(JOIN_ERRORS[code] ?? `Entrada na sala recusada (${code}).`);
    }
    this.sessionId = sid;
    this.receiver = new SignalReceiver({
      selfSession: sid,
      now: this.o.now,
      onDeliver: (env) => this.onDeliver(env),
      onGap: (from, seq) => this.o.log(`Lacuna na sinalização de ${from.slice(0, 8)}… (seq ${seq}); seguindo.`),
    });
    if (this.isClosed()) return void this.leave();

    try {
      this.channel = await this.o.backend.openChannel(`oryn:s:${sid}`, {
        onBroadcast: (event, payload) => this.onBroadcast(event, payload),
        onStatus: (status) => this.onChannelStatus(status),
      });
    } catch (error) {
      void this.leave();
      this.state = 'closed';
      throw new Error(`Canal privado da sessão recusado (${shortCode(error instanceof Error ? error.message : '')}).`);
    }
    if (this.isClosed()) {
      void this.channel?.close();
      return void this.leave();
    }

    this.state = 'open';
    this.timers.push(setInterval(() => void this.heartbeat(), this.o.heartbeatMs));
    this.timers.push(setInterval(() => this.receiver?.tick(), this.o.tickMs));
    this.timers.push(setInterval(() => void this.flushAcks(), this.o.ackMs));
    this.o.log('Sessão aberta na sala; canal privado assinado.');
    // Depois de connect() resolver (o PeerCall já está pronto): descobre quem está na sala.
    queueMicrotask(() => this.discover(true));
  }

  send(message: ClientMessage): boolean {
    if (this.state !== 'open') return false;
    switch (message.type) {
      case 'ice-request':
        // Só STUN, sem credenciais: respondido localmente, depois do retorno (como uma resposta de rede).
        queueMicrotask(() => this.emit({ type: 'ice-config', mode: message.mode, iceServers: this.o.iceServers, expiresAt: null }));
        return true;
      case 'signal':
        return this.enqueue(message.epoch, message.payload);
      case 'leave':
        return true; // a saída (leave_room) acontece em close(), que o PeerCall chama logo em seguida
      default:
        return false; // create/join/rejoin/invite: não existem neste backend
    }
  }

  /** Idempotente. Para timers, descarta a fila, sai da sala (bye para o par) e remove o canal. */
  close(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const w of this.waits) {
      clearTimeout(w.timer);
      w.resolve();
    }
    this.waits.clear();
    this.counters.dropped += this.queue.length;
    this.queue = [];
    const channel = this.channel;
    this.channel = null;
    this.closed = (async () => {
      await this.leave();
      await channel?.close().catch(() => undefined);
    })();
  }

  // ---- descoberta do par ----

  /** Serializada: hello e o roster inicial nunca adotam dois pares ao mesmo tempo. */
  private discover(initial: boolean): void {
    this.discovery = this.discovery.then(() => this.discoverNow(initial)).catch(() => undefined);
  }

  private async discoverNow(initial: boolean): Promise<void> {
    if (this.isClosed() || !this.sessionId) return;
    const res = await this.o.backend.rpc<unknown[]>('get_roster', { p_room_id: this.o.roomId });
    if (this.isClosed()) return;
    if (this.memberGone(res.error)) return;
    const roster = (res.data ?? []).map(parseRosterEntry).filter((e): e is RosterEntry => e !== null);
    if (res.error) this.o.log(`Roster indisponível (${shortCode(res.error)}).`);
    const others = roster.filter((e) => !e.is_self && e.session_id !== this.sessionId);
    if (initial) {
      const first = others[0];
      if (first) this.peer = first.session_id;
      const sid = this.sessionId;
      this.emit({
        type: 'session',
        sessionId: sid,
        role: first ? this.roleWith(first.session_id) : 'guest',
        epoch: first ? pairEpoch(sid, first.session_id) : 0,
        peerPresent: first !== undefined,
      });
      if (others.length > 1) this.o.log(`Sala com ${others.length} sessões de outras contas: só a primeira é atendida (1:1).`);
      const early = this.early ?? [];
      this.early = null;
      for (const e of early) this.onBroadcast(e.event, e.payload);
      return;
    }
    if (this.peer === null && others[0]) this.adopt(others[0].session_id);
  }

  private adopt(peer: string): void {
    if (!this.sessionId || this.peer !== null) return;
    this.peer = peer;
    this.o.log(`Par adotado: ${peer.slice(0, 8)}…`);
    this.emit({ type: 'peer-joined', epoch: pairEpoch(this.sessionId, peer), role: this.roleWith(peer) });
  }

  private dropPeer(reason: string): void {
    const peer = this.peer;
    if (!peer || !this.sessionId) return;
    this.peer = null;
    this.receiver?.forgetPeer(peer);
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => q.peer !== peer);
    this.counters.dropped += before - this.queue.length;
    this.o.log(`Par saiu (${reason}).`);
    this.emit({ type: 'peer-left', epoch: pairEpoch(this.sessionId, peer) });
    this.discover(false); // outra sessão viva de outra conta pode assumir
  }

  private roleWith(peer: string): Role {
    return isInitiator(this.sessionId!, peer) ? 'host' : 'guest';
  }

  // ---- recepção ----

  private onBroadcast(event: string, payload: unknown): void {
    if (this.isClosed()) return;
    if (this.early !== null) {
      if (this.early.length < 64) this.early.push({ event, payload });
      return;
    }
    if (event === 'signal') {
      const outcome = this.receiver?.receive(payload);
      if (outcome === 'duplicate') this.counters.duplicates += 1;
      else if (outcome && outcome !== 'delivered' && outcome !== 'buffered') this.o.log(`Sinal descartado (${outcome}).`);
      return;
    }
    if (event !== 'hello' && event !== 'bye') return;
    const ctl = parseControlEvent(event, payload);
    if (!ctl) return this.o.log(`Evento "${event}" inválido descartado.`);
    if (ctl.session_id === this.sessionId) return;
    if (ctl.event === 'bye') {
      if (ctl.session_id === this.peer) this.dropPeer('bye');
      return;
    }
    // hello: confirma pelo roster (sessão viva e de OUTRA conta) antes de adotar.
    if (this.peer === null) this.discover(false);
    else if (ctl.session_id !== this.peer) this.o.log('Terceira sessão na sala ignorada (1:1).');
  }

  private onDeliver(env: SignalEnvelope): void {
    // O envelope é montado pelo servidor: remetente = sessão viva da mesma sala, de from_user.
    if (env.from_user === this.o.selfUserId) {
      this.counters.ignored += 1;
      return this.o.log('Sinal de outra sessão da própria conta ignorado.');
    }
    if (this.peer === null) this.adopt(env.from_session); // chegou antes do hello/roster: o servidor já validou
    if (env.from_session !== this.peer) {
      this.counters.ignored += 1;
      return this.o.log('Sinal de terceira sessão ignorado (1:1).');
    }
    const payload = fromEnvelope(env);
    if (!payload) return this.o.log(`Sinal "${env.kind}" recebido e ignorado (renegociação não implementada).`);
    this.counters.delivered += 1;
    this.emit({ type: 'signal', epoch: env.pair_epoch, payload });
  }

  // ---- envio (fila serial + limite de taxa + retentativa do sendSignal) ----

  private enqueue(epoch: number, payload: SignalPayload): boolean {
    const peer = this.peer;
    if (!peer || !this.sessionId) return false;
    if (epoch !== pairEpoch(this.sessionId, peer)) {
      this.o.log('Sinal de negociação anterior não enviado.');
      return false;
    }
    if (this.queue.length >= this.o.maxQueue) {
      this.counters.dropped += 1;
      this.o.log('Fila de sinalização cheia; sinal descartado.');
      return false;
    }
    const request: SignalRequest = { session_id: this.sessionId, to_session_id: peer, client_msg_id: this.o.randomUUID(), pair_epoch: epoch, ...toRequestPayload(payload) };
    // Mesma validação da Edge Function: nada inválido sai daqui (ex.: SDP grande demais).
    if (!parseSignalRequest(JSON.stringify(request)).ok) {
      this.counters.dropped += 1;
      this.o.log(`Sinal "${request.kind}" fora do contrato; não enviado.`);
      return false;
    }
    this.queue.push({ request, peer });
    void this.pump();
    return true;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.isClosed() && this.queue.length > 0) {
        const wait = this.rate.take();
        if (wait > 0) {
          await this.sleep(wait);
          continue;
        }
        const item = this.queue.shift()!;
        if (item.peer !== this.peer) {
          this.counters.dropped += 1;
          continue;
        }
        const result = await sendSignal(item.request, (r) => this.o.backend.invokeSignal(r), { ...this.o.sendOptions, sleep: this.sleep });
        if (this.isClosed()) return;
        if (result.state === 'published') {
          this.counters.sent += 1;
          continue;
        }
        this.counters.sendFailed += 1;
        const reason = shortCode(result.reason);
        this.o.log(`Envio de "${item.request.kind}" falhou (${reason}, ${result.attempts} tentativa(s)).`);
        if (reason === 'unauthorized' || reason === 'jwt-invalid') return this.fatal(DISCONNECT.auth);
        if (reason === 'session-invalid') return this.fatal(DISCONNECT.session);
        if (reason === 'network-error') this.o.log('Sem resposta da função "signal" (rede, CORS ou função não publicada).');
      }
    } finally {
      this.pumping = false;
    }
  }

  // ---- manutenção ----

  private async heartbeat(): Promise<void> {
    if (this.isClosed() || !this.sessionId) return;
    const res = await this.o.backend.rpc<null>('touch_session', { p_session_id: this.sessionId });
    if (this.isClosed()) return;
    if (res.error) {
      const code = shortCode(res.error);
      if (code === 'session-invalid') return this.fatal(DISCONNECT.session);
      this.heartbeatFailures += 1;
      this.o.log(`Batimento falhou (${code}).`);
      if (this.heartbeatFailures >= 2) this.fatal(DISCONNECT.heartbeat);
      return;
    }
    this.heartbeatFailures = 0;
    // Par que caiu sem bye (aba fechada, rede): some do roster em até 90 s.
    if (this.peer !== null) {
      const roster = await this.o.backend.rpc<unknown[]>('get_roster', { p_room_id: this.o.roomId });
      if (this.isClosed() || this.memberGone(roster.error) || roster.error) return;
      const live = (roster.data ?? []).map(parseRosterEntry).some((e) => e?.session_id === this.peer);
      if (!live) this.dropPeer('sessão vencida');
    }
  }

  private async flushAcks(): Promise<void> {
    if (this.isClosed() || !this.sessionId || !this.receiver) return;
    const ids = this.receiver.takeAcks();
    if (ids.length === 0) return;
    const res = await this.o.backend.rpc<number>('ack_signals', { p_session_id: this.sessionId, p_msg_ids: ids });
    if (res.error) this.o.log(`Confirmação de sinais falhou (${shortCode(res.error)}).`);
    else this.counters.acked += ids.length;
  }

  private onChannelStatus(status: 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED'): void {
    if (this.isClosed()) return;
    if (status === 'CLOSED') return this.fatal(DISCONNECT.channel);
    this.o.log(`Canal privado: ${status}; o cliente Realtime tenta reconectar.`);
  }

  /**
   * MVP 01: `not-member` do get_roster depois de uma entrada aceita é terminal. A pertença só deixa de valer
   * com a sala encerrada (close_room) ou o membro removido, e nada desfaz isso. Só o código EXATO conta:
   * JWT vencido vira `unauthorized` ou mensagem do PostgREST, e falha de rede vira outra mensagem. Encerra com
   * 4403, como a sessão inválida no batimento.
   */
  private memberGone(error: string | null): boolean {
    if (shortCode(error) !== 'not-member') return false;
    this.fatal(DISCONNECT.session);
    return true;
  }

  private fatal(code: number): void {
    if (this.isClosed()) return;
    this.o.log(`Sinalização encerrada: ${DISCONNECT_MESSAGES[code] ?? code}.`);
    this.close();
    this.o.handlers.onDisconnected(code);
  }

  private async leave(): Promise<void> {
    const sid = this.sessionId;
    if (!sid) return;
    this.sessionId = null;
    const res = await this.o.backend.rpc<null>('leave_room', { p_session_id: sid }).catch(() => ({ data: null, error: 'erro' }));
    if (res.error) this.o.log(`Saída da sala não confirmada (${shortCode(res.error)}); a sessão vence em até 90 s.`);
  }

  private emit(message: ServerMessage): void {
    if (!this.isClosed()) this.o.handlers.onMessage(message);
  }

  private isClosed(): boolean {
    return this.state === 'closed';
  }
}
