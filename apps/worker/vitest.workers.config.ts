// apps/worker — workers project (@cloudflare/vitest-pool-workers).
// Tests run inside workerd against real D1/R2/KV/Queue bindings sourced from
// apps/worker/wrangler.test.jsonc. See .claude/rules/testing.md §Mocking — never
// mock the database; mock outbound provider HTTP at the adapter boundary.
//
// Naming convention: anything that needs real bindings is `*.worker.test.ts`.
// The unit project excludes everything matching that glob; this project
// includes only files matching it. Single rule, no hand-maintained list.
//
// Uses wrangler.test.jsonc (not wrangler.jsonc) to avoid Secrets Store bindings,
// which miniflare cannot populate with test values. Secrets are provided as
// plain vars instead; readSecret() handles both forms.
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: './wrangler.test.jsonc',
      },
    }),
  ],
  test: {
    name: 'workers',
    // CAP-045: include `test/**/*.worker.test.ts` so the preview-gate suite
    // (which needs the adjacent setup.ts spies) is discovered alongside the
    // `src/**` suite. Both globs share the worker-pool binding discipline.
    include: ['src/**/*.worker.test.ts', 'test/**/*.worker.test.ts'],
    exclude: ['**/node_modules/**', 'dist/**'],
    setupFiles: ['./test/setup.ts'],
  },
});
