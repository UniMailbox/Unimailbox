// claim-setup use case — POST /api/v1/setup/claim.
// Owner: onboarding module. Private file — export through modules/onboarding/index.ts.
//
// The operator proves they hold INSTALLATION_TOKEN (deploy-time secret).
// In exchange, they receive a short-lived KV setup session token that
// authenticates all subsequent setup API calls. Wrong token → 401.
// Already complete → 409.

import type { Database } from '../../platform/database';
import type { SetupSessionStore } from '../../platform/cache';
import type { Clock } from '../../platform/clock';
import type { IdGenerator } from '../../platform/ids';
import { DomainError } from '../../platform/errors';
import { constantTimeCompare } from '../../platform/crypto';
import { prepareCreateAuditEvent } from '../admin';
import {
  getInstallationState,
  prepareSeedInstallationState,
} from './installation-state-repository';

export interface ClaimSetupInput {
  readonly db: Database;
  readonly setupSessionStore: SetupSessionStore;
  readonly expectedToken: string;
  readonly providedToken: string;
  // CAP-046 / D-CAP-046-A: the request-id middleware-stamped UUID for
  // this claim request. Threaded to the audit row so R-AUDIT-001's
  // correlation invariant holds for setup writes.
  readonly requestId: string | null;
}

export interface ClaimSetupResult {
  readonly sessionToken: string;
  readonly expiresIn: number;
}

const SESSION_TTL_SECONDS = 1800; // 30 minutes

/**
 * Claims the setup wizard by validating INSTALLATION_TOKEN and creating a
 * KV session. Returns a session token valid for 30 minutes.
 *
 * R-AUTH-001: The INSTALLATION_TOKEN is the sole credential for the initial claim.
 * Token comparison is constant-time per security.md §Passwords / ADR-006.
 * R-SETUP-002: A fresh DB (no row) is treated as setup — claim is allowed and seeds the row.
 * R-SECRET-003: Secrets are never logged.
 *
 * @throws DomainError with code SETUP_CLAIM_INVALID_TOKEN (401) if token is wrong.
 * @throws DomainError with code SETUP_ALREADY_COMPLETE (409) if installation is complete.
 */
export async function claimSetup(
  input: ClaimSetupInput,
  deps: { clock: Clock; ids: IdGenerator },
): Promise<ClaimSetupResult> {
  // Constant-time token comparison — never === (R-SECRET-001).
  if (!constantTimeCompare(input.providedToken, input.expectedToken)) {
    throw new DomainError({
      code: 'SETUP_CLAIM_INVALID_TOKEN',
      message: 'Invalid installation token',
      httpStatus: 401,
    });
  }

  // Reject if installation is already complete.
  const state = await getInstallationState(input.db);
  if (state?.status === 'complete') {
    throw new DomainError({
      code: 'SETUP_ALREADY_COMPLETE',
      message: 'Installation is already complete',
      httpStatus: 409,
    });
  }

  // Create KV session.
  const sessionToken = deps.ids.uuid();
  // SQLite datetime format: 'YYYY-MM-DD HH:MM:SS' — matches datetime('now')
  // default in the DDL and the test-kit FIXED_TIMESTAMP convention.
  const now = deps.clock.now().toISOString().slice(0, 19).replace('T', ' ');
  await input.setupSessionStore.put(sessionToken, JSON.stringify({ createdAt: now }), {
    expirationTtl: SESSION_TTL_SECONDS,
  });

  // Seed installation_state if absent (fresh DB) and emit the audit row
  // in the same D1 batch (CAP-046 / D-CAP-046-B). A crash between the
  // seed and the audit row would violate R-AUDIT-001 (state transition
  // without the matching audit entry) — folding closes the window.
  await input.db.batch([
    prepareSeedInstallationState(input.db, 'preflight', now),
    prepareCreateAuditEvent(input.db, {
      id: deps.ids.uuid(),
      actorUserId: null,
      action: 'setup.claim',
      resourceType: 'system',
      resourceId: null,
      requestId: input.requestId,
      createdAt: now,
    }),
  ]);

  return { sessionToken, expiresIn: SESSION_TTL_SECONDS };
}
