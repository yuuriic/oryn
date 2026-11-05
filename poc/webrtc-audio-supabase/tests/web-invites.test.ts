// Convites de sala (MVP 02): link, controladores do dono e do convidado e, no fim, os dois contra o SQL real (PGlite).
// O navegador de verdade fica no roteiro de validação com o stack local.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomSummary } from '../src/contracts.ts';
import {
  BAD_LINK,
  COPY_FAILED,
  CREATE_INVITE_ERRORS,
  CREATE_INVITE_FAILED,
  INVITE_ACCEPTED,
  INVITE_ALREADY_MEMBER,
  INVITE_BAD_NAME,
  INVITE_EXPIRED,
  INVITE_FAILED,
  INVITE_INVALID,
  INVITE_ROOM_FULL,
  INVITE_SESSION,
  INVITE_TTL_MINUTES,
  InviteAcceptController,
  InviteShareController,
  LINK_COPIED,
  REVOKE_ERRORS,
  REVOKE_FAILED,
  SHARE_FAILED,
  buildInviteLink,
  inviteLoginHint,
  parseInviteFragment,
  revokeConfirmation,
  revokeDone,
  takeInviteFromLocation,
  type InviteAcceptDeps,
  type InviteShareDeps,
} from '../src/web/invites.ts';
import { createRoom, makeCreator, openSession } from './helpers/fixtures.ts';
import { TestDb } from './helpers/db.ts';

const TOKEN = 'A'.repeat(43);
const OTHER = 'B'.repeat(43);
const ROOM = '11111111-1111-4111-8111-111111111111';
const ROOM2 = '22222222-2222-4222-8222-222222222222';
const LOC = { origin: 'https://oryn.example', pathname: '/', hash: '', search: '' };

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const code = (text: string) => text.replace(/\/\/.*$/gm, '');

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const room = (over: Partial<RoomSummary> = {}): RoomSummary => ({
  room_id: ROOM,
  name: 'Sala',
  role: 'owner',
  is_open: true,
  closed_at: null,
  member_count: 1,
  max_members: 2,
  created_at: '2026-11-04T00:00:00Z',
  ...over,
});

describe('link do convite', () => {
  it('token válido; outro fragmento não é convite; fragmento de convite fora do formato é inválido', () => {
    expect(parseInviteFragment(`#convite=${TOKEN}`)).toEqual({ kind: 'token', token: TOKEN });
    expect(parseInviteFragment('')).toEqual({ kind: 'none' });
    expect(parseInviteFragment('#outra-coisa')).toEqual({ kind: 'none' });
    for (const bad of ['#convite=', '#convite=curto', `#convite=${TOKEN}A`, `#convite=${'A'.repeat(42)}!`, `#convite=${TOKEN}&x=1`]) {
      expect(parseInviteFragment(bad), bad).toEqual({ kind: 'invalid' });
    }
  });

  it('o convite sai da URL, válido ou não, e a query fica', () => {
    const replace = vi.fn();
    expect(takeInviteFromLocation({ hash: `#convite=${TOKEN}`, pathname: '/app', search: '?a=1' }, replace)).toEqual({ kind: 'token', token: TOKEN });
    expect(replace).toHaveBeenCalledWith('/app?a=1');
    replace.mockClear();
    expect(takeInviteFromLocation({ hash: '#convite=curto', pathname: '/', search: '' }, replace)).toEqual({ kind: 'invalid' });
    expect(replace).toHaveBeenCalledWith('/');
  });

  it('fragmento que não é convite não mexe na URL', () => {
    const replace = vi.fn();
    expect(takeInviteFromLocation({ hash: '#ancora', pathname: '/', search: '' }, replace)).toEqual({ kind: 'none' });
    expect(replace).not.toHaveBeenCalled();
  });

  it('o link usa a origem da página, no fragmento, sem levar a query', () => {
    expect(buildInviteLink({ origin: 'https://a.example', pathname: '/' }, TOKEN)).toBe(`https://a.example/#convite=${TOKEN}`);
    const url = new URL(buildInviteLink({ origin: 'https://a.example', pathname: '/' }, TOKEN));
    expect(`${url.pathname}${url.search}`).toBe('/'); // é só isto que iria ao servidor
    expect(parseInviteFragment(url.hash)).toEqual({ kind: 'token', token: TOKEN });
  });
});

describe('dono: gerar e compartilhar', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-11-05T12:00:00Z') }));
  afterEach(() => vi.useRealTimers());

  function setup(over: Partial<InviteShareDeps> = {}) {
    const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => ({ data: [{ token: TOKEN, expires_at: 'x' }], error: null as string | null }));
    const copy = vi.fn(async (_link: string) => undefined);
    const share = vi.fn(async (_link: string) => true);
    const c = new InviteShareController({
      rpc: rpc as unknown as InviteShareDeps['rpc'],
      link: (t) => buildInviteLink(LOC, t),
      copy,
      share,
      confirm: () => true,
      onRevoked: () => undefined,
      onChange: () => undefined,
      ...over,
    });
    return { c, rpc, copy, share };
  }

  it('gera com 15 minutos e mostra o link', async () => {
    const { c, rpc } = setup();
    await c.open(ROOM);
    expect(INVITE_TTL_MINUTES).toBe(15);
    expect(rpc).toHaveBeenCalledWith('create_room_invite', { p_room_id: ROOM, p_ttl_minutes: 15 });
    expect(c.state).toMatchObject({ roomId: ROOM, link: `https://oryn.example/#convite=${TOKEN}`, busy: false, message: null });
    expect(c.state.expiresAt).toBe(Date.now() + 15 * 60_000);
  });

  it('fechar e reabrir mostra o mesmo link, sem gerar outro', async () => {
    const { c, rpc } = setup();
    await c.open(ROOM);
    const { link } = c.state;
    c.close();
    expect(c.state.roomId).toBeNull();
    expect(c.state.link).toBeNull();
    await c.open(ROOM);
    expect(c.state.link).toBe(link);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('clique repetido enquanto gera faz uma chamada só, e o painel não fecha no meio', async () => {
    const pending = deferred<{ data: unknown; error: null }>();
    const rpc = vi.fn(() => pending.promise);
    const { c } = setup({ rpc: rpc as unknown as InviteShareDeps['rpc'] });
    void c.open(ROOM);
    await c.open(ROOM);
    c.close();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(c.state).toMatchObject({ roomId: ROOM, busy: true });
    pending.resolve({ data: [{ token: TOKEN }], error: null });
    await vi.waitFor(() => expect(c.state.busy).toBe(false));
    expect(c.state.link).toContain(TOKEN);
  });

  it('cada sala tem o seu convite', async () => {
    const tokens = [TOKEN, OTHER];
    const rpc = vi.fn(async () => ({ data: [{ token: tokens.shift() }], error: null }));
    const { c } = setup({ rpc: rpc as unknown as InviteShareDeps['rpc'] });
    await c.open(ROOM);
    await c.open(ROOM2);
    expect(c.state.link).toContain(OTHER);
    await c.open(ROOM);
    expect(c.state.link).toContain(TOKEN);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('expirado com o painel aberto: some o link, avisa e só gera outro com novo clique', async () => {
    const { c, rpc } = setup();
    await c.open(ROOM);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(c.state).toMatchObject({ roomId: ROOM, link: null, expired: true, message: { tone: 'info', text: INVITE_EXPIRED } });
    expect(rpc).toHaveBeenCalledTimes(1);
    await c.open(ROOM);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(c.state.link).toContain(TOKEN);
    expect(c.state.expired).toBe(false);
  });

  it('expirado com o painel fechado: nada aparece, e o próximo clique gera outro', async () => {
    const { c, rpc } = setup();
    await c.open(ROOM);
    c.close();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(c.state.roomId).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
    await c.open(ROOM);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('relógio local errado não vence o convite na hora: a validade local parte da resposta', async () => {
    const rpc = vi.fn(async () => ({ data: [{ token: TOKEN, expires_at: '2000-01-01T00:00:00Z' }], error: null }));
    const { c } = setup({ rpc: rpc as unknown as InviteShareDeps['rpc'] });
    await c.open(ROOM);
    expect(c.state.link).toContain(TOKEN);
  });

  it.each(Object.entries(CREATE_INVITE_ERRORS))('erro %s: mensagem própria, sem link', async (error, text) => {
    const { c } = setup({ rpc: (async () => ({ data: null, error })) as unknown as InviteShareDeps['rpc'] });
    await c.open(ROOM);
    expect(c.state).toMatchObject({ roomId: ROOM, link: null, busy: false, message: { tone: 'error', text } });
  });

  it('falha de rede, erro desconhecido e resposta fora do contrato: mensagem genérica, sem repassar o servidor', async () => {
    const answers: (() => Promise<unknown>)[] = [
      () => Promise.reject(new Error('rede')),
      () => Promise.resolve({ data: null, error: 'detalhe interno: tabela oryn.x' }),
      () => Promise.resolve({ data: [{ token: 'curto' }], error: null }),
      () => Promise.resolve({ data: [], error: null }),
    ];
    for (const answer of answers) {
      const { c } = setup({ rpc: answer as unknown as InviteShareDeps['rpc'] });
      await c.open(ROOM);
      expect(c.state).toMatchObject({ link: null, message: { tone: 'error', text: CREATE_INVITE_FAILED } });
    }
  });

  it('copiar e compartilhar: sucesso, falha e desistência', async () => {
    const { c, copy, share } = setup();
    await c.open(ROOM);
    await c.copy();
    expect(copy).toHaveBeenCalledWith(c.state.link);
    expect(c.state.message?.text).toBe(LINK_COPIED);
    await c.share();
    expect(share).toHaveBeenCalledWith(c.state.link);

    const failing = setup({ copy: () => Promise.reject(new Error('negado')), share: () => Promise.reject(new Error('negado')) });
    await failing.c.open(ROOM);
    await failing.c.copy();
    expect(failing.c.state.message).toEqual({ tone: 'error', text: COPY_FAILED });
    expect(failing.c.state.link).toContain(TOKEN); // o link continua à vista para copiar à mão
    await failing.c.share();
    expect(failing.c.state.message).toEqual({ tone: 'error', text: SHARE_FAILED });

    const cancelled = setup({ share: async () => false });
    await cancelled.c.open(ROOM);
    await cancelled.c.share();
    expect(cancelled.c.state.message).toBeNull();
  });

  it('sala encerrada: o convite é esquecido e o painel fecha', async () => {
    const { c, rpc } = setup();
    await c.open(ROOM);
    c.forget(ROOM);
    expect(c.state.roomId).toBeNull();
    await c.open(ROOM);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('logout: esquece tudo, e a resposta em curso não reaparece na sessão seguinte', async () => {
    const pending = deferred<{ data: unknown; error: null }>();
    const rpc = vi.fn().mockResolvedValueOnce({ data: [{ token: TOKEN }], error: null }).mockReturnValueOnce(pending.promise).mockResolvedValue({ data: [{ token: OTHER }], error: null });
    const { c } = setup({ rpc: rpc as unknown as InviteShareDeps['rpc'] });
    await c.open(ROOM);
    c.reset();
    expect(c.state).toMatchObject({ roomId: null, link: null, busy: false });
    const inFlight = c.open(ROOM2);
    c.reset();
    pending.resolve({ data: [{ token: 'C'.repeat(43) }], error: null });
    await inFlight;
    expect(c.state.link).toBeNull();
    await c.open(ROOM);
    expect(c.state.link).toContain(OTHER);
  });

  it('lista atualizada: sala cheia, encerrada, de outro dono ou ausente fecha o painel; com lugar livre, mantém', async () => {
    const closes: RoomSummary[][] = [
      [room({ member_count: 2 })],
      [room({ is_open: false, closed_at: '2026-11-05T00:00:00Z' })],
      [room({ role: 'member' })],
      [],
    ];
    for (const rooms of closes) {
      const { c } = setup();
      await c.open(ROOM);
      c.syncRooms(rooms);
      expect(c.state.roomId).toBeNull();
    }
    const { c, rpc } = setup();
    await c.open(ROOM);
    c.syncRooms([room()]);
    expect(c.state.link).toContain(TOKEN);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('sala que deixou de aceitar convite enquanto gerava: a resposta é descartada', async () => {
    const pending = deferred<{ data: unknown; error: null }>();
    const { c } = setup({ rpc: (() => pending.promise) as unknown as InviteShareDeps['rpc'] });
    const inFlight = c.open(ROOM);
    c.syncRooms([room({ member_count: 2 })]);
    pending.resolve({ data: [{ token: TOKEN }], error: null });
    await inFlight;
    expect(c.state).toMatchObject({ roomId: null, link: null, busy: false });
  });
});

describe('dono: revogar', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-11-05T12:00:00Z') }));
  afterEach(() => vi.useRealTimers());

  type Answer = { data: unknown; error: string | null };
  function setup(revokeAnswer: () => Promise<Answer> = async () => ({ data: 1, error: null }), confirmed = true) {
    const confirm = vi.fn((_message: string) => confirmed);
    const onRevoked = vi.fn();
    const tokens = [TOKEN, OTHER, 'C'.repeat(43)];
    const rpc = vi.fn((fn: string, _args: Record<string, unknown>) => (fn === 'revoke_room_invite' ? revokeAnswer() : Promise.resolve<Answer>({ data: [{ token: tokens.shift() }], error: null })));
    const c = new InviteShareController({
      rpc: rpc as unknown as InviteShareDeps['rpc'],
      link: (t) => buildInviteLink(LOC, t),
      copy: async () => undefined,
      share: async () => true,
      confirm,
      onRevoked,
      onChange: () => undefined,
    });
    const revokes = () => rpc.mock.calls.filter(([fn]) => fn === 'revoke_room_invite');
    return { c, rpc, confirm, onRevoked, revokes };
  }

  it('a confirmação diz que TODOS os pendentes daquela sala serão invalidados', async () => {
    const { c, confirm } = setup();
    await c.revoke(ROOM, 'Minha sala');
    expect(confirm).toHaveBeenCalledTimes(1);
    const text = confirm.mock.calls[0]![0];
    expect(text).toBe(revokeConfirmation('Minha sala'));
    expect(text).toMatch(/TODOS os convites pendentes da sala "Minha sala"/);
    expect(text).toMatch(/outras salas não são afetadas/);
  });

  it('cancelar: nenhuma chamada, e painel e convite ficam como estavam', async () => {
    const { c, revokes, onRevoked } = setup(undefined, false);
    await c.open(ROOM);
    const before = c.state;
    await c.revoke(ROOM, 'Sala');
    expect(revokes()).toEqual([]);
    expect(c.state).toBe(before);
    expect(onRevoked).not.toHaveBeenCalled();
    expect(c.state.link).toContain(TOKEN);
  });

  it('confirmar: chama só com o id da sala, descarta o link local e recarrega a lista', async () => {
    const { c, rpc, revokes, onRevoked } = setup(async () => ({ data: 2, error: null }));
    await c.open(ROOM);
    await c.revoke(ROOM, 'Sala');
    expect(revokes()).toEqual([['revoke_room_invite', { p_room_id: ROOM }]]);
    expect(c.state).toMatchObject({ roomId: ROOM, link: null, expiresAt: null, busy: false, revoking: false, message: { tone: 'info', text: revokeDone(2) } });
    expect(onRevoked).toHaveBeenCalledTimes(1);
    await c.open(ROOM); // o link revogado não volta: "Convidar" gera outro
    expect(c.state.link).toContain(OTHER);
    expect(rpc.mock.calls.filter(([fn]) => fn === 'create_room_invite')).toHaveLength(2);
  });

  it('isolamento local: o convite em memória de outra sala continua igual e no mesmo prazo', async () => {
    const { c, rpc } = setup();
    await c.open(ROOM);
    await c.open(ROOM2);
    const { link: other, expiresAt } = c.state;
    await c.revoke(ROOM, 'Sala');
    await c.open(ROOM2);
    expect(c.state.link).toBe(other);
    expect(c.state.expiresAt).toBe(expiresAt);
    expect(rpc.mock.calls.filter(([fn]) => fn === 'create_room_invite')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(c.state).toMatchObject({ roomId: ROOM2, expired: true });
  });

  it('depois de revogar, o prazo do convite descartado não dispara aviso de expiração', async () => {
    const { c } = setup();
    await c.open(ROOM);
    await c.revoke(ROOM, 'Sala');
    const after = c.state;
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(c.state).toBe(after);
  });

  it('não autorizado: mensagem fixa, e o link local continua à vista', async () => {
    const { c, onRevoked } = setup(async () => ({ data: null, error: 'unauthorized' }));
    await c.open(ROOM);
    await c.revoke(ROOM, 'Sala');
    expect(c.state).toMatchObject({ roomId: ROOM, busy: false, message: { tone: 'error', text: REVOKE_ERRORS['unauthorized'] } });
    expect(c.state.link).toContain(TOKEN);
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('falhas: sem texto técnico, sem token na mensagem, e dá para repetir', async () => {
    const answers: (() => Promise<Answer>)[] = [
      () => Promise.reject(new Error(`rede ${TOKEN}`)),
      async () => ({ data: null, error: `detalhe interno: tabela oryn.room_invites ${TOKEN}` }),
      async () => ({ data: 'dois', error: null }),
      async () => ({ data: null, error: null }),
    ];
    for (const answer of answers) {
      const { c, onRevoked } = setup(answer);
      await c.open(ROOM);
      await c.revoke(ROOM, 'Sala');
      expect(c.state.message).toEqual({ tone: 'error', text: REVOKE_FAILED });
      expect(c.state.message?.text).not.toContain(TOKEN);
      expect(c.state.busy).toBe(false);
      expect(onRevoked).not.toHaveBeenCalled();
    }
    const retry = [() => Promise.reject(new Error('rede')), async () => ({ data: 1, error: null })];
    const { c } = setup(() => retry.shift()!());
    await c.open(ROOM);
    await c.revoke(ROOM, 'Sala');
    await c.revoke(ROOM, 'Sala');
    expect(c.state).toMatchObject({ link: null, message: { tone: 'info', text: revokeDone(1) } });
  });

  it('duplo clique: uma confirmação e uma chamada; em curso, o painel diz que está revogando', async () => {
    const pending = deferred<Answer>();
    const { c, confirm, revokes } = setup(() => pending.promise);
    const first = c.revoke(ROOM, 'Sala');
    await c.revoke(ROOM, 'Sala');
    await c.open(ROOM);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(revokes()).toHaveLength(1);
    expect(c.state).toMatchObject({ roomId: ROOM, busy: true, revoking: true });
    pending.resolve({ data: 0, error: null });
    await first;
    expect(c.state.revoking).toBe(false);
  });

  it('logout no meio: a resposta é descartada e a lista não é recarregada', async () => {
    const pending = deferred<Answer>();
    const { c, onRevoked } = setup(() => pending.promise);
    const first = c.revoke(ROOM, 'Sala');
    c.reset();
    pending.resolve({ data: 1, error: null });
    await first;
    expect(c.state).toMatchObject({ roomId: null, message: null, busy: false });
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('nome de sala hostil na confirmação é só texto, e a mensagem de sucesso não leva dado do servidor', () => {
    const evil = '<img src=x onerror=alert(1)>';
    expect(revokeConfirmation(evil)).toContain(evil); // window.confirm não interpreta HTML
    expect(revokeDone(0)).toBe('Não havia convites pendentes nesta sala.');
    expect(revokeDone(3)).toMatch(/^Convites pendentes revogados: 3\./);
  });
});

describe('convidado: aceitar', () => {
  function setup(answer: () => Promise<unknown> = async () => ({ data: ROOM, error: null })) {
    const states: unknown[] = [];
    const rpc = vi.fn(answer);
    const onMember = vi.fn();
    const c = new InviteAcceptController({
      rpc: rpc as unknown as InviteAcceptDeps['rpc'],
      onMember,
      onChange: (s) => states.push(s),
    });
    c.receive({ kind: 'token', token: TOKEN });
    return { c, rpc, onMember, states };
  }

  it('receber o link não resgata: só o clique', async () => {
    const { c, rpc } = setup();
    expect(c.state).toEqual({ status: 'pending', busy: false, message: null });
    expect(rpc).not.toHaveBeenCalled();
    await c.accept(' Convidada ');
    expect(rpc).toHaveBeenCalledWith('redeem_room_invite', { p_token: TOKEN, p_display_name: 'Convidada' });
  });

  it('sucesso: recarrega a lista, avisa e não guarda mais o token', async () => {
    const { c, rpc, onMember } = setup();
    await c.accept('Convidada');
    expect(c.state).toEqual({ status: 'result', tone: 'info', text: INVITE_ACCEPTED });
    expect(onMember).toHaveBeenCalledTimes(1);
    await c.accept('Convidada');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('duplo clique: uma chamada só', async () => {
    const pending = deferred<unknown>();
    const { c, rpc } = setup(() => pending.promise);
    const first = c.accept('A');
    await c.accept('A');
    expect(rpc).toHaveBeenCalledTimes(1);
    pending.resolve({ data: ROOM, error: null });
    await first;
  });

  it('nome inválido nem chega ao servidor; a correção continua possível', async () => {
    const { c, rpc } = setup();
    for (const bad of ['', '   ', 'a'.repeat(33), 'a\u0007b']) {
      await c.accept(bad);
      expect(c.state, bad).toEqual({ status: 'pending', busy: false, message: INVITE_BAD_NAME });
    }
    expect(rpc).not.toHaveBeenCalled();
    await c.accept('Certo');
    expect(c.state).toMatchObject({ status: 'result', tone: 'info' });
  });

  it.each([
    ['invite-invalid', INVITE_INVALID],
    ['room-full', INVITE_ROOM_FULL],
  ])('%s encerra o convite nesta aba', async (error, text) => {
    const { c, rpc, onMember } = setup(async () => ({ data: null, error }));
    await c.accept('A');
    expect(c.state).toEqual({ status: 'result', tone: 'error', text });
    expect(onMember).not.toHaveBeenCalled();
    await c.accept('A');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('já membro: avisa e recarrega a lista, como quem repete depois de perder a resposta', async () => {
    const { c, onMember } = setup(async () => ({ data: null, error: 'already-member' }));
    await c.accept('A');
    expect(c.state).toEqual({ status: 'result', tone: 'info', text: INVITE_ALREADY_MEMBER });
    expect(onMember).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['invalid-argument', INVITE_BAD_NAME],
    ['unauthorized', INVITE_SESSION],
    ['detalhe interno do servidor', INVITE_FAILED],
  ])('%s mantém o convite para tentar de novo', async (error, message) => {
    const answers = [{ data: null, error }, { data: ROOM, error: null }];
    const { c } = setup(async () => answers.shift());
    await c.accept('A');
    expect(c.state).toEqual({ status: 'pending', busy: false, message });
    await c.accept('A');
    expect(c.state).toEqual({ status: 'result', tone: 'info', text: INVITE_ACCEPTED });
  });

  it('falha de rede e resposta fora do contrato mantêm o convite', async () => {
    for (const answer of [() => Promise.reject(new Error('rede')), async () => ({ data: 'nao-uuid', error: null })]) {
      const { c } = setup(answer);
      await c.accept('A');
      expect(c.state).toEqual({ status: 'pending', busy: false, message: INVITE_FAILED });
    }
  });

  it('link fora do formato: mensagem sem chamar o servidor, e ela não substitui por convite antigo', async () => {
    const { c, rpc } = setup();
    c.receive({ kind: 'invalid' });
    expect(c.state).toEqual({ status: 'result', tone: 'error', text: BAD_LINK });
    await c.accept('A');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('recusar descarta o convite, e fechar a mensagem volta ao estado inicial', async () => {
    const { c, rpc } = setup();
    c.decline();
    expect(c.state).toEqual({ status: 'none' });
    await c.accept('A');
    expect(rpc).not.toHaveBeenCalled();
    const other = setup();
    await other.c.accept('A');
    other.c.dismiss();
    expect(other.c.state).toEqual({ status: 'none' });
  });

  it('troca de conta: o convite fica, e a resposta da conta anterior é descartada', async () => {
    const pending = deferred<unknown>();
    const answers: (() => Promise<unknown>)[] = [() => pending.promise, async () => ({ data: ROOM, error: null })];
    const { c, rpc, onMember } = setup(() => answers.shift()!());
    const first = c.accept('Conta errada');
    c.accountChanged();
    expect(c.state).toEqual({ status: 'pending', busy: false, message: null });
    pending.resolve({ data: ROOM, error: null });
    await first;
    expect(c.state.status).toBe('pending');
    expect(onMember).not.toHaveBeenCalled();
    await c.accept('Conta certa');
    expect(rpc).toHaveBeenLastCalledWith('redeem_room_invite', { p_token: TOKEN, p_display_name: 'Conta certa' });
    expect(c.state.status).toBe('result');
  });

  it('um novo link substitui o anterior', async () => {
    const { c, rpc } = setup();
    c.receive({ kind: 'token', token: OTHER });
    await c.accept('A');
    expect(rpc).toHaveBeenCalledWith('redeem_room_invite', { p_token: OTHER, p_display_name: 'A' });
  });

  it('tela de login: orienta a usar uma conta existente, e nunca mostra o token', () => {
    const { c, states } = setup();
    expect(inviteLoginHint(c.state)).toMatch(/conta existente/);
    expect(inviteLoginHint({ status: 'none' })).toBeNull();
    expect(inviteLoginHint({ status: 'result', tone: 'error', text: BAD_LINK })).toBe(BAD_LINK);
    expect(JSON.stringify(states)).not.toContain(TOKEN);
    expect(JSON.stringify(c.state)).not.toContain(TOKEN);
  });
});

describe('estático: sigilo do token e regras da página', () => {
  const invites = code(read('src/web/invites.ts'));
  const main = code(read('src/web/main.ts'));

  it('invites.ts não usa armazenamento nem console, e não usa HTML', () => {
    expect(invites).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|console\.|innerHTML|fetch\(/);
  });

  it('o convite sai da URL antes de a página fazer qualquer outra coisa', () => {
    expect(main.indexOf('const arrivedInvite = takeInvite()')).toBeGreaterThan(-1);
    expect(main.indexOf('const arrivedInvite = takeInvite()')).toBeLessThan(main.indexOf('createClient(cfg'));
    expect(main.indexOf('const arrivedInvite = takeInvite()')).toBeLessThan(main.indexOf('const ui = {'));
    expect(main).toMatch(/addEventListener\('hashchange'/);
  });

  it('a página não registra o link nem o estado do convite', () => {
    for (const line of main.split('\n').filter((l) => /\blog\(|showNotice\(|showError\(/.test(l) && !l.includes('TOKEN_REFRESHED'))) {
      expect(line).not.toMatch(/invite|link|token/i);
    }
    expect(main).not.toMatch(/console\./);
  });

  it('a revogação passa pela confirmação da página e pela RPC existente, sem acesso a tabela', () => {
    expect(main).toMatch(/confirm: \(message\) => window\.confirm\(message\)/);
    expect(invites.match(/'revoke_room_invite'/g)).toHaveLength(1);
    expect(invites).toMatch(/if \(!this\.deps\.confirm\(revokeConfirmation\(roomName\)\)\) return;[\s\S]{0,160}revoke_room_invite/);
    expect(invites).not.toMatch(/\.from\(/);
  });

  it('o resgate depende do formulário "Aceitar convite", e a sessão do Auth não lê a URL', () => {
    expect(read('index.html')).toMatch(/id="invite-accept-btn" type="submit">Aceitar convite</);
    expect(main.match(/inviteAccept\.accept\(/g)).toHaveLength(1);
    expect(main).toMatch(/inviteAcceptForm\.addEventListener\('submit'[\s\S]{0,120}inviteAccept\.accept\(/);
    expect(code(read('src/web/auth-session.ts'))).toMatch(/detectSessionInUrl: false/);
  });

  it('aceitar não inicia chamada nem pede microfone', () => {
    expect(invites).not.toMatch(/getUserMedia|startCall|PeerCall/);
    expect(main).toMatch(/onMember: \(\) => void lobby\.refresh\(\)/);
  });

  it('o fragmento não é enviado por Referer: a política da hospedagem continua no-referrer', () => {
    expect(read('vercel.json')).toMatch(/"Referrer-Policy", "value": "no-referrer"/);
  });
});

describe('fluxo completo contra o SQL real', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await TestDb.create();
  });
  afterEach(() => db.close());

  /** O formato do cliente: erro como mensagem curta do banco, dado como o PostgREST devolveria. */
  const rpcOk = (actor: { uid: string }) => (async (fn: string, args: Record<string, unknown>) => {
    try {
      const rows = await db.rpc<Record<string, unknown>>(actor, `public.${fn}`, args);
      const single = rows.length === 1 && Object.keys(rows[0]!).length === 1 ? rows[0]![fn] : undefined;
      return { data: single === undefined ? rows : single, error: null };
    } catch (e) {
      return { data: null, error: (e as Error).message };
    }
  }) as unknown as InviteShareDeps['rpc'];

  const dono = (actor: { uid: string }) => {
    const tokens: string[] = [];
    const c = new InviteShareController({
      rpc: rpcOk(actor),
      link: (t) => {
        tokens.push(t);
        return buildInviteLink(LOC, t);
      },
      copy: async () => undefined,
      share: async () => true,
      confirm: () => true,
      onRevoked: () => undefined,
      onChange: () => undefined,
    });
    return { c, tokens };
  };
  const convidado = (actor: { uid: string }, token: string) => {
    const onMember = vi.fn();
    const c = new InviteAcceptController({ rpc: rpcOk(actor), onMember, onChange: () => undefined });
    c.receive({ kind: 'token', token });
    return { c, onMember };
  };
  const pending = async (room: string) =>
    (await db.admin<{ n: number }>(`select count(*)::int as n from oryn.room_invites where room_id = $1 and used_at is null and revoked_at is null and expires_at > now()`, [room]))[0]!.n;
  const myRooms = async (actor: { uid: string }) => db.rpc<{ room_id: string; role: string; member_count: number }>(actor, 'public.list_my_rooms');

  it('dono gera, membro aceita, a sala aparece e a entrada funciona; o mesmo link não serve a mais ninguém', async () => {
    const owner = await makeCreator(db);
    const room = await createRoom(db, owner, 2);
    const member = await db.newUser();
    expect(await myRooms(member)).toEqual([]);
    expect(await db.rpcError(member, 'public.join_room', { p_room_id: room })).toBe('not-member');

    const d = dono(owner);
    await d.c.open(room);
    const token = d.tokens[0]!;
    expect(d.c.state.link).toContain(token);
    expect((await db.admin<{ n: number }>(`select count(*)::int as n from oryn.room_invites where token_hash = convert_to($1, 'UTF8')`, [token]))[0]!.n).toBe(0); // só o hash fica no banco

    const m = convidado(member, token);
    await m.c.accept('Convidada');
    expect(m.c.state).toEqual({ status: 'result', tone: 'info', text: INVITE_ACCEPTED });
    expect(m.onMember).toHaveBeenCalled();
    const rows = await myRooms(member);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ room_id: room, role: 'member', member_count: 2 });
    expect(await openSession(db, member, room)).toMatch(/^[0-9a-f-]{36}$/);

    const third = convidado(await db.newUser(), token);
    await third.c.accept('Outro');
    expect(third.c.state).toEqual({ status: 'result', tone: 'error', text: INVITE_INVALID });
  });

  it('reabrir o painel não gasta os 3 convites pendentes; o limite do banco aparece como mensagem', async () => {
    const owner = await makeCreator(db);
    const room = await createRoom(db, owner, 2);
    const d = dono(owner);
    for (let i = 0; i < 5; i++) {
      await d.c.open(room);
      d.c.close();
    }
    expect(await pending(room)).toBe(1);

    // Recarregar a página perde o link, mas os convites anteriores continuam pendentes até expirar.
    for (let i = 0; i < 2; i++) await dono(owner).c.open(room);
    expect(await pending(room)).toBe(3);
    const reloaded = dono(owner);
    await reloaded.c.open(room);
    expect(reloaded.c.state.message?.text).toBe(CREATE_INVITE_ERRORS['limit-reached']);
    expect(await pending(room)).toBe(3);
  });

  it('expirado, revogado e sala encerrada recebem a mesma mensagem', async () => {
    const owner = await makeCreator(db);
    const room = await createRoom(db, owner, 2);
    const emit = async () => {
      const d = dono(owner);
      await d.c.open(room);
      return d.tokens[0]!;
    };
    const expired = await emit();
    await db.admin(`update oryn.room_invites set created_at = now() - interval '1 hour', expires_at = now() - interval '1 second'`);
    const revoked = await emit();
    await db.rpc(owner, 'public.revoke_room_invite', { p_room_id: room });
    const closed = await emit();
    await db.rpc(owner, 'public.close_room', { p_room_id: room });
    for (const token of [expired, revoked, closed, TOKEN]) {
      const m = convidado(await db.newUser(), token);
      await m.c.accept('A');
      expect(m.c.state, token).toEqual({ status: 'result', tone: 'error', text: INVITE_INVALID });
    }
  });

  it('o dono abre o próprio link: "já participa", sem consumir o convite', async () => {
    const owner = await makeCreator(db);
    const room = await createRoom(db, owner, 2);
    const d = dono(owner);
    await d.c.open(room);
    const self = convidado(owner, d.tokens[0]!);
    await self.c.accept('Dono');
    expect(self.c.state).toEqual({ status: 'result', tone: 'info', text: INVITE_ALREADY_MEMBER });
    const m = convidado(await db.newUser(), d.tokens[0]!);
    await m.c.accept('Membro');
    expect(m.c.state).toMatchObject({ status: 'result', tone: 'info', text: INVITE_ACCEPTED });
  });

  it('limite de participantes: o segundo convite pendente não passa do limite e não é consumido', async () => {
    const owner = await makeCreator(db);
    const room = await createRoom(db, owner, 2);
    const a = dono(owner);
    await a.c.open(room);
    const b = dono(owner);
    await b.c.open(room);
    await convidado(await db.newUser(), a.tokens[0]!).c.accept('A');
    const late = convidado(await db.newUser(), b.tokens[0]!);
    await late.c.accept('B');
    expect(late.c.state).toEqual({ status: 'result', tone: 'error', text: INVITE_ROOM_FULL });
    expect(await pending(room)).toBe(1);
    const full = dono(owner);
    await full.c.open(room);
    expect(full.c.state.message?.text).toBe(CREATE_INVITE_ERRORS['room-full']);
  });

  it('quem não é dono não gera convite', async () => {
    const owner = await makeCreator(db);
    const room = await createRoom(db, owner, 2);
    const stranger = dono(await db.newUser());
    await stranger.c.open(room);
    expect(stranger.c.state.message?.text).toBe(CREATE_INVITE_ERRORS['unauthorized']);
  });

  it('revogar: invalida todos os pendentes da sala, inclusive os de antes de recarregar, e nenhum de outra sala', async () => {
    const owner = await makeCreator(db);
    const roomA = await createRoom(db, owner, 2, 'A');
    const roomB = await createRoom(db, owner, 2, 'B');
    const antes = dono(owner); // outra "carga da página": este link já se perdeu para quem revoga
    await antes.c.open(roomA);
    const a = dono(owner);
    await a.c.open(roomA);
    const b = dono(owner);
    await b.c.open(roomB);

    await a.c.revoke(roomA, 'A');
    expect(a.c.state).toMatchObject({ roomId: roomA, link: null, message: { tone: 'info', text: revokeDone(2) } });
    expect(await pending(roomA)).toBe(0);
    expect(await pending(roomB)).toBe(1);

    for (const token of [antes.tokens[0]!, a.tokens[0]!]) {
      const m = convidado(await db.newUser(), token);
      await m.c.accept('Membro');
      expect(m.c.state).toEqual({ status: 'result', tone: 'error', text: INVITE_INVALID });
    }
    const m = convidado(await db.newUser(), b.tokens[0]!);
    await m.c.accept('Membro');
    expect(m.c.state).toMatchObject({ status: 'result', tone: 'info', text: INVITE_ACCEPTED });
  });

  it('revogar: membro e estranho são recusados pelo servidor e nada é cancelado', async () => {
    const owner = await makeCreator(db);
    const room = await createRoom(db, owner, 3);
    const first = dono(owner);
    await first.c.open(room);
    const memberActor = await db.newUser();
    await convidado(memberActor, first.tokens[0]!).c.accept('Membro');
    const pendente = dono(owner);
    await pendente.c.open(room);
    for (const actor of [memberActor, await db.newUser()]) {
      const c = dono(actor);
      await c.c.revoke(room, 'Partida');
      expect(c.c.state.message).toEqual({ tone: 'error', text: REVOKE_ERRORS['unauthorized'] });
    }
    expect(await pending(room)).toBe(1);
  });

  it('revogar sem pendentes: avisa que não havia, sem erro; o limite de 3 volta a ter folga', async () => {
    const owner = await makeCreator(db);
    const room = await createRoom(db, owner, 2);
    const vazio = dono(owner);
    await vazio.c.revoke(room, 'Partida');
    expect(vazio.c.state.message).toEqual({ tone: 'info', text: revokeDone(0) });
    for (let i = 0; i < 3; i++) await dono(owner).c.open(room);
    const cheio = dono(owner);
    await cheio.c.open(room);
    expect(cheio.c.state.message?.text).toBe(CREATE_INVITE_ERRORS['limit-reached']);
    await cheio.c.revoke(room, 'Partida');
    await cheio.c.open(room);
    expect(cheio.c.state.link).toContain(cheio.tokens[0]!);
    expect(await pending(room)).toBe(1);
  });
});
