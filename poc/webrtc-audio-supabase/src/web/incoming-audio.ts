// Áudio recebido: silenciar só neste aparelho o som dos outros participantes. É o `muted` de cada elemento <audio>
// remoto; a conexão WebRTC continua, o microfone não muda e nada disso é enviado aos outros (não é o mudo do
// microfone). Os sons da sala tocam por outro caminho (sound-bus) e têm a sua própria desativação local.

/** O mínimo de um elemento de mídia: o que o controle precisa ler e escrever. */
export interface Mutable {
  muted: boolean;
}

/**
 * O silenciamento geral se compõe com o individual (voice-prefs): um elemento fica mudo se QUALQUER um dos dois pedir.
 * Restaurar o áudio geral não desfaz o silenciamento de uma pessoa, e vice-versa. Todo `muted` passa por aqui.
 */
export class IncomingAudio {
  private silenced = false;
  private readonly heldBack: (el: Mutable) => boolean;

  /** `heldBack`: o elemento está silenciado individualmente (só para esta conta, neste aparelho). */
  constructor(heldBack: (el: Mutable) => boolean = () => false) {
    this.heldBack = heldBack;
  }

  get muted(): boolean {
    return this.silenced;
  }

  /** Aplica o estado a todos os elementos atuais. Quem entra depois recebe o mesmo estado em `adopt`. */
  set(muted: boolean, elements: Iterable<Mutable>): void {
    this.silenced = muted;
    for (const el of elements) this.adopt(el);
  }

  toggle(elements: Iterable<Mutable>): boolean {
    this.set(!this.silenced, elements);
    return this.silenced;
  }

  /** Participante novo (ou que voltou), ou preferência individual alterada: aplica o estado efetivo, sem tocar um instante antes. */
  adopt(el: Mutable): void {
    el.muted = this.silenced || this.heldBack(el);
  }

  /** Fim da chamada: a próxima começa ouvindo. */
  reset(elements: Iterable<Mutable>): void {
    this.set(false, elements);
  }
}

/** Nome e estado do botão, sempre em texto (o ícone muda junto, mas não sozinho). */
export function incomingLabel(muted: boolean): string {
  return muted ? 'Ativar áudio da chamada' : 'Silenciar áudio da chamada';
}
