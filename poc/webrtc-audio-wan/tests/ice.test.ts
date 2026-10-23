// Modos ICE no cliente (02B.4): montagem da RTCConfiguration, falha fechada, ausência de fallback,
// validação do protocolo e sanitização das estatísticas do par selecionado.
import { describe, expect, it } from 'vitest';
import { buildRtcConfiguration, parseIceUrl, type IceServerConfig } from '../src/ice.ts';
import { parseClientMessage, parseServerMessage } from '../src/protocol.ts';
import { describePair, mediaPath, selectedPair, type StatsEntry } from '../src/stats.ts';

const STUN: IceServerConfig = { urls: ['stun:stun.cloudflare.com:3478'] };
const TURN: IceServerConfig = {
  urls: [
    'turn:turn.cloudflare.com:3478?transport=udp',
    'turn:turn.cloudflare.com:3478?transport=tcp',
    'turns:turn.cloudflare.com:5349?transport=tcp',
    'turns:turn.cloudflare.com:443?transport=tcp',
  ],
  username: 'usuario-temporario',
  credential: 'segredo-temporario',
};
const UDP_ONLY: IceServerConfig = { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' };

const urlsOf = (config: RTCConfiguration): string[] => (config.iceServers ?? []).flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));

describe('URLs ICE', () => {
  it.each([
    ['stun:stun.cloudflare.com:3478', 'stun'],
    ['turn:turn.cloudflare.com:3478?transport=udp', 'turn'],
    ['turns:turn.cloudflare.com:443?transport=tcp', 'turns'],
    ['turn:127.0.0.1:3478', 'turn'],
  ])('aceita %s', (url, scheme) => {
    expect(parseIceUrl(url)?.scheme).toBe(scheme);
  });

  it.each([
    ['porta 53 (bloqueada pelos navegadores)', 'turn:turn.cloudflare.com:53?transport=udp'],
    ['stun com transporte', 'stun:stun.cloudflare.com:3478?transport=udp'],
    ['esquema http', 'http://turn.cloudflare.com'],
    ['credencial embutida', 'turn:user:pass@turn.cloudflare.com:3478'],
    ['transporte desconhecido', 'turn:turn.cloudflare.com:3478?transport=sctp'],
    ['porta zero', 'turn:turn.cloudflare.com:0'],
    ['maiúsculas/caracteres estranhos', 'TURN:turn.cloudflare.com'],
  ])('recusa %s', (_name, url) => {
    expect(parseIceUrl(url)).toBeNull();
  });
});

describe('modos ICE', () => {
  it('auto: STUN + TURN, iceTransportPolicy "all"', () => {
    const r = buildRtcConfiguration('auto', [STUN, TURN]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.config.iceTransportPolicy).toBe('all');
    expect(urlsOf(r.config)).toEqual([...STUN.urls, ...TURN.urls]);
    expect(r.turnConfigured).toBe(true);
    expect(r.summary).toBe('STUN 1 · TURN 4 (tcp, tls, udp)');
  });

  it('auto sem nenhum servidor (rede local): configuração vazia, policy "all"', () => {
    const r = buildRtcConfiguration('auto', []);
    expect(r).toMatchObject({ ok: true, turnConfigured: false, config: { iceServers: [], iceTransportPolicy: 'all' } });
  });

  it('direct: só STUN, mesmo recebendo TURN; policy "all"', () => {
    const r = buildRtcConfiguration('direct', [STUN, TURN]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.config.iceTransportPolicy).toBe('all');
    expect(urlsOf(r.config)).toEqual(STUN.urls);
    expect(JSON.stringify(r.config)).not.toContain('segredo-temporario');
    expect(r.turnConfigured).toBe(false);
  });

  it('relay: só TURN (udp/tcp/tls), policy "relay", nunca STUN', () => {
    const r = buildRtcConfiguration('relay', [STUN, TURN]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.config.iceTransportPolicy).toBe('relay');
    expect(urlsOf(r.config)).toEqual(TURN.urls);
    expect(urlsOf(r.config).some((u) => u.startsWith('stun:'))).toBe(false);
  });

  it('relay-tls: só turns: sobre TCP, policy "relay"; nenhuma URL turn: (UDP/TCP sem TLS)', () => {
    const r = buildRtcConfiguration('relay-tls', [STUN, TURN]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.config.iceTransportPolicy).toBe('relay');
    expect(urlsOf(r.config)).toEqual(['turns:turn.cloudflare.com:5349?transport=tcp', 'turns:turn.cloudflare.com:443?transport=tcp']);
    expect(r.summary).toBe('STUN 0 · TURN 2 (tls)');
  });

  it('relay-tls aceita turns: sem parâmetro de transporte; recusa turns: com transport=udp', () => {
    const ok = buildRtcConfiguration('relay-tls', [{ urls: ['turns:turn.cloudflare.com:443'], username: 'u', credential: 'c' }]);
    expect(ok.ok).toBe(true);
    const dtls = buildRtcConfiguration('relay-tls', [{ urls: ['turns:turn.cloudflare.com:443?transport=udp'], username: 'u', credential: 'c' }]);
    expect(dtls.ok).toBe(false);
  });

  describe('falha fechada', () => {
    it.each([
      ['relay sem servidores', 'relay', []],
      ['relay só com STUN', 'relay', [STUN]],
      ['relay com TURN sem credencial', 'relay', [{ urls: TURN.urls }]],
      ['relay com TURN só com username', 'relay', [{ urls: TURN.urls, username: 'u' }]],
      ['relay-tls sem servidores', 'relay-tls', []],
      ['relay-tls só com TURN/UDP', 'relay-tls', [UDP_ONLY]],
      ['relay-tls só com STUN', 'relay-tls', [STUN]],
    ] as const)('%s → recusado (nenhuma configuração produzida)', (_name, mode, servers) => {
      const r = buildRtcConfiguration(mode, servers as unknown as IceServerConfig[]);
      expect(r.ok).toBe(false);
      expect('config' in r).toBe(false);
    });
  });

  it('URLs inválidas (porta 53, esquema estranho) são descartadas antes de qualquer modo', () => {
    const r = buildRtcConfiguration('relay', [{ urls: ['turn:turn.cloudflare.com:53?transport=udp', 'turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' }]);
    if (!r.ok) throw new Error(r.reason);
    expect(urlsOf(r.config)).toEqual(['turn:turn.cloudflare.com:3478?transport=udp']);
  });

  it('resumo nunca contém hosts, portas ou credenciais', () => {
    for (const mode of ['auto', 'direct', 'relay', 'relay-tls'] as const) {
      const r = buildRtcConfiguration(mode, [STUN, TURN]);
      if (!r.ok) throw new Error(r.reason);
      expect(r.summary).not.toMatch(/cloudflare|3478|5349|443|usuario|segredo/);
    }
  });
});

describe('protocolo ICE', () => {
  it('ice-request só com modo conhecido e sem chaves extras', () => {
    expect(parseClientMessage('{"type":"ice-request","mode":"relay-tls"}')).toEqual({ ok: true, value: { type: 'ice-request', mode: 'relay-tls' } });
    for (const raw of ['{"type":"ice-request"}', '{"type":"ice-request","mode":"tcp"}', '{"type":"ice-request","mode":"auto","ttl":99999}']) {
      expect(parseClientMessage(raw).ok, raw).toBe(false);
    }
  });

  const msg = (iceServers: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'ice-config', mode: 'auto', iceServers, expiresAt: 1_700_000_000_000, ...extra });

  it('ice-config válido é aceito', () => {
    expect(parseServerMessage(msg([STUN, TURN]))).not.toBeNull();
    expect(parseServerMessage(msg([], { expiresAt: null }))).not.toBeNull();
  });

  it.each([
    ['URL com porta 53', [{ urls: ['turn:x.example:53'], username: 'u', credential: 'c' }]],
    ['URL de outro esquema', [{ urls: ['https://x.example'] }]],
    ['TURN sem credencial', [{ urls: ['turn:x.example:3478'] }]],
    ['credencial em servidor só STUN', [{ urls: ['stun:x.example:3478'], username: 'u', credential: 'c' }]],
    ['chave extra no servidor', [{ urls: ['stun:x.example:3478'], credentialType: 'oauth' }]],
    ['servidores demais', Array.from({ length: 5 }, () => STUN)],
    ['URLs demais', [{ urls: Array.from({ length: 9 }, () => 'stun:x.example:3478') }]],
    ['credencial gigante', [{ urls: ['turn:x.example:3478'], username: 'u', credential: 'x'.repeat(600) }]],
    ['urls vazia', [{ urls: [] }]],
  ])('ice-config com %s → descartado', (_name, servers) => {
    expect(parseServerMessage(msg(servers))).toBeNull();
  });

  it('ice-config com modo desconhecido ou chave extra → descartado', () => {
    expect(parseServerMessage(msg([], { mode: 'tcp' }))).toBeNull();
    expect(parseServerMessage(msg([], { apiToken: 'x' }))).toBeNull();
  });
});

describe('estatísticas do par selecionado (sanitização e comprovação)', () => {
  const entries = (local: Record<string, unknown>, remote: Record<string, unknown>, pairState = 'succeeded'): StatsEntry[] => [
    { id: 'T', type: 'transport', timestamp: 1, selectedCandidatePairId: 'P' },
    { id: 'P', type: 'candidate-pair', timestamp: 1, state: pairState, localCandidateId: 'L', remoteCandidateId: 'R', currentRoundTripTime: 0.05 },
    { id: 'L', type: 'local-candidate', timestamp: 1, address: '203.0.113.7', ip: '203.0.113.7', port: 50000, url: 'turns:turn.cloudflare.com:443?transport=tcp', ...local },
    { id: 'R', type: 'remote-candidate', timestamp: 1, address: '198.51.100.9', port: 40000, ...remote },
  ];

  it('relay local com TLS → caminho relay, relayProtocol tls, sem endereços/URLs', () => {
    const pair = selectedPair(entries({ candidateType: 'relay', protocol: 'udp', relayProtocol: 'tls' }, { candidateType: 'srflx' }));
    expect(pair).toEqual({ state: 'succeeded', rttMs: 50, localCandidateType: 'relay', remoteCandidateType: 'srflx', protocol: 'udp', relayProtocol: 'tls' });
    expect(mediaPath(pair)).toBe('relay');
    expect(describePair(pair)).toBe('relay ↔ srflx · udp · TURN/tls (succeeded)');
    expect(JSON.stringify(pair)).not.toMatch(/203\.0\.113|198\.51\.100|50000|cloudflare/);
  });

  it('relay só do lado remoto também é caminho relay', () => {
    expect(mediaPath(selectedPair(entries({ candidateType: 'srflx', protocol: 'udp' }, { candidateType: 'relay' })))).toBe('relay');
  });

  it('host/srflx/prflx dos dois lados → direto; relayProtocol ignorado fora de relay', () => {
    const pair = selectedPair(entries({ candidateType: 'prflx', protocol: 'udp', relayProtocol: 'tls' }, { candidateType: 'host' }));
    expect(mediaPath(pair)).toBe('direct');
    expect(pair?.relayProtocol).toBeNull();
  });

  it('par não selecionado/sucedido ou tipos desconhecidos → caminho indeterminado (nunca inferido)', () => {
    expect(mediaPath(selectedPair(entries({ candidateType: 'relay' }, { candidateType: 'host' }, 'in-progress')))).toBeNull();
    expect(mediaPath(selectedPair(entries({ candidateType: '203.0.113.7' }, { candidateType: 'host' })))).toBeNull();
    expect(mediaPath(null)).toBeNull();
  });

  it('valores fora das listas fechadas viram null (nada arbitrário chega à tela)', () => {
    const pair = selectedPair(entries({ candidateType: 'relay', protocol: '203.0.113.7:50000', relayProtocol: 'turn.cloudflare.com' }, { candidateType: 'x' }));
    expect(pair).toMatchObject({ protocol: null, relayProtocol: null, remoteCandidateType: null });
  });
});
