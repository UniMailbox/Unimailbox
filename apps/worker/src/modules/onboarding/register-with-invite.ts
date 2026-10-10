// apps/worker/src/modules/onboarding/register-with-invite.ts — CAP-042 (AC 17).
//
// Extracted from the legacy `/api/v1/auth/register` handler so the use case
// is testable in isolation and so the atomic batch (user + credential +
// role + invite-use increment) is the canonical application surface.
//
// The four statements run in a single `db.batch([...])` call:
//   1. INSERT canonical `users` row                  (prepareCreateUser)
//   2. INSERT Better Auth `auth_accounts` row        (prepareCreateCredential)
//   3. INSERT `user_roles` row for the invite role  (prepareRoleInsert)
//   4. UPDATE `registration_keys.used_count += 1`   (prepareIncrementKeyUsage)
//
// All four commit or roll back together. The `registration_keys` BEFORE
// UPDATE trigger (migrations/0014) raises `RAISE(ABORT, ...)` when the
// invite is exhausted, which rolls the entire batch back.
//
// R-AUTH-001: `auth_accounts` is the canonical credential row; the verified-
//   email flow is gated by the factory (`requireEmailVerification: false`).
// R-AUTH-002: users.status is 'active' for the new user.
// R-AUTH-007 / R-AUTH-008 / R-AUTH-009 are enforced by the route layer's
//   zod parse and by the canonical `users.email COLLATE NOCASE` lookup.

import type { Database } from '../../platform/database';
import type { Clock } from '../../platform/clock';
import type { IdGenerator } from '../../platform/ids';
import type { EmailAddress } from '@unimailbox/contracts';
import { DomainError } from '../../platform/errors';
import { hashPassword } from '../../platform/crypto';
import { prepareCreateUser, prepareCreateCredential, encodeCredentialEnvelope } from '../identity';
import { prepareIncrementKeyUsage } from './registration-key-repository';

export interface RegisterWithInviteInput {
  readonly db: Database;
  readonly codeHash: string;
  readonly registrationKeyId: string;
  readonly email: EmailAddress;
  readonly password: string;
  readonly displayName: string | null;
}

export interface RegisterWithInviteDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface RegisterWithInviteResult {
  readonly userId: string;
  readonly credentialId: string;
  readonly assignedRoleId: string;
}

/**
 * Run the atomic invite-registration batch.
 *
 * The four prepared statements are returned in the order they must be
 * inserted into a `db.batch([...])`. Splitting construction from
 * execution lets the route layer append additional statements (idempotency,
 * audit) without coupling the use case to the batch.
 *
 * The batch is application-owned because D1 cannot run SQL transactions
 * (`spike-evidence.md` §D1 transaction and atomic registration result);
 * the `registration_keys.used_count` BEFORE UPDATE trigger converts
 * invite exhaustion into an in-batch SQLite ABORT, rolling the whole
 * batch back.
 *
 * @throws DomainError ROLE_NOT_FOUND when neither the invite's role_id nor
 *   the member fallback is present. The role check runs before the batch
 *   so a missing role does not waste a PBKDF2 hash.
 */
export async function registerWithInvite(
  input: RegisterWithInviteInput,
  deps: RegisterWithInviteDeps,
): Promise<RegisterWithInviteResult> {
  // Resolve the invite role. The legacy route hardcoded member; spike-evidence
  // §D1 transaction and atomic registration result says we now use
  // `role_id ?? member`. Resolve to a concrete role id BEFORE preparing the
  // batch so a missing role fails before PBKDF2 runs.
  const invite = await input.db
    .prepare(`SELECT role_id FROM registration_keys WHERE id = ?`)
    .bind(input.registrationKeyId)
    .first<{ role_id: string | null }>();
  if (!invite) {
    // Defensive backstop — the route layer's `findKeyByCodeHash` already
    // validated existence and we passed an explicit id. A 404 here means
    // the key was deleted between the lookup and the batch.
    throw new DomainError({
      code: 'REGISTRATION_CODE_INVALID',
      message: 'Invalid registration code',
      httpStatus: 409,
    });
  }
  const resolvedRoleId = invite.role_id ?? 'member';

  const role = await input.db
    .prepare(`SELECT id FROM roles WHERE id = ? LIMIT 1`)
    .bind(resolvedRoleId)
    .first<{ id: string }>();
  if (!role) {
    throw new DomainError({
      code: 'ROLE_NOT_FOUND',
      message: `Role '${resolvedRoleId}' not found`,
      httpStatus: 500,
    });
  }

  // Hash the password (PBKDF2-SHA256, 600k iterations — ADR-006).
  const passwordHash = await hashPassword(input.password);
  const credentialEnvelope = encodeCredentialEnvelope(passwordHash);
  const userId = deps.ids.uuid();
  // Canonical SQLite datetime for `users.created_at` / `users.updated_at`.
  const now = deps.clock.now().toISOString().slice(0, 19).replace('T', ' ');
  // Better Auth `auth_accounts` columns are integer epoch milliseconds.
  const nowMs = deps.clock.unixMs();

  // Prepare the four-statement batch. Order is fixed: the trigger's RAISE
  // fires inside the fourth statement and rolls back the first three.
  const insertUser = prepareCreateUser(input.db, {
    id: userId,
    email: input.email,
    displayName: input.displayName,
    status: 'active',
    passwordAlgorithm: passwordHash.algorithm,
    passwordIterations: passwordHash.iterations,
    passwordSalt: passwordHash.salt,
    passwordHash: passwordHash.hash,
    createdAt: now,
    updatedAt: now,
  });
  const insertCredential = prepareCreateCredential(input.db, {
    userId,
    envelope: credentialEnvelope,
    nowMs,
  });
  const insertRole = input.db
    .prepare(
      `INSERT INTO user_roles (user_id, role_id, granted_at, granted_by)
       VALUES (?, ?, ?, NULL)`,
    )
    .bind(userId, resolvedRoleId, now);
  const incrementInvite = prepareIncrementKeyUsage(input.db).bind(input.registrationKeyId);

  // Single batch — atomic across all four writes.
  await input.db.batch([insertUser, insertCredential, insertRole, incrementInvite]);

  return {
    userId,
    credentialId: `cap042-credential-${userId}`,
    assignedRoleId: resolvedRoleId,
  };
}
