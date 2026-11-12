// Sinalização da voz multiponto (mesh). Herda de SupabaseSignaling a sessão, o canal privado, o batimento, os acks, a fila
// com limite de taxa e a saída da sala; o que muda é a regra de "quem é par": em vez de um só, um por CONTA.
//
// Identidade: um participante é uma conta (`participant_ref`, referência opaca do servidor), não uma sessão. Uma conta pode
// ter até 2 sessões vivas na sala. Para todos chegarem à mesma conclusão sem conversar, a regra só depende do que o servidor
// devolve: de cada conta, só a sessão MAIS ANTIGA entra no mesh. A outra fica em espera, sem nenhuma conexão, e assume quando
// a mais antiga sair. Isso mantém no máximo 4 conexões por cliente e 10 no total, com 5 contas.
//
// Sessão fantasma: se um navegador cai sem avisar, a sessão dele segue "viva" no servidor por até 90 s, e a pessoa pode voltar
// antes disso. A sessão nova não sabe que a antiga morreu. Quem sabe é o par, pela falha de ICE: ele passa para a próxima sessão
// daquela conta e a chama. A sessão em espera só negocia com quem a chamou. Assim, duas sessões vivas não duplicam conexões, e a
// volta não espera a antiga vencer.
//
// Papéis e `pair_epoch` são os mesmos do 1:1 (isInitiator, pairEpoch), funções só dos dois session_id: como o iniciador é
// determinístico, não há colisão de offer entre pares. Um cliente 1:1 anterior continua compatível numa sala com 2 contas.
//
// O servidor decide a pertença e autentica o remetente de cada sinal. Esta classe só escolhe com quem negociar.

import type { ControlEvent, VoiceParticipant } from '../contracts.ts';
import { parseVoiceParticipant } from '../contracts.ts';
import type { SignalEnvelope } from '../../supabase/functions/_shared/signal-contract.ts';
import type { Role, SignalPayload } from './protocol.ts';
import { SupabaseSignaling, fromEnvelope, isInitiator, pairEpoch, shortCode, type PeerLossReason, type SupabaseSignalingOptions } from './supabase-signaling.ts';

/** Com 5 contas, cada cliente fala com as outras 4. Um servidor com mais contas não abre mais conexões aqui. */
export const MAX_MESH_PEERS = 4;
/**
 * Cada par gasta offer ou answer, candidatos e fim de candidatos (um sinal cada): a fila do 1:1 ficaria curta para 4 pares
 * juntos. 192 dá 48 por par, folga larga sobre os 4 a 8 de uma negociação.
 */
const MESH_MAX_QUEUE = 192;
const MAX_PARKED_PER_SESSION = 32;

export interface MeshParticipant {
  session: string;
  ref: string;
  displayName: string;
}

export interface MeshEvents {
  /** A primeira descoberta terminou. Sempre antes de qualquer outro evento. */
  onOpen(sessionId: string): void;
  onPeerUp(peer: MeshParticipant, epoch: number, role: Role): void;
  onPeerDown(session: string, reason: 'left' | 'unreachable'): void;
  onSignal(session: string, epoch: number, payload: SignalPayload): void;
  /** Quem está na chamada, por conta, e se esta sessão está em espera, por haver outra mais antiga da mesma conta. */
  onParticipants(others: MeshParticipant[], standby: boolean): void;
  /** Evento do soundboard no tópico privado desta sessão. Não passa pela fila de sinalização. */
  onSound?(payload: unknown): void;
}

export interface MeshSignalingOptions extends Omit<SupabaseSignalingOptions, 'handlers'> {
  events: MeshEvents;
  onDisconnected(code: number): void;
}

/**
 * Uma sessão por conta: a mais antiga, sem contar as dadas como inalcançáveis. O servidor devolve em ordem de entrada.
 * Sem `unreachable`, é sempre a mais antiga.
 */
export function pickPrimaries(rows: readonly VoiceParticipant[], unreachable: ReadonlySet<string> = new Set()): VoiceParticipant[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.participant_ref) || unreachable.has(row.session_id)) return false;
    seen.add(row.participant_ref);
    return true;
  });
}

export class MeshSignaling extends SupabaseSignaling {
  private readonly peers = new Map<string, MeshParticipant>();
  /** Sinais de quem ainda não é par: podem chegar antes do hello. Entregues se a descoberta o adotar. */
  private readonly parked = new Map<string, SignalEnvelope[]>();
  /** Sessões em espera só negociam com quem as chamou: prova de que, para esse par, a sessão mais antiga morreu. */
  private readonly calledBy = new Set<string>();
  private readonly events: MeshEvents;
  private standby = false;
  private lastParticipants = '';
  private opened = false;

  constructor(options: MeshSignalingOptions) {
    const { events, onDisconnected, ...rest } = options;
    super({
      maxQueue: MESH_MAX_QUEUE,
      ...rest,
      handlers: { onMessage: () => undefined, onDisconnected, onInvalid: () => undefined },
    });
    this.events = events;
  }

  get peerSessions(): string[] {
    return [...this.peers.keys()];
  }
  get isStandby(): boolean {
    return this.standby;
  }
  get ownSession(): string | null {
    return this.sessionId;
  }

  /** Envia um sinal a um par. A fila, o limite de taxa e as retentativas são os mesmos do 1:1. */
  sendTo(session: string, epoch: number, payload: SignalPayload): boolean {
    if (this.isClosed() || !this.peers.has(session)) return false;
    return this.enqueueTo(session, epoch, payload);
  }

  /**
   * O caminho até UM par se perdeu. Os demais não são afetados. Como no 1:1: pede prova de vida e deixa de negociar até ela.
   * False: tentativas esgotadas, e o par fica como falho, até dar sinal de vida.
   */
  peerLost(session: string, epoch: number, reason: PeerLossReason): boolean {
    if (this.isClosed() || !this.sessionId || !this.peers.has(session) || epoch !== pairEpoch(this.sessionId, session)) return false;
    if (!this.spendRecovery(session)) {
      this.o.log(`Par inalcançável (${reason}): tentativas de recuperação esgotadas.`);
      return false;
    }
    this.o.log(`Par inalcançável (${reason}); aguardando reconexão.`);
    this.markSuspect(session);
    this.sendRestart(session, 'ice-failed');
    this.events.onPeerDown(session, 'unreachable');
    void this.heartbeat();
    return true;
  }

  /** A negociação com um par falhou de vez: ele só volta com prova de vida. A chamada com os demais continua. */
  abandon(session: string): void {
    if (this.peers.has(session)) this.markSuspect(session);
  }

  private markSuspect(session: string): void {
    this.peers.delete(session);
    this.suspects.add(session);
    this.dropQueued(session);
  }

  protected override isActivePeer(peer: string): boolean {
    return this.peers.has(peer);
  }

  // ---- descoberta ----

  protected override async discoverNow(initial: boolean): Promise<void> {
    if (this.isClosed() || !this.sessionId) return;
    const res = await this.participants('get_voice_participants');
    if (this.isClosed()) return;
    if (this.memberGone(res.error)) return;
    if (res.error) {
      this.o.log(`Participantes indisponíveis (${shortCode(res.error)}).`);
    } else {
      this.reconcile((res.data ?? []).map(parseVoiceParticipant).filter((e): e is VoiceParticipant => e !== null), initial);
    }
    if (initial) {
      this.opened = true;
      const early = this.early ?? [];
      this.early = null;
      for (const e of early) this.onBroadcast(e.event, e.payload);
    }
  }

  private reconcile(rows: readonly VoiceParticipant[], initial: boolean): void {
    const sid = this.sessionId!;
    for (const suspect of [...this.suspects]) {
      if (rows.some((r) => r.session_id === suspect)) continue;
      this.forgetSuspect(suspect);
      this.o.log('Par saiu (sessão vencida).');
    }
    for (const session of [...this.calledBy]) {
      if (!rows.some((r) => r.session_id === session)) this.calledBy.delete(session);
    }
    const standby = pickPrimaries(rows).some((p) => p.is_self && p.session_id !== sid);
    if (standby !== this.standby) {
      this.standby = standby;
      this.o.log(standby ? 'Outra sessão desta conta já está na chamada: esta fica em espera.' : 'Esta sessão assumiu a chamada desta conta.');
    }
    // De cada conta, a sessão mais antiga que não foi dada como inalcançável.
    const reachable = pickPrimaries(rows, this.suspects).filter((p) => !p.is_self);
    const oldest = new Map(pickPrimaries(rows).map((p) => [p.participant_ref, p.session_id]));
    const candidates = standby ? reachable.filter((p) => this.calledBy.has(p.session_id)) : reachable;
    const wanted = candidates.slice(0, MAX_MESH_PEERS);
    const wantedIds = new Set(wanted.map((p) => p.session_id));
    // Para a tela: cada conta uma vez, mesmo com a sessão inalcançável.
    const others = pickPrimaries(rows).filter((p) => !p.is_self).map((p) => reachable.find((r) => r.participant_ref === p.participant_ref) ?? p);

    if (initial) this.events.onOpen(sid);
    this.emitParticipants(others, standby && wanted.length === 0);
    for (const session of [...this.peers.keys()]) {
      if (!wantedIds.has(session)) this.dropMeshPeer(session, 'sessão vencida');
    }
    for (const p of wanted) {
      const existing = this.peers.get(p.session_id);
      // A mesma referência é usada pelos avisos do par. Atualizar só o rótulo
      // evita nomes antigos nos diagnósticos sem recriar nem renegociar a conexão.
      if (existing) existing.displayName = p.display_name;
      else this.adoptMesh(p, oldest.get(p.participant_ref) !== p.session_id);
    }
    // Quem não foi adotado perdeu os sinais guardados: se virar par, precisa pedir que venham de novo.
    for (const session of [...this.parked.keys()]) {
      this.parked.delete(session);
      this.ignoredFrom.add(session);
      this.counters.ignored += 1;
    }
  }

  private emitParticipants(others: readonly VoiceParticipant[], waiting: boolean): void {
    const list = others.map((p) => ({ session: p.session_id, ref: p.participant_ref, displayName: p.display_name }));
    const key = JSON.stringify([list, waiting]);
    if (key === this.lastParticipants) return;
    this.lastParticipants = key;
    this.events.onParticipants(list, waiting);
  }

  /** `fallback`: a sessão mais antiga dessa conta está inalcançável; esta pode estar em espera e precisa ser chamada. */
  private adoptMesh(p: VoiceParticipant, fallback: boolean): void {
    const sid = this.sessionId!;
    const session = p.session_id;
    const peer: MeshParticipant = { session, ref: p.participant_ref, displayName: p.display_name };
    this.peers.set(session, peer);
    this.o.log(`Par adotado: ${session.slice(0, 8)}…`);
    const role: Role = isInitiator(sid, session) ? 'host' : 'guest';
    // Sinais dele foram ignorados antes: quem só responde precisa pedir que a offer venha de novo.
    if ((this.ignoredFrom.delete(session) && role === 'guest') || fallback) this.sendRestart(session, 'ice-failed');
    this.events.onPeerUp(peer, pairEpoch(sid, session), role);
    const queued = this.parked.get(session);
    if (queued) {
      this.parked.delete(session);
      for (const env of queued) this.deliverToPeer(env);
    }
  }

  private dropMeshPeer(session: string, reason: string): void {
    if (!this.peers.delete(session)) return;
    this.receiver?.forgetPeer(session);
    this.dropQueued(session);
    this.o.log(`Par saiu (${reason}).`);
    this.events.onPeerDown(session, 'left');
  }

  // ---- recepção ----

  protected override onBroadcast(event: string, payload: unknown): void {
    if (event !== 'sound') return super.onBroadcast(event, payload);
    if (!this.isClosed()) this.events.onSound?.(payload);
  }

  protected override onControl(ctl: ControlEvent): void {
    if (ctl.session_id === this.sessionId) {
      // A própria sessão foi revogada (remoção ou saída em outra aba). O batimento confirma e encerra na hora, sem esperar 30 s.
      if (ctl.event === 'bye') void this.heartbeat();
      return;
    }
    if (ctl.event === 'bye') {
      if (this.peers.has(ctl.session_id)) this.dropMeshPeer(ctl.session_id, 'bye');
      else if (this.suspects.has(ctl.session_id)) {
        this.forgetSuspect(ctl.session_id);
        this.o.log('Par saiu (bye).');
      }
    }
    // hello e bye: quem entra é confirmado pelo servidor, e uma sessão em espera pode assumir.
    this.discover(false);
  }

  protected override onDeliver(env: SignalEnvelope): void {
    if (env.from_user === this.o.selfUserId) {
      this.counters.ignored += 1;
      return this.o.log('Sinal de outra sessão da própria conta ignorado.');
    }
    if (env.kind === 'restart-request') return this.onMeshRestart(env);
    const from = env.from_session;
    if (this.peers.has(from)) return this.deliverToPeer(env);
    this.suspects.delete(from); // prova de vida: o remetente vem do servidor
    if (this.standby) this.calledBy.add(from);
    const queued = this.parked.get(from) ?? [];
    if (queued.length < MAX_PARKED_PER_SESSION) queued.push(env);
    this.parked.set(from, queued);
    this.discover(false);
  }

  private deliverToPeer(env: SignalEnvelope): void {
    const payload = fromEnvelope(env);
    if (!payload) return this.o.log(`Sinal "${env.kind}" recebido e ignorado.`);
    this.counters.delivered += 1;
    this.events.onSignal(env.from_session, env.pair_epoch, payload);
  }

  private onMeshRestart(env: SignalEnvelope): void {
    const from = env.from_session;
    const reason = (env.payload as { reason?: unknown }).reason;
    if (reason !== 'ice-failed' && reason !== 'renegotiate') return this.o.log('Pedido de reconexão com outro motivo ignorado.');
    if (!this.peers.has(from)) {
      // Prova de vida de quem estava fora: a descoberta decide, pela regra de sempre, se ele volta a ser par.
      this.suspects.delete(from);
      this.ignoredFrom.delete(from); // quem pediu já refaz a própria parte
      if (this.standby) this.calledBy.add(from);
      this.discover(false);
      return;
    }
    if (reason === 'renegotiate') return; // resposta a um pedido nosso: o par já está em andamento
    if (!this.spendRecovery(from)) return this.o.log('Pedido de reconexão ignorado: tentativas esgotadas.');
    this.o.log('Um par pediu reconexão.');
    const peer = this.peers.get(from)!;
    const sid = this.sessionId!;
    this.peers.delete(from);
    this.dropQueued(from);
    this.sendRestart(from, 'renegotiate'); // antes da offer, na ordem da fila
    this.events.onPeerDown(from, 'unreachable');
    this.peers.set(from, peer);
    this.events.onPeerUp(peer, pairEpoch(sid, from), isInitiator(sid, from) ? 'host' : 'guest');
  }

  protected override async afterBeat(): Promise<void> {
    // Par que caiu sem bye some em até 90 s; e um suspeito pode ter voltado.
    if (this.opened) this.discover(false);
  }
}
