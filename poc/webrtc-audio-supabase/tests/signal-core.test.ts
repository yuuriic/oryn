// Núcleo da Edge Function `signal` com dependências SIMULADAS (unitário). Não prova nada sobre o Supabase
// real: só a lógica de estados, idempotência, mapeamento de erros e montagem do envelope.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RpcError, handleSignal, type AuthorizeResult, type SignalDeps } from '../supabase/functions/_shared/signal-core.ts';
import type { SignalEnvelope } from '../supabase/functions/_shared/signal-contract.ts';

// JWT fictício montado em execução (nenhum literal com formato de JWT fica versionado).
const JWT = ['eyJhbGciOiJSUzI1NiJ9', 'eyJzdWIiOiJ4In0', 'c2lnbmF0dXJh'].join('.');
const USER = randomUUID();
const SDP = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';

function request(over: Record<string, unknown> = {}) {
  return { session_id: randomUUID(), to_session_id: randomUUID(), client_msg_id: randomUUID(), kind: 'offer', pair_epoch: 2, payload: { sdp: SDP }, ...over };
}

interface Fake {
  deps: SignalDeps;
  states: string[];
  published: { topic: string; envelope: SignalEnvelope }[];
  logs: Record<string, unknown>[];
}

function fake(opts: { auth?: Partial<AuthorizeResult> | Error; user?: string | null; publishFails?: boolean; setStateFails?: string } = {}): Fake {
  const f: Fake = { deps: undefined as unknown as SignalDeps, states: [], published: [], logs: [] };
  f.deps = {
    verifyUser: async () => (opts.user === undefined ? USER : opts.user),
    authorize: async () => {
      if (opts.auth instanceof Error) throw opts.auth;
      return { msg_id: randomUUID(), seq: 7, from_user: USER, room_id: randomUUID(), state: 'accepted', duplicate: false, accepted_at: '2026-10-23T12:00:00.000Z', ...opts.auth };
    },
    setState: async (_id, state) => {
      if (opts.setStateFails === state) throw new Error('db down');
      f.states.push(state);
    },
    publish: async (topic, envelope) => {
      if (opts.publishFails) throw new Error('broadcast 500');
      f.published.push({ topic, envelope });
    },
    log: (e) => f.logs.push(e),
  };
  return f;
}

const call = (f: Fake, body: unknown, authorization: string | null = `Bearer ${JWT}`) => handleSignal({ authorization, body: JSON.stringify(body) }, f.deps);

describe('autenticação e validação', () => {
  it('sem Authorization, formato errado ou usuário inválido → 401', async () => {
    expect((await call(fake(), request(), null)).status).toBe(401);
    expect((await call(fake(), request(), 'Basic abc')).status).toBe(401);
    expect((await call(fake(), request(), `Bearer ${JWT} extra`)).status).toBe(401);
    expect((await call(fake({ user: null }), request())).status).toBe(401);
  });

  it('corpo inválido → 400; grande demais → 413; remetente no corpo → 400 (sem chamar o banco)', async () => {
    const f = fake();
    expect((await handleSignal({ authorization: `Bearer ${JWT}`, body: '{x' }, f.deps)).status).toBe(400);
    expect((await call(f, request({ payload: { sdp: `v=0${'a'.repeat(17_000)}` } }))).status).toBe(413);
    expect((await call(f, request({ from_session: randomUUID() }))).status).toBe(400);
    expect(f.states).toEqual([]);
  });

  it.each([
    ['session-invalid', 403],
    ['recipient-invalid', 403],
    ['not-member', 403],
    ['unauthorized', 403],
    ['invalid-argument', 400],
    ['idempotency-conflict', 409],
    ['rate-limited', 429],
  ])('erro do banco %s → %i, sem publicar', async (code, status) => {
    const f = fake({ auth: new RpcError(code) });
    const res = await call(f, request());
    expect(res.status).toBe(status);
    expect(res.body['error']).toBe(code);
    expect(f.published).toEqual([]);
  });

  it('banco indisponível → 503 com retryable', async () => {
    const res = await call(fake({ auth: new Error('timeout') }), request());
    expect(res).toEqual({ status: 503, body: { error: 'database-unavailable', retryable: true } });
  });

  it('remetente divergente entre JWT e banco (defesa em profundidade) → 403', async () => {
    const res = await call(fake({ auth: { from_user: randomUUID() } }), request());
    expect(res.status).toBe(403);
  });
});

describe('publicação e estados', () => {
  it('caminho feliz: publishing → published; envelope com remetente do servidor no tópico do destino', async () => {
    const f = fake();
    const req = request();
    const res = await call(f, req);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ state: 'published', seq: 7, duplicate: false });
    expect(f.states).toEqual(['publishing', 'published']);
    expect(f.published).toHaveLength(1);
    const { topic, envelope } = f.published[0]!;
    expect(topic).toBe(`oryn:s:${req.to_session_id}`);
    expect(envelope).toMatchObject({ v: 1, from_session: req.session_id, from_user: USER, to_session: req.to_session_id, seq: 7, kind: 'offer', pair_epoch: 2, sent_at: '2026-10-23T12:00:00.000Z' });
    expect(envelope.payload).toEqual({ sdp: SDP });
  });

  it('repetição de mensagem já publicada → 200 duplicate, SEM republicar', async () => {
    const f = fake({ auth: { duplicate: true, state: 'published' } });
    const res = await call(f, request());
    expect(res).toMatchObject({ status: 200, body: { duplicate: true, state: 'published' } });
    expect(f.published).toEqual([]);
    expect(f.states).toEqual([]);
  });

  it('falha entre registro e publicação: repetição de mensagem accepted/failed/publishing é republicada com o mesmo msg_id', async () => {
    const msg = randomUUID();
    for (const state of ['accepted', 'failed', 'publishing'] as const) {
      const f = fake({ auth: { msg_id: msg, duplicate: true, state } });
      const res = await call(f, request());
      expect(res.status, state).toBe(202);
      expect(f.published[0]!.envelope.msg_id).toBe(msg);
    }
  });

  it('falha no Broadcast → failed + 503 retryable (o cliente repete o MESMO client_msg_id)', async () => {
    const f = fake({ publishFails: true });
    const res = await call(f, request());
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'publish-failed', retryable: true, state: 'failed' });
    expect(f.states).toEqual(['publishing', 'failed']);
  });

  it('falha ao marcar publishing → 503 retryable, sem publicar', async () => {
    const f = fake({ setStateFails: 'publishing' });
    const res = await call(f, request());
    expect(res.status).toBe(503);
    expect(f.published).toEqual([]);
  });

  it('limite de tentativas → 409 definitivo', async () => {
    const f = fake();
    f.deps.setState = async () => {
      throw new RpcError('retry-limit');
    };
    expect((await call(f, request())).status).toBe(409);
  });

  it('publicado mas estado não gravado → 202 (verdade) e log recorded=false', async () => {
    const f = fake({ setStateFails: 'published' });
    const res = await call(f, request());
    expect(res.status).toBe(202);
    expect(f.logs.at(-1)).toMatchObject({ outcome: 'published', recorded: false });
  });

  it('logs nunca contêm JWT, SDP, payload, IDs completos ou usuário', async () => {
    const f = fake();
    const req = request();
    await call(f, req);
    await call(fake({ auth: new RpcError('session-invalid') }), req);
    const text = JSON.stringify(f.logs);
    for (const secret of [JWT, SDP, 'v=0', USER, req.session_id, req.to_session_id, req.client_msg_id]) expect(text).not.toContain(secret);
  });
});
