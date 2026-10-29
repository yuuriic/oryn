import { defineConfig } from 'vitest/config';

// O frontend é servido pelo próprio servidor da POC (server/index.ts) a partir de dist/,
// no mesmo host/porta da sinalização. Não há dev server exposto na rede.
export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
