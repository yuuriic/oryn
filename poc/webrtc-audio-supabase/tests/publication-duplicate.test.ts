// Contrato de publicação, ponta a ponta LOCAL (02C.1A.1): SQL real (PGlite, com o shim) + núcleo da Edge
// Function + envio com retentativas + recepção. Cenário revisado pelo arquiteto:
//   1. o Broadcast REST aceita a publicação;
//   2. a Edge Function "morre" antes de registrar `published` (e a resposta não chega ao remetente);
//   3. o remetente repete o MESMO client_msg_id;
//   4. o destinatário recebe uma duplicata — e a descarta.
// Garantia demonstrada: PELO MENOS UMA VEZ com descarte de duplicatas (não "exatamente uma vez").
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RpcError, handleSignal, type AuthorizeResult, type SignalDeps } from '../supabase/functions/_shared/signal-core.ts';
import type { SignalEnvelope, SignalRequest } from '../src/contracts.ts';
import { SignalReceiver } from '../src/signal-receiver.ts';
import { sendSignal } from '../src/signal-sender.ts';
import { TestDb } from './helpers/db.ts';
import { scenario, type Scenario } from './helpers/fixtures.ts';

// JWT fictício montado em execução (nenhum literal com formato de JWT versionado).
const JWT = ['eyJhbGciOiJSUzI1NiJ9', 'eyJzdWIiOiJ4In0', 'c2lnbmF0dXJh'].join('.');
const SDP = 'v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';

let db: TestDb;
let s: Scenario;
beforeEach(async () => {
  db = await TestDb.create();
  s = await scenario(db);
});
afterEach(() => db.close());

const rpcCode = (error: unknown): RpcError => new RpcError(error instanceof Error ? error.message : 'erro');

/** Dependências da Edge Function ligadas ao banco REAL de teste; o Broadcast entrega ao receptor do dono. */
function edge(sender: { uid: string }, deliver: (env: SignalEnvelope) => void, crash: { onPublished: number }) {
  const published: SignalEnvelope[] = [];
  const deps: SignalDeps = {
    verifyUser: async () => sender.uid,
    authorize: async (_jwt, req, bytes) => {
      try {
        const rows = await db.rpc<AuthorizeResult & { accepted_at: Date }>(sender, 'public.authorize_signal', {
          p_session_id: req.session_id,
          p_to_session_id: req.to_session_id,
          p_client_msg_id: req.client_msg_id,
          p_kind: req.kind,
          p_pair_epoch: req.pair_epoch,
          p_payload_bytes: bytes,
        });
        const r = rows[0]!;
        return { ...r, seq: Number(r.seq), accepted_at: new Date(r.accepted_at).toISOString() };
      } catch (error) {
        throw rpcCode(error);
      }
    },
    setState: async (msgId, state) => {
      if (state === 'published' && crash.onPublished > 0) {
        crash.onPublished -= 1;
        throw new Error('função encerrada antes de registrar published');
      }
      try {
        await db.rpc('service', 'public.set_signal_state', { p_msg_id: msgId, p_state: state });
      } catch (error) {
        throw rpcCode(error);
      }
    },
    publish: async (_topic, envelope) => {
      published.push(envelope);
      deliver(structuredClone(envelope)); // o Broadcast REST aceitou e entregou
    },
    log: () => undefined,
  };
  return { deps, published };
}

describe('Broadcast aceito, função falha antes de registrar published, remetente repete', () => {
  it('o destinatário recebe a duplicata e a descarta; a mensagem é entregue uma vez à aplicação', async () => {
    const delivered: SignalEnvelope[] = [];
    const outcomes: string[] = [];
    const receiver = new SignalReceiver({ selfSession: s.ownerSession, now: () => Date.now(), onDeliver: (e) => delivered.push(e), onGap: () => undefined });
    const crash = { onPublished: 1 };
    const { deps, published } = edge(s.member, (env) => outcomes.push(receiver.receive(env)), crash);

    const request: SignalRequest = { session_id: s.memberSession, to_session_id: s.ownerSession, client_msg_id: crypto.randomUUID(), kind: 'offer', pair_epoch: 1, payload: { sdp: SDP } };
    let responsesLost = 1;
    const result = await sendSignal(request, async (req) => {
      const res = await handleSignal({ authorization: `Bearer ${JWT}`, body: JSON.stringify(req) }, deps);
      if (responsesLost > 0) {
        // A 1ª execução publicou mas não registrou `published`; a resposta também não chega ao remetente.
        responsesLost -= 1;
        throw new Error('conexão encerrada');
      }
      return res;
    }, { sleep: async () => undefined });

    // Remetente: sucesso após 2 tentativas; mesmo msg_id/seq nas duas publicações.
    expect(result).toMatchObject({ state: 'published', attempts: 2 });
    expect(published).toHaveLength(2);
    expect(published[1]!.msg_id).toBe(published[0]!.msg_id);
    expect(published[1]!.seq).toBe(published[0]!.seq);
    // Destinatário: a 1ª entrega vale; a republicação é descartada.
    expect(outcomes).toEqual(['delivered', 'duplicate']);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.payload).toEqual({ sdp: SDP });
    // Banco: uma única linha, publicada, com 2 tentativas; o payload nunca foi gravado.
    const rows = await db.admin<{ state: string; attempts: number }>('select state, attempts from oryn.signal_log');
    expect(rows).toEqual([{ state: 'published', attempts: 2 }]);
    expect(JSON.stringify(await db.admin('select * from oryn.signal_log'))).not.toContain('v=0');
    // Confirmação pelo destinatário: published → acknowledged; repetir é inofensivo.
    const acks = receiver.takeAcks();
    expect(acks).toEqual([published[0]!.msg_id]);
    expect((await db.rpc<{ ack_signals: number }>(s.owner, 'public.ack_signals', { p_session_id: s.ownerSession, p_msg_ids: acks }))[0]!.ack_signals).toBe(1);
    expect((await db.rpc<{ ack_signals: number }>(s.owner, 'public.ack_signals', { p_session_id: s.ownerSession, p_msg_ids: acks }))[0]!.ack_signals).toBe(0);
  });

  it('depois de published, uma nova repetição NÃO republica (200 duplicate)', async () => {
    const delivered: SignalEnvelope[] = [];
    const receiver = new SignalReceiver({ selfSession: s.ownerSession, now: () => Date.now(), onDeliver: (e) => delivered.push(e), onGap: () => undefined });
    const { deps, published } = edge(s.member, (env) => receiver.receive(env), { onPublished: 0 });
    const request: SignalRequest = { session_id: s.memberSession, to_session_id: s.ownerSession, client_msg_id: crypto.randomUUID(), kind: 'end-of-candidates', pair_epoch: 0, payload: {} };
    const first = await handleSignal({ authorization: `Bearer ${JWT}`, body: JSON.stringify(request) }, deps);
    const again = await handleSignal({ authorization: `Bearer ${JWT}`, body: JSON.stringify(request) }, deps);
    expect(first.status).toBe(202);
    expect(again).toMatchObject({ status: 200, body: { duplicate: true, state: 'published' } });
    expect(published).toHaveLength(1);
    expect(delivered).toHaveLength(1);
  });

  it('republicações repetidas param no limite de tentativas (5) sem nova linha nem novo seq', async () => {
    const { deps, published } = edge(s.member, () => undefined, { onPublished: 10 });
    const request: SignalRequest = { session_id: s.memberSession, to_session_id: s.ownerSession, client_msg_id: crypto.randomUUID(), kind: 'end-of-candidates', pair_epoch: 0, payload: {} };
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await handleSignal({ authorization: `Bearer ${JWT}`, body: JSON.stringify(request) }, deps)).status);
    // A resposta da 1ª à 5ª é 202 (publicado de fato, estado não gravado); a 6ª atinge o limite.
    expect(statuses).toEqual([202, 202, 202, 202, 202, 409]);
    expect(new Set(published.map((p) => `${p.msg_id}:${p.seq}`)).size).toBe(1);
    expect((await db.admin<{ n: number }>('select count(*)::int as n from oryn.signal_log'))[0]!.n).toBe(1);
  });
});
