// Renderização do painel de membros e dos participantes da chamada. Só createElement + textContent: os nomes vêm de outros
// usuários e NUNCA passam por HTML. O documento é injetado para os testes.

import type { ParticipantState, ParticipantView } from './mesh-call.ts';
import type { MembersState } from './members.ts';
import type { ViewDocument } from './rooms-view.ts';
import { roomInitials } from './shell.ts';

export interface MembersViewOptions {
  canManage: boolean;
  onLeave(): void;
  onRemove(memberRef: string): void;
}

const ROLE = { owner: 'dono', member: 'membro' } as const;

export function renderMembers(doc: ViewDocument, state: MembersState, opts: MembersViewOptions): HTMLElement {
  const el = (tag: string, text?: string, className?: string): HTMLElement => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text: string, onClick: () => void, disabled: boolean, className?: string): HTMLButtonElement => {
    const node = el('button', text, className) as HTMLButtonElement;
    node.type = 'button';
    node.disabled = disabled;
    node.addEventListener('click', onClick);
    return node;
  };

  const root = el('div');
  if (state.status === 'loading') root.append(el('p', 'Carregando membros…', 'muted'));
  const list = el('ul', undefined, 'rooms');
  const busy = state.busy !== null;
  for (const member of state.members) {
    const item = el('li');
    item.setAttribute('data-initial', roomInitials(member.display_name));
    item.setAttribute('data-role', member.role); // o dono ganha o destaque dourado; o papel segue no texto
    item.append(
      el('strong', member.is_self ? `${member.display_name} (você)` : member.display_name),
      el('span', ` ${ROLE[member.role]}${member.in_call ? ' · na chamada' : ''}`, 'muted'),
    );
    const removing = typeof state.busy === 'object' && state.busy?.removing === member.member_ref;
    if (opts.canManage && !member.is_self) {
      const actions = el('div', undefined, 'buttons');
      actions.append(button(removing ? 'Removendo…' : 'Remover', () => opts.onRemove(member.member_ref), busy, 'danger'));
      item.append(actions);
    }
    if (member.is_self && member.role === 'member') {
      const actions = el('div', undefined, 'buttons');
      actions.append(button(state.busy === 'leave' ? 'Saindo…' : 'Sair da sala', opts.onLeave, busy, 'danger'));
      item.append(actions);
    }
    list.append(item);
  }
  root.append(list);
  return root;
}

const STATE_TEXT: Record<ParticipantState, string> = {
  connecting: 'conectando…',
  connected: 'conectado',
  reconnecting: 'reconectando…',
  failed: 'sem conexão',
  waiting: 'aguardando conexão…',
};

/** Texto de estado de um participante da chamada. */
export const participantStateText = (state: ParticipantState): string => STATE_TEXT[state];

/** Palco da chamada: o próprio cartão e as vagas livres. Só estado que já existe (papel, mudo, lotação): nada de fala simulada. */
export interface ParticipantStage {
  /** Papel da própria conta na sala da chamada. */
  owner: boolean;
  /** O próprio microfone está mutado. */
  muted: boolean;
  /** Lugares ainda livres na chamada. */
  freeSlots: number;
}

export function renderParticipants(doc: ViewDocument, list: readonly ParticipantView[], standby: boolean, stage?: ParticipantStage): HTMLElement {
  const el = (tag: string, text?: string, className?: string): HTMLElement => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const root = el('div');
  if (standby) root.append(el('p', 'Esta conta já está na chamada em outra aba ou aparelho. Esta sessão fica em espera e assume quando a outra sair.', 'notice'));
  if (list.length === 0 && !standby) root.append(el('p', 'Nenhum outro participante na chamada.', stage ? 'visually-hidden' : 'muted'));
  if (list.length === 0 && !stage) return root;
  const items = el('ul', undefined, stage ? 'rooms participant-grid' : 'rooms');
  if (stage) {
    const self = el('li', undefined, 'participant-self');
    self.setAttribute('data-initial', 'Eu');
    self.setAttribute('data-role', stage.owner ? 'owner' : 'member');
    self.setAttribute('data-muted', String(stage.muted));
    self.append(el('strong', 'Você'), el('span', stage.muted ? 'Microfone desligado' : 'Microfone ligado', 'muted'));
    if (stage.owner) self.append(el('span', 'Dono', 'owner-badge'));
    items.append(self);
  }
  for (const p of list) {
    const item = el('li');
    item.setAttribute('data-initial', roomInitials(p.displayName));
    item.setAttribute('data-state', p.state);
    item.append(el('strong', p.displayName), el('span', ` ${standby ? 'na chamada' : STATE_TEXT[p.state]}`, p.state === 'failed' && !standby ? 'error' : 'muted'));
    items.append(item);
  }
  if (stage && stage.freeSlots > 0) {
    const waiting = el('li', undefined, 'participant-waiting');
    waiting.append(el('strong', 'Aguardando participantes'), el('span', stage.freeSlots === 1 ? 'Até 1 vaga disponível' : `Até ${stage.freeSlots} vagas disponíveis`, 'muted'));
    items.append(waiting);
  }
  if (stage) items.setAttribute('data-count', String(Math.min(4, list.length + 1 + (stage.freeSlots > 0 ? 1 : 0)))); // só o desenho da grade
  root.append(items);
  return root;
}
