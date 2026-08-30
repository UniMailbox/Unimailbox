// installation-state-repository — reads the single installation_state row.
// Owner: onboarding module. Private file — export through modules/onboarding/index.ts.
//
// The installation_state table has CHECK (id = 1) enforced at the database level,
// so there is at most one row. A missing row means the database is fresh and the
// setup wizard has not been claimed yet — callers receive null.

import {
  installationStateInfoSchema,
  type InstallationStateInfo,
  type InstallationStep,
} from '@unimailbox/contracts';
import type { Database } from '../../platform/database';

/**
 * Reads the installation_state row (id = 1). Returns null when the row does not
 * exist (fresh DB). The query is specific to id = 1 because the table enforces
 * CHECK (id = 1) — there is at most one row.
 *
 * The raw D1 row is validated through the zod schema from contracts rather than
 * cast with `as`, so schema drift or a manual DB edit produces a loud error
 * instead of silently passing through.
 */
export async function getInstallationState(db: Database): Promise<InstallationStateInfo | null> {
  const result = await db
    .prepare(
      `SELECT status, current_step
       FROM installation_state
       WHERE id = 1`,
    )
    .first<{ status: string; current_step: string }>();

  if (!result) {
    return null;
  }

  return installationStateInfoSchema.parse({
    status: result.status,
    currentStep: result.current_step,
  });
}

/**
 * Seeds the installation_state row (id = 1) if it does not exist.
 * Uses ON CONFLICT DO NOTHING for idempotency — does not overwrite an
 * existing row (R-SETUP-002). If the operator re-claims after session expiry,
 * the existing current_step is preserved.
 */
export async function seedInstallationState(
  db: Database,
  currentStep: InstallationStep,
  timestamp: string,
): Promise<void> {
  // CAP-046 / D-CAP-046-B: delegate to the prepare variant so the seed
  // statement can be folded into a db.batch with the audit row.
  await prepareSeedInstallationState(db, currentStep, timestamp).run();
}

/**
 * Returns a prepared INSERT statement for the installation_state row.
 * Use this when the seed must be atomic with other writes (e.g., the audit
 * row emitted by claim-setup). Mirrors `prepareUpdateInstallationStep`
 * below (same shape for batched vs. standalone callers).
 */
export function prepareSeedInstallationState(
  db: Database,
  currentStep: InstallationStep,
  timestamp: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO installation_state (id, status, current_step, schema_version, updated_at, created_at)
       VALUES (1, 'setup', ?, 1, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(currentStep, timestamp, timestamp);
}

/**
 * Returns a prepared UPDATE statement for the installation step. Use this
 * when the update must be atomic with other writes (e.g., user creation).
 */
export function prepareUpdateInstallationStep(
  db: Database,
  step: InstallationStep,
  timestamp: string,
): D1PreparedStatement {
  return db
    .prepare('UPDATE installation_state SET current_step = ?, updated_at = ? WHERE id = 1')
    .bind(step, timestamp);
}

/**
 * Returns a prepared UPDATE statement that ONLY fires when the row's
 * `current_step` matches `fromStep`. Used by the CAP-041 preflight hotfix
 * to make re-running preflight when the state already advanced a
 * zero-row update with no audit row. Batch the returned statement with
 * a conditional audit INSERT (e.g. `INSERT ... SELECT FROM
 * installation_state WHERE id = 1 AND current_step = ?`) so both
 * statements fire only on the same state predicate.
 */
export function prepareConditionalUpdateInstallationStep(
  db: Database,
  fromStep: InstallationStep,
  toStep: InstallationStep,
  timestamp: string,
): D1PreparedStatement {
  return db
    .prepare(
      'UPDATE installation_state SET current_step = ?, updated_at = ? WHERE id = 1 AND current_step = ?',
    )
    .bind(toStep, timestamp, fromStep);
}

/**
 * Updates the current_step of the single installation_state row (id = 1).
 * Used after each setup wizard step to advance the installation progress.
 */
export async function updateInstallationStep(
  db: Database,
  step: InstallationStep,
  timestamp: string,
): Promise<void> {
  await db
    .prepare('UPDATE installation_state SET current_step = ?, updated_at = ? WHERE id = 1')
    .bind(step, timestamp)
    .run();
}
