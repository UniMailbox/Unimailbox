// packages/test-kit — unit tests only. The package itself is helpers; the
// contract does not require self-tests (see task.md §Scope). Leaving the
// project in place keeps the workspace uniform.
//
// CAP-004 added migrationsDb.worker.test.ts which depends on the
// `cloudflare:test` virtual module. That module only exists inside the
// worker pool (packages/test-kit/vitest.workers.config.ts), so we exclude
// `*.worker.test.ts` here to keep the unit (node) pool green.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'test-kit',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'dist/**', 'src/**/*.worker.test.ts'],
  },
});