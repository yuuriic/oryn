// Recepção (duplicatas, fora de ordem, lacunas, epoch, idade, destino) e envio com retentativas pelo
// MESMO client_msg_id (unitário, relógio e transporte simulados). Entrega "pelo menos uma vez".
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SignalEnvelope, SignalRequest } from '../src/contracts.ts';
import { SignalReceiver } from '../src/signal-receiver.ts';
import { sendSignal, type TransportResponse } from '../src/signal-sender.ts';

const SELF = randomUUID();
const PEER = randomUUID();
const PEER_USER = randomUUID();

function env(seq: number, over: Partial<SignalEnvelope> = {}): SignalEnvelope {
  return {
    v: 1,
    msg_id: randomUUID(),
    seq,
    from_session: PEER,
    from_user: PEER_USER,
    to_session: SELF,
    sent_at: new Date(1_000_000).toISOString(),
    kind: 'candidate',
    pair_epoch: 1,
    payload: { candidate: { candidate: '', sdpMid: '0', sdpMLineIndex: 0 } },
    ...over,
  };
}

function receiver(now = { t: 1_000_500 }) {
  const delivered: number[] = [];
  const gaps: [string, number][] = [];
  const r = new SignalReceiver({ selfSession: SELF, now: () => now.t, onDeliver: (e) => delivered.push(e.seq), onGap: (f, s) => gaps.push([f, s]) });
  return { r, delivered, gaps, now };
}

describe('recepção', () => {
  it('entrega em ordem e descarta duplicatas (mesmo msg_id e seq já processado)', () => {
    const { r, delivered } = receiver();
    const one = env(1);
    expect(r.receive(one)).toBe('delivered');
    expect(r.receive(one)).toBe('duplicate');
    expect(r.receive({ ...env(1) })).toBe('duplicate'); // msg_id novo, seq antigo (republicação)
    expect(r.receive(env(2))).toBe('delivered');
    expect(delivered).toEqual([1, 2]);
  });

  it('duplicata tardia depois de esquecer o remetente (bye) continua descartada pelo msg_id', () => {
    const { r, delivered } = receiver();
    const one = env(1);
    r.receive(one);
    r.forgetPeer(PEER);
    expect(r.receive(one)).toBe('duplicate');
    expect(delivered).toEqual([1]);
  });

  it('fora de ordem: guarda adiantadas e entrega tudo em ordem quando a lacuna fecha', () => {
    const { r, delivered } = receiver();
    expect(r.receive(env(3))).toBe('buffered');
    expect(r.receive(env(2))).toBe('buffered');
    expect(r.receive(env(1))).toBe('delivered');
    expect(delivered).toEqual([1, 2, 3]);
  });

  it('lacuna que não fecha no prazo: avisa (restart-request) e segue a partir da próxima disponível', () => {
    const { r, delivered, gaps, now } = receiver();
    r.receive(env(1));
    r.receive(env(3));
    r.receive(env(4));
    now.t += 1_999;
    r.tick();
    expect(gaps).toEqual([]);
    now.t += 1;
    r.tick();
    expect(gaps).toEqual([[PEER, 2]]);
    expect(delivered).toEqual([1, 3, 4]);
  });

  it('epoch antigo é consumido mas não entregue; epoch novo passa a valer', () => {
    const { r, delivered } = receiver();
    r.receive(env(1, { pair_epoch: 2 }));
    expect(r.receive(env(2, { pair_epoch: 1 }))).toBe('stale-epoch');
    expect(r.receive(env(3, { pair_epoch: 3 }))).toBe('delivered');
    expect(delivered).toEqual([1, 3]);
    expect(r.epochOf(PEER)).toBe(3);
  });

  it('mensagem velha demais, de outro destinatário ou inválida é ignorada', () => {
    const { r, delivered } = receiver({ t: 1_000_000 + 60_001 });
    expect(r.receive(env(1))).toBe('too-old');
    expect(r.receive(env(1, { to_session: randomUUID(), sent_at: new Date(1_060_000).toISOString() }))).toBe('not-for-me');
    expect(r.receive({ ...env(1), from_user: 'admin' })).toBe('invalid');
    expect(r.receive('lixo')).toBe('invalid');
    expect(delivered).toEqual([]);
  });

  it('buffer limitado; remetentes independentes; confirmação em lotes de até 64', () => {
    const { r } = receiver();
    for (let i = 2; i <= 33; i++) r.receive(env(i));
    expect(r.receive(env(40))).toBe('buffer-full');
    const other = randomUUID();
    expect(r.receive(env(1, { from_session: other }))).toBe('delivered');
    r.receive(env(1));
    const acks = r.takeAcks(100);
    expect(acks.length).toBe(34);
    expect(acks.length).toBeLessThanOrEqual(64);
    r.forgetPeer(PEER);
    expect(r.receive(env(1))).toBe('delivered');
  });
});

describe('envio com retentativas', () => {
  const req: SignalRequest = { session_id: randomUUID(), to_session_id: randomUUID(), client_msg_id: randomUUID(), kind: 'end-of-candidates', pair_epoch: 0, payload: {} };
  const ok: TransportResponse = { status: 202, body: { msg_id: 'm', seq: 4, state: 'published', duplicate: false } };
  const noSleep = { sleep: async () => undefined };

  it('repete o MESMO pedido (mesmo client_msg_id) em falhas transitórias até publicar', async () => {
    const seen: SignalRequest[] = [];
    const replies: (TransportResponse | Error)[] = [new Error('rede'), { status: 503, body: { error: 'publish-failed', retryable: true } }, { status: 429, body: { error: 'rate-limited' } }, ok];
    const r = await sendSignal(req, async (x) => {
      seen.push(x);
      const next = replies.shift()!;
      if (next instanceof Error) throw next;
      return next;
    }, noSleep);
    expect(r).toEqual({ state: 'published', msg_id: 'm', seq: 4, attempts: 4, duplicate: false });
    expect(new Set(seen.map((x) => x.client_msg_id)).size).toBe(1);
  });

  it('duplicata já publicada conta como sucesso', async () => {
    const r = await sendSignal(req, async () => ({ status: 200, body: { msg_id: 'm', seq: 4, state: 'published', duplicate: true } }), noSleep);
    expect(r).toMatchObject({ state: 'published', duplicate: true, attempts: 1 });
  });

  it.each([400, 401, 403, 409, 413])('erro definitivo %i não é repetido', async (status) => {
    let calls = 0;
    const r = await sendSignal(req, async () => {
      calls += 1;
      return { status, body: { error: 'x' } };
    }, noSleep);
    expect(r).toMatchObject({ state: 'failed', retryable: false, attempts: 1 });
    expect(calls).toBe(1);
  });

  it('desiste após o máximo de tentativas, com espera exponencial limitada', async () => {
    const delays: number[] = [];
    const r = await sendSignal(req, async () => ({ status: 503, body: { error: 'publish-failed' } }), { sleep: async (ms) => void delays.push(ms) });
    expect(r).toEqual({ state: 'failed', reason: 'publish-failed', attempts: 5, retryable: true });
    expect(delays).toEqual([250, 500, 1000, 2000]);
  });
});
