import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/*/tests/**/*.test.ts', 'scripts/tests/**/*.test.mjs'],
    restoreMocks: true,
    unstubGlobals: true,
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
