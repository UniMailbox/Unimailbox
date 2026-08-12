// apps/worker — unit project (node pool, pure primitives).
// Excludes binding-backed tests, which run under the workers pool.
//
// Coverage is configured at the root vitest.config.ts only (vitest 4 projects
// mode ignores per-project coverage blocks). See vitest.config.ts for the
// actual configuration.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'unit',
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: [
      'src/**/*.worker.test.ts',
      '**/node_modules/**',
      'dist/**',
    ],
    setupFiles: ['./test/setup.ts'],
  },
});