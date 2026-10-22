import { defineConfig } from 'vitest/config';

// Porta fixa usada por src-tauri/tauri.conf.json (build.devUrl). Escuta apenas em localhost.
export default defineConfig({
  clearScreen: false,
  server: {
    host: 'localhost',
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    // WebView2 Evergreen é Chromium recente; mantém o mesmo alvo da POC-01A.
    target: 'es2022',
    sourcemap: false,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
