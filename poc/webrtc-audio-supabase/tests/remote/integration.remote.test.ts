// Testes de integração contra o Supabase REAL (02C.1B). NUNCA rodam no `pnpm test` nem no CI: só com
// `pnpm test:remote` E ORYN_REMOTE=1 (ver ./remote-env.ts e integration/RUNBOOK-02C.1B.md).
// Só credencial de cliente (chave publicável + JWT de usuários anônimos de teste). Os itens que exigem
// SQL privilegiado, painel ou Edge Function publicada ficam como `todo` com o motivo.
//
// Custo por execução completa: até 8 cadastros anônimos (limite padrão: 30/h por IP).
// Nada de JWT, chave ou token de convite em mensagens de asserção ou log.
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseControlEvent } from '../../src/contracts.ts';
import { remoteGate, type RemoteEnv } from './remote-env.ts';

const gate = remoteGate(process.env);
const env = gate.enabled ? gate.env : (undefined as unknown as RemoteEnv);
const hasRoomSetup = gate.enabled && env.creatorInvite !== undefined;

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
  const client = 'client' in user ? user.client : user;
  const { data, error } = await client.rpc(fn, args);
  return { data: (data as T) ?? null, message: error?.message ?? null };
}

interface Sub {
  status: string;
  channel: RealtimeChannel;
  received: { event: string; payload: unknown }[];
}

/** Assina um tópico e espera o estado final da entrada (SUBSCRIBED ou erro). */
function subscribe(client: SupabaseClient, topic: string, opts: { private: boolean; ack?: boolean } = { private: true }): Promise<Sub> {
  return new Promise((resolve) => {
    const received: Sub['received'] = [];
    const channel = client.channel(topic, { config: { private: opts.private, broadcast: { self: false, ack: opts.ack ?? false } } });
    channel.on('broadcast', { event: '*' }, (msg) => received.push({ event: String(msg['event']), payload: msg['payload'] }));
    let done = false;
    const finish = (status: string) => {
      if (done) return;
      done = true;
      resolve({ status, channel, received });
    };
    channel.subscribe((status) => {
      if (status !== 'SUBSCRIBED' && status !== 'CHANNEL_ERROR' && status !== 'TIMED_OUT' && status !== 'CLOSED') return;
      finish(status);
    }, 10_000);
    setTimeout(() => finish('NO_REPLY'), 12_000);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const topicOf = (sessionId: string) => `oryn:s:${sessionId}`;

afterAll(async () => {
  for (const c of clients) await c.removeAllChannels().catch(() => undefined);
});

describe.skipIf(!gate.enabled)('Supabase real — sem sala (só cadastro anônimo)', () => {
  let stranger: TestUser;
  beforeAll(async () => {
    stranger = await newUser();
  });

  it('#4 RPC sem JWT de usuário (só chave publicável) → permission denied', async () => {
    const anon = newClient();
    const { message } = await rpc(anon, 'join_room', { p_room_id: crypto.randomUUID() });
    expect(message).toMatch(/permission denied/);
  });

  it('#4 RPC com JWT de usuário sem convite → código curto, sem detalhes internos', async () => {
    const { message } = await rpc(stranger, 'join_room', { p_room_id: crypto.randomUUID() });
    expect(message).toBe('not-member');
  });

  it('#3 schemas oryn e realtime não são alcançáveis pela Data API', async () => {
    const oryn = await stranger.client.schema('oryn').from('rooms').select('id').limit(1);
    expect(oryn.error?.code).toBe('PGRST106');
    const realtime = await stranger.client.schema('realtime').rpc('send', { payload: {}, event: 'x', topic: 'oryn:s:x', private: true });
    expect(realtime.error?.code).toBe('PGRST106');
    const internal = await rpc(stranger, 'admin_issue_creator_invite', { p_ttl_minutes: 60, p_max_open_rooms: 5 });
    expect(internal.message).not.toBeNull(); // não existe em public; o schema oryn não é exposto
  });

  it('#4 transição de publicação (só service_role) recusada para usuário', async () => {
    const { message } = await rpc(stranger, 'set_signal_state', { p_msg_id: crypto.randomUUID(), p_state: 'published' });
    expect(message).toMatch(/permission denied/);
  });

  it('#6 tópico de sessão inexistente não é assinável', async () => {
    const sub = await subscribe(stranger.client, topicOf(crypto.randomUUID()));
    expect(sub.status).not.toBe('SUBSCRIBED');
  });
});

describe.skipIf(!hasRoomSetup)('Supabase real — sala de teste (exige ORYN_IT_CREATOR_INVITE)', () => {
  let owner: TestUser;
  let member: TestUser;
  let stranger: TestUser;
  let room: string;
  let ownerSession: string;
  let memberSession: string;

  beforeAll(async () => {
    owner = await newUser();
    member = await newUser();
    stranger = await newUser();
    const grant = await rpc<number>(owner, 'redeem_creator_invite', { p_token: env.creatorInvite });
    if (grant.message) throw new Error(`convite de criador recusado: ${grant.message}`);
    const created = await rpc<string>(owner, 'create_room', { p_name: 'it-02c1b', p_display_name: 'it-owner', p_max_members: 10 });
    if (!created.data) throw new Error(`create_room: ${created.message}`);
    room = created.data;
    const invite = await rpc<{ token: string }[]>(owner, 'create_room_invite', { p_room_id: room, p_ttl_minutes: 10 });
    const redeemed = await rpc(member, 'redeem_room_invite', { p_token: invite.data?.[0]?.token, p_display_name: 'it-member' });
    if (redeemed.message) throw new Error(`redeem_room_invite: ${redeemed.message}`);
    ownerSession = (await rpc<{ session_id: string }[]>(owner, 'join_room', { p_room_id: room })).data![0]!.session_id;
    memberSession = (await rpc<{ session_id: string }[]>(member, 'join_room', { p_room_id: room })).data![0]!.session_id;
  }, 60_000);

  afterAll(async () => {
    if (ownerSession) await rpc(owner, 'leave_room', { p_session_id: ownerSession });
    if (memberSession) await rpc(member, 'leave_room', { p_session_id: memberSession });
  });

  it('#6 o dono da sessão assina o próprio tópico privado', async () => {
    expect((await subscribe(owner.client, topicOf(ownerSession))).status).toBe('SUBSCRIBED');
  });

  it('#6 membro da MESMA sala não assina a sessão do outro; estranho também não', async () => {
    expect((await subscribe(member.client, topicOf(ownerSession))).status).not.toBe('SUBSCRIBED');
    expect((await subscribe(stranger.client, topicOf(ownerSession))).status).not.toBe('SUBSCRIBED');
  });

  it('#7 o próprio tópico sem private:true é recusado ("Allow public access" desligado)', async () => {
    const other = await sameUserClient(owner);
    expect((await subscribe(other, topicOf(ownerSession), { private: false })).status).not.toBe('SUBSCRIBED');
  });

  it('#8 WebSocket: o cliente não entrega Broadcast no próprio tópico oryn:*', async () => {
    const receiver = await subscribe(owner.client, topicOf(ownerSession));
    const senderClient = await sameUserClient(owner);
    const sender = await subscribe(senderClient, topicOf(ownerSession), { private: true, ack: true });
    expect(receiver.status).toBe('SUBSCRIBED');
    expect(sender.status).toBe('SUBSCRIBED');
    const result = await sender.channel.send({ type: 'broadcast', event: 'signal', payload: { forged: true } });
    await sleep(2_000);
    expect(result).not.toBe('ok');
    expect(receiver.received).toEqual([]);
  });

  it('#8 REST com o JWT do usuário: não entrega no tópico de outra sessão (inclusive em maiúsculas)', async () => {
    const receiver = await subscribe(owner.client, topicOf(ownerSession));
    expect(receiver.status).toBe('SUBSCRIBED');
    for (const topic of [topicOf(ownerSession), topicOf(ownerSession).toUpperCase()]) {
      const ch = member.client.channel(topic, { config: { private: true } });
      const res = await ch.httpSend('signal', { forged: true });
      await member.client.removeChannel(ch);
      expect(res.success, topic === topicOf(ownerSession) ? 'minúsculo' : 'maiúsculo').toBe(false);
    }
    await sleep(2_000);
    expect(receiver.received).toEqual([]);
  });

  it('#11 realtime.send (controle): hello chega ao destinatário e o cliente o aceita (id injetado + session_id + label)', async () => {
    const receiver = await subscribe(member.client, topicOf(memberSession));
    expect(receiver.status).toBe('SUBSCRIBED');
    const second = (await rpc<{ session_id: string }[]>(owner, 'join_room', { p_room_id: room })).data![0]!.session_id;
    const deadline = Date.now() + 10_000;
    while (receiver.received.length === 0 && Date.now() < deadline) await sleep(200);
    await rpc(owner, 'leave_room', { p_session_id: second });
    const hello = receiver.received.find((m) => m.event === 'hello');
    expect(hello).toBeDefined();
    // 02C.2B: o realtime.send real acrescenta `id`; nada além de id, label e session_id.
    expect(Object.keys(hello!.payload as object).filter((k) => k !== 'id').sort()).toEqual(['label', 'session_id']);
    expect(parseControlEvent('hello', hello!.payload)).toEqual({ event: 'hello', session_id: second, label: 'it-owner' });
  });

  it('#18 M5: 5 join_room SIMULTÂNEOS do mesmo usuário → no máximo 2 sessões vivas', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => rpc<{ session_id: string }[]>(member, 'join_room', { p_room_id: room })));
    const opened = results.filter((r) => r.message === null).map((r) => r.data![0]!.session_id);
    // O membro já tem 1 sessão (beforeAll): sobra exatamente 1 vaga.
    expect(opened).toHaveLength(1);
    expect(results.filter((r) => r.message === 'limit-reached')).toHaveLength(4);
    for (const sid of opened) await rpc(member, 'leave_room', { p_session_id: sid });
  });

  it('#18 authorize_signal: 5 repetições SIMULTÂNEAS do mesmo client_msg_id → mesmo msg_id, sem erro bruto', async () => {
    const args = { p_session_id: memberSession, p_to_session_id: ownerSession, p_client_msg_id: crypto.randomUUID(), p_kind: 'candidate', p_pair_epoch: 1, p_payload_bytes: 200 };
    const results = await Promise.all(Array.from({ length: 5 }, () => rpc<{ msg_id: string; duplicate: boolean }[]>(member, 'authorize_signal', args)));
    expect(results.map((r) => r.message)).toEqual(Array(5).fill(null));
    expect(new Set(results.map((r) => r.data![0]!.msg_id)).size).toBe(1);
    expect(results.filter((r) => r.data![0]!.duplicate === false)).toHaveLength(1);
  });

  it('#15 HTTP: 5 resgates SIMULTÂNEOS do mesmo convite → exatamente 1 sucesso', async () => {
    const invite = await rpc<{ token: string }[]>(owner, 'create_room_invite', { p_room_id: room, p_ttl_minutes: 5 });
    const token = invite.data?.[0]?.token;
    expect(token).toBeDefined();
    const racers = await Promise.all(Array.from({ length: 5 }, () => newUser()));
    const results = await Promise.all(racers.map((u, i) => rpc(u, 'redeem_room_invite', { p_token: token, p_display_name: `it-r${i}` })));
    expect(results.filter((r) => r.message === null)).toHaveLength(1);
    expect(results.filter((r) => r.message === 'invite-invalid')).toHaveLength(4);
  }, 60_000);
});

describe('Supabase real — fora do harness de cliente', () => {
  it.todo('#1/#2/#16 migrações, privilégios padrão e dono: integration/sql/00_preflight.sql e 01_postflight.sql (SQL editor)');
  it.todo('#5 Turnstile: decisão B5 pendente (chaves de teste no ambiente isolado)');
  it.todo('#9/#10 Broadcast REST com a chave secreta e não persistência: Edge Function publicada ou operador + SQL');
  it.todo('#12 revogação com autorização em cache: exige publicação do servidor depois do leave_room');
  it.todo('#13/#14 Edge Function ponta a ponta e logs: publicação ainda não autorizada');
  it.todo('#15 variante SQL com 2 sessões psql: integration/sql/10_concurrency_redeem.sql');
  it.todo('#17 integração GitHub: Fase 0 do runbook (painel)');
});
