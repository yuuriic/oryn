// Textos do painel de voz e da barra da chamada, a partir de estados que já existem. Sem acesso a DOM nem a WebRTC.

export interface VoiceSummaryInput {
  active: boolean;
  /** Texto da fase da chamada, o mesmo do diagnóstico. */
  phase: string;
  room: string;
}

const capitalize = (text: string): string => text.charAt(0).toLocaleUpperCase('pt-BR') + text.slice(1);

const IDLE_TEXT = 'Nenhuma chamada em curso. Para falar, abra uma sala e use "Entrar na chamada".';

export function voiceSummary({ active, phase, room }: VoiceSummaryInput): { title: string; state: string } {
  if (active) return { title: `Chamada em ${room}`, state: capitalize(phase) };
  if (phase === '—' || phase === 'parada') return { title: 'Chamada', state: IDLE_TEXT };
  if (phase === 'verificando o motivo') return { title: 'Chamada', state: 'Verificando o motivo…' };
  if (phase === 'encerrada') return { title: 'Chamada', state: 'Chamada encerrada.' };
  if (phase === 'falhou') return { title: 'Chamada', state: 'A chamada falhou.' };
  return { title: 'Chamada', state: capitalize(phase) };
}

/** Estado do próprio microfone. Vazio enquanto não há captura: nada de estado inventado. */
export function micLabel(mic: string): string {
  if (mic === 'capturando') return 'Microfone ligado';
  if (mic === 'capturando (mutado)') return 'Microfone desligado';
  return '';
}

/** A sala em tela não é a da chamada: a chamada continua, e a pessoa precisa saber onde. */
export function otherRoomNote(active: boolean, selectedRoomId: string | null, callRoomId: string | null, room: string): string | null {
  if (!active || selectedRoomId === null || selectedRoomId === callRoomId) return null;
  return `Você está vendo outra sala. A chamada continua em ${room}.`;
}
