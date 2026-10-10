// packages/test-kit/src/seed.ts — worker-pool seeding helpers.
//
// Promotes the seed/reset helpers that were duplicated across setup-gate and
// setup-status test files (code-review MEDIUM, testing.md §Mocking: "Fixtures
// and builders live in packages/test-kit/, not copy-pasted per test file").
//
// Worker-pool only: uses `cloudflare:test` (reset) and `migrationsDb()`.

import type { InstallationStep } from '@unimailbox/contracts';
import { migrationsDb } from './migrationsDb';

/** Fixed timestamp for deterministic test seeding (testing.md §Determinism). */
export const FIXED_TIMESTAMP = '2026-01-01 00:00:00';

/**
 * Reset the worker-pool D1 and apply migrations. Equivalent to `reset()`
 * followed by `migrationsDb()`. Use in `beforeEach` for a clean, migrated DB.
 */
export async function resetAndMigrate(): Promise<void> {
  const { reset } = await import('cloudflare:test');
  await reset();
  await migrationsDb();
}

export interface SeedInstallationStateOptions {
  /** Installation status. Defaults to `'setup'`. */
  readonly status?: 'setup' | 'complete';
  /** Current setup-wizard step. Defaults to `'claim'`. */
  readonly currentStep?: InstallationStep;
}

/**
 * Seed the single `installation_state` row (id = 1). The row is absent after
 * `resetAndMigrate()` — call this when a test needs a non-fresh DB.
 *
 * Uses a fixed timestamp for determinism. `schema_version` is pinned to 1
 * (the initial migration version).
 */
export async function seedInstallationState(
  options: SeedInstallationStateOptions = {},
): Promise<void> {
  const { status = 'setup', currentStep = 'claim' } = options;
  const db = await migrationsDb();
  await db
    .prepare(
      `INSERT INTO installation_state (id, status, current_step, schema_version, updated_at, created_at)
       VALUES (1, ?, ?, 1, ?, ?)`,
    )
    .bind(status, currentStep, FIXED_TIMESTAMP, FIXED_TIMESTAMP)
    .run();
}
