import { defineConfig } from 'vitest/config';

// Servidor restrito a localhost: getUserMedia exige contexto seguro,
// e localhost é tratado como seguro pelos navegadores sem precisar de TLS.
export default defineConfig({
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: 'localhost',
    port: 4173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
