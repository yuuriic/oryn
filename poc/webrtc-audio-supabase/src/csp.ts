// Política de conexões da página (SEC-01), resolvida no build a partir do endpoint configurado: nenhum URL do projeto
// fica no código versionado. O que não depende do projeto, como frame-ancestors, vai por cabeçalho HTTP (vercel.json);
// o <meta> não aceita frame-ancestors. As duas políticas não repetem nenhuma diretiva.

export const CSP_PLACEHOLDER = '__ORYN_PAGE_CSP__';

export interface PolicyOptions {
  /** Servidor de desenvolvimento do Vite: libera o WebSocket do recarregamento. */
  dev: boolean;
}

/** Endpoints aceitos: o projeto Supabase, ou o stack local no loopback. O cliente usa a mesma regra (config.ts). */
export function isSupabaseUrl(url: string): boolean {
  return /^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(url) || /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(url);
}

/** O Supabase usa HTTP(S) para Auth, RPC e Edge Functions e WS(S) para o Realtime, sempre no mesmo host. */
export function connectSources(url: string | undefined, { dev }: PolicyOptions): string[] {
  const sources = ["'self'"];
  const endpoint = (url ?? '').trim();
  if (endpoint) {
    if (!isSupabaseUrl(endpoint)) throw new Error('VITE_SUPABASE_URL fora do formato: política de conexões não gerada');
    sources.push(endpoint, endpoint.replace(/^http/, 'ws'));
  }
  if (dev) sources.push('ws://localhost:*', 'ws://127.0.0.1:*');
  return sources;
}

export function pagePolicy(url: string | undefined, options: PolicyOptions): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    `connect-src ${connectSources(url, options).join(' ')}`,
    "media-src 'self' blob: mediastream:",
    "img-src 'self' data:",
  ].join('; ');
}

export function applyPagePolicy(html: string, url: string | undefined, options: PolicyOptions): string {
  if (html.split(CSP_PLACEHOLDER).length !== 2) throw new Error(`index.html: marcador ${CSP_PLACEHOLDER} ausente ou repetido`);
  return html.replace(CSP_PLACEHOLDER, pagePolicy(url, options));
}
