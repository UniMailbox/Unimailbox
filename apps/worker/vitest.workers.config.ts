// apps/worker — workers project (@cloudflare/vitest-pool-workers).
// Tests run inside workerd against real D1/R2/KV/Queue bindings sourced from
// apps/worker/wrangler.jsonc. See .claude/rules/testing.md §Mocking — never
// mock the database; mock outbound provider HTTP at the adapter boundary.
//
// Naming convention: anything that needs real bindings is `*.worker.test.ts`.
// The unit project excludes everything matching that glob; this project
// includes only files matching it. Single rule, no hand-maintained list.
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: './wrangler.jsonc',
      },
    }),
  ],
  test: {
    name: 'workers',
    include: ['src/**/*.worker.test.ts'],
    exclude: ['**/node_modules/**', 'dist/**'],
    setupFiles: ['./test/setup.ts'],
  },
});