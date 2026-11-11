// Renderização do chat. Só createElement + textContent: as mensagens vêm de outros usuários e NUNCA passam
// por HTML (nada de innerHTML/insertAdjacentHTML; há teste). O documento é injetado para os testes.

import { CHAT_ARCHIVED, CHAT_DENIED, CHAT_LOAD_FAILED, CHAT_READ_ONLY, CHAT_STALE, type ChatState } from './chat.ts';
import type { ViewDocument } from './rooms-view.ts';

export interface ChatViewOptions {
  onRetry(nonce: string): void;
  onDiscard(nonce: string): void;
  onLoadOlder(): void;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

/** Linha de situação do painel, ou null. A negação e a falha de carga vêm antes de qualquer outra. */
export function chatStatusText(state: ChatState): { tone: 'info' | 'error'; text: string } | null {
  if (state.status === 'denied') return { tone: 'error', text: CHAT_DENIED };
  if (state.status === 'error') return { tone: 'error', text: CHAT_LOAD_FAILED };
  if (state.status === 'loading') return { tone: 'info', text: 'Carregando mensagens…' };
  if (state.stale) return { tone: 'error', text: CHAT_STALE };
  if (state.notice) return { tone: 'error', text: state.notice };
  if (state.archived) return { tone: 'info', text: CHAT_ARCHIVED };
  if (state.readOnly) return { tone: 'info', text: CHAT_READ_ONLY };
  return null;
}

export function renderChatMessages(doc: ViewDocument, state: ChatState, opts: ChatViewOptions): HTMLElement {
  const el = (tag: string, text?: string, className?: string): HTMLElement => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text: string, onClick: () => void, disabled = false): HTMLButtonElement => {
    const node = el('button', text) as HTMLButtonElement;
    node.type = 'button';
    node.disabled = disabled;
    node.addEventListener('click', onClick);
    return node;
  };

  const root = el('div');
  if (state.status === 'ready' && state.hasOlder) {
    root.append(button(state.loadingOlder ? 'Carregando…' : 'Carregar mensagens anteriores', opts.onLoadOlder, state.loadingOlder));
  }
  if (state.status === 'ready' && state.skipped > 0) {
    root.append(el('p', `${state.skipped} mensagem(ns) fora do padrão não exibida(s).`, 'muted'));
  }
  if (state.status === 'ready' && state.messages.length === 0 && state.pending.length === 0) {
    root.append(el('p', 'Nenhuma mensagem ainda.', 'muted chat-empty'), el('p', 'Envie uma mensagem para iniciar a conversa na sala.', 'muted chat-empty-hint'));
  }

  const list = el('ul', undefined, 'chat-list');
  for (const message of state.messages) {
    const item = el('li', undefined, message.is_mine ? 'chat-mine' : undefined);
    const head = el('div', undefined, 'chat-head');
    head.append(el('strong', message.is_mine ? `${message.display_name} (você)` : message.display_name), el('span', ` ${formatTime(message.created_at)}`, 'muted'));
    item.append(head, el('div', message.body, 'chat-body'));
    list.append(item);
  }
  for (const message of state.pending) {
    const item = el('li', undefined, 'chat-mine chat-pending');
    item.append(el('div', message.body, 'chat-body'));
    if (message.state === 'sending') {
      item.append(el('div', 'Enviando…', 'muted'));
    } else {
      const failure = el('div', message.error ?? 'Não enviada.', 'error');
      failure.setAttribute('role', 'alert');
      const actions = el('div', undefined, 'buttons');
      actions.append(button('Repetir', () => opts.onRetry(message.nonce), state.readOnly), button('Descartar', () => opts.onDiscard(message.nonce)));
      item.append(failure, actions);
    }
    list.append(item);
  }
  root.append(list);
  return root;
}
