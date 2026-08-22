// apps/worker/drizzle.config.ts — CAP-004.
// drizzle-kit config. The typed schemas in src/database/schema/* are
// referenced here so `pnpm exec drizzle-kit check` can compare them
// against what a future migration would generate. CAP-004 ships with
// no auto-generated SQL: migrations are hand-written and reviewed. Once
// a later capability decides otherwise, the generator writes to
// migrations/ and the runner picks them up.
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/database/schema/index.ts',
  out: '../../migrations/drizzle',
  dialect: 'sqlite',
});
