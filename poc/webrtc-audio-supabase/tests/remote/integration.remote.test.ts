// Testes de integração contra o Supabase REAL (02C.1B; ampliado no 02C.4B; revisto no 02C.4B.1). NUNCA
// rodam no `pnpm test` nem no CI: só com `pnpm test:remote` E ORYN_REMOTE=1 (ver ./remote-env.ts e
// integration/RUNBOOK-02C.1B.md). Só credencial de cliente (chave publicável + JWT de usuários anônimos de
// teste). Os itens que exigem SQL privilegiado, publicação do operador ou Edge Function ficam como `todo`.
//
// Duas fases (02C.4B.1):
//   C1 — sem ORYN_IT_CREATOR_INVITE: só o bloco "sem sala" (1 cadastro). É a 1ª conexão WebSocket, que cria
//        as partições de realtime.messages. Não depende de D0.
//   C2 — com o convite: o portão EXIGE ORYN_IT_PARTITIONS_CONFIRMED=1 (D0, leitura do operador depois da C1).
// Custo da execução completa: 9 cadastros anônimos (1 na C1; 3 no beforeAll da sala + 5 no #15). Limite
// padrão: 30/h por IP. Duração da C2: ~3 min, dos quais ~100 s são a espera de expiração do A2.
//
// Confiabilidade (02C.4B.1):
// - Recusa de entrada só conta se veio do SERVIDOR (resposta de erro com `reason`); queda de transporte,
//   timeout ou falta de resposta reprovam o teste negativo em vez de passar por engano.
// - Todo teste de NÃO entrega termina com um controle positivo no mesmo canal (um evento legítimo do servidor
//   chega), e por isso fica no bloco de entrega, depois de D1/D2.
// - Teste encerrado (timeout/cancelamento) não inicia mais nenhuma operação remota (AsyncLocalStorage + signal).
// - Canais abertos por um teste são fechados no afterEach, mesmo em falha.
// Nada de JWT, chave, token de convite, payload ou UUID completo em mensagens de asserção ou log: identidades
// são comparadas como booleanos e os motivos de recusa são anotados sem UUIDs.
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { parseControlEvent } from '../../src/contracts.ts';
import { guard, isCredentialRefusal, isServerReply, sanitize, sleep, testSignal, waitFor } from './harness-utils.ts';
import { remoteGate, type RemoteEnv } from './remote-env.ts';

const gate = remoteGate(process.env);
const env = gate.enabled ? gate.env : (undefined as unknown as RemoteEnv);
// O portão garante que o convite só vem junto com a confirmação da partição (C2 nunca começa sem D0).
const hasRoomSetup = gate.enabled && env.creatorInvite !== undefined && env.partitionsConfirmed;

/** Identifica os dados desta execução (nome da sala), para auditoria e limpeza posterior pelo operador. */
const RUN = crypto.randomUUID().slice(0, 8);

/** `it` dos testes remotos: o corpo roda com o `signal` do teste, que `guard` e `sleep` respeitam. */
function rit(name: string, fn: (ctx: TestContext) => Promise<void>, timeout?: number): void {
  it(name, (ctx) => testSignal.run(ctx.signal, () => fn(ctx)), timeout);
}

// --- clientes, usuários e RPC -------------------------------------------------------------------------------

interface TestUser {
  client: SupabaseClient;
  uid: string;
  jwt: string;
}

const clients: SupabaseClient[] = [];

function newClient(): SupabaseClient {
  const client = createClient(env.url, env.publishableKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  clients.push(client);
  return client;
}

async function newUser(): Promise<TestUser> {
  guard();
  const client = newClient();
  const { data, error } = await client.auth.signInAnonymously(env.captchaToken ? { options: { captchaToken: env.captchaToken } } : undefined);
  if (error || !data.session || !data.user) throw new Error(`signInAnonymously falhou: ${error?.message ?? 'sem sessão'}`);
  await client.realtime.setAuth(data.session.access_token);
  return { client, uid: data.user.id, jwt: data.session.access_token };
}

/** Segundo cliente do MESMO usuário (outra aba), sem novo cadastro. */
async function sameUserClient(user: TestUser): Promise<SupabaseClient> {
  const client = newClient();
  await client.realtime.setAuth(user.jwt);
  return client;
}

async function rpc<T>(user: TestUser | SupabaseClient, fn: string, args: Record<string, unknown>): Promise<{ data: T | null; message: string | null }> {
  guard();
  const client = 'client' in user ? user.client : user;
  const { data, error } = await client.rpc(fn, args);
  return { data: (data as T) ?? null, message: error?.message ?? null };
}

const joinRoom = async (user: TestUser, room: string): Promise<string> => {
  const res = await rpc<{ session_id: string }[]>(user, 'join_room', { p_room_id: room });
  const sid = res.data?.[0]?.session_id;
  if (!sid) throw new Error(`join_room: ${res.message}`);
  return sid;
};

// --- canais ---------------------------------------------------------------------------------------------------

interface Sub {
  status: string;
  refusedByServer: boolean;
  reason: string;
  client: SupabaseClient;
  channel: RealtimeChannel;
  received: { event: string; payload: unknown }[];
  presenceJoins: number;
}

const openSubs = new Set<Sub>();

/**
 * Assina um tópico e espera o estado final da entrada (SUBSCRIBED ou erro).
 * O realtime-js devolve o canal JÁ EXISTENTE do mesmo tópico no mesmo cliente, e um segundo subscribe() nele
 * nunca chama o callback: o canal anterior é removido antes. Canal recusado é removido logo (sem novas
 * tentativas de entrada em segundo plano); canal aceito é fechado no afterEach.
 */
async function subscribe(client: SupabaseClient, topic: string, opts: { private: boolean; ack?: boolean; presence?: boolean } = { private: true }): Promise<Sub> {
  guard();
  const stale = client.getChannels().find((c) => c.topic === `realtime:${topic}`);
  if (stale) await client.removeChannel(stale);
  const sub = await new Promise<Sub>((resolve) => {
    const config = {
      private: opts.private,
      broadcast: { self: false, ack: opts.ack ?? false },
      ...(opts.presence ? { presence: { key: `it-${RUN}`, enabled: true } } : {}),
    };
    const channel = client.channel(topic, { config });
    const result: Sub = { status: 'PENDING', refusedByServer: false, reason: '', client, channel, received: [], presenceJoins: 0 };
    channel.on('broadcast', { event: '*' }, (msg) => result.received.push({ event: String(msg['event']), payload: msg['payload'] }));
    if (opts.presence) channel.on('presence', { event: 'join' }, () => void (result.presenceJoins += 1));
    let done = false;
    const finish = (status: string) => {
      if (done) return;
      done = true;
      clearTimeout(noReply);
      result.status = status;
      resolve(result);
    };
    const noReply = setTimeout(() => finish('NO_REPLY'), 12_000);
    channel.subscribe((status, err) => {
      if (status !== 'SUBSCRIBED' && status !== 'CHANNEL_ERROR' && status !== 'TIMED_OUT' && status !== 'CLOSED') return;
      if (status === 'CHANNEL_ERROR' && !done) {
        result.refusedByServer = isServerReply(err);
        result.reason = sanitize(err?.message);
      }
      finish(status);
    }, 10_000);
  });
  if (sub.status === 'SUBSCRIBED') openSubs.add(sub);
  else await client.removeChannel(sub.channel);
  return sub;
}

const release = async (sub: Sub) => {
  openSubs.delete(sub);
  await sub.client.removeChannel(sub.channel);
};

/**
 * Negativo de entrada: só passa com RECUSA DO SERVIDOR. Timeout, falta de resposta ou queda de transporte
 * reprovam (falso PASS evitado). Recusa por credencial (JWT/token) só é aceita onde o teste a espera (anon).
 */
async function expectRefused(sub: Sub, ctx: TestContext, label: string, opts: { allowCredentialError?: boolean } = {}) {
  await ctx.annotate(`${label}: ${sub.status}${sub.reason ? ` (${sub.reason})` : ''}`);
  expect(sub.status, `${label}: estado`).toBe('CHANNEL_ERROR');
  expect(sub.refusedByServer, `${label}: a recusa veio do servidor, não do transporte`).toBe(true);
  if (!opts.allowCredentialError) expect(isCredentialRefusal(sub.reason), `${label}: recusa por credencial, não por autorização`).toBe(false);
}

/** Broadcast REST pelo cliente: `httpSend` REJEITA em qualquer status ≠ 202 (realtime-js 2.118). */
const httpSendOutcome = async (client: SupabaseClient, topic: string): Promise<string> => {
  guard();
  const ch = client.channel(topic, { config: { private: true } });
  try {
    const res = await ch.httpSend('signal', { forged: true });
    return res.success ? 'aceito (202)' : 'recusado';
  } catch (error) {
    return `recusado: ${sanitize((error as Error).message)}`;
  } finally {
    await client.removeChannel(ch);
  }
};

const topicOf = (sessionId: string) => `oryn:s:${sessionId}`;
const controlFor = (sub: Sub, event: 'hello' | 'bye', sessionId: string) =>
  sub.received.some((m) => m.event === event && parseControlEvent(event, m.payload)?.session_id === sessionId);
const channelJoined = (sub: Sub) => sub.channel.state === 'joined';

afterEach(async () => {
  for (const sub of [...openSubs]) await release(sub).catch(() => undefined);
});

afterAll(async () => {
  for (const c of clients) await c.removeAllChannels().catch(() => undefined);
});

// --- C1 -------------------------------------------------------------------------------------------------------

describe.skipIf(!gate.enabled)('Supabase real — C1: sem sala (só cadastro anônimo)', () => {
  let stranger: TestUser;
  beforeAll(async () => {
    stranger = await newUser();
  });

  rit('#4 RPC sem JWT de usuário (só chave publicável) → permission denied', async () => {
    const anon = newClient();
    const { message } = await rpc(anon, 'join_room', { p_room_id: crypto.randomUUID() });
    expect(message).toMatch(/permission denied/);
  });

  rit('#4 RPC com JWT de usuário sem convite → código curto, sem detalhes internos', async () => {
    const { message } = await rpc(stranger, 'join_room', { p_room_id: crypto.randomUUID() });
    expect(message).toBe('not-member');
  });

  rit('#3 schemas oryn e realtime não são alcançáveis pela Data API', async () => {
    guard();
    const oryn = await stranger.client.schema('oryn').from('rooms').select('id').limit(1);
    expect(oryn.error?.code).toBe('PGRST106');
    guard();
    const realtime = await stranger.client.schema('realtime').rpc('send', { payload: {}, event: 'x', topic: 'oryn:s:x', private: true });
    expect(realtime.error?.code).toBe('PGRST106');
    const internal = await rpc(stranger, 'admin_issue_creator_invite', { p_ttl_minutes: 60, p_max_open_rooms: 5 });
    expect(internal.message).not.toBeNull(); // não existe em public; o schema oryn não é exposto
  });

  rit('#4 transição de publicação (só service_role) recusada para usuário', async () => {
    const { message } = await rpc(stranger, 'set_signal_state', { p_msg_id: crypto.randomUUID(), p_state: 'published' });
    expect(message).toMatch(/permission denied/);
  });

  // Também é a PRIMEIRA conexão WebSocket da execução: segundo a documentação, é ela que cria as partições
  // diárias de realtime.messages. Depois da C1, o operador confere a partição de hoje (D0) por leitura.
  rit('#6/S4 tópico de sessão inexistente não é assinável (recusa do servidor)', async (ctx) => {
    await expectRefused(await subscribe(stranger.client, topicOf(crypto.randomUUID())), ctx, 'inexistente');
  });
});

// --- C2 -------------------------------------------------------------------------------------------------------

describe.skipIf(!hasRoomSetup)('Supabase real — C2: sala de teste (convite + ORYN_IT_PARTITIONS_CONFIRMED=1)', () => {
  let owner: TestUser;
  let member: TestUser;
  let stranger: TestUser;
  let room: string;
  let ownerSession: string;
  let memberSession: string;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let keepaliveInFlight: Promise<unknown> = Promise.resolve();
  let keepaliveFailures = 0;

  beforeAll(async () => {
    owner = await newUser();
    member = await newUser();
    stranger = await newUser();
    const grant = await rpc<number>(owner, 'redeem_creator_invite', { p_token: env.creatorInvite });
    if (grant.message) throw new Error(`convite de criador recusado: ${grant.message}`);
    const created = await rpc<string>(owner, 'create_room', { p_name: `it-02c4b-${RUN}`, p_display_name: 'it-owner', p_max_members: 10 });
    if (!created.data) throw new Error(`create_room: ${created.message}`);
    room = created.data;
    const invite = await rpc<{ token: string }[]>(owner, 'create_room_invite', { p_room_id: room, p_ttl_minutes: 10 });
    const redeemed = await rpc(member, 'redeem_room_invite', { p_token: invite.data?.[0]?.token, p_display_name: 'it-member' });
    if (redeemed.message) throw new Error(`redeem_room_invite: ${redeemed.message}`);
    ownerSession = await joinRoom(owner, room);
    memberSession = await joinRoom(member, room);
    // A execução passa de 90 s (A2). Sem batimento, as duas sessões fixas venceriam no meio e os testes
    // seguintes falhariam por motivo errado. A sessão-alvo do A2 NUNCA entra aqui. `unref`: o timer nunca
    // segura o processo; o afterAll o encerra e espera a chamada em voo antes de sair da sala.
    keepalive = setInterval(() => {
      keepaliveInFlight = Promise.all([
        rpc(owner, 'touch_session', { p_session_id: ownerSession }),
        rpc(member, 'touch_session', { p_session_id: memberSession }),
      ]).then(
        (rs) => void (keepaliveFailures += rs.filter((r) => r.message !== null).length),
        () => void (keepaliveFailures += 1),
      );
    }, 30_000);
    keepalive.unref();
  }, 60_000);

  // Roda também quando o beforeAll falha (Vitest executa afterAll mesmo assim).
  afterAll(async () => {
    clearInterval(keepalive);
    await keepaliveInFlight.catch(() => undefined);
    if (ownerSession) await rpc(owner, 'leave_room', { p_session_id: ownerSession });
    if (memberSession) await rpc(member, 'leave_room', { p_session_id: memberSession });
  });

  describe('inscrição em canais privados', () => {
    rit('#6/S1 o dono da sessão assina o próprio tópico privado', async () => {
      expect((await subscribe(owner.client, topicOf(ownerSession))).status).toBe('SUBSCRIBED');
    });

    rit('A4 segundo cliente do MESMO usuário (outra aba) assina a própria sessão', async () => {
      expect((await subscribe(await sameUserClient(owner), topicOf(ownerSession))).status).toBe('SUBSCRIBED');
    });

    rit('#6/S2/S3 membro da MESMA sala não assina a sessão do outro; estranho também não', async (ctx) => {
      await expectRefused(await subscribe(member.client, topicOf(ownerSession)), ctx, 'membro');
      await expectRefused(await subscribe(stranger.client, topicOf(ownerSession)), ctx, 'estranho');
    }, 60_000);

    rit('#7/S5 o próprio tópico sem private:true é recusado ("Allow public access" desligado)', async (ctx) => {
      await expectRefused(await subscribe(await sameUserClient(owner), topicOf(ownerSession), { private: false }), ctx, 'private:false');
    });

    rit('S6 só a chave publicável (papel anon, sem JWT de usuário) não assina uma sessão viva', async (ctx) => {
      await expectRefused(await subscribe(newClient(), topicOf(ownerSession)), ctx, 'anon', { allowCredentialError: true });
    });

    rit('S7 variações do próprio tópico são recusadas (maiúsculas, UUID maiúsculo, outro prefixo, sufixo)', async (ctx) => {
      const variants = {
        'ORYN:S:<uuid>': topicOf(ownerSession).toUpperCase(),
        'oryn:s:<UUID>': `oryn:s:${ownerSession.toUpperCase()}`,
        'oryn:x:<uuid>': `oryn:x:${ownerSession}`,
        'oryn:s:<uuid>:x': `${topicOf(ownerSession)}:x`,
      };
      for (const [label, topic] of Object.entries(variants)) await expectRefused(await subscribe(owner.client, topic), ctx, label);
    }, 60_000);

    // A política permissiva só cobre extension='broadcast'. Critério: NENHUMA presença se propaga. A forma
    // da recusa (entrada recusada ou track() sem efeito) não é documentada: fica anotada. Entrada sem
    // resposta ou queda de transporte reprovam.
    rit('S8/P5 Presence no próprio tópico não se propaga', async (ctx) => {
      const observer = await subscribe(await sameUserClient(owner), topicOf(ownerSession), { private: true, presence: true });
      const tracker = await subscribe(owner.client, topicOf(ownerSession), { private: true, presence: true });
      for (const [label, sub] of [['observador', observer], ['rastreador', tracker]] as const) {
        await ctx.annotate(`${label}: ${sub.status}${sub.reason ? ` (${sub.reason})` : ''}`);
        expect(['SUBSCRIBED', 'CHANNEL_ERROR'], `${label}: entrada conclusiva`).toContain(sub.status);
        if (sub.status === 'CHANNEL_ERROR') expect(sub.refusedByServer, `${label}: recusa do servidor`).toBe(true);
      }
      if (tracker.status === 'SUBSCRIBED') {
        guard();
        await ctx.annotate(`track() = ${await tracker.channel.track({ label: 'it' })}`);
      }
      await sleep(2_000);
      expect(observer.presenceJoins).toBe(0);
      if (observer.status === 'SUBSCRIBED') {
        expect(Object.keys(observer.channel.presenceState()).length).toBe(0);
        expect(channelJoined(observer), 'observador ainda conectado ao fim da janela').toBe(true);
      }
    }, 60_000);
  });

  describe('sessão: revogação, expiração e isolamento', () => {
    rit('A1 depois de leave_room, a sessão não volta: nova assinatura recusada e touch_session negado', async (ctx) => {
      const sid = await joinRoom(member, room);
      const before = await subscribe(await sameUserClient(member), topicOf(sid));
      expect(before.status, 'controle positivo antes da revogação').toBe('SUBSCRIBED');
      await release(before);
      expect((await rpc(member, 'leave_room', { p_session_id: sid })).message).toBeNull();
      await expectRefused(await subscribe(await sameUserClient(member), topicOf(sid)), ctx, 'revogada');
      expect((await rpc(member, 'touch_session', { p_session_id: sid })).message).toBe('session-invalid');
    }, 60_000);

    rit(
      'A2/A3 sem batimento por mais de 90 s a sessão vence; join_room a revoga como expired e a nova vale',
      async (ctx) => {
        const expiring = await joinRoom(member, room);
        const before = await subscribe(await sameUserClient(member), topicOf(expiring));
        expect(before.status, 'controle positivo antes da expiração').toBe('SUBSCRIBED');
        await release(before);
        await sleep(100_000); // batimento de 90 s + margem; o keepalive não toca nesta sessão
        // O batimento das sessões fixas funcionou (senão o resto da suíte falharia por motivo errado).
        expect(keepaliveFailures, 'falhas do batimento das sessões fixas').toBe(0);
        expect((await rpc(member, 'touch_session', { p_session_id: memberSession })).message, 'sessão fixa viva').toBeNull();
        // A2: vencida
        await expectRefused(await subscribe(await sameUserClient(member), topicOf(expiring)), ctx, 'vencida');
        expect((await rpc(member, 'touch_session', { p_session_id: expiring })).message).toBe('session-invalid');
        // A3: nova entrada revoga a vencida e abre outra, que é assinável; a antiga continua fora
        const fresh = await joinRoom(member, room);
        expect((await subscribe(await sameUserClient(member), topicOf(fresh))).status).toBe('SUBSCRIBED');
        await expectRefused(await subscribe(await sameUserClient(member), topicOf(expiring)), ctx, 'vencida depois do join_room');
        const roster = await rpc<{ session_id: string }[]>(member, 'get_roster', { p_room_id: room });
        expect(roster.data?.some((r) => r.session_id === expiring)).toBe(false);
        await rpc(member, 'leave_room', { p_session_id: fresh });
      },
      180_000,
    );
  });

  // Positivos (D1, D2) ANTES dos negativos de entrega. Cada negativo termina com um controle positivo no MESMO
  // canal: sem ele, "nada chegou" poderia ser só um canal morto.
  describe('entrega pelo servidor e publicação por clientes', () => {
    /** Evento legítimo do servidor para `sub`: outra sessão entra na sala (hello) e sai. */
    async function positiveControl(sub: Sub, joiner: TestUser, label: string) {
      const probe = await joinRoom(joiner, room);
      const arrived = await waitFor(() => controlFor(sub, 'hello', probe));
      await rpc(joiner, 'leave_room', { p_session_id: probe });
      expect(arrived, `${label}: controle positivo, o canal ainda recebe do servidor`).toBe(true);
    }

    rit('#11/D1 realtime.send (controle): hello chega ao destinatário e o cliente o aceita (id injetado + session_id + label)', async () => {
      const receiver = await subscribe(member.client, topicOf(memberSession));
      expect(receiver.status).toBe('SUBSCRIBED');
      const second = await joinRoom(owner, room);
      const arrived = await waitFor(() => controlFor(receiver, 'hello', second));
      await rpc(owner, 'leave_room', { p_session_id: second });
      expect(arrived).toBe(true);
      const hello = receiver.received.find((m) => m.event === 'hello')!;
      // 02C.2B: o realtime.send real acrescenta `id`; nada além de id, label e session_id.
      expect(Object.keys(hello.payload as object).filter((k) => k !== 'id').sort()).toEqual(['label', 'session_id']);
      const parsed = parseControlEvent('hello', hello.payload);
      expect(parsed?.event === 'hello' && parsed.label).toBe('it-owner');
    });

    rit('D2 leave_room publica bye só com session_id (+ id injetado)', async () => {
      const receiver = await subscribe(member.client, topicOf(memberSession));
      expect(receiver.status).toBe('SUBSCRIBED');
      const second = await joinRoom(owner, room);
      expect(await waitFor(() => controlFor(receiver, 'hello', second))).toBe(true);
      await rpc(owner, 'leave_room', { p_session_id: second });
      expect(await waitFor(() => controlFor(receiver, 'bye', second))).toBe(true);
      const bye = receiver.received.find((m) => m.event === 'bye' && parseControlEvent('bye', m.payload)?.session_id === second)!;
      expect(Object.keys(bye.payload as object).filter((k) => k !== 'id')).toEqual(['session_id']);
    });

    // O critério de segurança é a NÃO ENTREGA. O resultado do ack fica anotado: a documentação não garante
    // se o servidor responde erro ou aceita e descarta.
    rit('#8/P1 WebSocket: o cliente não entrega Broadcast no próprio tópico oryn:*', async (ctx) => {
      const receiver = await subscribe(owner.client, topicOf(ownerSession));
      const sender = await subscribe(await sameUserClient(owner), topicOf(ownerSession), { private: true, ack: true });
      expect(receiver.status).toBe('SUBSCRIBED');
      expect(sender.status).toBe('SUBSCRIBED');
      guard();
      await ctx.annotate(`send() com ack = ${await sender.channel.send({ type: 'broadcast', event: 'signal', payload: { forged: true } })}`);
      await sleep(2_000);
      expect(receiver.received.filter((m) => m.event === 'signal').length).toBe(0);
      await positiveControl(receiver, member, 'receptor');
    });

    rit('#8/P2/P3 REST: nem o JWT de outro usuário nem a chave publicável entregam no tópico (minúsculo e maiúsculo)', async (ctx) => {
      const receiver = await subscribe(owner.client, topicOf(ownerSession));
      expect(receiver.status).toBe('SUBSCRIBED');
      const anon = newClient();
      for (const [who, client] of [['JWT do membro', member.client], ['chave publicável', anon]] as const) {
        for (const [label, topic] of [['minúsculo', topicOf(ownerSession)], ['maiúsculo', topicOf(ownerSession).toUpperCase()]] as const) {
          await ctx.annotate(`${who}, ${label}: ${await httpSendOutcome(client, topic)}`);
        }
      }
      await sleep(2_000);
      expect(receiver.received.filter((m) => m.event === 'signal').length).toBe(0);
      await positiveControl(receiver, member, 'receptor');
    }, 60_000);

    // Cobre a parte do R1 que não exige operador: o canal antigo continua aberto (autorização em cache), mas
    // o servidor não publica para sessão revogada. O canal "em cache" precisa seguir conectado até o fim.
    rit('D3 sessão revogada com o canal ainda aberto não recebe hello; a sessão viva recebe (controle)', async () => {
      const live = await subscribe(member.client, topicOf(memberSession));
      const revoked = await joinRoom(member, room);
      const cached = await subscribe(await sameUserClient(member), topicOf(revoked));
      expect(live.status).toBe('SUBSCRIBED');
      expect(cached.status).toBe('SUBSCRIBED');
      await rpc(member, 'leave_room', { p_session_id: revoked });
      const third = await joinRoom(owner, room);
      const arrived = await waitFor(() => controlFor(live, 'hello', third));
      await sleep(2_000);
      await rpc(owner, 'leave_room', { p_session_id: third });
      expect(arrived, 'controle positivo: sessão viva recebe').toBe(true);
      expect(controlFor(cached, 'hello', third)).toBe(false);
      expect(channelJoined(cached), 'canal da sessão revogada ainda conectado (senão o negativo não prova nada)').toBe(true);
    });
  });

  describe('concorrência', () => {
    rit('#18 M5: 5 join_room SIMULTÂNEOS do mesmo usuário → no máximo 2 sessões vivas', async () => {
      const results = await Promise.all(Array.from({ length: 5 }, () => rpc<{ session_id: string }[]>(member, 'join_room', { p_room_id: room })));
      const opened = results.filter((r) => r.message === null).map((r) => r.data![0]!.session_id);
      for (const sid of opened) await rpc(member, 'leave_room', { p_session_id: sid });
      // O membro tem só a sessão do beforeAll (A1–A3, D3 e os controles fecham as suas): sobra exatamente 1 vaga.
      expect(opened.length).toBe(1);
      expect(results.filter((r) => r.message === 'limit-reached').length).toBe(4);
    });

    rit('#18 authorize_signal: 5 repetições SIMULTÂNEAS do mesmo client_msg_id → mesmo msg_id, sem erro bruto', async () => {
      const args = { p_session_id: memberSession, p_to_session_id: ownerSession, p_client_msg_id: crypto.randomUUID(), p_kind: 'candidate', p_pair_epoch: 1, p_payload_bytes: 200 };
      const results = await Promise.all(Array.from({ length: 5 }, () => rpc<{ msg_id: string; duplicate: boolean }[]>(member, 'authorize_signal', args)));
      expect(results.map((r) => r.message)).toEqual(Array(5).fill(null));
      expect(new Set(results.map((r) => r.data![0]!.msg_id)).size).toBe(1);
      expect(results.filter((r) => r.data![0]!.duplicate === false).length).toBe(1);
    });

    rit('#15 HTTP: 5 resgates SIMULTÂNEOS do mesmo convite → exatamente 1 sucesso', async () => {
      const invite = await rpc<{ token: string }[]>(owner, 'create_room_invite', { p_room_id: room, p_ttl_minutes: 5 });
      expect(invite.data?.[0]?.token !== undefined).toBe(true);
      const racers = await Promise.all(Array.from({ length: 5 }, () => newUser()));
      const results = await Promise.all(racers.map((u, i) => rpc(u, 'redeem_room_invite', { p_token: invite.data![0]!.token, p_display_name: `it-r${i}` })));
      expect(results.filter((r) => r.message === null).length).toBe(1);
      expect(results.filter((r) => r.message === 'invite-invalid').length).toBe(4);
    }, 60_000);
  });
});

describe('Supabase real — fora do harness de cliente', () => {
  it.todo('D0 partição de hoje em realtime.messages: leitura do operador (consulta em 02C.4A, seção 3) depois da C1; só então ORYN_IT_PARTITIONS_CONFIRMED=1 (o portão exige para a C2)');
  it.todo('#1/#2/#16 migrações, privilégios padrão e dono: integration/sql/00_preflight.sql e 01_postflight.sql (SQL editor)');
  it.todo('#5 Turnstile: decisão B5 pendente (chaves de teste no ambiente isolado)');
  it.todo('A5/#12 revogação com autorização em cache RECEBENDO publicação: exige realtime.send do operador no tópico revogado (escrita autorizada) ou a Edge Function');
  it.todo('D4/#9 Broadcast REST com a chave secreta entrega só ao destinatário: Edge Function publicada ou operador');
  it.todo('N5/#10 Broadcast REST não persiste nem aparece no Replay: depende do D4 + leitura SQL');
  it.todo('D5/#13 e N6/#14 Edge Function ponta a ponta, p95 e logs sem SDP/JWT/IDs: publicação ainda não autorizada');
  it.todo('N3/N4 depois da execução: realtime.messages em oryn:* só com hello/bye e payload só com id/session_id/label (leitura SQL)');
  it.todo('#15 variante SQL com 2 sessões psql: integration/sql/10_concurrency_redeem.sql');
  it.todo('#17 integração GitHub: Fase 0 do runbook (painel)');
});
