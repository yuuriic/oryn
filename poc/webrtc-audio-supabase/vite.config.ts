import { defineConfig } from 'vite';

// Cliente web da integração 02C. Só em localhost (contexto seguro para o microfone, sem TLS): cada
// participante roda o próprio `pnpm dev`. Não há servidor exposto na rede nem hospedagem.
export default defineConfig({
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  // Só VITE_* chega ao bundle; config.ts recusa qualquer valor com cara de credencial administrativa.
  envPrefix: 'VITE_',
  build: { target: 'es2022', sourcemap: false },
});
