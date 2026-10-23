// Evidência sanitizada por participante (02B.5): montagem, "indisponível" para ausentes, coerência do
// caminho com o par selecionado, rejeição de dados sensíveis e CLI de validação.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { EVIDENCE_FORMAT, OPERATOR_PENDING, UNAVAILABLE, browserFamily, buildEvidence, findSensitive, validateEvidence, type EvidenceInput } from '../src/evidence.ts';

const UA = {
  chromeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.8059.85 Safari/537.36',
  edgeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.4283.62',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  chromeIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/155.0.0.0 Mobile/15E148 Safari/604.1',
};

const base = (over: Partial<EvidenceInput> = {}): EvidenceInput => ({
  sessionId: 'AbCdEfGhIjKlMnOpQrStUv',
  role: 'guest',
  userAgent: UA.safariIphone,
  iceMode: 'relay-tls',
  iceState: 'connected',
  connectionState: 'connected',
  pair: { state: 'succeeded', rttMs: 80, localCandidateType: 'relay', remoteCandidateType: 'srflx', protocol: 'udp', relayProtocol: 'tls' },
  turnConfigured: true,
  rttMs: 81.234,
  rttSource: 'rtcp',
  jitterMs: 4.56,
  lossPct: 0.123,
  remoteLossPct: null,
  packetsSent: 1200,
  packetsReceived: 1190,
  remoteLevelMax: 0.2,
  now: new Date('2026-10-23T14:05:09.000Z'),
  ...over,
});

describe('montagem', () => {
  it('evidência completa de um convidado em relay-tls no iPhone', () => {
    const e = buildEvidence(base());
    expect(e).toEqual({
      formato: EVIDENCE_FORMAT,
      sessao: 'AbCd…',
      papel: 'convidado',
      navegador: 'Safari 18',
      plataforma: 'iPhone (iOS)',
      modoIce: 'relay-tls',
      estadoIce: 'connected',
      estadoConexao: 'connected',
      parSelecionado: { local: 'relay', remoto: 'srflx', protocolo: 'udp', relayProtocol: 'tls', estado: 'succeeded' },
      caminho: 'relay',
      turnConfigurado: 'sim',
      rttMs: 81.2,
      rttFonte: 'rtcp',
      jitterMs: 4.6,
      perdaRecebidoPct: 0.12,
      perdaEnviadoPct: UNAVAILABLE,
      pacotesEnviados: 1200,
      pacotesRecebidos: 1190,
      audio: { recebidoNesteLado: 'sim', bidirecional: OPERATOR_PENDING },
      seguranca: OPERATOR_PENDING,
      timestamp: '2026-10-23T14:05:09.000Z',
    });
    expect(validateEvidence(e)).toEqual([]);
  });

  it('dados ausentes viram "indisponível" (nunca inventados); TURN configurado não vira relay', () => {
    const e = buildEvidence(
      base({ sessionId: null, role: null, userAgent: 'agente-desconhecido', iceState: null, connectionState: null, pair: null, rttMs: null, rttSource: null, jitterMs: null, lossPct: null, packetsSent: null, packetsReceived: null, remoteLevelMax: null, turnConfigured: true }),
    );
    expect(e).toMatchObject({ sessao: UNAVAILABLE, papel: UNAVAILABLE, navegador: UNAVAILABLE, plataforma: UNAVAILABLE, parSelecionado: UNAVAILABLE, caminho: UNAVAILABLE, turnConfigurado: 'sim', rttMs: UNAVAILABLE, audio: { recebidoNesteLado: UNAVAILABLE } });
    expect(validateEvidence(e)).toEqual([]);
  });

  it('áudio recebido exige pacotes E nível acima do limiar', () => {
    expect(buildEvidence(base({ remoteLevelMax: 0 })).audio.recebidoNesteLado).toBe('não');
    expect(buildEvidence(base({ packetsReceived: 0 })).audio.recebidoNesteLado).toBe('não');
  });

  it.each([
    [UA.chromeWin, 'Chrome 155', 'Windows'],
    [UA.edgeWin, 'Edge 155', 'Windows'],
    [UA.safariIphone, 'Safari 18', 'iPhone (iOS)'],
    [UA.chromeIphone, 'Chrome 155 (iOS)', 'iPhone (iOS)'],
  ])('navegador e plataforma só com família e versão principal', (ua, navegador, plataforma) => {
    expect(browserFamily(ua)).toEqual({ navegador, plataforma });
  });
});

describe('sanitização', () => {
  const good = () => JSON.parse(JSON.stringify(buildEvidence(base()))) as Record<string, unknown>;
  it.each([
    ['IPv4', (e: Record<string, unknown>) => (e['estadoIce'] = 'connected 192.168.0.23')],
    ['IPv6', (e: Record<string, unknown>) => (e['estadoIce'] = 'fe80::1c2d')],
    // JWT montado em execução: nenhum JWT literal fica versionado (a prontidão procura JWT nos arquivos do git).
    ['JWT', (e: Record<string, unknown>) => (e['estadoIce'] = ['eyJhbGciOiJSUzI1NiJ9', 'eyJzdWIiOiJ4In0', 'c2lnbmF0dXJh'].join('.'))],
    ['token longo', (e: Record<string, unknown>) => (e['estadoIce'] = 'A'.repeat(43))],
    ['e-mail', (e: Record<string, unknown>) => (e['estadoIce'] = 'convidado@example.com')],
    ['candidato ICE', (e: Record<string, unknown>) => (e['estadoIce'] = 'candidate:1 1 udp 2122260223')],
    ['cookie do Access', (e: Record<string, unknown>) => (e['estadoIce'] = 'CF_Authorization=abc')],
    ['URL TURN', (e: Record<string, unknown>) => (e['estadoIce'] = 'turns:turn.cloudflare.com:443')],
    ['campo username', (e: Record<string, unknown>) => (e['username'] = 'x')],
    ['campo credential aninhado', (e: Record<string, unknown>) => ((e['audio'] as Record<string, unknown>)['credential'] = 'x')],
    ['ID de sessão completo', (e: Record<string, unknown>) => (e['sessao'] = 'AbCdEfGhIjKlMnOpQrStUv')],
    ['relay sem candidato relay no par', (e: Record<string, unknown>) => (e['parSelecionado'] = { local: 'host', remoto: 'host', protocolo: 'udp', relayProtocol: UNAVAILABLE, estado: 'succeeded' })],
    ['relayProtocol sem candidato local relay', (e: Record<string, unknown>) => ((e['parSelecionado'] as Record<string, unknown>)['local'] = 'srflx')],
    ['número inventado como texto', (e: Record<string, unknown>) => (e['rttMs'] = 'baixo')],
    ['formato desconhecido', (e: Record<string, unknown>) => (e['formato'] = 'outro/1')],
  ])('recusa %s', (_name, mutate) => {
    const e = good();
    mutate(e);
    expect(validateEvidence(e).length).toBeGreaterThan(0);
  });

  it('rótulos sem o conteúdo encontrado; timestamp ISO e versões não são falsos positivos', () => {
    expect(findSensitive('ip 203.0.113.9')).toEqual(['endereço IPv4']);
    expect(findSensitive('2026-10-23T14:05:09.000Z host ↔ srflx · udp Safari 18')).toEqual([]);
    expect(validateEvidence(good()).length).toBe(0);
  });
});

describe('CLI evidence:check (sem rede)', () => {
  const cli = fileURLToPath(new URL('../server/evidence-cli.ts', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'oryn-evidence-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, value: unknown) => {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(value));
    return p;
  };
  const run = (files: string[]) => {
    const r = spawnSync(process.execPath, [cli, ...files], { encoding: 'utf8', timeout: 20_000 });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it('par válido (anfitrião + convidado da mesma sessão) → saída 0', () => {
    const a = write('a.json', buildEvidence(base({ role: 'host', userAgent: UA.chromeWin, iceMode: 'auto' })));
    const b = write('b.json', buildEvidence(base()));
    const r = run([a, b]);
    expect(r.status).toBe(0);
    expect(r.out).toContain('mesma sessão, os dois papéis presentes');
  });

  it('evidência com IP e token → saída 1, sem ecoar os valores', () => {
    const bad = { ...buildEvidence(base()), estadoIce: 'connected via 198.51.100.77', extra: 'Q'.repeat(43) };
    const r = run([write('bad.json', bad)]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('endereço IPv4');
    expect(r.out).not.toContain('198.51.100.77');
    expect(r.out).not.toContain('Q'.repeat(43));
  });

  it('sem arquivos → uso incorreto (2)', () => {
    expect(run([]).status).toBe(2);
  });
});
