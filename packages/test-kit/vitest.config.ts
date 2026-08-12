// packages/test-kit — unit tests only. The package itself is helpers; the
// contract does not require self-tests (see task.md §Scope). Leaving the
// project in place keeps the workspace uniform.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'test-kit',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'dist/**'],
  },
});