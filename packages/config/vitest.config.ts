// packages/config — unit tests only (typed config shapes).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'config',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'dist/**'],
  },
});