// Root vitest config — CAP-002.
// Defines the workspace of test projects for the whole monorepo. Each
// project is named and points at either a per-package config file or an
// inline configuration. apps/worker splits into `unit` (node pool) and
// `workers` (cloudflare pool). See work/active/CAP-002-test-harness/task.md §Scope.
//
// Coverage is configured here (the root), not per-project: vitest 4 projects
// mode honours `coverage` only in the root config. The threshold is the
// `lines` gate the contract asks for; branches/functions/statistics are
// intentionally not gated in CAP-002 and will be added when a feature
// capability demands them.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      './apps/worker/vitest.unit.config.ts',
      './apps/worker/vitest.workers.config.ts',
      './apps/web/vitest.config.ts',
      './packages/contracts/vitest.config.ts',
      './packages/email-core/vitest.config.ts',
      './packages/config/vitest.config.ts',
      './packages/test-kit/vitest.config.ts',
      './packages/test-kit/vitest.workers.config.ts',
      './scripts/vitest.config.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['apps/worker/src/platform/**/*.ts', 'packages/email-core/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/test/**', '**/dist/**', '**/node_modules/**'],
      thresholds: {
        lines: 70,
      },
    },
  },
});
