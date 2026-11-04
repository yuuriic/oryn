import { defineConfig } from 'vitest/config';

// Harness de integração com o Supabase REAL (02C.1B). Só pelo `pnpm test:remote`, e mesmo assim tudo fica
// pulado sem ORYN_REMOTE=1 (tests/remote/remote-env.ts). Sequencial e sem repetição automática: cada
// execução gasta cadastros anônimos (limite por IP) e um convite de criador de uso único.
export default defineConfig({
  test: {
    include: ['tests/remote/**/*.remote.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    retry: 0,
  },
});
