// Registro de sessões de sinalização: lógica pura, sem sockets (testável de forma determinística).
// O servidor nunca recebe nem retransmite mídia: só encaminha offer/answer/candidate entre os
// dois participantes de uma sessão.
//
// Admissão (POC-02B.2B):
// - host = operador: só quem apresenta a chave do operador por um Host local cria a sessão ou
//   volta a ela (rejoin);
// - convidado = quem apresenta um convite de uso único emitido pelo operador; convites só
//   preenchem a vaga de convidado;
// - falhas de autorização repetidas na mesma conexão encerram a conexão.

import type { ClientMessage, ErrorCode, Role, ServerMessage } from '../src/protocol.ts';
import type { Admission } from './admission.ts';

export interface Participant {
  /** Identificador interno da conexão (não exposto a outros clientes). */
  readonly id: string;
  send(message: ServerMessage): void;
  /** Encerra a conexão (ex.: falhas de autorização repetidas). */
  close?(code: number, reason: string): void;
}

/** Contexto de admissão derivado do Host validado da conexão. */
export interface ConnectionContext {
  /** true quando o Host é local (loopback); false quando chegou pelo hostname público. */
  local: boolean;
}

interface Session {
  readonly id: string;
  host: Participant | null;
  guest: Participant | null;
  /** Incrementa a cada vez que um par é formado; sinais de epochs antigos são rejeitados. */
  epoch: number;
  lastActivity: number;
}

export interface RegistryOptions {
  maxSessions: number;
  /** Sessões com um único participante expiram após esse tempo sem atividade. */
  idleTimeoutMs: number;
  /** Falhas de autorização por conexão antes de encerrá-la. */
  maxAuthFailures: number;
  admission: Admission;
  /** Origem pública (https://hostname) informada ao operador junto com o convite, ou null. */
  publicOrigin: string | null;
  now: () => number;
  randomId: () => string;
  log?: (event: string) => void;
}

/** Prefixo curto para logs: nunca registra o identificador completo. */
export const shortId = (id: string): string => `${id.slice(0, 4)}…`;

const AUTH_ERRORS: readonly ErrorCode[] = ['unauthorized', 'invite-invalid', 'locked'];

export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly membership = new Map<string, Session>();
  private readonly authFailures = new Map<string, number>();
  private readonly options: RegistryOptions;

  constructor(options: RegistryOptions) {
    this.options = options;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /** Visão somente leitura para testes e diagnóstico (sem participantes). */
  inspect(sessionId: string): { host: boolean; guest: boolean; epoch: number } | null {
    const s = this.sessions.get(sessionId);
    return s ? { host: s.host !== null, guest: s.guest !== null, epoch: s.epoch } : null;
  }

  sessionOf(participant: Participant): string | null {
    return this.membership.get(participant.id)?.id ?? null;
  }

  handle(participant: Participant, message: ClientMessage, context: ConnectionContext): void {
    switch (message.type) {
      case 'create':
        return this.create(participant, message.operatorKey, context);
      case 'rejoin':
        return this.rejoin(participant, message.sessionId, message.operatorKey, context);
      case 'invite':
        return this.invite(participant);
      case 'join':
        return this.join(participant, message.invite);
      case 'signal':
        return this.signal(participant, message.epoch, message.payload);
      case 'leave':
        return this.leave(participant);
    }
  }

  /** Conexão encerrada (fechamento normal, erro ou heartbeat expirado). */
  disconnect(participant: Participant): void {
    this.leave(participant);
    this.authFailures.delete(participant.id);
  }

  /** Remove sessões ociosas com um único participante e convites expirados. */
  sweep(): void {
    this.options.admission.sweep();
    const limit = this.options.now() - this.options.idleTimeoutMs;
    for (const session of [...this.sessions.values()]) {
      const alone = (session.host === null) !== (session.guest === null);
      if (alone && session.lastActivity < limit) {
        const remaining = session.host ?? session.guest;
        this.destroy(session);
        remaining?.send({ type: 'session-closed', reason: 'expired' });
        this.log(`sessão ${shortId(session.id)} expirada por inatividade`);
      }
    }
  }

  /** Encerra todas as sessões (desligamento do servidor). */
  closeAll(): void {
    for (const session of [...this.sessions.values()]) {
      const members = [session.host, session.guest];
      this.destroy(session);
      for (const p of members) p?.send({ type: 'session-closed', reason: 'server-shutdown' });
    }
  }

  // ---------- operações ----------

  private create(p: Participant, operatorKey: string, context: ConnectionContext): void {
    if (this.membership.has(p.id)) return this.error(p, 'already-in-session');
    const auth = this.options.admission.verifyOperator(operatorKey, context.local);
    if (auth !== 'ok') return this.authFailure(p, auth);
    if (this.sessions.size >= this.options.maxSessions) return this.error(p, 'server-busy');
    let id = this.options.randomId();
    while (this.sessions.has(id)) id = this.options.randomId();
    const session: Session = { id, host: p, guest: null, epoch: 0, lastActivity: this.options.now() };
    this.sessions.set(id, session);
    this.membership.set(p.id, session);
    this.authFailures.delete(p.id);
    p.send({ type: 'session', sessionId: id, role: 'host', epoch: 0, peerPresent: false });
    this.sendInvite(p, session);
    this.log(`sessão ${shortId(id)} criada pelo operador`);
  }

  private rejoin(p: Participant, sessionId: string, operatorKey: string, context: ConnectionContext): void {
    if (this.membership.has(p.id)) return this.error(p, 'already-in-session');
    const auth = this.options.admission.verifyOperator(operatorKey, context.local);
    if (auth !== 'ok') return this.authFailure(p, auth);
    const session = this.sessions.get(sessionId);
    if (!session) return this.error(p, 'not-found');
    if (session.host) return this.error(p, 'session-full');
    this.authFailures.delete(p.id);
    this.occupy(session, 'host', p);
  }

  private invite(p: Participant): void {
    const session = this.membership.get(p.id);
    // Só o operador (host) da sessão emite convites.
    if (!session || session.host !== p) return this.authFailure(p, 'unauthorized');
    if (session.guest) return this.error(p, 'session-full');
    this.sendInvite(p, session);
  }

  private join(p: Participant, token: string): void {
    if (this.membership.has(p.id)) return this.error(p, 'already-in-session');
    const admission = this.options.admission;
    // Verificação e consumo na mesma chamada síncrona: atômico em relação a outras mensagens.
    const sessionId = admission.peekInvite(token);
    const session = sessionId === null ? undefined : this.sessions.get(sessionId);
    if (!session) {
      admission.consumeInvite(token); // descarta convite expirado ou órfão
      return this.authFailure(p, 'invite-invalid');
    }
    if (session.guest) return this.error(p, 'session-full'); // convite preservado para uso posterior
    if (admission.consumeInvite(token) !== session.id) return this.authFailure(p, 'invite-invalid');
    this.authFailures.delete(p.id);
    this.occupy(session, 'guest', p);
  }

  private occupy(session: Session, role: Role, p: Participant): void {
    session[role] = p;
    session.epoch += 1;
    session.lastActivity = this.options.now();
    this.membership.set(p.id, session);
    const other = this.peerOf(session, p);
    p.send({ type: 'session', sessionId: session.id, role, epoch: session.epoch, peerPresent: other !== null });
    other?.send({ type: 'peer-joined', epoch: session.epoch });
    this.log(`sessão ${shortId(session.id)}: ${role === 'host' ? 'operador' : 'convidado'} entrou (epoch ${session.epoch})`);
  }

  private signal(p: Participant, epoch: number, payload: Extract<ClientMessage, { type: 'signal' }>['payload']): void {
    const session = this.membership.get(p.id);
    if (!session) return this.error(p, 'not-in-session');
    const other = this.peerOf(session, p);
    if (!other) return this.error(p, 'no-peer');
    if (epoch !== session.epoch) return this.error(p, 'stale-epoch');
    // Ordem de papéis: somente o host oferta e somente o guest responde.
    const role: Role = session.host === p ? 'host' : 'guest';
    if ((payload.kind === 'offer' && role !== 'host') || (payload.kind === 'answer' && role !== 'guest')) {
      return this.error(p, 'unexpected-signal');
    }
    session.lastActivity = this.options.now();
    // Encaminhamento opaco: o conteúdo de SDP/candidatos não é registrado nem inspecionado além da validação.
    other.send({ type: 'signal', epoch, payload });
  }

  private leave(p: Participant): void {
    const session = this.membership.get(p.id);
    if (!session) return;
    this.membership.delete(p.id);
    if (session.host === p) session.host = null;
    if (session.guest === p) session.guest = null;
    const remaining = session.host ?? session.guest;
    if (remaining) {
      session.lastActivity = this.options.now();
      remaining.send({ type: 'peer-left', epoch: session.epoch });
      this.log(`sessão ${shortId(session.id)}: participante saiu`);
    } else {
      this.destroy(session);
      this.log(`sessão ${shortId(session.id)} encerrada (vazia); convites revogados`);
    }
  }

  private destroy(session: Session): void {
    for (const p of [session.host, session.guest]) if (p) this.membership.delete(p.id);
    session.host = session.guest = null;
    this.sessions.delete(session.id);
    this.options.admission.revokeSession(session.id);
  }

  private sendInvite(p: Participant, session: Session): void {
    const { token, expiresAt } = this.options.admission.issueInvite(session.id);
    p.send({ type: 'invite', token, expiresAt, publicOrigin: this.options.publicOrigin });
    this.log(`sessão ${shortId(session.id)}: convite emitido`); // o token nunca é registrado
  }

  private authFailure(p: Participant, code: ErrorCode): void {
    const count = (this.authFailures.get(p.id) ?? 0) + 1;
    this.authFailures.set(p.id, count);
    this.error(p, code);
    if (AUTH_ERRORS.includes(code)) this.log(`falha de autorização (${code})`);
    if (count >= this.options.maxAuthFailures) {
      this.authFailures.delete(p.id);
      p.close?.(1008, 'too many failed attempts');
    }
  }

  private peerOf(session: Session, p: Participant): Participant | null {
    return session.host === p ? session.guest : session.host;
  }

  private error(p: Participant, code: ErrorCode): void {
    p.send({ type: 'error', code });
  }

  private log(event: string): void {
    this.options.log?.(event);
  }
}
