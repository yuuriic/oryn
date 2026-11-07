// Renderização do lobby (MVP 01). Só createElement + textContent: nomes de salas vêm de outros usuários e NUNCA
// passam por HTML (nada de innerHTML/insertAdjacentHTML; há teste). O documento é injetado para os testes.

import type { RoomSummary } from '../contracts.ts';
import { splitRooms, type LobbyState } from './rooms.ts';
import { roomInitials } from './shell.ts';

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
  /** Há um convite sendo gerado: nenhum outro é pedido enquanto isso. */
  inviteBusy?: boolean;
  onInvite?(roomId: string): void;
  onRevokeInvites?(roomId: string): void;
  /** Abre o chat da sala. A chamada em curso não impede: o chat é independente dela. */
  onChat?(roomId: string): void;
  /** Sala com o chat aberto, se houver. */
  chatRoomId?: string | null;
  /** Abre o painel de membros. */
  onMembers?(roomId: string): void;
  /** Sala com o painel de membros aberto, se houver. */
  membersRoomId?: string | null;
  /** Mostra só esta sala, com as mesmas ações. Sem ela, todas. */
  selectedRoomId?: string | null;
  /** Salas com "Gerenciar sala" aberto: o redesenho não pode recolher o que a pessoa abriu. */
  adminOpenRoomIds?: ReadonlySet<string>;
  onAdminToggle?(roomId: string, open: boolean): void;
}

export interface RoomNavOptions {
  selectedRoomId: string | null;
  /** Sala da chamada em curso, se houver. */
  activeRoomId: string | null;
  /** Só muda o que é mostrado: não entra na chamada. */
  onSelect(roomId: string): void;
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

/** Título e resumo do cabeçalho, para a sala selecionada ou para a visão geral. */
export function roomContext(state: LobbyState, selectedRoomId: string | null, activeRoomId: string | null = null): { title: string; detail: string | null } {
  const room = selectedRoomId === null ? undefined : state.rooms.find((r) => r.room_id === selectedRoomId);
  if (!room) return { title: 'Minhas salas', detail: null };
  if (room.is_open && room.room_id === activeRoomId) return { title: room.name, detail: `Em chamada · ${room.member_count}/${room.max_members} membros` };
  const situation = room.is_open ? `${room.member_count}/${room.max_members} membros · aberta` : `encerrada em ${formatWhen(room.closed_at ?? '')}`;
  return { title: room.name, detail: `${ROLE[room.role]} · ${situation}` };
}

/** Salas na barra lateral. Abrir uma sala aqui nunca entra na chamada: isso é uma ação da área central. */
export function renderRoomNav(doc: ViewDocument, state: LobbyState, opts: RoomNavOptions): HTMLElement {
  const el = (tag: string, text?: string, className?: string): HTMLElement => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const root = el('div');
  if (state.status === 'loading' && state.rooms.length === 0) root.append(el('p', 'Carregando…', 'muted room-nav-status'));
  if (state.status === 'error') root.append(el('p', 'Lista indisponível', 'error room-nav-status'));

  const item = (room: RoomSummary): HTMLElement => {
    const inCall = opts.activeRoomId === room.room_id;
    const selected = opts.selectedRoomId === room.room_id;
    const li = el('li');
    const button = el('button', undefined, `room-link${room.is_open ? '' : ' room-closed'}${inCall ? ' room-in-call' : ''}`) as HTMLButtonElement;
    button.type = 'button';
    const situation = room.is_open ? 'aberta' : 'encerrada';
    button.setAttribute('aria-label', `${room.name}, ${ROLE[room.role]}, ${situation}${inCall ? ', na chamada' : ''}`);
    button.setAttribute('title', room.name);
    button.setAttribute('data-name', room.name);
    if (selected) button.setAttribute('aria-current', 'true');
    const initials = el('span', roomInitials(room.name), 'room-initials');
    initials.setAttribute('aria-hidden', 'true');
    const text = el('span', undefined, 'room-text');
    text.append(el('span', room.name, 'room-name'), el('span', `${inCall ? 'na chamada' : ROLE[room.role]} · ${room.member_count}/${room.max_members}`, 'room-meta'));
    button.append(initials, text);
    button.addEventListener('click', () => opts.onSelect(room.room_id));
    li.append(button);
    return li;
  };

  // Só salas abertas: as encerradas seguem em "Minhas salas", recolhidas e só para leitura.
  const { open } = splitRooms(state.rooms);
  if (open.length > 0) {
    const list = el('ul', undefined, 'room-list');
    list.append(...open.map(item));
    root.append(list);
  } else if (state.status === 'ready') {
    root.append(el('p', 'Nenhuma sala aberta', 'muted room-nav-status'));
  }
  return root;
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

  const chatButton = (roomId: string, text: string, onChat: (roomId: string) => void): HTMLElement => {
    const opened = opts.chatRoomId === roomId;
    const button = el('button', opened ? 'Chat aberto' : text, 'room-chat') as HTMLButtonElement;
    button.type = 'button';
    button.disabled = opened;
    button.addEventListener('click', () => onChat(roomId));
    return button;
  };

  const membersButton = (roomId: string, onMembers: (roomId: string) => void): HTMLElement => {
    const opened = opts.membersRoomId === roomId;
    const button = el('button', opened ? 'Membros abertos' : 'Membros', 'room-members') as HTMLButtonElement;
    button.type = 'button';
    button.disabled = opened;
    button.addEventListener('click', () => onMembers(roomId));
    return button;
  };

  const selected = opts.selectedRoomId ?? null;
  const shown = (state.status === 'ready' ? state.rooms : []).filter((r) => selected === null || r.room_id === selected);
  const { open, closed } = splitRooms(shown);
  const busy = state.busy !== null;

  if (open.length > 0) {
    const list = el('ul', undefined, 'rooms');
    for (const room of open) {
      const item = el('li');
      item.append(el('strong', room.name), el('span', ` ${ROLE[room.role]} · ${room.member_count}/${room.max_members} membros · aberta`, 'muted'));
      const actions = el('div', undefined, 'buttons');
      const inThis = opts.activeRoomId === room.room_id;
      const join = el('button', inThis ? 'Na chamada' : 'Entrar na chamada', inThis ? 'room-join room-joined' : 'room-join') as HTMLButtonElement;
      join.type = 'button';
      join.disabled = opts.callActive || busy;
      join.addEventListener('click', () => opts.onJoin(room.room_id));
      actions.append(join);
      if (opts.onChat) actions.append(chatButton(room.room_id, 'Abrir chat', opts.onChat));
      if (opts.onMembers) actions.append(membersButton(room.room_id, opts.onMembers));
      // Administração do dono: recolhida, depois das ações principais, para não competir com elas.
      const admin = el('div', undefined, 'buttons');
      if (room.role === 'owner' && room.member_count < room.max_members && opts.onInvite) {
        const { onInvite } = opts;
        const invite = el('button', 'Convidar', 'room-invite') as HTMLButtonElement;
        invite.type = 'button';
        invite.disabled = busy || opts.inviteBusy === true; // a chamada em curso não impede: o dono pode estar esperando
        invite.addEventListener('click', () => onInvite(room.room_id));
        admin.append(invite);
      }
      // Fora do painel de propósito: depois de recarregar, o dono revoga sem precisar gerar mais um convite.
      if (room.role === 'owner' && room.member_count < room.max_members && opts.onRevokeInvites) {
        const { onRevokeInvites } = opts;
        const revoke = el('button', 'Revogar convites pendentes desta sala', 'danger') as HTMLButtonElement;
        revoke.type = 'button';
        revoke.disabled = busy || opts.inviteBusy === true;
        revoke.addEventListener('click', () => onRevokeInvites(room.room_id));
        admin.append(revoke);
      }
      if (room.role === 'owner') {
        const closing = state.busy?.kind === 'close' && state.busy.roomId === room.room_id;
        const close = el('button', closing ? 'Encerrando…' : 'Encerrar sala', 'danger') as HTMLButtonElement;
        close.type = 'button';
        close.disabled = busy;
        close.addEventListener('click', () => opts.onClose(room.room_id));
        admin.append(close);
      }
      item.append(actions);
      if (admin.children.length > 0) {
        const box = el('details', undefined, 'room-admin');
        if (opts.adminOpenRoomIds?.has(room.room_id)) box.setAttribute('open', '');
        box.addEventListener('toggle', () => opts.onAdminToggle?.(room.room_id, (box as HTMLDetailsElement).open));
        box.append(el('summary', 'Gerenciar sala'), admin);
        item.append(box);
      }
      list.append(item);
    }
    root.append(list);
  }

  if (closed.length > 0) {
    // Recolhida por padrão e sem nenhuma ação. Selecionada, já é o que a pessoa pediu para ver.
    const box = el(selected === null ? 'details' : 'div');
    if (selected === null) box.append(el('summary', `Salas encerradas (${closed.length})`));
    const list = el('ul', undefined, 'rooms');
    for (const room of closed) {
      const item = el('li');
      item.append(el('strong', room.name), el('span', ` ${ROLE[room.role]} · encerrada em ${formatWhen(room.closed_at ?? '')}`, 'muted'));
      if (opts.onChat) {
        const actions = el('div', undefined, 'buttons');
        actions.append(chatButton(room.room_id, 'Ver mensagens', opts.onChat));
        if (opts.onMembers) actions.append(membersButton(room.room_id, opts.onMembers));
        item.append(actions);
      }
      list.append(item);
    }
    box.append(list);
    root.append(box);
  }
  return root;
}
