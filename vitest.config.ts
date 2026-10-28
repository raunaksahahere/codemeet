import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@codemeet/shared': path.resolve(__dirname, 'shared/src/index.ts'),
      '@codemeet/core': path.resolve(__dirname, 'core/src/index.ts'),
      '@codemeet/server': path.resolve(__dirname, 'server/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.codemeet/**'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Integration suites share one PostgreSQL server; each file creates its own database.
    fileParallelism: false,
    coverage: { reporter: ['text', 'lcov'] },
  },
});
