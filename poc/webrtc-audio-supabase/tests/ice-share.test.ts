// Configuração ICE por chamada (cliente): uma emissão compartilhada entre os pares, validade, fallback do auto para STUN
// com aviso, falha fechada dos modos de relay e validação da resposta da função. Sem rede e sem navegador.
import { describe, expect, it, vi } from 'vitest';
import { buildRtcConfiguration } from '../src/web/ice.ts';
import { IceShare, chosenIceMode, requestTurn, type TurnGrant } from '../src/web/ice-share.ts';

const STUN = [{ urls: ['stun:stun.l.google.com:19302'] }];
const PROVIDER_STUN = { urls: ['stun:stun.cloudflare.com:3478'] };
const TURN = { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u-temp', credential: 'c-temp' };
const HOUR = 60 * 60_000;

function share(results: TurnGrant[] | (() => Promise<TurnGrant>), clock = { t: 0 }) {
  const fetch = vi.fn(typeof results === 'function' ? results : async () => results.shift() ?? { ok: false as const, code: 'acabou' });
  const degraded: string[] = [];
  const restored: number[] = [];
  const logs: string[] = [];
  const s = new IceShare({ fetch, stun: STUN, now: () => clock.t, onDegraded: (c) => degraded.push(c), onRestored: () => restored.push(clock.t), log: (m) => logs.push(m), timeoutMs: 50 });
  return { s, fetch, degraded, restored, logs, clock };
}
const ok = (expiresAt: number, servers = [PROVIDER_STUN, TURN]): TurnGrant => ({ ok: true, iceServers: servers, expiresAt });

describe('IceShare: uma configuração por chamada', () => {
  it('quatro pares pedindo ao mesmo tempo → uma emissão só, e todos recebem a mesma configuração com validade', async () => {
    const h = share([ok(2 * HOUR)]);
    const answers = await Promise.all(Array.from({ length: 4 }, () => h.s.request('auto')));
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.s.fetches).toBe(1);
    for (const a of answers) expect(a).toEqual({ type: 'ice-config', mode: 'auto', iceServers: [PROVIDER_STUN, TURN], expiresAt: 2 * HOUR });
    // Um par que reconecta depois reaproveita a mesma configuração enquanto vale.
    h.clock.t = HOUR;
    await h.s.request('auto');
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('direct não chama a função: só o STUN do cliente, sem validade', async () => {
    const h = share([ok(2 * HOUR)]);
    expect(await h.s.request('direct')).toEqual({ type: 'ice-config', mode: 'direct', iceServers: STUN, expiresAt: null });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('sem STUN do provedor, o STUN do cliente completa (auto)', async () => {
    const h = share([ok(2 * HOUR, [TURN])]);
    expect((await h.s.request('auto')) as unknown).toMatchObject({ iceServers: [...STUN, TURN] });
  });

  it('vencida ou a menos de 10 min do fim → nunca reaproveitada: nova emissão', async () => {
    const h = share([ok(2 * HOUR), ok(4 * HOUR)]);
    await h.s.request('auto');
    h.clock.t = 2 * HOUR - 9 * 60_000;
    const renewed = await h.s.request('relay');
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(renewed).toMatchObject({ expiresAt: 4 * HOUR });
  });

  it('credencial que já chega perto do fim é recusada (o PeerCall pediria de novo, em ciclo) e não é buscada em rajada', async () => {
    const h = share([ok(60_000), ok(60_000)]);
    expect(await h.s.request('relay')).toEqual({ type: 'error', code: 'turn-unavailable' });
    expect(await h.s.request('auto')).toMatchObject({ iceServers: STUN, expiresAt: null });
    expect(h.degraded).toEqual(['short-validity']);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('IceShare: indisponibilidade', () => {
  it('auto sem TURN → segue só com STUN, avisa UMA vez e registra; nunca configuração vazia', async () => {
    const h = share([{ ok: false, code: 'turn-unavailable' }]);
    const answers = await Promise.all([h.s.request('auto'), h.s.request('auto'), h.s.request('auto')]);
    for (const a of answers) expect(a).toEqual({ type: 'ice-config', mode: 'auto', iceServers: STUN, expiresAt: null });
    expect(h.degraded).toEqual(['turn-unavailable']);
    expect(h.logs.join(' ')).toMatch(/seguindo só com STUN/);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('relay e relay-tls sem TURN → turn-unavailable (o par falha fechado); limite → ice-limit', async () => {
    const h = share([{ ok: false, code: 'unreachable' }]);
    expect(await h.s.request('relay')).toEqual({ type: 'error', code: 'turn-unavailable' });
    expect(await h.s.request('relay-tls')).toEqual({ type: 'error', code: 'turn-unavailable' });
    expect(h.degraded).toEqual([]);
    const limited = share([{ ok: false, code: 'ice-limit' }]);
    expect(await limited.s.request('relay')).toEqual({ type: 'error', code: 'ice-limit' });
  });

  it('a falha vale 30 s (sem rajada de pedidos); depois tenta de novo e, voltando, avisa que normalizou', async () => {
    const h = share([{ ok: false, code: 'unreachable' }, ok(3 * HOUR)]);
    await h.s.request('auto');
    h.clock.t = 10_000;
    await h.s.request('auto');
    expect(h.fetch).toHaveBeenCalledTimes(1);
    h.clock.t = 31_000;
    expect(await h.s.request('auto')).toMatchObject({ iceServers: [PROVIDER_STUN, TURN] });
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.restored).toEqual([31_000]);
  });

  it('função que não responde a tempo → tratada como indisponível (o par recebe resposta antes do prazo dele)', async () => {
    const h = share(() => new Promise<TurnGrant>(() => undefined));
    expect(await h.s.request('auto')).toMatchObject({ iceServers: STUN, expiresAt: null });
    expect(h.degraded).toEqual(['timeout']);
  });

  it('busca que lança → indisponível', async () => {
    const h = share(async () => { throw new Error('x'); });
    expect(await h.s.request('relay')).toEqual({ type: 'error', code: 'turn-unavailable' });
  });
});

describe('requestTurn: valida a resposta da função', () => {
  const now = () => 1_000;
  const target = { room_id: 'r', channel_id: null, session_id: 's' };
  it('200 com TURN e validade futura → ok, sanitizado', async () => {
    const grant = await requestTurn(async () => ({ status: 200, body: { iceServers: [PROVIDER_STUN, TURN, { urls: ['turn:x.example:53'], username: 'a', credential: 'b' }], expiresAt: 9_000 } }), target, now);
    expect(grant).toEqual({ ok: true, iceServers: [PROVIDER_STUN, TURN], expiresAt: 9_000 });
  });

  it.each([
    [{ status: 200, body: { iceServers: [PROVIDER_STUN], expiresAt: 9_000 } }, 'invalid-response'],
    [{ status: 200, body: { iceServers: [TURN], expiresAt: 500 } }, 'invalid-response'],
    [{ status: 200, body: { iceServers: [TURN] } }, 'invalid-response'],
    [{ status: 503, body: { error: 'turn-unavailable' } }, 'turn-unavailable'],
    [{ status: 429, body: { error: 'ice-limit' } }, 'ice-limit'],
    [{ status: 403, body: { error: 'Texto Livre Com Espaços' } }, 'http-403'],
  ])('resposta %j → falha %s, nunca configuração parcial', async (res, code) => {
    expect(await requestTurn(async () => res, target, now)).toEqual({ ok: false, code });
  });

  it('falha de rede → unreachable; o pedido leva só sala, canal e sessão', async () => {
    const seen: unknown[] = [];
    expect(await requestTurn(async (t) => { seen.push(t); throw new Error('rede'); }, target, now)).toEqual({ ok: false, code: 'unreachable' });
    expect(seen).toEqual([target]);
  });
});

describe('modos e montagem', () => {
  it('modo de teste pela URL (?oryn-ice=), senão o da build; valores estranhos ignorados', () => {
    expect(chosenIceMode('', 'auto')).toBe('auto');
    expect(chosenIceMode('?oryn-ice=relay-tls', 'auto')).toBe('relay-tls');
    expect(chosenIceMode('?x=1&oryn-ice=direct', 'auto')).toBe('direct');
    expect(chosenIceMode('?oryn-ice=tudo', 'relay')).toBe('relay');
  });

  it('com a configuração compartilhada: auto usa STUN e TURN com política all; relay só TURN; relay-tls só turns/tcp', () => {
    const servers = [PROVIDER_STUN, TURN];
    const auto = buildRtcConfiguration('auto', servers);
    expect(auto).toMatchObject({ ok: true, config: { iceTransportPolicy: 'all' }, turnConfigured: true });
    const relay = buildRtcConfiguration('relay', servers);
    expect(relay).toMatchObject({ ok: true, config: { iceTransportPolicy: 'relay', iceServers: [TURN] } });
    const tls = buildRtcConfiguration('relay-tls', servers);
    expect(tls).toMatchObject({ ok: true, config: { iceTransportPolicy: 'relay', iceServers: [{ ...TURN, urls: ['turns:turn.cloudflare.com:443?transport=tcp'] }] } });
    expect(buildRtcConfiguration('relay', STUN)).toMatchObject({ ok: false });
  });
});
