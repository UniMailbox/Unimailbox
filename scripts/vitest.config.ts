// scripts/ — operator-tooling tests (node pool).
// Covers tests for repo-root scripts: deploy.ts, db-migrate.ts, etc.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'scripts',
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      'apps/**',
      'packages/**',
    ],
  },
});
