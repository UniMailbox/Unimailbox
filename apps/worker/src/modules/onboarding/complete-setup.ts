// complete-setup use case — POST /api/v1/setup/complete. CAP-016.
// Owner: onboarding module. Private file — export through modules/onboarding/index.ts.
//
// CAP-017: Seeds roles and permissions, assigns administrator role to the first user,
// then flips installation_state.status to 'complete' and current_step to 'complete'.
// After this, the setup gate (CAP-006) stops redirecting — GET / returns the
// React app shell instead of 302.

import type { Database } from '../../platform/database';
import type { Clock } from '../../platform/clock';
import { systemIds } from '../../platform/ids';
import { seedRolesAndPermissions, prepareCreateAuditEvent } from '../admin';
import { getFirstUser } from '../identity';

export interface CompleteSetupInput {
  readonly db: Database;
  // CAP-046 / D-CAP-046-A: the request-id middleware-stamped UUID for
  // this /complete request. Threaded to the audit row so R-AUDIT-001's
  // correlation invariant holds for setup writes.
  readonly requestId: string | null;
}

export interface CompleteSetupResult {
  readonly status: 'complete';
}

/**
 * Completes the installation process.
 *
 * CAP-017: Seeds roles and permissions, assigns the administrator role to the first user,
 * then updates installation_state.status to 'complete' and current_step to 'complete'.
 *
 * The setup gate checks this status — when 'complete', it passes through to the
 * actual handler instead of redirecting to /setup.
 *
 * Seeding is split into two parts:
 * 1. seedRolesAndPermissions (idempotent via INSERT OR IGNORE)
 * 2. assignRole + status flip (atomic in a single D1 batch for correctness)
 */
export async function completeSetup(
  input: CompleteSetupInput,
  deps: { clock: Clock },
): Promise<CompleteSetupResult> {
  const now = deps.clock.now().toISOString().slice(0, 19).replace('T', ' ');

  // 1. Seed roles and permissions (idempotent, can run multiple times)
  // This generates 49 statements (21 permissions + 2 roles + 26 role_permissions)
  await seedRolesAndPermissions(input.db, now);

  // 2. Assign administrator role to the first user and flip status in one batch
  const admin = await getFirstUser(input.db);
  const stmts: D1PreparedStatement[] = [];

  if (admin) {
    stmts.push(
      input.db
        .prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_at) VALUES (?, ?, ?)')
        .bind(admin.id, 'administrator', now),
    );
  }

  // Flip status to complete
  stmts.push(
    input.db
      .prepare(
        'UPDATE installation_state SET status = ?, current_step = ?, updated_at = ? WHERE id = 1',
      )
      .bind('complete', 'complete', now),
  );

  // R-AUDIT-001 + CAP-046 / D-CAP-046-A + D-CAP-046-B: append the audit
  // row prepared statement to the same batch so the state flip and its
  // audit row land atomically. The audit row carries the request-id the
  // middleware stamped on the /complete request.
  stmts.push(
    prepareCreateAuditEvent(input.db, {
      id: systemIds.uuid(),
      actorUserId: admin?.id ?? null,
      action: 'setup.complete',
      resourceType: 'system',
      resourceId: null,
      requestId: input.requestId,
      createdAt: now,
    }),
  );

  // The batch is ALWAYS non-empty: the audit statement is unconditionally
  // pushed above, and the installation_state UPDATE is also unconditional.
  // The optional `user_roles` INSERT may or may not be present depending
  // on whether `getFirstUser` returned a row — but the two guaranteed
  // statements guarantee the batch carries at least the audit + UPDATE.
  // A future refactor that conditionally removes the UPDATE will not
  // silently load-bear this guard-less batch.
  await input.db.batch(stmts);

  return { status: 'complete' };
}
