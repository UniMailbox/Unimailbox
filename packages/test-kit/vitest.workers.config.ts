// packages/test-kit — workers project (@cloudflare/vitest-pool-workers).
// Exercises the migrationsDb() fixture against a real D1 binding. Reuses
// apps/worker/wrangler.jsonc which already declares the DB binding; we
// point at it via absolute path so test-kit has no per-package wrangler
// config to maintain.
//
// Naming convention: tests that need real bindings are `*.worker.test.ts`.
// The matching node-pool config (vitest.config.ts) excludes that glob.
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_WRANGLER = resolve(HERE, '../../apps/worker/wrangler.jsonc');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: WORKER_WRANGLER,
      },
    }),
  ],
  test: {
    name: 'test-kit-workers',
    include: ['src/**/*.worker.test.ts'],
    exclude: ['**/node_modules/**', 'dist/**'],
  },
});
