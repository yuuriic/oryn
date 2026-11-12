// Rascunhos do chat por canal, só em memória (nunca em armazenamento do navegador). O campo de mensagem é um só; ao trocar
// de canal, o texto digitado fica guardado no canal de origem e o campo recebe o rascunho do canal de destino. Assim o que
// foi escrito para um canal nunca é enviado em outro.

/** Chave do canal: sala + canal. `null` no canal é o texto padrão da sala (o caminho antigo, as mesmas mensagens). */
export function draftKey(roomId: string | null, channelId: string | null): string | null {
  return roomId === null ? null : `${roomId}:${channelId ?? 'default'}`;
}

export class DraftBook {
  private readonly drafts = new Map<string, string>();

  /**
   * Troca de canal: guarda `current` (o que está no campo) em `from` e devolve o rascunho de `to`. Texto vazio não ocupa
   * espaço. Sem troca de fato, devolve `current` como está.
   */
  switch(from: string | null, to: string | null, current: string): string {
    if (from === to) return current;
    if (from !== null) {
      if (current.trim() === '') this.drafts.delete(from);
      else this.drafts.set(from, current);
    }
    return to === null ? '' : (this.drafts.get(to) ?? '');
  }

  /** Mensagem enviada: o rascunho do canal acabou. */
  clear(key: string | null): void {
    if (key !== null) this.drafts.delete(key);
  }

  /** Saída da conta: nada do que foi digitado sobrevive. */
  reset(): void {
    this.drafts.clear();
  }

  get size(): number {
    return this.drafts.size;
  }
}
