// vitest config — CAP-002 will fill in real test files.
// This file exists today so the @cloudflare/vitest-pool-workers pool can be
// loaded by the test runner; an empty defineWorkersConfig({}) is enough.
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
      },
    },
  },
});