// Estado visual da navegação: barra lateral recolhida, painel aberto em telas pequenas e sala selecionada.
// Só em memória, de propósito. Selecionar uma sala só muda o que é mostrado: não entra na chamada nem pede o microfone.

export interface ShellState {
  /** Barra lateral recolhida na tela grande. Em telas pequenas, quem manda é `drawerOpen`. */
  collapsed: boolean;
  /** Navegação aberta sobre o conteúdo, em telas pequenas. */
  drawerOpen: boolean;
  /** Sala mostrada na área central. `null`: visão de todas as salas. */
  selectedRoomId: string | null;
}

const INITIAL: ShellState = { collapsed: false, drawerOpen: false, selectedRoomId: null };

export class ShellController {
  state: ShellState = INITIAL;
  private readonly onChange: (state: ShellState) => void;

  constructor(onChange: (state: ShellState) => void) {
    this.onChange = onChange;
  }

  private set(next: Partial<ShellState>): void {
    this.state = { ...this.state, ...next };
    this.onChange(this.state);
  }

  toggleCollapsed(): void {
    this.set({ collapsed: !this.state.collapsed });
  }

  openDrawer(): void {
    this.set({ drawerOpen: true });
  }

  closeDrawer(): void {
    if (this.state.drawerOpen) this.set({ drawerOpen: false });
  }

  select(roomId: string | null): void {
    this.set({ selectedRoomId: roomId, drawerOpen: false });
  }

  /** A sala selecionada saiu da lista: volta à visão geral. Não avisa: quem chama está desenhando a lista. */
  reconcile(roomIds: readonly string[]): void {
    const { selectedRoomId } = this.state;
    if (selectedRoomId !== null && !roomIds.includes(selectedRoomId)) this.state = { ...this.state, selectedRoomId: null };
  }

  reset(): void {
    this.set(INITIAL);
  }
}

/** Identificador compacto: a primeira letra das duas primeiras palavras. Respeita emoji e acentos combinados. */
export function roomInitials(name: string): string {
  const segmenter = new Intl.Segmenter('pt-BR', { granularity: 'grapheme' });
  const first = (word: string): string => segmenter.segment(word)[Symbol.iterator]().next().value?.segment ?? '';
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(first).join('').toLocaleUpperCase('pt-BR');
}

/** Troca o conteúdo sem perder o foco do teclado: volta ao elemento na mesma posição ou ao vizinho habilitado. */
export function replaceKeepingFocus(container: HTMLElement, next: Node): void {
  const active = document.activeElement;
  const path: number[] = [];
  if (active instanceof HTMLElement && active !== container && container.contains(active)) {
    for (let node: HTMLElement = active; node !== container; node = node.parentElement!) {
      path.unshift([...node.parentElement!.children].indexOf(node));
    }
  }
  container.replaceChildren(next);
  if (path.length === 0) return;
  let target: Element = container;
  for (const index of path) {
    const child = target.children[index];
    if (!child) break;
    target = child;
  }
  const usable = (node: Element): node is HTMLElement => node instanceof HTMLElement && !node.matches(':disabled');
  if (target === container) return;
  if (usable(target)) target.focus();
  else [...(target.parentElement?.querySelectorAll('button') ?? [])].find(usable)?.focus();
}
