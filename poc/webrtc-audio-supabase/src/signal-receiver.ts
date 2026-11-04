// Recepção de sinalização no cliente (POC-02C.1A). A entrega é PELO MENOS UMA VEZ e o transporte pode
// reordenar; este módulo garante, por remetente:
// - descarte de duplicatas por msg_id (e de seq já processado);
// - entrega em ordem de seq, com buffer limitado para mensagens adiantadas;
// - lacuna que não se fecha no prazo → aviso (o app pede restart-request) e salto para o próximo seq;
// - descarte de epoch antigo (renegociação substituída) e de mensagens velhas demais;
// - mensagens de outro destinatário ou inválidas são ignoradas;
// - coleta de msg_ids entregues para confirmar (ack_signals) em lotes.

import { parseEnvelope, type SignalEnvelope } from '../supabase/functions/_shared/signal-contract.ts';

export type ReceiveOutcome = 'delivered' | 'duplicate' | 'buffered' | 'stale-epoch' | 'too-old' | 'not-for-me' | 'invalid' | 'buffer-full';

export interface ReceiverOptions {
  selfSession: string;
  now: () => number;
  onDeliver: (envelope: SignalEnvelope) => void;
  /** Lacuna não preenchida a tempo: o app deve enviar restart-request ao remetente. */
  onGap: (fromSession: string, missingSeq: number) => void;
  maxAgeMs?: number;
  gapTimeoutMs?: number;
  maxBuffered?: number;
  maxSeen?: number;
}

interface PeerState {
  expected: number;
  buffer: Map<number, SignalEnvelope>;
  gapSince: number | null;
  epoch: number;
}

export class SignalReceiver {
  private readonly peers = new Map<string, PeerState>();
  private readonly seen = new Set<string>();
  private readonly acks: string[] = [];
  private readonly o: Required<ReceiverOptions>;

  constructor(options: ReceiverOptions) {
    this.o = { maxAgeMs: 60_000, gapTimeoutMs: 2_000, maxBuffered: 32, maxSeen: 512, ...options };
  }

  receive(raw: unknown): ReceiveOutcome {
    const env = parseEnvelope(raw);
    if (!env) return 'invalid';
    if (env.to_session !== this.o.selfSession) return 'not-for-me';
    if (this.seen.has(env.msg_id)) return 'duplicate';
    if (this.o.now() - Date.parse(env.sent_at) > this.o.maxAgeMs) {
      this.remember(env.msg_id);
      return 'too-old';
    }
    const peer = this.peer(env.from_session);
    if (env.seq < peer.expected) {
      this.remember(env.msg_id);
      return 'duplicate';
    }
    if (env.seq > peer.expected) {
      if (peer.buffer.has(env.seq)) return 'duplicate';
      if (peer.buffer.size >= this.o.maxBuffered) return 'buffer-full';
      peer.buffer.set(env.seq, env);
      peer.gapSince ??= this.o.now();
      return 'buffered';
    }
    const outcome = this.consume(peer, env);
    this.drain(peer);
    return outcome;
  }

  /** Chamado periodicamente: resolve lacunas vencidas. */
  tick(): void {
    for (const [from, peer] of this.peers) {
      if (peer.gapSince === null || this.o.now() - peer.gapSince < this.o.gapTimeoutMs || peer.buffer.size === 0) continue;
      this.o.onGap(from, peer.expected);
      peer.expected = Math.min(...peer.buffer.keys());
      peer.gapSince = null;
      this.drain(peer);
    }
  }

  /** Remetente saiu (bye) ou a sessão terminou: esquece o estado dele. */
  forgetPeer(fromSession: string): void {
    this.peers.delete(fromSession);
  }

  /** Até 64 msg_ids entregues para confirmar (ack_signals). */
  takeAcks(max = 64): string[] {
    return this.acks.splice(0, Math.min(max, 64));
  }

  epochOf(fromSession: string): number {
    return this.peers.get(fromSession)?.epoch ?? 0;
  }

  private peer(from: string): PeerState {
    let p = this.peers.get(from);
    if (!p) {
      p = { expected: 1, buffer: new Map(), gapSince: null, epoch: 0 };
      this.peers.set(from, p);
    }
    return p;
  }

  private consume(peer: PeerState, env: SignalEnvelope): ReceiveOutcome {
    peer.expected = env.seq + 1;
    this.remember(env.msg_id);
    if (env.pair_epoch < peer.epoch) return 'stale-epoch';
    peer.epoch = env.pair_epoch;
    this.acks.push(env.msg_id);
    this.o.onDeliver(env);
    return 'delivered';
  }

  private drain(peer: PeerState): void {
    for (let next = peer.buffer.get(peer.expected); next; next = peer.buffer.get(peer.expected)) {
      peer.buffer.delete(next.seq);
      this.consume(peer, next);
    }
    peer.gapSince = peer.buffer.size > 0 ? (peer.gapSince ?? this.o.now()) : null;
  }

  private remember(msgId: string): void {
    this.seen.add(msgId);
    if (this.seen.size > this.o.maxSeen) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}
