// Painel de membros da sala: lista, saída definitiva e remoção pelo dono, pelas RPCs da migração 0600. Sem DOM: a renderização
// fica em members-view.ts. O servidor decide tudo; aqui só se esconde o que não faz sentido oferecer.
//
// Mensagens: só textos fixos por código curto. A presença na chamada é atualizada por consulta periódica, só com o painel aberto
// e a página visível.

import { hasRoomMemberShape, parseRoomMember, type RoomMember } from '../contracts.ts';
import { shortCode, type RpcResult } from './supabase-signaling.ts';

export const MEMBERS_POLL_MS = 5_000;
export const MEMBERS_RPC_TIMEOUT_MS = 15_000;

export const MEMBERS_LOAD_FAILED = 'Não foi possível carregar os membros (falha de rede ou do servidor). Tentando de novo…';
export const MEMBERS_DENIED = 'Esta conta não participa mais desta sala.';

const LEAVE_ERRORS: Record<string, string> = {
  unauthorized: 'Esta conta não participa mais desta sala.',
  'owner-cannot-leave': 'O dono não sai da sala: encerre a sala.',
};
const LEAVE_FAILED = 'Não foi possível sair da sala (falha de rede ou do servidor). Tente de novo.';
const REMOVE_ERRORS: Record<string, string> = {
  unauthorized: 'Não foi possível remover: a pessoa já saiu ou esta conta não tem permissão.',
};
const REMOVE_FAILED = 'Não foi possível remover (falha de rede ou do servidor). Tente de novo.';

export type MembersStatus = 'closed' | 'loading' | 'ready' | 'error' | 'denied';

export interface MembersState {
  roomId: string | null;
  roomName: string;
  /** Sala encerrada: só leitura. */
  readOnly: boolean;
  status: MembersStatus;
  members: RoomMember[];
  /** Operação em curso: sair, ou a referência de quem está sendo removido. */
  busy: 'leave' | { removing: string } | null;
  message: { tone: 'info' | 'error'; text: string } | null;
}

export interface MembersDeps {
  rpc<T>(fn: string, args: Record<string, unknown>): Promise<RpcResult<T>>;
  confirm(message: string): boolean;
  isHidden(): boolean;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  onChange(state: MembersState): void;
  /** Antes de sair: a página encerra a chamada desta sala, se houver, enquanto a sessão ainda vale. */
  beforeLeave(roomId: string): Promise<void> | void;
  /** A conta saiu da sala: a página fecha o chat dela e atualiza a lista. */
  onLeft(roomId: string): void;
  /** O servidor recusou o acesso: a pertença acabou (remoção) ou a sala não existe mais para esta conta. */
  onDenied(roomId: string): void;
  /** A lista de membros mudou por ação daqui: contagens e botões do lobby. */
  onChanged(): void;
}

const CLOSED: MembersState = { roomId: null, roomName: '', readOnly: false, status: 'closed', members: [], busy: null, message: null };

/** `null` = fora do contrato: é erro, não lista vazia. Valor fora da regra é ignorado. */
export function parseMembers(data: unknown): RoomMember[] | null {
  if (!Array.isArray(data) || !data.every(hasRoomMemberShape)) return null;
  return data.map(parseRoomMember).filter((m): m is RoomMember => m !== null);
}

export class MembersController {
  private s: MembersState = CLOSED;
  /** Muda ao abrir, fechar e sair da conta: uma resposta anterior é descartada. */
  private generation = 0;
  private timer: unknown = null;
  private loading = false;
  private readonly deps: MembersDeps;

  constructor(deps: MembersDeps) {
    this.deps = deps;
  }

  get state(): MembersState {
    return this.s;
  }

  private set(patch: Partial<MembersState>): void {
    this.s = { ...this.s, ...patch };
    this.deps.onChange(this.s);
  }

  private call(fn: string, args: Record<string, unknown>): Promise<RpcResult<unknown>> {
    const failed: RpcResult<unknown> = { data: null, error: 'erro' };
    return new Promise((resolve) => {
      const timer = this.deps.setTimer(() => resolve(failed), MEMBERS_RPC_TIMEOUT_MS);
      const finish = (result: RpcResult<unknown>): void => {
        this.deps.clearTimer(timer);
        resolve(result);
      };
      this.deps.rpc<unknown>(fn, args).then(finish, () => finish(failed));
    });
  }

  open(roomId: string, roomName: string, readOnly: boolean): void {
    if (this.s.roomId === roomId && this.s.status !== 'closed') return;
    this.stop();
    this.set({ ...CLOSED, roomId, roomName, readOnly, status: 'loading' });
    void this.load();
  }

  close(): void {
    this.stop();
    this.set(CLOSED);
  }

  private stop(): void {
    this.generation += 1;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    this.loading = false;
  }

  private schedule(): void {
    const gen = this.generation;
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      if (gen === this.generation) void this.load();
    }, MEMBERS_POLL_MS);
  }

  private async load(): Promise<void> {
    if (this.loading) return;
    if (this.deps.isHidden() && this.s.status === 'ready') return this.schedule();
    const roomId = this.s.roomId;
    if (roomId === null) return;
    const gen = this.generation;
    this.loading = true;
    const res = await this.call('list_room_members', { p_room_id: roomId });
    if (gen !== this.generation) return;
    this.loading = false;
    if (res.error && shortCode(res.error) === 'unauthorized') {
      this.set({ status: 'denied', members: [], message: { tone: 'error', text: MEMBERS_DENIED } });
      this.deps.onDenied(roomId);
      return; // sem acesso: não insiste
    }
    const members = res.error ? null : parseMembers(res.data);
    if (!members) {
      if (this.s.status !== 'ready' && this.s.status !== 'error') this.set({ status: 'error' });
      else if (this.s.status === 'ready') this.set({ message: { tone: 'error', text: MEMBERS_LOAD_FAILED } });
    } else if (this.s.status !== 'ready' || JSON.stringify(members) !== JSON.stringify(this.s.members) || this.s.message?.text === MEMBERS_LOAD_FAILED) {
      this.set({ status: 'ready', members, message: this.s.message?.text === MEMBERS_LOAD_FAILED ? null : this.s.message });
    }
    this.schedule();
  }

  get canManage(): boolean {
    return this.s.status === 'ready' && !this.s.readOnly && this.s.members.some((m) => m.is_self && m.role === 'owner');
  }

  /** Saída definitiva da própria conta. Pede confirmação; encerra antes a chamada desta sala, se houver. */
  async leave(): Promise<boolean> {
    const roomId = this.s.roomId;
    if (roomId === null || this.s.busy !== null || this.s.status !== 'ready') return false;
    if (!this.deps.confirm(`Sair definitivamente da sala "${this.s.roomName}"? Você perde o acesso ao chat e à chamada. Para voltar, será preciso um convite novo.`)) return false;
    const gen = this.generation;
    this.set({ busy: 'leave', message: null });
    await this.deps.beforeLeave(roomId);
    if (gen !== this.generation) return false;
    const res = await this.call('leave_room_membership', { p_room_id: roomId });
    if (gen !== this.generation) return false;
    if (res.error) {
      this.set({ busy: null, message: { tone: 'error', text: LEAVE_ERRORS[shortCode(res.error)] ?? LEAVE_FAILED } });
      return false;
    }
    this.close();
    this.deps.onLeft(roomId);
    return true;
  }

  /** Remoção pelo dono, com confirmação. */
  async remove(memberRef: string): Promise<boolean> {
    const roomId = this.s.roomId;
    if (roomId === null || this.s.busy !== null || !this.canManage) return false;
    const member = this.s.members.find((m) => m.member_ref === memberRef && !m.is_self);
    if (!member) return false;
    if (!this.deps.confirm(`Remover "${member.display_name}" da sala? A pessoa perde o acesso ao chat e à chamada. Os convites pendentes desta sala deixam de valer.`)) return false;
    const gen = this.generation;
    this.set({ busy: { removing: memberRef }, message: null });
    const res = await this.call('remove_room_member', { p_room_id: roomId, p_member_ref: memberRef });
    if (gen !== this.generation) return false;
    this.set({
      busy: null,
      message: res.error ? { tone: 'error', text: REMOVE_ERRORS[shortCode(res.error)] ?? REMOVE_FAILED } : { tone: 'info', text: `"${member.display_name}" foi removido da sala.` },
    });
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    await this.load();
    if (!res.error) this.deps.onChanged();
    return !res.error;
  }
}
