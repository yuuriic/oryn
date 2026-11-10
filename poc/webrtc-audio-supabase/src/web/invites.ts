// Convites de sala (MVP 02): o dono gera um link, e quem o recebe aceita com a conta que estiver usando. Sem DOM: o
// estado e as regras ficam aqui, e a página (main.ts) só mostra. Autorização, uso único, validade e limites continuam
// no banco, nas RPCs create_room_invite, redeem_room_invite e revoke_room_invite.
//
// Sigilo do token: ele chega no fragmento da URL, que o navegador não envia ao servidor, e sai da barra de endereço
// assim que a página carrega. Depois disso fica só em memória, nesta aba: nada de armazenamento, registro em tela ou
// mensagem. F5 antes de aceitar perde o token, e basta abrir o link de novo.
// Limite: o histórico do navegador grava a URL completa antes de esta página rodar, e ela não consegue apagar esse
// registro. O que protege ali é o uso único e a validade curta. Risco aceito para o teste fechado: runbook §14.9.
//
// Mensagens: só textos fixos por código curto. Nada do servidor é repassado à tela.

import { isUuid } from '../../supabase/functions/_shared/signal-contract.ts';
import { isDisplayName, isInviteToken, type RoomSummary } from '../contracts.ts';
import { shortCode, type RpcResult } from './supabase-signaling.ts';

export const INVITE_TTL_MINUTES = 15;
const FRAGMENT_PREFIX = '#convite=';

type Rpc = <T>(fn: string, args: Record<string, unknown>) => Promise<RpcResult<T>>;

// ---------- link ----------

export type InviteArrival = { kind: 'none' } | { kind: 'invalid' } | { kind: 'token'; token: string };

export function parseInviteFragment(hash: string): InviteArrival {
  if (!hash.startsWith(FRAGMENT_PREFIX)) return { kind: 'none' };
  const token = hash.slice(FRAGMENT_PREFIX.length);
  return isInviteToken(token) ? { kind: 'token', token } : { kind: 'invalid' };
}

/** Lê o convite da URL e o apaga dela. Um fragmento que não é de convite fica como está. */
export function takeInviteFromLocation(location: { hash: string; pathname: string; search: string }, replaceUrl: (url: string) => void): InviteArrival {
  const arrival = parseInviteFragment(location.hash);
  if (arrival.kind !== 'none') replaceUrl(`${location.pathname}${location.search}`);
  return arrival;
}

/** A origem é a da própria página, e a query fica de fora: o link serve só para esta publicação e não leva mais nada. */
export function buildInviteLink(location: { origin: string; pathname: string }, token: string): string {
  return `${location.origin}${location.pathname}${FRAGMENT_PREFIX}${token}`;
}

// ---------- dono: gerar e compartilhar ----------

export const CREATE_INVITE_ERRORS: Record<string, string> = {
  unauthorized: 'Só o dono de uma sala aberta pode convidar.',
  'room-full': 'Esta sala já está completa. Atualize a lista.',
  'limit-reached': 'Já há 3 convites pendentes nesta sala. Aguarde um deles expirar ou revogue os pendentes.',
};
export const CREATE_INVITE_FAILED = 'Não foi possível gerar o convite (falha de rede ou do servidor). Tente de novo.';
export const INVITE_EXPIRED = 'Este convite expirou.';
export const LINK_COPIED = 'Link copiado.';
export const COPY_FAILED = 'Não foi possível copiar automaticamente: selecione o link acima e copie.';
export const SHARE_FAILED = 'Não foi possível abrir o compartilhamento: use "Copiar link".';
export const REVOKE_ERRORS: Record<string, string> = {
  unauthorized: 'Só o dono desta sala pode revogar convites.',
};
export const REVOKE_FAILED = 'Não foi possível revogar os convites (falha de rede ou do servidor). Tente de novo.';

/** A RPC não identifica um convite: ela cancela todos os pendentes da sala, inclusive links gerados antes de recarregar. */
export const revokeConfirmation = (roomName: string): string =>
  `Revogar TODOS os convites pendentes da sala "${roomName}"? Todos os links desta sala ainda não usados deixam de funcionar, inclusive os gerados antes. Quem já entrou continua na sala, e outras salas não são afetadas.`;

export const revokeDone = (count: number): string =>
  count === 0 ? 'Não havia convites pendentes nesta sala.' : `Convites pendentes revogados: ${count}. Os links anteriores não funcionam mais.`;

export interface InviteShareState {
  /** Sala do painel aberto; null = painel fechado. */
  roomId: string | null;
  link: string | null;
  expiresAt: number | null;
  /** O convite desta sala venceu com o painel aberto: gerar outro depende de um clique. */
  expired: boolean;
  busy: boolean;
  /** A operação em curso é a revogação (a tela diferencia de "gerando"). */
  revoking: boolean;
  message: { tone: 'info' | 'error'; text: string } | null;
}

export interface InviteShareDeps {
  rpc: Rpc;
  link(token: string): string;
  copy(link: string): Promise<void>;
  /** Abre o compartilhamento do aparelho. `false` = a pessoa desistiu, o que não é erro. */
  share(link: string): Promise<boolean>;
  /** Confirmação explícita da pessoa (window.confirm na página). */
  confirm(message: string): boolean;
  /** Convites revogados: a página recarrega a lista. */
  onRevoked(): void;
  onChange(state: InviteShareState): void;
}

const CLOSED: InviteShareState = { roomId: null, link: null, expiresAt: null, expired: false, busy: false, revoking: false, message: null };

const firstToken = (data: unknown): string | null => {
  const row: unknown = Array.isArray(data) ? data[0] : data;
  const token = typeof row === 'object' && row !== null ? (row as Record<string, unknown>)['token'] : null;
  return isInviteToken(token) ? token : null;
};

export class InviteShareController {
  private s: InviteShareState = CLOSED;
  /** Muda a cada reset (logout): uma resposta da sessão anterior não mexe em nada. */
  private epoch = 0;
  /** Convites gerados nesta página e ainda válidos. Fechar o painel não os descarta. */
  private readonly invites = new Map<string, { link: string; expiresAt: number; timer: ReturnType<typeof setTimeout> }>();
  private readonly deps: InviteShareDeps;

  constructor(deps: InviteShareDeps) {
    this.deps = deps;
  }

  get state(): InviteShareState {
    return this.s;
  }

  private set(next: InviteShareState): void {
    this.s = next;
    this.deps.onChange(next);
  }

  /** "Convidar": mostra o convite válido desta sala; só gera outro se não houver nenhum em memória. */
  async open(roomId: string): Promise<void> {
    if (this.s.busy) return;
    const known = this.invites.get(roomId);
    if (known) return this.set({ ...CLOSED, roomId, link: known.link, expiresAt: known.expiresAt });
    const epoch = this.epoch;
    this.set({ ...CLOSED, roomId, busy: true });
    const res = await this.deps
      .rpc<unknown>('create_room_invite', { p_room_id: roomId, p_ttl_minutes: INVITE_TTL_MINUTES })
      .catch(() => ({ data: null, error: 'erro' }));
    if (epoch !== this.epoch) return;
    const token = res.error ? null : firstToken(res.data);
    if (!token) {
      const text = CREATE_INVITE_ERRORS[shortCode(res.error)] ?? CREATE_INVITE_FAILED;
      return this.set({ ...CLOSED, roomId, message: { tone: 'error', text } });
    }
    // Validade pelo relógio local, a partir da resposta: um relógio adiantado não faz o convite "vencer" na hora.
    // Quem decide de verdade é o servidor, no resgate.
    const expiresAt = Date.now() + INVITE_TTL_MINUTES * 60_000;
    const link = this.deps.link(token);
    const timer = setTimeout(() => this.expire(roomId), expiresAt - Date.now());
    this.invites.set(roomId, { link, expiresAt, timer });
    this.set({ ...CLOSED, roomId, link, expiresAt });
  }

  /** Fecha o painel e mantém o convite: reabrir mostra o mesmo link. */
  close(): void {
    if (!this.s.busy) this.set(CLOSED);
  }

  async copy(): Promise<void> {
    const { link } = this.s;
    if (!link) return;
    const ok = await this.deps.copy(link).then(() => true, () => false);
    if (this.s.link !== link) return;
    this.set({ ...this.s, message: ok ? { tone: 'info', text: LINK_COPIED } : { tone: 'error', text: COPY_FAILED } });
  }

  async share(): Promise<void> {
    const { link } = this.s;
    if (!link) return;
    const shared = await this.deps.share(link).then((done) => (done ? 'ok' : 'cancelled'), () => 'failed');
    if (this.s.link !== link || shared !== 'failed') return;
    this.set({ ...this.s, message: { tone: 'error', text: SHARE_FAILED } });
  }

  /**
   * Revoga todos os convites pendentes DESTA sala, depois de confirmar. O dono é conferido no servidor. Em caso de falha
   * o convite local continua à vista, porque nada garante que deixou de valer; repetir não causa dano.
   */
  async revoke(roomId: string, roomName: string): Promise<void> {
    if (this.s.busy) return;
    if (!this.deps.confirm(revokeConfirmation(roomName))) return;
    const epoch = this.epoch;
    this.set({ ...CLOSED, roomId, busy: true, revoking: true });
    const res = await this.deps.rpc<unknown>('revoke_room_invite', { p_room_id: roomId }).catch(() => ({ data: null, error: 'erro' }));
    if (epoch !== this.epoch) return;
    if (res.error || !Number.isInteger(res.data)) {
      const known = this.invites.get(roomId);
      const text = REVOKE_ERRORS[shortCode(res.error)] ?? REVOKE_FAILED;
      return this.set({ ...CLOSED, roomId, link: known?.link ?? null, expiresAt: known?.expiresAt ?? null, message: { tone: 'error', text } });
    }
    this.drop(roomId);
    this.set({ ...CLOSED, roomId, message: { tone: 'info', text: revokeDone(res.data as number) } });
    this.deps.onRevoked();
  }

  private drop(roomId: string): void {
    const known = this.invites.get(roomId);
    if (known) clearTimeout(known.timer);
    this.invites.delete(roomId);
  }

  /** Sala encerrada: os convites dela não valem mais. */
  forget(roomId: string): void {
    this.drop(roomId);
    if (this.s.roomId !== roomId) return;
    if (this.s.busy) this.epoch += 1; // a resposta em curso é de uma sala que não aceita mais convites
    this.set(CLOSED);
  }

  /** Lista atualizada: sala encerrada ou completa não tem mais o que convidar. */
  syncRooms(rooms: readonly RoomSummary[]): void {
    const usable = (id: string) => rooms.some((r) => r.room_id === id && r.is_open && r.role === 'owner' && r.member_count < r.max_members);
    for (const id of [...this.invites.keys()]) if (!usable(id)) this.forget(id);
    if (this.s.roomId !== null && !usable(this.s.roomId)) this.forget(this.s.roomId);
  }

  /** Logout. Respostas em curso são descartadas. */
  reset(): void {
    this.epoch += 1;
    for (const known of this.invites.values()) clearTimeout(known.timer);
    this.invites.clear();
    this.set(CLOSED);
  }

  private expire(roomId: string): void {
    this.invites.delete(roomId);
    if (this.s.roomId === roomId && this.s.link) this.set({ ...CLOSED, roomId, expired: true, message: { tone: 'info', text: INVITE_EXPIRED } });
  }
}

// ---------- convidado: aceitar ----------

export const BAD_LINK = 'Este link de convite não é válido.';
export const INVITE_INVALID = 'Convite inválido, expirado, já utilizado ou revogado. Peça um novo ao dono da sala.';
export const INVITE_ALREADY_MEMBER = 'Esta conta já participa desta sala. Ela está em "Minhas salas".';
export const INVITE_ROOM_FULL = 'Esta sala já está completa.';
export const INVITE_BAD_NAME = 'Seu nome de exibição: de 1 a 32 caracteres, sem caracteres de controle. Ajuste no Perfil; o convite continua nesta aba.';
export const INVITE_SESSION = 'Não foi possível confirmar seu login. Entre de novo; o convite continua nesta aba.';
export const INVITE_FAILED = 'Não foi possível concluir (falha de rede ou do servidor). Tente de novo.';
export const INVITE_ACCEPTED = 'Convite aceito. A sala está em "Minhas salas". O microfone só é ativado quando você clicar em "Entrar na chamada".';

export type InviteAcceptState =
  | { status: 'none' }
  | { status: 'pending'; busy: boolean; message: string | null }
  | { status: 'result'; tone: 'info' | 'error'; text: string };

export interface InviteAcceptDeps {
  rpc: Rpc;
  /** A conta passou a participar da sala: a página recarrega a lista. */
  onMember(): void;
  onChange(state: InviteAcceptState): void;
}

/** Texto da tela de login. Cadastro está fora desta etapa: só uma conta existente aceita o convite. */
export function inviteLoginHint(state: InviteAcceptState): string | null {
  if (state.status === 'pending') return 'Você recebeu um convite para uma sala. Entre com uma conta existente para aceitá-lo.';
  return state.status === 'result' ? state.text : null;
}

export class InviteAcceptController {
  private s: InviteAcceptState = { status: 'none' };
  /** Fora do estado de propósito: o que a tela recebe nunca contém o token. */
  private token: string | null = null;
  /** Muda ao receber outro convite, recusar e trocar de conta: a resposta anterior deixa de valer. */
  private epoch = 0;
  private readonly deps: InviteAcceptDeps;

  constructor(deps: InviteAcceptDeps) {
    this.deps = deps;
  }

  get state(): InviteAcceptState {
    return this.s;
  }

  private set(next: InviteAcceptState): void {
    this.s = next;
    this.deps.onChange(next);
  }

  private finish(tone: 'info' | 'error', text: string): void {
    this.token = null;
    this.set({ status: 'result', tone, text });
  }

  receive(arrival: InviteArrival): void {
    if (arrival.kind === 'none') return;
    this.epoch += 1;
    if (arrival.kind === 'invalid') return this.finish('error', BAD_LINK);
    this.token = arrival.token;
    this.set({ status: 'pending', busy: false, message: null });
  }

  /** Só o clique em "Aceitar convite" chega aqui. O uso único é do servidor; o bloqueio local evita o duplo clique. */
  async accept(displayName: string): Promise<void> {
    if (this.s.status !== 'pending' || this.s.busy || !this.token) return;
    const name = displayName.trim();
    if (!isDisplayName(name)) return this.set({ status: 'pending', busy: false, message: INVITE_BAD_NAME });
    const epoch = ++this.epoch;
    this.set({ status: 'pending', busy: true, message: null });
    const res = await this.deps
      .rpc<unknown>('redeem_room_invite', { p_token: this.token, p_display_name: name })
      .catch(() => ({ data: null, error: 'erro' }));
    if (epoch !== this.epoch) return;
    const retry = (message: string) => this.set({ status: 'pending', busy: false, message });
    if (res.error) {
      const code = shortCode(res.error);
      if (code === 'invite-invalid') return this.finish('error', INVITE_INVALID);
      if (code === 'room-full') return this.finish('error', INVITE_ROOM_FULL);
      if (code === 'invalid-argument') return retry(INVITE_BAD_NAME);
      if (code === 'unauthorized') return retry(INVITE_SESSION);
      if (code !== 'already-member') return retry(INVITE_FAILED);
      // Também é o caminho de quem repete depois de perder a resposta do primeiro aceite.
      this.finish('info', INVITE_ALREADY_MEMBER);
      return this.deps.onMember();
    }
    if (typeof res.data !== 'string' || !isUuid(res.data)) return retry(INVITE_FAILED);
    this.finish('info', INVITE_ACCEPTED);
    this.deps.onMember();
  }

  decline(): void {
    this.epoch += 1;
    this.token = null;
    this.set({ status: 'none' });
  }

  dismiss(): void {
    if (this.s.status === 'result') this.set({ status: 'none' });
  }

  /** Logout ou outra conta: o convite fica, para a conta certa aceitar. A tela volta a mostrar qual conta é. */
  accountChanged(): void {
    this.epoch += 1;
    if (this.s.status === 'pending') this.set({ status: 'pending', busy: false, message: null });
  }
}
