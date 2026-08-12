// installation-state-repository — reads the single installation_state row.
// Owner: onboarding module. Private file — export through modules/onboarding/index.ts.
//
// The installation_state table has CHECK (id = 1) enforced at the database level,
// so there is at most one row. A missing row means the database is fresh and the
// setup wizard has not been claimed yet — callers receive null.

import { installationStateInfoSchema, type InstallationStateInfo } from '@unimailbox/contracts';
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
export async function getInstallationState(
  db: Database,
): Promise<InstallationStateInfo | null> {
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
