// Áudio recebido: silenciar só neste aparelho o som dos outros participantes. É o `muted` de cada elemento <audio>
// remoto; a conexão WebRTC continua, o microfone não muda e nada disso é enviado aos outros (não é o mudo do
// microfone). Os sons da sala tocam por outro caminho (sound-bus) e têm a sua própria desativação local.

/** O mínimo de um elemento de mídia: o que o controle precisa ler e escrever. */
export interface Mutable {
  muted: boolean;
}

export class IncomingAudio {
  private silenced = false;

  get muted(): boolean {
    return this.silenced;
  }

  /** Aplica o estado a todos os elementos atuais. Quem entra depois recebe o mesmo estado em `adopt`. */
  set(muted: boolean, elements: Iterable<Mutable>): void {
    this.silenced = muted;
    for (const el of elements) el.muted = muted;
  }

  toggle(elements: Iterable<Mutable>): boolean {
    this.set(!this.silenced, elements);
    return this.silenced;
  }

  /** Participante novo (ou que voltou): já entra no estado atual, sem tocar um instante antes. */
  adopt(el: Mutable): void {
    el.muted = this.silenced;
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
