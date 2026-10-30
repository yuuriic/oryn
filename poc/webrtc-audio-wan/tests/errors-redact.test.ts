import { describe, expect, it } from 'vitest';
import { describeMediaError } from '../src/errors.ts';
import { describeCandidate, describeDescription } from '../src/redact.ts';

describe('describeMediaError', () => {
  const cases: Array<[string, string]> = [
    ['NotAllowedError', 'permission-denied'],
    ['PermissionDeniedError', 'permission-denied'],
    ['SecurityError', 'insecure-context'],
    ['NotFoundError', 'no-device'],
    ['DevicesNotFoundError', 'no-device'],
    ['NotReadableError', 'device-busy'],
    ['TrackStartError', 'device-busy'],
    ['OverconstrainedError', 'constraints'],
    ['AbortError', 'aborted'],
    ['TypeError', 'unknown'],
  ];

  it.each(cases)('%s → %s', (name, code) => {
    const result = describeMediaError({ name, message: 'x' });
    expect(result.code).toBe(code);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('trata valores que não são erros', () => {
    expect(describeMediaError(undefined).code).toBe('unknown');
    expect(describeMediaError('falhou').code).toBe('unknown');
  });
});

describe('describeCandidate', () => {
  it('expõe somente tipo e protocolo', () => {
    const candidate = {
      type: 'host',
      protocol: 'udp',
      address: '192.0.2.44',
      candidate: 'candidate:1 1 udp 2122260223 192.0.2.44 54321 typ host',
    };
    const text = describeCandidate(candidate);
    expect(text).toBe('host/udp');
    expect(text).not.toContain('192.0.2.44');
  });

  it('sinaliza fim da coleta e campos ausentes', () => {
    expect(describeCandidate(null)).toBe('fim da coleta');
    expect(describeCandidate({})).toBe('desconhecido/?');
  });
});

describe('describeDescription', () => {
  const sdp = [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    'a=fingerprint:sha-256 AA:BB:CC',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
    'c=IN IP4 0.0.0.0',
    'a=ice-ufrag:abcd',
    'a=candidate:1 1 udp 2122260223 192.0.2.44 54321 typ host',
  ].join('\r\n');

  it('resume tipo e mídias sem vazar conteúdo do SDP', () => {
    const text = describeDescription({ type: 'offer', sdp });
    expect(text).toBe('offer — mídia: audio');
    for (const secret of ['192.0.2.44', 'abcd', 'AA:BB', '127.0.0.1', '4611731400430051336']) {
      expect(text).not.toContain(secret);
    }
  });

  it('trata descrição ausente ou sem mídia', () => {
    expect(describeDescription(null)).toBe('descrição ausente');
    expect(describeDescription({ type: 'answer', sdp: 'v=0' })).toBe('answer — mídia: nenhuma');
  });
});
