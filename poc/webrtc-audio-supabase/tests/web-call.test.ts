// Ponta a ponta local (02C, integração): dois PeerCall (cópia da 02B) falando pelo SupabaseSignaling e pelo
// backend em memória com o núcleo REAL da Edge Function. Sem navegador e sem rede: RTCPeerConnection falsa.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerCall, type CallCallbacks, type CallDeps, type CallPhase } from '../src/web/call.ts';
import { DISCONNECT, SupabaseSignaling, pairEpoch } from '../src/web/supabase-signaling.ts';
import { FakePeerConnection, FakeStream, FakeSupabase, USERS, ROOM, settle } from './helpers/web-fakes.ts';

const STUN = [{ urls: ['stun:stun.l.google.com:19302'] }];

interface Side {
  call: PeerCall;
  phases: CallPhase[];
  errors: string[];
  logs: string[];
  remote: unknown[];
  streams: FakeStream[];
  pcs: FakePeerConnection[];
  signalings: SupabaseSignaling[];
}

let server: FakeSupabase;
const sides: Side[] = [];

function side(user: string): Side {
  const s: Side = { call: undefined as unknown as PeerCall, phases: [], errors: [], logs: [], remote: [], streams: [], pcs: [], signalings: [] };
  const deps: CallDeps = {
    getUserMedia: async () => {
      const st = new FakeStream();
      s.streams.push(st);
      return st as unknown as MediaStream;
    },
    createPeerConnection: (config) => {
      const pc = new FakePeerConnection(config);
      s.pcs.push(pc);
      return pc as unknown as RTCPeerConnection;
    },
    createSignaling: (handlers) => {
      const sig = new SupabaseSignaling({ backend: server.backend(user), roomId: ROOM, selfUserId: user, handlers, iceServers: STUN, log: (m) => s.logs.push(m) });
      s.signalings.push(sig);
      return sig;
    },
    audioCodecs: () => [{ mimeType: 'audio/PCMU', clockRate: 8000 }, { mimeType: 'audio/opus', clockRate: 48000, channels: 2 }] as RTCRtpCodec[],
    iceMode: 'direct',
  };
  const cb: CallCallbacks = {
    onPhase: (phase, error) => {
      s.phases.push(phase);
      if (error) s.errors.push(error);
    },
    onSession: () => undefined,
    onInvite: () => undefined,
    onPeerStates: () => undefined,
    onLocalStream: () => undefined,
    onRemoteStream: (r) => s.remote.push(r),
    onStats: () => undefined,
    onLog: (m) => s.logs.push(m),
  };
  s.call = new PeerCall(deps, cb);
  sides.push(s);
  return s;
}

async function start(s: Side): Promise<void> {
  await s.call.start({ kind: 'room' });
  await settle(3000);
}

beforeEach(() => {
  vi.useFakeTimers();
  server = new FakeSupabase();
});

afterEach(() => {
  for (const s of sides.splice(0)) s.call.end();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('chamada 1:1 pelo Supabase (PeerCall + SupabaseSignaling + núcleo da Edge Function)', () => {
  it('OWNER e MEMBER conectam: offer só do iniciador, answer do outro, candidatos dos dois, mesmo epoch', async () => {
    const owner = side(USERS.owner);
    const member = side(USERS.member);
    await start(owner);
    expect(owner.call.phase).toBe('waiting-peer');
    await start(member);
    expect(owner.call.phase).toBe('connected');
    expect(member.call.phase).toBe('connected');

    const [o, m] = [owner.signalings[0]!.session!, member.signalings[0]!.session!];
    const epoch = pairEpoch(o, m);
    expect(owner.call.currentEpoch).toBe(epoch);
    expect(member.call.currentEpoch).toBe(epoch);
    const host = o < m ? owner : member;
    const guest = host === owner ? member : owner;
    expect(host.call.currentRole).toBe('host');
    expect(guest.call.currentRole).toBe('guest');

    const kinds = (sid: string) => server.invokes.filter((r) => r.session_id === sid).map((r) => r.kind);
    const hostSid = host.signalings[0]!.session!;
    const guestSid = guest.signalings[0]!.session!;
    expect(kinds(hostSid).filter((k) => k === 'offer')).toHaveLength(1);
    expect(kinds(hostSid)).not.toContain('answer');
    expect(kinds(guestSid).filter((k) => k === 'answer')).toHaveLength(1);
    expect(kinds(guestSid)).not.toContain('offer');
    for (const sid of [hostSid, guestSid]) expect(kinds(sid).filter((k) => k === 'candidate')).toHaveLength(2);
    expect(host.pcs[0]!.addedCandidates).toHaveLength(2);
    expect(guest.pcs[0]!.addedCandidates).toHaveLength(2);
    expect(owner.remote.at(-1)).not.toBeNull();
    expect(member.remote.at(-1)).not.toBeNull();
    // Só STUN, sem TURN; Opus primeiro.
    expect(owner.pcs[0]!.config).toEqual({ iceServers: STUN, iceTransportPolicy: 'all' });
    expect((owner.pcs[0]!.setCodecPreferences.mock.calls.at(-1)![0] as { mimeType: string }[])[0]!.mimeType).toBe('audio/opus');
  });

  it('o iniciador é o mesmo qualquer que seja a ordem de entrada (menor sessão)', async () => {
    server.nextSessionIds = ['00000000-0000-4000-8000-0000000000f0', '00000000-0000-4000-8000-000000000001'];
    const owner = side(USERS.owner); // sessão maior, entra primeiro
    const member = side(USERS.member); // sessão menor, entra depois
    await start(owner);
    await start(member);
    expect(member.call.currentRole).toBe('host');
    expect(owner.call.currentRole).toBe('guest');
    expect(owner.call.phase).toBe('connected');
    expect(member.call.phase).toBe('connected');
  });

  it('nenhum SDP, candidato, token ou e-mail nos registros dos dois lados', async () => {
    const owner = side(USERS.owner);
    const member = side(USERS.member);
    await start(owner);
    await start(member);
    const text = [...owner.logs, ...member.logs].join('\n');
    expect(text).not.toMatch(/v=0|candidate:|192\.0\.2\.|ufrag|Bearer|eyJ|@/);
  });

  it('mute/unmute não gera sinalização nem renegociação', async () => {
    const owner = side(USERS.owner);
    const member = side(USERS.member);
    await start(owner);
    await start(member);
    const before = server.invokes.length;
    owner.call.setMuted(true);
    await settle();
    expect(owner.streams[0]!.track.enabled).toBe(false);
    owner.call.setMuted(false);
    expect(owner.streams[0]!.track.enabled).toBe(true);
    expect(server.invokes.length).toBe(before);
    expect(owner.call.phase).toBe('connected');
  });

  it('saída de um lado: o outro volta a aguardar; quem volta reconecta com epoch NOVO e conexão nova', async () => {
    const owner = side(USERS.owner);
    const member = side(USERS.member);
    await start(owner);
    await start(member);
    const firstEpoch = owner.call.currentEpoch;
    member.call.end();
    await member.signalings[0]!.closed;
    await settle(3000);
    expect(owner.call.phase).toBe('waiting-peer');
    expect(owner.pcs[0]!.signalingState).toBe('closed');
    expect(owner.remote.at(-1)).toBeNull();

    const again = side(USERS.member);
    await start(again);
    expect(owner.call.phase).toBe('connected');
    expect(again.call.phase).toBe('connected');
    expect(owner.call.currentEpoch).not.toBe(firstEpoch);
    expect(owner.call.currentEpoch).toBe(again.call.currentEpoch);
    expect(owner.pcs).toHaveLength(2);
  });

  it('encerrar libera microfone, conexão, canal, sessão na sala e todos os timers', async () => {
    const owner = side(USERS.owner);
    const member = side(USERS.member);
    await start(owner);
    await start(member);
    owner.call.end();
    member.call.end();
    await Promise.all([owner.signalings[0]!.closed, member.signalings[0]!.closed]);
    await settle();
    expect(owner.streams[0]!.track.readyState).toBe('ended');
    expect(owner.streams[0]!.track.listenerCount()).toBe(0);
    expect(owner.pcs[0]!.signalingState).toBe('closed');
    expect(server.subscribers()).toBe(0);
    expect(server.liveSessions()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(owner.phases.filter((p) => p === 'ended')).toHaveLength(1);
  });

  it('conta que não é membro: falha com mensagem clara e libera o microfone', async () => {
    const stranger = side(USERS.stranger);
    await start(stranger);
    expect(stranger.call.phase).toBe('failed');
    expect(stranger.errors[0]).toContain('não é membro da sala');
    expect(stranger.streams[0]!.track.readyState).toBe('ended');
    expect(server.subscribers()).toBe(0);
  });

  it('sessão invalidada no meio da chamada (batimento): a chamada falha com o código 4403 e limpa tudo', async () => {
    const owner = side(USERS.owner);
    const member = side(USERS.member);
    await start(owner);
    await start(member);
    server.rpcFaults.set('touch_session', 'session-invalid');
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    const failed = [owner, member].find((s) => s.call.phase === 'failed')!;
    expect(failed.errors.at(-1)).toContain(`código ${DISCONNECT.session}`);
    expect(failed.streams[0]!.track.readyState).toBe('ended');
  });
});
