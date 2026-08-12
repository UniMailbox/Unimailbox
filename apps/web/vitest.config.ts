// apps/web — unit tests only (no Cloudflare pool; pure TS utilities).
// Component tests deferred until a feature page lands in CAP-006+.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'web',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'dist/**'],
  },
});