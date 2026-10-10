// packages/email-core — unit tests only (pure RFC 5322 helpers).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'email-core',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'dist/**'],
  },
});
