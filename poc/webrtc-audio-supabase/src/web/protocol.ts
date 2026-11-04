// Tipos da sinalização que o PeerCall consome, copiados de poc/webrtc-audio-wan/src/protocol.ts e
// signaling-client.ts (POC-02B, 6daeb99). Só os TIPOS e as mensagens de erro: aqui não há servidor WebSocket
// nem parser de rede; quem produz estas mensagens é o adaptador SupabaseSignaling (supabase-signaling.ts),
// a partir das RPCs, do canal privado e da Edge Function `signal`.
//
// Diferenças em relação ao original (02C, integração):
// - `peer-joined` traz o `role` do par: no Supabase não há servidor que atribua host/guest na entrada; o
//   papel só é conhecido quando o outro participante aparece (iniciador determinístico, ver
//   supabase-signaling.ts). Opcional, para manter o formato original válido.

import type { IceMode, IceServerConfig } from './ice.ts';

export type Role = 'host' | 'guest';

export interface CandidatePayload {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment?: string | null;
}

export type SignalPayload =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | { kind: 'candidate'; candidate: CandidatePayload | null };

export type ClientMessage =
  /** Operador: cria sessão (exige a chave do operador e Host local). */
  | { type: 'create'; operatorKey: string }
  /** Operador: volta à própria sessão (vaga de host). */
  | { type: 'rejoin'; sessionId: string; operatorKey: string }
  /** Operador já na sessão: emite um novo convite (revoga o anterior). */
  | { type: 'invite' }
  /** Convidado: entra com um convite de uso único. */
  | { type: 'join'; invite: string }
  | { type: 'signal'; epoch: number; payload: SignalPayload }
  /** Participante ADMITIDO pede a configuração ICE do modo escolhido (02B.4). */
  | { type: 'ice-request'; mode: IceMode }
  | { type: 'leave' };

export type ErrorCode =
  | 'invalid-message'
  | 'too-large'
  | 'not-found'
  | 'session-full'
  | 'already-in-session'
  | 'not-in-session'
  | 'no-peer'
  | 'stale-epoch'
  | 'unexpected-signal'
  | 'rate-limited'
  | 'server-busy'
  | 'unauthorized'
  | 'invite-invalid'
  | 'locked'
  | 'turn-unavailable'
  | 'ice-limit';

export type ServerMessage =
  | { type: 'session'; sessionId: string; role: Role; epoch: number; peerPresent: boolean }
  | { type: 'peer-joined'; epoch: number; role?: Role }
  | { type: 'peer-left'; epoch: number }
  | { type: 'signal'; epoch: number; payload: SignalPayload }
  | { type: 'session-closed'; reason: 'expired' | 'server-shutdown' }
  /** Somente ao operador: convite de uso único e a origem pública configurada (ou null). */
  | { type: 'invite'; token: string; expiresAt: number; publicOrigin: string | null }
  /**
   * Configuração ICE para este participante (02B.4). Credenciais TURN são TEMPORÁRIAS e exclusivas
   * desta conexão; expiresAt = validade delas (null quando não há TURN).
   */
  | { type: 'ice-config'; mode: IceMode; iceServers: IceServerConfig[]; expiresAt: number | null }
  | { type: 'error'; code: ErrorCode };

export interface SignalingHandlers {
  onMessage(message: ServerMessage): void;
  /** Conexão perdida sem que close() tenha sido chamado. */
  onDisconnected(code: number): void;
  /** Mensagem do servidor fora do protocolo (descartada). */
  onInvalid(): void;
}

/** Mensagens exibíveis para os códigos de erro do servidor. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  'invalid-message': 'Mensagem de sinalização inválida.',
  'too-large': 'Mensagem de sinalização grande demais.',
  'not-found': 'Sessão não encontrada ou expirada. Confira o link ou crie uma nova sessão.',
  'session-full': 'A sessão já tem dois participantes.',
  'already-in-session': 'Esta conexão já participa de uma sessão.',
  'not-in-session': 'Esta conexão não participa de nenhuma sessão.',
  'no-peer': 'Ainda não há outro participante na sessão.',
  'stale-epoch': 'Sinal de uma negociação anterior foi descartado.',
  'unexpected-signal': 'Sinal fora da ordem esperada foi descartado.',
  'rate-limited': 'Muitas mensagens em pouco tempo; a conexão foi limitada.',
  'server-busy': 'O servidor atingiu o limite de sessões simultâneas.',
  unauthorized: 'Não autorizado.',
  'invite-invalid': 'Convite inválido, expirado ou já utilizado. Peça um novo convite ao anfitrião.',
  locked: 'Muitas tentativas de autorização. Aguarde e tente novamente.',
  'turn-unavailable': 'Servidor TURN indisponível: não foi possível obter credenciais temporárias.',
  'ice-limit': 'Limite de emissão de configuração ICE atingido; aguarde e tente novamente.',
};
