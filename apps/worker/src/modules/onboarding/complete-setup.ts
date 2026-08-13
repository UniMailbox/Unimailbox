// complete-setup use case — POST /api/v1/setup/complete. CAP-016.
// Owner: onboarding module. Private file — export through modules/onboarding/index.ts.
//
// Flips installation_state.status to 'complete' and current_step to 'complete'.
// After this, the setup gate (CAP-006) stops redirecting — GET / returns the
// React app shell instead of 302.

import type { Database } from '../../platform/database';
import type { Clock } from '../../platform/clock';

export interface CompleteSetupInput {
  readonly db: Database;
}

export interface CompleteSetupResult {
  readonly status: 'complete';
}

/**
 * Completes the installation process.
 *
 * Updates installation_state.status to 'complete' and current_step to 'complete'.
 * The setup gate checks this status — when 'complete', it passes through to the
 * actual handler instead of redirecting to /setup.
 */
export async function completeSetup(
  input: CompleteSetupInput,
  deps: { clock: Clock },
): Promise<CompleteSetupResult> {
  const now = deps.clock.now().toISOString().slice(0, 19).replace('T', ' ');
  await input.db
    .prepare(
      'UPDATE installation_state SET status = ?, current_step = ?, updated_at = ? WHERE id = 1',
    )
    .bind('complete', 'complete', now)
    .run();

  return { status: 'complete' };
}
