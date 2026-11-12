// Saída do áudio recebido: um elemento por sessão remota, com o volume individual (voice-prefs) e o silenciamento geral
// (IncomingAudio) compostos num lugar só. Nada aqui toca a conexão, o microfone ou o que os outros ouvem.
//
// A sessão muda a cada entrada; a preferência é da pessoa (participant_ref). A ligação sessão → referência vem da lista
// de participantes da chamada. Até ela chegar, o elemento toca no padrão (100%), e recebe a preferência assim que chegar.

import { IncomingAudio, type Mutable } from './incoming-audio.ts';
import { VOICE_PREF_DEFAULT, type VoicePref, type VoicePrefs } from './voice-prefs.ts';

/** O mínimo de um <audio>: o que a mixagem lê e escreve. `volume` vai de 0 a 1 (sem amplificação). */
export interface Output extends Mutable {
  volume: number;
}

export class VoiceMix<E extends Output> {
  readonly incoming: IncomingAudio;
  private readonly prefs: VoicePrefs;
  private readonly els = new Map<string, E>();
  private readonly refs = new Map<string, string>();
  private readonly sessionOf = new Map<E, string>();

  constructor(prefs: VoicePrefs) {
    this.prefs = prefs;
    this.incoming = new IncomingAudio((el) => this.prefOf(this.sessionOf.get(el as E)).muted);
  }

  get size(): number {
    return this.els.size;
  }
  values(): IterableIterator<E> {
    return this.els.values();
  }
  get(session: string): E | undefined {
    return this.els.get(session);
  }

  /** Áudio novo de uma sessão: já entra com o volume e o silenciamento efetivos, antes de tocar. */
  attach(session: string, el: E): void {
    this.detach(session);
    this.els.set(session, el);
    this.sessionOf.set(el, session);
    this.apply(session);
  }

  /** Fim do áudio de uma sessão. Devolve o elemento para quem o criou o liberar. */
  detach(session: string): E | undefined {
    const el = this.els.get(session);
    if (!el) return undefined;
    this.els.delete(session);
    this.sessionOf.delete(el);
    return el;
  }

  /** Quem está na chamada agora (sessão e referência). Reaplica a quem mudou de referência ou acabou de ganhar uma. */
  setParticipants(list: readonly { session: string; ref: string }[]): void {
    const next = new Map(list.map((p) => [p.session, p.ref]));
    const changed = [...this.els.keys()].filter((s) => this.refs.get(s) !== next.get(s));
    this.refs.clear();
    for (const [s, r] of next) this.refs.set(s, r);
    for (const s of changed) this.apply(s);
  }

  pref(ref: string): VoicePref {
    return this.prefs.get(ref);
  }

  /** Volume de uma pessoa, em porcentagem (0–100). Vale para todas as sessões dela. */
  setVolume(ref: string, percent: number): VoicePref {
    const pref = this.prefs.setVolume(ref, percent);
    this.applyRef(ref);
    return pref;
  }

  setMuted(ref: string, muted: boolean): VoicePref {
    const pref = this.prefs.setMuted(ref, muted);
    this.applyRef(ref);
    return pref;
  }

  /** Outra conta entrou neste aparelho (ou saiu): as preferências da anterior deixam de valer na hora. */
  setAccount(account: string | null): void {
    this.prefs.setAccount(account);
    for (const s of this.els.keys()) this.apply(s);
  }

  private prefOf(session: string | undefined): VoicePref {
    const ref = session === undefined ? undefined : this.refs.get(session);
    return ref === undefined ? { ...VOICE_PREF_DEFAULT } : this.prefs.get(ref);
  }

  private applyRef(ref: string): void {
    for (const [s, r] of this.refs) if (r === ref) this.apply(s);
  }

  private apply(session: string): void {
    const el = this.els.get(session);
    if (!el) return;
    el.volume = this.prefOf(session).volume;
    this.incoming.adopt(el);
  }
}

/**
 * Posição do menu: no ponto pedido (clique direito) ou junto ao botão (teclado e toque), sempre inteiro dentro da janela.
 * Valores em pixels da janela; `margin` é a folga mínima das bordas.
 */
export function placeMenu(
  at: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 8,
): { left: number; top: number } {
  const clamp = (v: number, max: number) => Math.max(margin, Math.min(v, Math.max(margin, max - margin)));
  // Sem espaço abaixo: abre para cima do ponto, como um menu de contexto.
  const top = at.y + size.height + margin > viewport.height ? at.y - size.height : at.y;
  return { left: Math.round(clamp(at.x, viewport.width - size.width)), top: Math.round(clamp(top, viewport.height - size.height)) };
}
