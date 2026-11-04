import { defineConfig } from 'vitest/config';

// Concorrência e compatibilidade em PostgreSQL 17 REAL embutido (02C.2B). Separado do `pnpm test` (PGlite)
// porque sobe um servidor Postgres local: `pnpm test:pg`. Roda no CI. Sem rede externa e sem credenciais.
export default defineConfig({
  test: {
    include: ['tests/pg/**/*.pg.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    retry: 0,
  },
});
