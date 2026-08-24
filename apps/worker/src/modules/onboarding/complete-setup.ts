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
import { seedRolesAndPermissions, createAuditEvent } from '../admin';
import { getFirstUser } from '../identity';

export interface CompleteSetupInput {
  readonly db: Database;
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

  if (stmts.length > 0) {
    await input.db.batch(stmts);
  }

  // R-AUDIT-001: record the state transition.
  await createAuditEvent(input.db, {
    id: systemIds.uuid(),
    actorUserId: admin?.id ?? null,
    action: 'setup.complete',
    resourceType: 'system',
    resourceId: null,
    createdAt: now,
  });

  return { status: 'complete' };
}
