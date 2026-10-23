// Contratos (02C.1A): pedido estrito (sem remetente), payloads por tipo, limites, envelope e eventos de
// controle. Unitário puro.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_REQUEST_BYTES,
  isDisplayName,
  isInviteToken,
  parseControlEvent,
  parseEnvelope,
  parseRosterEntry,
  parseSignalRequest,
  sessionTopic,
} from '../src/contracts.ts';

const SDP = 'v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const base = (over: Record<string, unknown> = {}) => ({
  session_id: randomUUID(),
  to_session_id: randomUUID(),
  client_msg_id: randomUUID(),
  kind: 'offer',
  pair_epoch: 1,
  payload: { sdp: SDP },
  ...over,
});
const parse = (v: unknown) => parseSignalRequest(JSON.stringify(v));

describe('pedido de sinalização', () => {
  it('pedidos válidos de cada tipo', () => {
    const cand = { candidate: { candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 } };
    for (const [kind, payload] of [
      ['offer', { sdp: SDP }],
      ['answer', { sdp: SDP }],
      ['candidate', cand],
      ['candidate', { candidate: { candidate: '', sdpMid: '0', sdpMLineIndex: null } }],
      ['end-of-candidates', {}],
      ['restart-request', { reason: 'gap' }],
    ] as const) {
      expect(parse(base({ kind, payload })).ok, kind).toBe(true);
    }
  });

  it('forjar remetente: from_session/from_user no corpo → pedido inválido', () => {
    expect(parse(base({ from_session: randomUUID() }))).toEqual({ ok: false, code: 'invalid-request' });
    expect(parse(base({ from_user: randomUUID() }))).toEqual({ ok: false, code: 'invalid-request' });
  });

  it.each([
    ['JSON inválido', '{x'],
    ['não é objeto', '[]'],
    ['session_id não UUID', JSON.stringify(base({ session_id: 'abc' }))],
    ['UUID maiúsculo', JSON.stringify(base({ to_session_id: randomUUID().toUpperCase() }))],
    ['origem = destino', (() => { const id = randomUUID(); return JSON.stringify(base({ session_id: id, to_session_id: id })); })()],
    ['tipo desconhecido', JSON.stringify(base({ kind: 'relay-audio' }))],
    ['epoch negativo', JSON.stringify(base({ pair_epoch: -1 }))],
    ['epoch fracionário', JSON.stringify(base({ pair_epoch: 1.5 }))],
    ['epoch acima de 2^31-1', JSON.stringify(base({ pair_epoch: 2 ** 31 }))],
    ['SDP sem v=0', JSON.stringify(base({ payload: { sdp: 'x' } }))],
    ['SDP vazio', JSON.stringify(base({ payload: { sdp: '' } }))],
    ['offer com chave extra', JSON.stringify(base({ payload: { sdp: SDP, type: 'offer' } }))],
    ['payload de outro tipo', JSON.stringify(base({ kind: 'candidate', payload: { sdp: SDP } }))],
    ['candidato sem prefixo', JSON.stringify(base({ kind: 'candidate', payload: { candidate: { candidate: 'x', sdpMid: '0', sdpMLineIndex: 0 } } }))],
    ['candidato sem mid e sem índice', JSON.stringify(base({ kind: 'candidate', payload: { candidate: { candidate: '', sdpMid: null, sdpMLineIndex: null } } }))],
    ['índice de linha 16', JSON.stringify(base({ kind: 'candidate', payload: { candidate: { candidate: '', sdpMid: null, sdpMLineIndex: 16 } } }))],
    ['end-of-candidates com conteúdo', JSON.stringify(base({ kind: 'end-of-candidates', payload: { x: 1 } }))],
    ['motivo de restart desconhecido', JSON.stringify(base({ kind: 'restart-request', payload: { reason: 'x' } }))],
  ])('%s → invalid-request', (_name, raw) => {
    expect(parseSignalRequest(raw)).toEqual({ ok: false, code: 'invalid-request' });
  });

  it('acima de 16 KiB → too-large (antes de interpretar o JSON); SDP acima de 12.000 → inválido', () => {
    expect(parseSignalRequest(JSON.stringify(base({ payload: { sdp: `v=0${'a'.repeat(MAX_REQUEST_BYTES)}` } })))).toEqual({ ok: false, code: 'too-large' });
    expect(parse(base({ payload: { sdp: `v=0${'a'.repeat(12_000)}` } }))).toEqual({ ok: false, code: 'invalid-request' });
    expect(parse(base({ kind: 'candidate', payload: { candidate: { candidate: `candidate:${'1'.repeat(1_100)}`, sdpMid: '0', sdpMLineIndex: 0 } } })).ok).toBe(false);
  });

  it('bytes contados em UTF-8', () => {
    const r = parse(base({ payload: { sdp: `v=0 ${'é'.repeat(100)}` } }));
    expect(r.ok && r.bytes > JSON.stringify(base()).length).toBe(true);
  });
});

describe('envelope recebido', () => {
  const env = (over: Record<string, unknown> = {}) => ({
    v: 1,
    msg_id: randomUUID(),
    seq: 1,
    from_session: randomUUID(),
    from_user: randomUUID(),
    to_session: randomUUID(),
    sent_at: new Date().toISOString(),
    kind: 'offer',
    pair_epoch: 0,
    payload: { sdp: SDP },
    ...over,
  });

  it('válido é aceito; versão, seq, datas, chaves extras e payload inválido são recusados', () => {
    expect(parseEnvelope(env())).not.toBeNull();
    for (const bad of [env({ v: 2 }), env({ seq: 0 }), env({ seq: 1.5 }), env({ sent_at: 'ontem' }), env({ extra: 1 }), env({ payload: { sdp: 'x' } }), env({ from_user: 'admin' })]) {
      expect(parseEnvelope(bad)).toBeNull();
    }
  });
});

describe('domínio', () => {
  it('convites, nomes, tópicos, eventos de controle e participantes', () => {
    expect(isInviteToken('A'.repeat(43))).toBe(true);
    expect(isInviteToken('A'.repeat(42))).toBe(false);
    expect(isInviteToken('A'.repeat(42) + '=')).toBe(false);
    expect(isDisplayName('Ana')).toBe(true);
    expect(isDisplayName('a\u0000b')).toBe(false);
    expect(isDisplayName('x'.repeat(33))).toBe(false);
    const id = randomUUID();
    expect(sessionTopic(id)).toBe(`oryn:s:${id}`);
    expect(parseControlEvent('hello', { session_id: id, label: 'Ana' })).toEqual({ event: 'hello', session_id: id, label: 'Ana' });
    expect(parseControlEvent('bye', { session_id: id })).toEqual({ event: 'bye', session_id: id });
    expect(parseControlEvent('hello', { session_id: id, label: 'Ana', sdp: 'v=0' })).toBeNull();
    expect(parseControlEvent('signal', { session_id: id })).toBeNull();
    expect(parseRosterEntry({ session_id: id, display_name: 'Ana', is_self: true, joined_at: 'x' })).not.toBeNull();
    expect(parseRosterEntry({ session_id: 'x', display_name: 'Ana', is_self: true, joined_at: 'x' })).toBeNull();
  });
});
