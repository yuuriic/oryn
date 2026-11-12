// Configuração do cliente web (02C, integração). Vem de `.env.local` (fora do Git; modelo em
// `.env.example`) pelas variáveis VITE_*, que o Vite embute no bundle: por isso SÓ a chave publicável é
// aceita. Qualquer coisa com cara de chave secreta, PAT ou JWT de service_role faz a página recusar-se a
// iniciar (falha fechada). As mensagens citam só o NOME da variável, nunca o valor.

import { isSupabaseUrl } from '../csp.ts';
import { parseIceUrl, type IceServerConfig } from './ice.ts';
import { isUuid } from '../../supabase/functions/_shared/signal-contract.ts';

export interface WebConfig {
  supabaseUrl: string;
  publishableKey: string;
  /** Sala padrão (opcional): a sala da C2, por exemplo. Pode ser trocada na tela. */
  defaultRoomId: string | null;
  iceServers: IceServerConfig[];
  /**
   * Origem pública da web para os links que saem do aplicativo (convite e recuperação de senha). Só o desktop a
   * define: lá, `location.origin` é a origem interna do WebView (`https://tauri.localhost`), inútil fora dele. Na web
   * fica `null`, e os links continuam saindo de `location`.
   */
  publicOrigin: string | null;
  /**
   * Botão "Continuar com Google". `off` (padrão): não aparece. `preview`: aparece só para revisão visual e avisa que
   * depende de configuração; nenhum fluxo OAuth é iniciado. Ligar de fato exige provedor configurado no Supabase,
   * URLs de retorno autorizadas e um retorno próprio (web e desktop): decisão e autorização separadas.
   */
  googleAuth: 'off' | 'preview';
}

/** Origem pública: `https://host[:porta]`, sem caminho, consulta ou fragmento; ou loopback HTTP para testes locais. */
export function parsePublicOrigin(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  if (!/^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(value) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(value)) {
    throw new WebConfigError('VITE_ORYN_PUBLIC_ORIGIN fora do formato https://<host>, sem caminho nem barra final');
  }
  return value.toLowerCase();
}

/**
 * Local usado para montar links públicos. Sem origem pública (web), é o próprio `location`, sem mudança nenhuma.
 * Com ela (desktop), a raiz dessa origem: o app web é servido em `/`.
 */
export function publicLocation(
  location: { protocol: string; hostname: string; origin: string; pathname: string },
  publicOrigin: string | null,
): { protocol: string; hostname: string; origin: string; pathname: string } {
  if (!publicOrigin) return location;
  const url = new URL(publicOrigin);
  return { protocol: url.protocol, hostname: url.hostname, origin: url.origin, pathname: '/' };
}

/** STUN público e gratuito, sem credencial (sem TURN nesta etapa). */
export const DEFAULT_STUN = ['stun:stun.l.google.com:19302'];

export class WebConfigError extends Error {}

/** Recusa qualquer valor que pareça credencial administrativa, em QUALQUER variável. */
const ADMIN_LIKE = /sb_secret_|sbp_[A-Za-z0-9]|service_role/;

export function parseWebConfig(env: Record<string, string | undefined>): WebConfig {
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith('VITE_') && value && ADMIN_LIKE.test(value)) throw new WebConfigError(`${name}: parece uma credencial administrativa; o frontend só aceita a chave publicável`);
  }
  const url = (env['VITE_SUPABASE_URL'] ?? '').trim();
  if (!isSupabaseUrl(url)) {
    throw new WebConfigError('VITE_SUPABASE_URL ausente ou fora do formato https://<ref>.supabase.co');
  }
  const key = (env['VITE_SUPABASE_PUBLISHABLE_KEY'] ?? '').trim();
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) throw new WebConfigError('VITE_SUPABASE_PUBLISHABLE_KEY ausente ou não é uma chave publicável (sb_publishable_…)');

  const room = (env['VITE_ORYN_ROOM_ID'] ?? '').trim();
  if (room && !isUuid(room)) throw new WebConfigError('VITE_ORYN_ROOM_ID não é um UUID');

  const stunRaw = (env['VITE_ORYN_STUN_URLS'] ?? '').trim();
  const stun = stunRaw ? stunRaw.split(',').map((u) => u.trim()).filter(Boolean) : DEFAULT_STUN;
  if (stun.length > 4) throw new WebConfigError('VITE_ORYN_STUN_URLS: no máximo 4 URLs');
  for (const u of stun) if (parseIceUrl(u)?.scheme !== 'stun') throw new WebConfigError('VITE_ORYN_STUN_URLS: só URLs stun: (sem TURN nesta etapa)');

  const publicOrigin = parsePublicOrigin(env['VITE_ORYN_PUBLIC_ORIGIN']);

  const google = (env['VITE_ORYN_AUTH_GOOGLE'] ?? '').trim();
  if (google !== '' && google !== 'off' && google !== 'preview') throw new WebConfigError('VITE_ORYN_AUTH_GOOGLE: use off ou preview (o fluxo OAuth ainda não foi autorizado)');
  const googleAuth = google === 'preview' ? 'preview' : 'off';

  return { supabaseUrl: url, publishableKey: key, defaultRoomId: room || null, iceServers: [{ urls: stun }], publicOrigin, googleAuth };
}
