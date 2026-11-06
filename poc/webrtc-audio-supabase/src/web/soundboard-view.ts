// Renderização da lista de sons. Só createElement + textContent: os nomes vêm de usuários e NUNCA passam por HTML.

import type { ViewDocument } from './rooms-view.ts';
import type { SoundboardState, SoundItem } from './soundboard.ts';

export interface SoundboardViewOptions {
  onTrigger(assetId: string): void;
  onRemove(assetId: string): void;
}

const seconds = (ms: number | null): string => (ms === null ? '' : `${(ms / 1000).toFixed(1).replace('.', ',')} s`);

export function soundDetail(sound: SoundItem): string {
  if (sound.state === 'quarantine') return 'em validação';
  if (sound.local === 'loading') return `${seconds(sound.duration_ms)}, carregando`;
  if (sound.local === 'error') return `${seconds(sound.duration_ms)}, falha ao carregar`;
  return seconds(sound.duration_ms);
}

export function soundboardStatus(state: SoundboardState): string | null {
  if (state.message) return state.message.text;
  if (state.status === 'loading') return 'Carregando sons…';
  if (state.standby) return 'Esta sessão está em espera: os sons tocam na sessão que está na chamada.';
  if (state.status === 'ready' && state.sounds.length === 0) return state.isOwner ? 'Nenhum som ainda. Publique o primeiro abaixo.' : 'Esta sala ainda não tem sons.';
  return null;
}

export function renderSoundboard(doc: ViewDocument, state: SoundboardState, opts: SoundboardViewOptions): HTMLElement {
  const list = doc.createElement('ul');
  list.className = 'sound-list';
  for (const sound of state.sounds) {
    const item = doc.createElement('li');
    const play = doc.createElement('button') as HTMLButtonElement;
    play.type = 'button';
    play.className = 'sound-play';
    play.dataset['asset'] = sound.asset_id;
    play.textContent = sound.name;
    play.disabled = sound.state !== 'available' || state.cooling || state.standby;
    play.addEventListener('click', () => opts.onTrigger(sound.asset_id));
    const detail = doc.createElement('span');
    detail.className = 'muted sound-detail';
    detail.textContent = soundDetail(sound);
    item.append(play, detail);
    if (state.isOwner) {
      const remove = doc.createElement('button') as HTMLButtonElement;
      remove.type = 'button';
      remove.className = 'danger';
      remove.textContent = 'Remover';
      remove.setAttribute('aria-label', `Remover ${sound.name}`);
      remove.disabled = state.removing !== null;
      remove.addEventListener('click', () => opts.onRemove(sound.asset_id));
      item.append(remove);
    }
    list.append(item);
  }
  return list;
}
