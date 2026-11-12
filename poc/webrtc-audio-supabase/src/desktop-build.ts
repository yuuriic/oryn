// Build do aplicativo desktop (Tauri): `vite build --mode desktop`, chamado pelo `beforeBuildCommand` do
// src-tauri/tauri.conf.json. É o mesmo bundle da web; a única diferença é a origem pública dos links.
//
// No WebView, `location.origin` é `https://tauri.localhost`. Um desktop sem VITE_ORYN_PUBLIC_ORIGIN copiaria convites
// que só abrem dentro dele, por isso o build falha fechado. Na web, nada muda: o modo não é `desktop`, e a variável
// continua opcional.

import { parsePublicOrigin } from './web/config.ts';

export const DESKTOP_MODE = 'desktop';

export function assertDesktopBuild(mode: string, env: Record<string, string | undefined>): void {
  if (mode !== DESKTOP_MODE) return;
  const origin = parsePublicOrigin(env['VITE_ORYN_PUBLIC_ORIGIN']);
  if (!origin || !origin.startsWith('https://')) {
    throw new Error('build desktop: VITE_ORYN_PUBLIC_ORIGIN (https://<host> da web publicada) é obrigatória, em .env.desktop.local ou no ambiente');
  }
}
