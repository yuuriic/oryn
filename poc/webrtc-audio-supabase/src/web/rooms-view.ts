// Renderização do lobby (MVP 01). Só createElement + textContent: nomes de salas vêm de outros usuários e NUNCA
// passam por HTML (nada de innerHTML/insertAdjacentHTML; há teste). O documento é injetado para os testes.

import type { RoomSummary } from '../contracts.ts';
import { splitRooms, type LobbyState } from './rooms.ts';

/** O mínimo do DOM usado aqui (o `document` da página ou um documento falso nos testes). */
export interface ViewDocument {
  createElement(tag: string): HTMLElement;
}

export interface LobbyViewOptions {
  /** Há uma chamada em curso: nenhuma outra entrada é permitida. */
  callActive: boolean;
  /** Sala da chamada em curso, se houver. */
  activeRoomId: string | null;
  onJoin(roomId: string): void;
  onClose(roomId: string): void;
}

const ROLE: Record<RoomSummary['role'], string> = { owner: 'dono', member: 'membro' };

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export function statusText(state: LobbyState): string {
  if (state.status === 'loading') return 'Carregando salas…';
  if (state.status === 'error') return state.listError ?? 'Não foi possível carregar as salas.';
  if (state.status !== 'ready') return '';
  if (state.rooms.length === 0) return 'Nenhuma sala ainda. Crie a primeira abaixo.';
  if (!state.rooms.some((r) => r.is_open)) return 'Nenhuma sala aberta.';
  return '';
}

export function renderLobby(doc: ViewDocument, state: LobbyState, opts: LobbyViewOptions): HTMLElement {
  const el = (tag: string, text?: string, className?: string): HTMLElement => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const root = el('div');
  const status = el('p', statusText(state), state.status === 'error' ? 'error' : 'muted');
  status.setAttribute('role', 'status');
  root.append(status);
  if (state.status === 'ready' && state.skipped > 0) {
    root.append(el('p', `${state.skipped} sala(s) com dados fora do padrão não exibida(s).`, 'muted'));
  }

  const { open, closed } = splitRooms(state.status === 'ready' ? state.rooms : []);
  const busy = state.busy !== null;

  if (open.length > 0) {
    const list = el('ul', undefined, 'rooms');
    for (const room of open) {
      const item = el('li');
      item.append(el('strong', room.name), el('span', ` ${ROLE[room.role]} · ${room.member_count}/${room.max_members} membros · aberta`, 'muted'));
      const actions = el('div', undefined, 'buttons');
      const inThis = opts.activeRoomId === room.room_id;
      const join = el('button', inThis ? 'Na chamada' : 'Entrar na chamada') as HTMLButtonElement;
      join.type = 'button';
      join.disabled = opts.callActive || busy;
      join.addEventListener('click', () => opts.onJoin(room.room_id));
      actions.append(join);
      if (room.role === 'owner') {
        const closing = state.busy?.kind === 'close' && state.busy.roomId === room.room_id;
        const close = el('button', closing ? 'Encerrando…' : 'Encerrar sala', 'danger') as HTMLButtonElement;
        close.type = 'button';
        close.disabled = busy;
        close.addEventListener('click', () => opts.onClose(room.room_id));
        actions.append(close);
      }
      item.append(actions);
      list.append(item);
    }
    root.append(list);
  }

  if (closed.length > 0) {
    // Recolhida por padrão e sem nenhuma ação.
    const box = el('details');
    box.append(el('summary', `Salas encerradas (${closed.length})`));
    const list = el('ul', undefined, 'rooms');
    for (const room of closed) {
      const item = el('li');
      item.append(el('strong', room.name), el('span', ` ${ROLE[room.role]} · encerrada em ${formatWhen(room.closed_at ?? '')}`, 'muted'));
      list.append(item);
    }
    box.append(list);
    root.append(box);
  }
  return root;
}
