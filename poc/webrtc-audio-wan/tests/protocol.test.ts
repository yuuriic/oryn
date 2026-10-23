import { describe, expect, it } from 'vitest';
import {
  MAX_MESSAGE_BYTES,
  MAX_SDP_LENGTH,
  isSessionId,
  parseClientMessage,
  parseServerMessage,
} from '../src/protocol.ts';
import { preferOpus } from '../src/codecs.ts';

const SID = 'AbCdEfGhIjKlMnOpQrStUv';
const TOKEN = 'T'.repeat(42) + 'x'; // 43 caracteres base64url
const SDP = 'v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const CAND = { candidate: 'candidate:1 1 udp 2122260223 x 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 };

const parse = (v: unknown) => parseClientMessage(typeof v === 'string' ? v : JSON.stringify(v));

describe('isSessionId', () => {
  it('aceita 22 caracteres base64url e rejeita o resto', () => {
    expect(isSessionId(SID)).toBe(true);
    expect(isSessionId('a'.repeat(21))).toBe(false);
    expect(isSessionId('a'.repeat(23))).toBe(false);
    expect(isSessionId('AbCdEfGhIjKlMnOpQrSt+/')).toBe(false);
    expect(isSessionId(42)).toBe(false);
  });
});

describe('parseClientMessage — mensagens válidas', () => {
  it.each([
    [{ type: 'create', operatorKey: TOKEN }],
    [{ type: 'rejoin', sessionId: SID, operatorKey: TOKEN }],
    [{ type: 'invite' }],
    [{ type: 'leave' }],
    [{ type: 'join', invite: TOKEN }],
    [{ type: 'signal', epoch: 1, payload: { kind: 'offer', sdp: SDP } }],
    [{ type: 'signal', epoch: 1, payload: { kind: 'answer', sdp: SDP } }],
    [{ type: 'signal', epoch: 1, payload: { kind: 'candidate', candidate: CAND } }],
    [{ type: 'signal', epoch: 1, payload: { kind: 'candidate', candidate: { ...CAND, usernameFragment: 'abcd' } } }],
    [{ type: 'signal', epoch: 1, payload: { kind: 'candidate', candidate: { ...CAND, candidate: '' } } }],
    [{ type: 'signal', epoch: 0, payload: { kind: 'candidate', candidate: null } }],
  ])('%j', (msg) => {
    const result = parse(msg);
    expect(result).toEqual({ ok: true, value: msg });
  });
});

describe('parseClientMessage — rejeições', () => {
  it.each([
    ['JSON inválido', '{type:'],
    ['não-objeto', '[1,2]'],
    ['tipo desconhecido', { type: 'relay-audio' }],
    ['chave extra', { type: 'create', operatorKey: TOKEN, admin: true }],
    ['create sem chave do operador', { type: 'create' }],
    ['create com chave curta', { type: 'create', operatorKey: 'abc' }],
    ['rejoin sem chave', { type: 'rejoin', sessionId: SID }],
    ['invite com campos extras', { type: 'invite', sessionId: SID }],
    ['join sem convite', { type: 'join' }],
    ['join com convite curto', { type: 'join', invite: 'abc' }],
    ['join com convite de caracteres inválidos', { type: 'join', invite: `${'T'.repeat(42)}+` }],
    ['join pelo ID da sessão (modelo antigo)', { type: 'join', sessionId: SID }],
    ['epoch negativo', { type: 'signal', epoch: -1, payload: { kind: 'offer', sdp: SDP } }],
    ['epoch fracionário', { type: 'signal', epoch: 1.5, payload: { kind: 'offer', sdp: SDP } }],
    ['kind desconhecido', { type: 'signal', epoch: 1, payload: { kind: 'media', data: 'x' } }],
    ['sdp sem v=0', { type: 'signal', epoch: 1, payload: { kind: 'offer', sdp: 'hello' } }],
    ['sdp grande demais', { type: 'signal', epoch: 1, payload: { kind: 'offer', sdp: `v=0${'a'.repeat(MAX_SDP_LENGTH)}` } }],
    ['payload com chave extra', { type: 'signal', epoch: 1, payload: { kind: 'offer', sdp: SDP, x: 1 } }],
    ['candidato sem prefixo', { type: 'signal', epoch: 1, payload: { kind: 'candidate', candidate: { ...CAND, candidate: 'evil' } } }],
    ['candidato sem mid e índice', { type: 'signal', epoch: 1, payload: { kind: 'candidate', candidate: { ...CAND, sdpMid: null, sdpMLineIndex: null } } }],
    ['sdpMLineIndex fora da faixa', { type: 'signal', epoch: 1, payload: { kind: 'candidate', candidate: { ...CAND, sdpMLineIndex: 99 } } }],
    ['candidato com chave extra', { type: 'signal', epoch: 1, payload: { kind: 'candidate', candidate: { ...CAND, address: '1.2.3.4' } } }],
  ])('%s → invalid-message', (_name, msg) => {
    expect(parse(msg)).toEqual({ ok: false, code: 'invalid-message' });
  });

  it('mensagem acima do limite de bytes → too-large (antes do JSON.parse)', () => {
    const big = JSON.stringify({ type: 'create', pad: 'x'.repeat(MAX_MESSAGE_BYTES) });
    expect(parse(big)).toEqual({ ok: false, code: 'too-large' });
  });

  it('mede bytes UTF-8, não caracteres', () => {
    const multibyte = JSON.stringify({ type: 'join', invite: TOKEN, pad: 'ç'.repeat(MAX_MESSAGE_BYTES / 2) });
    expect(parse(multibyte).ok).toBe(false);
    expect(parse(multibyte)).toEqual({ ok: false, code: 'too-large' });
  });
});

describe('parseServerMessage', () => {
  it('aceita mensagens válidas do servidor', () => {
    for (const m of [
      { type: 'session', sessionId: SID, role: 'host', epoch: 0, peerPresent: false },
      { type: 'peer-joined', epoch: 1 },
      { type: 'peer-left', epoch: 1 },
      { type: 'signal', epoch: 1, payload: { kind: 'answer', sdp: SDP } },
      { type: 'session-closed', reason: 'expired' },
      { type: 'error', code: 'session-full' },
      { type: 'error', code: 'invite-invalid' },
      { type: 'invite', token: TOKEN, expiresAt: 123, publicOrigin: null },
      { type: 'invite', token: TOKEN, expiresAt: 123, publicOrigin: 'https://oryn-poc.example.com' },
    ]) {
      expect(parseServerMessage(JSON.stringify(m))).toEqual(m);
    }
  });

  it('rejeita mensagens fora do protocolo', () => {
    for (const raw of [
      'nope',
      JSON.stringify({ type: 'session', sessionId: SID, role: 'admin', epoch: 0, peerPresent: false }),
      JSON.stringify({ type: 'error', code: 'pwned' }),
      JSON.stringify({ type: 'peer-joined', epoch: 1, extra: true }),
      JSON.stringify({ type: 'signal', epoch: 1, payload: { kind: 'offer', sdp: 'x' } }),
      JSON.stringify({ type: 'invite', token: TOKEN, expiresAt: 1, publicOrigin: 'http://oryn-poc.example.com' }),
      JSON.stringify({ type: 'invite', token: TOKEN, expiresAt: 1, publicOrigin: 'javascript:alert(1)' }),
      JSON.stringify({ type: 'invite', token: TOKEN, expiresAt: 1, publicOrigin: 'https://evil.example/#' }),
      JSON.stringify({ type: 'invite', token: 'curto', expiresAt: 1, publicOrigin: null }),
      JSON.stringify({ type: 'invite', token: TOKEN, expiresAt: 1, publicOrigin: null, sessionId: SID }),
    ]) {
      expect(parseServerMessage(raw)).toBeNull();
    }
  });
});

describe('preferOpus', () => {
  it('coloca Opus primeiro e preserva a ordem dos demais', () => {
    const codecs = [{ mimeType: 'audio/red' }, { mimeType: 'audio/PCMU' }, { mimeType: 'audio/opus' }, { mimeType: 'audio/G722' }];
    expect(preferOpus(codecs).map((c) => c.mimeType)).toEqual(['audio/opus', 'audio/red', 'audio/PCMU', 'audio/G722']);
  });

  it('não altera listas sem Opus', () => {
    const codecs = [{ mimeType: 'audio/PCMA' }];
    expect(preferOpus(codecs)).toEqual(codecs);
  });
});
