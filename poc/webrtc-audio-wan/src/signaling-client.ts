// Cliente de sinalização: WebSocket com mensagens validadas nos dois sentidos.
// O construtor do socket é injetável para testes determinísticos.

import { parseServerMessage, type ClientMessage, type ServerMessage } from './protocol.ts';

/** Subconjunto da interface WebSocket usado aqui. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export interface SignalingHandlers {
  onMessage(message: ServerMessage): void;
  /** Conexão perdida sem que close() tenha sido chamado. */
  onDisconnected(code: number): void;
  /** Mensagem do servidor fora do protocolo (descartada). */
  onInvalid(): void;
}

const OPEN = 1;

/**
 * ws:// para páginas HTTP (loopback) e wss:// para páginas HTTPS (túnel público, incremento futuro).
 * Mesmo host e porta da página.
 */
export function signalingUrl(location: { protocol: string; host: string }): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

export class SignalingClient {
  private socket: SocketLike | null = null;
  private closedByUs = false;
  /** Conexão em andamento: cancelada por close() para não deixar timer nem promise pendentes. */
  private cancelConnect: (() => void) | null = null;
  private readonly url: string;
  private readonly handlers: SignalingHandlers;
  private readonly factory: SocketFactory;

  constructor(url: string, handlers: SignalingHandlers, factory: SocketFactory = (u) => new WebSocket(u) as unknown as SocketLike) {
    this.url = url;
    this.handlers = handlers;
    this.factory = factory;
  }

  get connected(): boolean {
    return this.socket?.readyState === OPEN;
  }

  connect(timeoutMs = 8000): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = this.factory(this.url);
      this.socket = socket;
      let settled = false;
      this.cancelConnect = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('Conexão à sinalização cancelada.'));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close();
        reject(new Error('Tempo esgotado ao conectar à sinalização.'));
      }, timeoutMs);

      socket.onopen = () => {
        if (settled) return;
        settled = true;
        this.cancelConnect = null;
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => undefined; // o motivo chega em onclose
      socket.onclose = (ev) => {
        clearTimeout(timer);
        this.socket = null;
        if (!settled) {
          settled = true;
          reject(new Error('Não foi possível conectar à sinalização.'));
          return;
        }
        if (!this.closedByUs) this.handlers.onDisconnected(ev.code);
      };
      socket.onmessage = (ev) => {
        const message = typeof ev.data === 'string' ? parseServerMessage(ev.data) : null;
        if (message) this.handlers.onMessage(message);
        else this.handlers.onInvalid();
      };
    });
  }

  send(message: ClientMessage): boolean {
    if (!this.socket || this.socket.readyState !== OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  close(): void {
    this.closedByUs = true;
    this.cancelConnect?.();
    this.cancelConnect = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close(1000, 'leave');
    }
  }
}
