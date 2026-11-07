// Preferências de som só deste aparelho: volume e desativação. Não são credencial nem dado da conta.
// Armazenamento indisponível ou valor estranho: valem os padrões.

import type { SoundPrefs } from './soundboard.ts';

const KEY = 'oryn.sound.v1';
export const SOUND_PREFS_DEFAULT: SoundPrefs = { volume: 0.7, disabled: false };

export function loadSoundPrefs(): SoundPrefs {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as Partial<SoundPrefs> | null;
    if (v && typeof v.volume === 'number' && v.volume >= 0 && v.volume <= 1 && typeof v.disabled === 'boolean') return { volume: v.volume, disabled: v.disabled };
  } catch {
    // padrão
  }
  return SOUND_PREFS_DEFAULT;
}

export function saveSoundPrefs(prefs: SoundPrefs): void {
  try {
    // Campo a campo: nada além destes dois valores chega ao armazenamento.
    window.localStorage.setItem(KEY, JSON.stringify({ volume: prefs.volume, disabled: prefs.disabled }));
  } catch {
    // vale até fechar a página
  }
}
