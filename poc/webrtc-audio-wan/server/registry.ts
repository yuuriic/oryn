// Registro de sessões de sinalização: lógica pura, sem sockets (testável de forma determinística).
// O servidor nunca recebe nem retransmite mídia: só encaminha offer/answer/candidate entre os
// dois participantes de uma sessão.

import type { ClientMessage, ErrorCode, Role, ServerMessage } from '../src/protocol.ts';

export interface Participant {
  /** Identificador interno da conexão (não exposto a outros clientes). */
  readonly id: string;
  send(message: ServerMessage): void;
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
  now: () => number;
  randomId: () => string;
  log?: (event: string) => void;
}

/** Prefixo curto para logs: nunca registra o identificador completo (que funciona como convite). */
export const shortId = (id: string): string => `${id.slice(0, 4)}…`;

export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly membership = new Map<string, Session>();
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

  handle(participant: Participant, message: ClientMessage): void {
    switch (message.type) {
      case 'create':
        return this.create(participant);
      case 'join':
        return this.join(participant, message.sessionId);
      case 'signal':
        return this.signal(participant, message.epoch, message.payload);
      case 'leave':
        return this.leave(participant);
    }
  }

  /** Conexão encerrada (fechamento normal, erro ou heartbeat expirado). */
  disconnect(participant: Participant): void {
    this.leave(participant);
  }

  /** Remove sessões ociosas com um único participante. Chamado periodicamente pelo servidor. */
  sweep(): void {
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

  private create(p: Participant): void {
    if (this.membership.has(p.id)) return this.error(p, 'already-in-session');
    if (this.sessions.size >= this.options.maxSessions) return this.error(p, 'server-busy');
    let id = this.options.randomId();
    while (this.sessions.has(id)) id = this.options.randomId();
    const session: Session = { id, host: p, guest: null, epoch: 0, lastActivity: this.options.now() };
    this.sessions.set(id, session);
    this.membership.set(p.id, session);
    p.send({ type: 'session', sessionId: id, role: 'host', epoch: 0, peerPresent: false });
    this.log(`sessão ${shortId(id)} criada`);
  }

  private join(p: Participant, sessionId: string): void {
    if (this.membership.has(p.id)) return this.error(p, 'already-in-session');
    const session = this.sessions.get(sessionId);
    if (!session) return this.error(p, 'not-found');
    if (session.host && session.guest) {
      this.log(`sessão ${shortId(sessionId)}: terceiro participante recusado`);
      return this.error(p, 'session-full');
    }
    // Quem chega ocupa a vaga livre. Se o host original saiu, o recém-chegado vira host
    // (é sempre o host quem cria a offer), e o participante remanescente continua guest.
    const role: Role = session.host === null ? 'host' : 'guest';
    session[role] = p;
    session.epoch += 1;
    session.lastActivity = this.options.now();
    this.membership.set(p.id, session);
    const other = this.peerOf(session, p);
    p.send({ type: 'session', sessionId, role, epoch: session.epoch, peerPresent: other !== null });
    other?.send({ type: 'peer-joined', epoch: session.epoch });
    this.log(`sessão ${shortId(sessionId)}: participante entrou como ${role} (epoch ${session.epoch})`);
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
      this.sessions.delete(session.id);
      this.log(`sessão ${shortId(session.id)} encerrada (vazia)`);
    }
  }

  private destroy(session: Session): void {
    for (const p of [session.host, session.guest]) if (p) this.membership.delete(p.id);
    session.host = session.guest = null;
    this.sessions.delete(session.id);
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
