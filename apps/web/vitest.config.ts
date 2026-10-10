// apps/web — unit + component tests (CAP-041).
// happy-dom for browser-context tests (React Testing Library),
// include both .test.ts and .test.tsx sources.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'web',
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', 'dist/**'],
    setupFiles: ['./src/test-setup.ts'],
  },
});
