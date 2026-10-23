import { defineConfig } from 'vitest/config';

// Testes locais da POC-02C.1A: unitários (contratos, núcleo da Edge Function com mocks, recepção) e
// autorização SQL contra Postgres REAL em memória (PGlite) com um shim das peças do Supabase.
// Os testes contra o Supabase real (*.remote.test.ts) ficam FORA: só por `pnpm test:remote`.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'tests/remote/**', '**/*.remote.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
