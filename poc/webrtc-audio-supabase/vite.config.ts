import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv } from 'vite';
import { applyPagePolicy } from './src/csp.ts';
import { assertDesktopBuild } from './src/desktop-build.ts';

// Os mesmos cabeçalhos da hospedagem (vercel.json) no dev e no preview: o que passa aqui passa com a política real.
const hosting = JSON.parse(readFileSync(new URL('./vercel.json', import.meta.url), 'utf8')) as { headers: { headers: { key: string; value: string }[] }[] };
const headers = Object.fromEntries(hosting.headers[0]!.headers.map((h) => [h.key, h.value]));

// Cliente web da integração 02C. No dev, só em localhost (contexto seguro para o microfone, sem TLS).
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  assertDesktopBuild(mode, env);
  return {
    plugins: [
      {
        name: 'oryn-page-policy',
        // Grava no <meta> as conexões do endpoint configurado neste build.
        transformIndexHtml: {
          order: 'pre' as const,
          handler: (html: string) => applyPagePolicy(html, env['VITE_SUPABASE_URL'], { dev: command === 'serve' }),
        },
      },
    ],
    server: { host: '127.0.0.1', port: 5173, strictPort: true, headers },
    preview: { host: '127.0.0.1', port: 4173, strictPort: true, headers },
    // Só VITE_* chega ao bundle; config.ts recusa qualquer valor com cara de credencial administrativa.
    envPrefix: 'VITE_',
    build: { target: 'es2022', sourcemap: false },
  };
});
