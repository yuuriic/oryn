// Voz multiponto sem navegador e sem rede: MeshCall e MeshSignaling sobre o backend em memória, com o núcleo REAL da Edge
// Function e RTCPeerConnection falsa. Prova a coordenação (quem conecta com quem, isolamento e limpeza), NÃO a qualidade de áudio.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerCall, type CallCallbacks, type CallPhase } from '../src/web/call.ts';
import { MAX_MESH_PEERS, MeshSignaling, pickPrimaries } from '../src/web/mesh-signaling.ts';
import { MeshCall, type ParticipantView } from '../src/web/mesh-call.ts';
import { SupabaseSignaling, pairEpoch } from '../src/web/supabase-signaling.ts';
import { FakePeerConnection, FakeStream, FakeSupabase, ROOM, USERS, settle } from './helpers/web-fakes.ts';

const STUN = [{ urls: ['stun:stun.l.google.com:19302'] }];
const ALL = [USERS.owner, USERS.member, USERS.third, USERS.fourth];

interface Client {
  user: string;
  call: MeshCall;
  phases: CallPhase[];
  errors: string[];
  logs: string[];
  problems: [string, string][];
  participants: ParticipantView[];
  standby: boolean;
  audio: Map<string, unknown>;
  streams: FakeStream[];
  pcs: FakePeerConnection[];
  signaling: MeshSignaling | null;
}

let server: FakeSupabase;
const clients: Client[] = [];

function client(user: string, negotiationTimeoutMs?: number): Client {
  const c: Client = { user, call: undefined as unknown as MeshCall, phases: [], errors: [], logs: [], problems: [], participants: [], standby: false, audio: new Map(), streams: [], pcs: [], signaling: null };
  c.call = new MeshCall(
    {
      getUserMedia: async () => {
        const stream = new FakeStream();
        c.streams.push(stream);
        return stream as unknown as MediaStream;
      },
      createPeerConnection: (config) => {
        const pc = new FakePeerConnection(config);
        c.pcs.push(pc);
        return pc as unknown as RTCPeerConnection;
      },
      createRoom: (events, onDisconnected) => {
        c.signaling = new MeshSignaling({ backend: server.backend(user), roomId: ROOM, selfUserId: user, events, onDisconnected, iceServers: STUN, log: (m) => c.logs.push(m) });
        return c.signaling;
      },
      iceServers: STUN,
      iceMode: 'direct',
      ...(negotiationTimeoutMs ? { negotiationTimeoutMs } : {}),
    },
    {
      onPhase: (phase, error) => {
        c.phases.push(phase);
        if (error) c.errors.push(error);
      },
      onParticipants: (list, standby) => {
        c.participants = list;
        c.standby = standby;
      },
      onRemoteAudio: (session, stream) => {
        if (stream) c.audio.set(session, stream);
        else c.audio.delete(session);
      },
      onLocalStream: () => undefined,
      onPeerStates: () => undefined,
      onStats: () => undefined,
      onLog: (m) => c.logs.push(m),
      onPeerProblem: (name, kind) => c.problems.push([name, kind]),
    },
  );
  clients.push(c);
  return c;
}

const open = (c: Client) => c.pcs.filter((pc) => pc.connectionState !== 'closed');
const connected = (c: Client) => c.pcs.filter((pc) => pc.connectionState === 'connected');
const session = (c: Client) => c.signaling!.session!;
/** A conexão atual de `a` com `b`, lida do motor daquele par. */
function pairConnection(a: Client, b: Client, optional: true): FakePeerConnection | undefined;
function pairConnection(a: Client, b: Client): FakePeerConnection;
function pairConnection(a: Client, b: Client, _optional?: true): FakePeerConnection | undefined {
  const entries = (a.call as unknown as { entries: Map<string, { call: { pc: FakePeerConnection | null } }> }).entries;
  return entries.get(session(b))?.call.pc ?? undefined;
}

async function enter(...users: string[]): Promise<Client[]> {
  const list: Client[] = [];
  for (const u of users) {
    const c = client(u);
    list.push(c);
    await c.call.start();
    await settle();
  }
  await settle();
  return list;
}

function fullMesh(list: Client[]): void {
  for (const c of list) {
    expect(connected(c), c.user).toHaveLength(list.length - 1);
    expect(open(c), c.user).toHaveLength(list.length - 1);
    expect(c.call.phase).toBe('connected');
    expect(c.audio.size).toBe(list.length - 1);
    expect(c.participants.map((p) => p.state)).toEqual(Array(list.length - 1).fill('connected'));
    expect(c.streams).toHaveLength(1); // uma só captura
    expect(c.pcs.every((pc) => pc.senders[0]!.track === c.streams[0]!.track)).toBe(true);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  server = new FakeSupabase();
  server.members.set(USERS.third, 'it-third');
  server.members.set(USERS.fourth, 'it-fourth');
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.call.end();
  await settle();
  vi.useRealTimers();
});

describe('quantos participantes', () => {
  it('1 participante: aguarda, com microfone capturado e nenhuma conexão', async () => {
    const [a] = await enter(USERS.owner);
    expect(a!.call.phase).toBe('waiting-peer');
    expect(a!.pcs).toEqual([]);
    expect(a!.streams).toHaveLength(1);
    expect(a!.participants).toEqual([]);
  });

  it('2 participantes: uma conexão de cada lado (regressão 1:1)', async () => {
    const list = await enter(USERS.owner, USERS.member);
    fullMesh(list);
  });

  it('3 participantes: 2 conexões por cliente e 3 no total', async () => {
    const list = await enter(USERS.owner, USERS.member, USERS.third);
    fullMesh(list);
  });

  it('4 participantes: 3 conexões por cliente, 3 envios de áudio e 6 pares distintos', async () => {
    const list = await enter(...ALL);
    fullMesh(list);
    const pairs = new Set<number>();
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) pairs.add(pairEpoch(session(list[i]!), session(list[j]!)));
    expect(pairs.size).toBe(6);
    expect(server.published.filter((e) => e.kind === 'offer')).toHaveLength(6);
    expect(server.published.filter((e) => e.kind === 'answer')).toHaveLength(6);
  });

  it('entrada simultânea dos 4: mesmo resultado', async () => {
    const list = ALL.map((u) => client(u));
    await Promise.all(list.map((c) => c.call.start()));
    await settle(2000);
    await vi.advanceTimersByTimeAsync(1000);
    await settle(2000);
    fullMesh(list);
    expect(server.published.filter((e) => e.kind === 'offer')).toHaveLength(6);
  });

  it('o limite é por conexão: uma sala com mais contas não abre mais de 3 pares', async () => {
    server.members.set(USERS.stranger, 'it-quinto');
    const list = await enter(...ALL, USERS.stranger);
    expect(MAX_MESH_PEERS).toBe(3);
    for (const c of list) expect(open(c).length).toBeLessThanOrEqual(3);
  });
});

describe('isolamento entre pares', () => {
  it('a saída de um não derruba os demais nem a captura deles', async () => {
    const [a, b, c, d] = await enter(...ALL);
    const before = open(a!).map((pc) => pc.id);
    d!.call.end();
    await settle();
    for (const x of [a!, b!, c!]) {
      expect(connected(x)).toHaveLength(2);
      expect(x.call.phase).toBe('connected');
      expect(x.audio.size).toBe(2);
      expect(x.streams[0]!.track.readyState).toBe('live');
      expect(x.participants).toHaveLength(2);
    }
    expect(open(a!).every((pc) => before.includes(pc.id))).toBe(true);
    expect(d!.streams[0]!.track.readyState).toBe('ended');
    expect(open(d!)).toEqual([]);
  });

  it('quem sai pode voltar: os outros formam só o par novo', async () => {
    const [a, b, c] = await enter(USERS.owner, USERS.member, USERS.third);
    c!.call.end();
    await settle();
    const before = [a!.pcs.length, b!.pcs.length];
    const [c2] = await enter(USERS.third);
    expect(a!.pcs.length).toBe(before[0]! + 1);
    expect(b!.pcs.length).toBe(before[1]! + 1);
    fullMesh([a!, b!, c2!]);
  });

  it('reconexão de só um par: os outros não são tocados', async () => {
    const [a, b, c] = await enter(USERS.owner, USERS.member, USERS.third);
    const toB = pairConnection(a!, b!);
    const toC = pairConnection(a!, c!);
    const bToC = pairConnection(b!, c!);
    toB.connectionState = 'failed';
    toB.onconnectionstatechange?.();
    await settle(2000);
    await vi.advanceTimersByTimeAsync(1000);
    await settle(2000);
    expect(toB.connectionState).toBe('closed');
    expect(pairConnection(a!, c!)).toBe(toC);
    expect(toC.connectionState).toBe('connected');
    expect(pairConnection(b!, c!)).toBe(bToC);
    expect(pairConnection(a!, b!)).not.toBe(toB);
    expect(a!.problems[0]![1]).toBe('reconnecting');
    expect(a!.call.phase).toBe('connected');
    fullMesh([a!, b!, c!]);
  });

  it('falha parcial definitiva: tentativas esgotadas marcam só aquele par, e a chamada continua', async () => {
    const [a, b, c] = await enter(USERS.owner, USERS.member, USERS.third);
    const toC = pairConnection(a!, c!);
    for (let i = 0; i < 6 && !a!.problems.some(([, kind]) => kind === 'failed'); i++) {
      const pc = pairConnection(a!, b!, true);
      if (pc) {
        pc.connectionState = 'failed';
        pc.onconnectionstatechange?.();
      }
      await settle(2000);
      await vi.advanceTimersByTimeAsync(500);
      await settle(2000);
    }
    expect(a!.problems.some(([, kind]) => kind === 'failed')).toBe(true);
    expect(a!.call.phase).toBe('connected');
    expect(a!.streams[0]!.track.readyState).toBe('live');
    expect(a!.participants.find((p) => p.session === session(b!))!.state).toBe('failed');
    expect(a!.participants.find((p) => p.session === session(c!))!.state).toBe('connected');
    expect(toC.connectionState).toBe('connected');
  });

  it('negociação sem resposta com um par não afeta o par que já conectou', async () => {
    const [a, b] = await enter(USERS.owner, USERS.member);
    fullMesh([a!, b!]);
    server.silent = true;
    const c = client(USERS.third, 5_000);
    await c.call.start();
    await settle();
    server.silent = false;
    await settle(2000);
    await vi.advanceTimersByTimeAsync(6_000);
    await settle(2000);
    expect(connected(a!).length).toBeGreaterThanOrEqual(1);
    expect(a!.call.phase).toBe('connected');
  });
});

describe('negociação', () => {
  it('sem colisão de offer: em cada par, só o iniciador determinístico oferece', async () => {
    const list = await enter(...ALL);
    const offers = server.published.filter((e) => e.kind === 'offer');
    for (const offer of offers) expect(offer.from_session < offer.to_session).toBe(true);
    expect(new Set(offers.map((o) => `${o.from_session}|${o.to_session}`)).size).toBe(6);
    fullMesh(list);
  });

  it('offer de quem não é iniciador é descartada sem quebrar o par', async () => {
    const [a, b] = await enter(USERS.owner, USERS.member);
    const host = session(a!) < session(b!) ? a! : b!;
    const guest = host === a! ? b! : a!;
    const epoch = pairEpoch(session(a!), session(b!));
    (host.call as unknown as { entries: Map<string, { link: { deliver(m: unknown): void } }> }).entries.get(session(guest))!.link.deliver({ type: 'signal', epoch, payload: { kind: 'offer', sdp: 'v=0' } });
    await settle();
    expect(host.logs.some((l) => l.includes('Offer fora de ordem descartada'))).toBe(true);
    fullMesh([a!, b!]);
  });

  it('entrega duplicada de sinais: nenhum efeito', async () => {
    server.duplicateDeliveries = true;
    const list = await enter(USERS.owner, USERS.member, USERS.third);
    fullMesh(list);
    expect(list.reduce((n, c) => n + c.signaling!.counters.duplicates, 0)).toBeGreaterThan(0);
  });

  it('entrega fora de ordem: candidatos e descrições são reordenados, e todos conectam', async () => {
    server.holdDeliveries = true;
    const list = ALL.slice(0, 3).map((u) => client(u));
    await Promise.all(list.map((c) => c.call.start()));
    for (let i = 0; i < 12; i++) {
      await settle(600);
      server.flushReversed();
    }
    server.holdDeliveries = false;
    server.flushReversed();
    await settle(2000);
    await vi.advanceTimersByTimeAsync(2000);
    server.flushReversed();
    await settle(2000);
    fullMesh(list);
  });

  it('sinal que chega antes do par ser conhecido não se perde', async () => {
    const [a] = await enter(USERS.owner);
    server.rpcFaults.set('get_voice_participants', 'erro de rede');
    const [b] = await enter(USERS.member);
    await vi.advanceTimersByTimeAsync(31_000);
    await settle(2000);
    fullMesh([a!, b!]);
  });

  it('cada par tem o próprio pair_epoch; os dois lados calculam o mesmo', async () => {
    const [a, b, c] = await enter(USERS.owner, USERS.member, USERS.third);
    const epochs = server.published.filter((e) => e.kind === 'offer').map((e) => e.pair_epoch).sort();
    expect(epochs).toEqual([pairEpoch(session(a!), session(b!)), pairEpoch(session(a!), session(c!)), pairEpoch(session(b!), session(c!))].sort());
  });
});

describe('microfone', () => {
  it('mudo vale para todos os pares, sem renegociar', async () => {
    const [a, b, c] = await enter(USERS.owner, USERS.member, USERS.third);
    const offers = server.published.length;
    a!.call.setMuted(true);
    expect(a!.streams[0]!.track.enabled).toBe(false);
    expect(a!.call.muted).toBe(true);
    await settle();
    expect(server.published.length).toBe(offers);
    a!.call.setMuted(false);
    expect(a!.streams[0]!.track.enabled).toBe(true);
    fullMesh([a!, b!, c!]);
  });

  it('um pedido só de microfone; liberado ao sair, sem sobrar ouvinte', async () => {
    const [a] = await enter(USERS.owner, USERS.member, USERS.third);
    const track = a!.streams[0]!.track;
    a!.call.end();
    await settle();
    expect(a!.streams).toHaveLength(1);
    expect(track.readyState).toBe('ended');
    expect(track.listenerCount()).toBe(0);
    expect(open(a!)).toEqual([]);
    expect(a!.audio.size).toBe(0);
    expect(a!.call.phase).toBe('ended');
  });

  it('microfone recusado: falha sem entrar na sala', async () => {
    const c = client(USERS.owner);
    (c.call as unknown as { deps: { getUserMedia(): Promise<MediaStream> } }).deps.getUserMedia = () => Promise.reject(new DOMException('negado', 'NotAllowedError'));
    await c.call.start();
    expect(c.call.phase).toBe('failed');
    expect(server.calls.filter((x) => x.fn === 'join_room')).toEqual([]);
  });

  it('dispositivo perdido encerra a chamada inteira, e saem todos os pares', async () => {
    const [a, b] = await enter(USERS.owner, USERS.member);
    const track = a!.streams[0]!.track as unknown as { listeners: Map<string, Set<() => void>> };
    for (const fn of track.listeners.get('ended') ?? []) fn();
    await settle();
    expect(a!.call.phase).toBe('failed');
    expect(open(a!)).toEqual([]);
    await settle();
    expect(b!.call.phase).toBe('waiting-peer');
  });

  it('a falha de um par nunca para a faixa compartilhada', async () => {
    const [a] = await enter(USERS.owner, USERS.member);
    const pc = connected(a!)[0]!;
    pc.connectionState = 'failed';
    pc.onconnectionstatechange?.();
    await settle();
    expect(a!.streams[0]!.track.readyState).toBe('live');
  });
});

describe('duas sessões da mesma conta', () => {
  it('só a mais antiga entra no mesh; a outra aguarda em espera, sem nenhuma conexão', async () => {
    const [a, b1] = await enter(USERS.owner, USERS.member);
    const [b2] = await enter(USERS.member);
    expect(b2!.standby).toBe(true);
    expect(b2!.pcs).toEqual([]);
    expect(b2!.call.phase).toBe('waiting-peer');
    expect(open(a!)).toHaveLength(1);
    expect(a!.participants).toHaveLength(1); // a conta aparece uma vez
    fullMesh([a!, b1!]);
  });

  it('a sessão em espera assume quando a mais antiga sai', async () => {
    const [a, b1] = await enter(USERS.owner, USERS.member);
    const [b2] = await enter(USERS.member);
    b1!.call.end();
    await settle(2000);
    expect(b2!.standby).toBe(false);
    fullMesh([a!, b2!]);
  });

  it('sessão fantasma: navegador caiu sem avisar e a pessoa voltou; o par troca de sessão, sem esperar 90 s', async () => {
    const [a, b1, c] = await enter(USERS.owner, USERS.member, USERS.third);
    const toB1 = pairConnection(a!, b1!);
    const cToB1 = pairConnection(c!, b1!);
    // Queda sem aviso: a sessão segue viva no servidor.
    server.rpcFaults.set('leave_room', 'erro');
    b1!.call.end();
    await settle();
    expect(server.liveSessions(USERS.member)).toHaveLength(1);
    const [b2] = await enter(USERS.member);
    expect(b2!.standby).toBe(true);
    expect(b2!.pcs).toEqual([]);
    // A falha de ICE é o que revela a queda, para cada par, sem esperar a sessão vencer.
    toB1.connectionState = 'failed';
    toB1.onconnectionstatechange?.();
    cToB1.connectionState = 'failed';
    cToB1.onconnectionstatechange?.();
    await settle(2000);
    await vi.advanceTimersByTimeAsync(1000);
    await settle(2000);
    expect(server.liveSessions(USERS.member)).toHaveLength(2); // a fantasma ainda não venceu
    expect(b2!.standby).toBe(false);
    fullMesh([a!, b2!, c!]);
    // Quando ela vence, nada muda.
    server.expire(b1!.signaling ? [...server.sessions.values()].find((s) => s.user === USERS.member && !s.revoked)!.id : '');
    await vi.advanceTimersByTimeAsync(31_000);
    await settle(2000);
    fullMesh([a!, b2!, c!]);
  });

  it('a sessão em espera não negocia com quem não a chamou', async () => {
    const [a, b1, c] = await enter(USERS.owner, USERS.member, USERS.third);
    const [b2] = await enter(USERS.member);
    const toB1 = pairConnection(a!, b1!);
    toB1.connectionState = 'failed';
    toB1.onconnectionstatechange?.();
    await settle(2000);
    await vi.advanceTimersByTimeAsync(1000);
    await settle(2000);
    // `a` e `b1` se recuperam: a sessão mais antiga estava viva. `b2` não abre conexão com `c`, que não a chamou.
    expect(open(c!)).toHaveLength(2);
    expect(b2!.pcs.length).toBeLessThanOrEqual(1);
  });

  it('pickPrimaries: uma sessão por referência, a mais antiga', () => {
    const row = (session_id: string, participant_ref: string) => ({ session_id, participant_ref, display_name: 'x', is_self: false, joined_at: '' });
    expect(pickPrimaries([row('s1', 'a'), row('s2', 'b'), row('s3', 'a')]).map((r) => r.session_id)).toEqual(['s1', 's2']);
    expect(pickPrimaries([row('s1', 'a'), row('s2', 'b'), row('s3', 'a')], new Set(['s1'])).map((r) => r.session_id)).toEqual(['s2', 's3']);
  });

  it('as duas sessões juntas não contam como duas contas para os outros', async () => {
    const [a] = await enter(USERS.owner);
    await enter(USERS.member);
    await enter(USERS.member);
    await enter(USERS.third);
    expect(open(a!)).toHaveLength(2);
    expect(a!.participants).toHaveLength(2);
  });
});

describe('perda de pertença', () => {
  it('removido durante a chamada: encerra com 4403, na hora, e libera o microfone; os outros seguem', async () => {
    const [a, b, c] = await enter(USERS.owner, USERS.member, USERS.third);
    server.removeMember(USERS.third);
    await settle(2000);
    expect(c!.call.phase).toBe('failed');
    expect(c!.errors[0]).toMatch(/código 4403/);
    expect(c!.streams[0]!.track.readyState).toBe('ended');
    expect(open(c!)).toEqual([]);
    for (const x of [a!, b!]) {
      expect(connected(x)).toHaveLength(1);
      expect(x.call.phase).toBe('connected');
      expect(x.participants).toHaveLength(1);
    }
  });

  it('sala encerrada: todos saem', async () => {
    const list = await enter(USERS.owner, USERS.member, USERS.third);
    server.closeRoom();
    await settle(2000);
    await vi.advanceTimersByTimeAsync(31_000);
    await settle(2000);
    for (const c of list) {
      expect(c.call.phase).toBe('failed');
      expect(c.errors[0]).toMatch(/código 4403/);
    }
  });

  it('entrada recusada: falha com a mensagem do servidor, sem conexão', async () => {
    const c = client(USERS.stranger);
    await c.call.start();
    expect(c.call.phase).toBe('failed');
    expect(c.errors[0]).toMatch(/não é membro/);
    expect(c.streams[0]!.track.readyState).toBe('ended');
  });
});

describe('compatibilidade com o cliente 1:1 anterior', () => {
  it('um cliente em cache (PeerCall + SupabaseSignaling) conversa com o mesh numa sala de 2', async () => {
    const [a] = await enter(USERS.owner);
    const pcs: FakePeerConnection[] = [];
    const phases: CallPhase[] = [];
    const cb: CallCallbacks = {
      onPhase: (p) => phases.push(p),
      onSession: () => undefined,
      onInvite: () => undefined,
      onPeerStates: () => undefined,
      onLocalStream: () => undefined,
      onRemoteStream: () => undefined,
      onStats: () => undefined,
      onLog: () => undefined,
    };
    const old = new PeerCall(
      {
        getUserMedia: async () => new FakeStream() as unknown as MediaStream,
        createPeerConnection: (config) => {
          const pc = new FakePeerConnection(config);
          pcs.push(pc);
          return pc as unknown as RTCPeerConnection;
        },
        createSignaling: (handlers) => new SupabaseSignaling({ backend: server.backend(USERS.member), roomId: ROOM, selfUserId: USERS.member, handlers, iceServers: STUN }),
        iceMode: 'direct',
      },
      cb,
    );
    await old.start({ kind: 'room' });
    await settle(2000);
    expect(phases).toContain('connected');
    expect(a!.call.phase).toBe('connected');
    expect(pcs[0]!.connectionState).toBe('connected');
    old.end();
    await settle();
    expect(a!.call.phase).toBe('waiting-peer');
  });
});
