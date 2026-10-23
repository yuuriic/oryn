// PeerCall + modos ICE (02B.4): pedido de configuração só após admissão, RTCConfiguration de cada modo,
// falha fechada sem criar RTCPeerConnection, sem fallback, credenciais fora do log, renovação perto do
// vencimento, caminho de mídia pelo par SELECIONADO e limpeza.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerCall, type CallCallbacks, type CallPhase, type CallStats, type IceInfo } from '../src/call.ts';
import type { IceMode, IceServerConfig } from '../src/ice.ts';
import { SignalingHub, harness, settle, type Harness } from './helpers/fakes.ts';

const STUN: IceServerConfig = { urls: ['stun:stun.cloudflare.com:3478'] };
const TURN: IceServerConfig = {
  urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
  username: 'USUARIO-TEMPORARIO',
  credential: 'CREDENCIAL-TEMPORARIA',
};

interface Probe {
  phases: CallPhase[];
  errors: string[];
  logs: string[];
  stats: (CallStats | null)[];
  ice: (IceInfo | null)[];
  invite: string | null;
  cb: CallCallbacks;
}

function probe(): Probe {
  const p: Probe = { phases: [], errors: [], logs: [], stats: [], ice: [], invite: null, cb: undefined as unknown as CallCallbacks };
  p.cb = {
    onPhase: (phase, error) => {
      p.phases.push(phase);
      if (error) p.errors.push(error);
    },
    onSession: () => undefined,
    onInvite: (invite) => (p.invite = invite.token),
    onPeerStates: () => undefined,
    onLocalStream: () => undefined,
    onRemoteStream: () => undefined,
    onStats: (s) => p.stats.push(s),
    onLog: (m) => p.logs.push(m),
    onIce: (info) => p.ice.push(info),
  };
  return p;
}

let hub: SignalingHub;
beforeEach(() => {
  vi.useFakeTimers();
  hub = new SignalingHub();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** Host (modo hostMode) cria a sessão; guest (modo guestMode) entra com o convite. */
async function pair(hostMode: IceMode, guestMode: IceMode, extra: { now?: () => number } = {}) {
  const hostH = harness(hub);
  const guestH = harness(hub);
  const hostP = probe();
  const guestP = probe();
  const host = new PeerCall({ ...hostH.deps, iceMode: hostMode, ...extra }, hostP.cb);
  const guest = new PeerCall({ ...guestH.deps, iceMode: guestMode, ...extra }, guestP.cb);
  await host.start({ kind: 'create', operatorKey: hub.operatorKey });
  await settle();
  await guest.start({ kind: 'join', invite: hostP.invite! });
  await settle();
  return { host, guest, hostH, guestH, hostP, guestP };
}

const urls = (h: Harness, i = 0) => (h.configs[i]?.iceServers ?? []).flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));

describe('pedido de configuração ICE', () => {
  it('é enviado só depois da admissão (session), uma vez, com o modo escolhido', async () => {
    hub.ice = { iceServers: [STUN, TURN], expiresAt: Date.now() + 3_600_000 };
    const { hostH, guestH } = await pair('auto', 'relay');
    const types = (h: Harness) => h.signalings[0]!.sent.map((m) => (m as { type: string }).type);
    expect(types(hostH).indexOf('create')).toBeLessThan(types(hostH).indexOf('ice-request'));
    expect(types(guestH).indexOf('join')).toBeLessThan(types(guestH).indexOf('ice-request'));
    expect(types(guestH).filter((t) => t === 'ice-request')).toHaveLength(1);
    expect(hub.iceRequests).toEqual(['auto', 'relay']);
  });

  it('sem resposta do servidor no prazo → falha, sem RTCPeerConnection', async () => {
    hub.ice = 'silent';
    const h = harness(hub);
    const p = probe();
    const call = new PeerCall({ ...h.deps, iceMode: 'relay', iceConfigTimeoutMs: 5_000 }, p.cb);
    await call.start({ kind: 'create', operatorKey: hub.operatorKey });
    await settle();
    vi.advanceTimersByTime(5_000);
    expect(call.phase).toBe('failed');
    expect(p.errors.at(-1)).toMatch(/configuração ICE/);
    expect(h.configs).toHaveLength(0);
  });
});

describe('RTCConfiguration por modo', () => {
  beforeEach(() => {
    hub.ice = { iceServers: [STUN, TURN], expiresAt: Date.now() + 3_600_000 };
  });

  it('auto: STUN + TURN, policy all; direct: só STUN, policy all', async () => {
    const { host, guest, hostH, guestH } = await pair('auto', 'direct');
    expect(host.phase).toBe('connected');
    expect(guest.phase).toBe('connected');
    expect(hostH.configs[0]!.iceTransportPolicy).toBe('all');
    expect(urls(hostH)).toEqual([...STUN.urls, ...TURN.urls]);
    expect(guestH.configs[0]!.iceTransportPolicy).toBe('all');
    expect(urls(guestH)).toEqual(STUN.urls);
  });

  it('relay: só TURN, policy relay; relay-tls: só turns:, policy relay (nenhum fallback)', async () => {
    const { hostH, guestH } = await pair('relay', 'relay-tls');
    expect(hostH.configs[0]!.iceTransportPolicy).toBe('relay');
    expect(urls(hostH)).toEqual(TURN.urls);
    expect(guestH.configs[0]!.iceTransportPolicy).toBe('relay');
    expect(urls(guestH)).toEqual(['turns:turn.cloudflare.com:443?transport=tcp']);
  });

  it('a interface recebe o modo e um resumo sem hosts nem credenciais; "TURN configurado" não é caminho', async () => {
    const { hostP } = await pair('auto', 'auto');
    const info = hostP.ice.find((i) => i !== null)!;
    expect(info).toMatchObject({ mode: 'auto', turnConfigured: true, summary: 'STUN 1 · TURN 2 (tls, udp)' });
    expect(JSON.stringify(info)).not.toMatch(/cloudflare|USUARIO|CREDENCIAL/);
  });
});

describe('falha fechada', () => {
  it.each([
    ['relay sem TURN', 'relay', [STUN]],
    ['relay-tls só com TURN/UDP', 'relay-tls', [STUN, { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' }]],
    ['relay-tls sem servidores', 'relay-tls', []],
  ] as const)('%s → falha antes de criar RTCPeerConnection', async (_name, mode, servers) => {
    hub.ice = { iceServers: [...servers] as IceServerConfig[], expiresAt: null };
    const h = harness(hub);
    const p = probe();
    const call = new PeerCall({ ...h.deps, iceMode: mode }, p.cb);
    await call.start({ kind: 'create', operatorKey: hub.operatorKey });
    await settle();
    expect(call.phase).toBe('failed');
    expect(p.errors.at(-1)).toMatch(/exige um servidor TURN/);
    expect(h.configs).toHaveLength(0);
  });

  it('turn-unavailable do servidor: relay falha; auto prossegue de forma visível, sem STUN/TURN', async () => {
    hub.ice = { error: 'turn-unavailable' };
    const h = harness(hub);
    const p = probe();
    const relay = new PeerCall({ ...h.deps, iceMode: 'relay' }, p.cb);
    await relay.start({ kind: 'create', operatorKey: hub.operatorKey });
    await settle();
    expect(relay.phase).toBe('failed');
    expect(p.errors.at(-1)).toMatch(/TURN indisponível/);

    const hostH = harness(hub);
    const guestH = harness(hub);
    const hostP = probe();
    const host = new PeerCall({ ...hostH.deps, iceMode: 'auto' }, hostP.cb);
    await host.start({ kind: 'create', operatorKey: hub.operatorKey });
    await settle();
    const guest = new PeerCall({ ...guestH.deps, iceMode: 'auto' }, probe().cb);
    await guest.start({ kind: 'join', invite: hostP.invite! });
    await settle();
    expect(host.phase).toBe('connected');
    expect(hostP.logs.some((l) => l.startsWith('Aviso: TURN indisponível'))).toBe(true);
    expect(hostH.configs[0]).toEqual({ iceServers: [], iceTransportPolicy: 'all' });
  });

  it('ice-limit do servidor → falha com mensagem clara', async () => {
    hub.ice = { error: 'ice-limit' };
    const h = harness(hub);
    const p = probe();
    const call = new PeerCall({ ...h.deps, iceMode: 'auto' }, p.cb);
    await call.start({ kind: 'create', operatorKey: hub.operatorKey });
    await settle();
    expect(call.phase).toBe('failed');
    expect(p.errors.at(-1)).toMatch(/Limite de emissão/);
  });

  it('falha de conexão em relay informa que não houve fallback', async () => {
    hub.ice = { iceServers: [TURN], expiresAt: null };
    const { host, hostH, hostP } = await pair('relay', 'relay');
    hostH.pcs[0]!.failConnection();
    expect(host.phase).toBe('failed');
    expect(hostP.errors.at(-1)).toMatch(/modo relay.*sem fallback/);
  });
});

describe('segredos, renovação, comprovação e limpeza', () => {
  it('credenciais TURN nunca aparecem nos logs nem nas informações de interface', async () => {
    hub.ice = { iceServers: [STUN, TURN], expiresAt: Date.now() + 3_600_000 };
    const { hostP, guestP } = await pair('auto', 'relay-tls');
    const all = JSON.stringify([hostP.logs, guestP.logs, hostP.ice, guestP.ice]);
    for (const secret of ['USUARIO-TEMPORARIO', 'CREDENCIAL-TEMPORARIA', 'turn.cloudflare.com', 'stun.cloudflare.com']) expect(all).not.toContain(secret);
  });

  it('credencial perto de vencer: novo par pede nova configuração antes de criar a conexão', async () => {
    let now = 1_000_000;
    hub.ice = { iceServers: [TURN], expiresAt: now + 10 * 60_000 };
    const { host, guestH, hostH, hostP } = await pair('relay', 'relay', { now: () => now });
    expect(host.phase).toBe('connected');
    const hostRequests = () => hostH.signalings[0]!.sent.filter((m) => (m as { type: string }).type === 'ice-request').length;
    expect(hostRequests()).toBe(1);
    // O convidado cai; 6 min depois faltam < 5 min de validade.
    guestH.signalings[0]!.drop();
    await settle();
    expect(host.phase).toBe('waiting-peer');
    now += 6 * 60_000;
    hub.ice = { iceServers: [TURN], expiresAt: now + 60 * 60_000 };
    host.requestInvite();
    await settle();
    const guest2 = new PeerCall({ ...harness(hub).deps, iceMode: 'relay', now: () => now }, probe().cb);
    await guest2.start({ kind: 'join', invite: hostP.invite! });
    await settle();
    // O host renovou ANTES de criar a segunda RTCPeerConnection.
    expect(hostRequests()).toBe(2);
    expect(hostH.configs).toHaveLength(2);
    expect(host.phase).toBe('connected');
    expect(guest2.phase).toBe('connected');
  });

  it('caminho de mídia vem do par SELECIONADO: TURN configurado + par host → "direct"; par relay → "relay"', async () => {
    hub.ice = { iceServers: [STUN, TURN], expiresAt: null };
    const { hostH, hostP } = await pair('auto', 'auto');
    const pc = hostH.pcs[0]!;
    const stats = (localType: string, relayProtocol?: string) => [
      { id: 'T', type: 'transport', timestamp: 1, selectedCandidatePairId: 'P' },
      { id: 'P', type: 'candidate-pair', timestamp: 1, state: 'succeeded', localCandidateId: 'L', remoteCandidateId: 'R' },
      { id: 'L', type: 'local-candidate', timestamp: 1, candidateType: localType, protocol: 'udp', address: '203.0.113.5', ...(relayProtocol ? { relayProtocol } : {}) },
      { id: 'R', type: 'remote-candidate', timestamp: 1, candidateType: 'host', address: '192.0.2.44' },
    ];
    pc.statsEntries = stats('host');
    await vi.advanceTimersByTimeAsync(1000);
    expect(hostP.stats.at(-1)?.path).toBe('direct');
    pc.statsEntries = stats('relay', 'tls');
    await vi.advanceTimersByTimeAsync(1000);
    expect(hostP.stats.at(-1)?.path).toBe('relay');
    const pairLogs = hostP.logs.filter((l) => l.startsWith('Par ICE selecionado'));
    expect(pairLogs).toEqual([
      'Par ICE selecionado: host ↔ host · udp (succeeded) → caminho direct.',
      'Par ICE selecionado: relay ↔ host · udp · TURN/tls (succeeded) → caminho relay.',
    ]);
    expect(JSON.stringify(hostP.logs)).not.toMatch(/203\.0\.113|192\.0\.2/);
  });

  it('encerrar descarta a configuração ICE e limpa os timers', async () => {
    hub.ice = { iceServers: [TURN], expiresAt: null };
    const { host, guest, hostP } = await pair('relay', 'relay');
    host.end();
    guest.end();
    expect(hostP.ice.at(-1)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
