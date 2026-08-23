import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@core': resolve('src/core'),
      '@renderer': resolve('src/renderer'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    environmentMatchGlobs: [['tests/renderer/**', 'jsdom']],
    coverage: {
      provider: 'v8',
      include: ['src/core/**', 'src/shared/**'],
      reporter: ['text', 'lcov'],
    },
  },
});
