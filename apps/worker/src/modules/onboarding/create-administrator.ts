// create-administrator use case — POST /api/v1/setup/administrator.
// Owner: onboarding module. Private file — export through modules/onboarding/index.ts.
//
// The operator creates the first user (the initial administrator) with a
// PBKDF2-hashed password. After successful creation, the installation step
// advances from 'administrator' to 'domain'.
//
// The user insert + step update are batched as one D1 transaction (coding.md
// §Data: "Multi-row writes that must be atomic go in a single D1 batch").
// If either fails, both roll back — preventing a wedged setup state where
// the user exists but the step didn't advance.

import type { Database } from '../../platform/database';
import type { Clock } from '../../platform/clock';
import type { IdGenerator } from '../../platform/ids';
import type { EmailAddress } from '@unimailbox/contracts';
import { DomainError } from '../../platform/errors';
import { hashPassword } from '../../platform/crypto';
import { prepareCreateUser } from '../identity';
import { prepareUpdateInstallationStep } from './installation-state-repository';

export interface CreateAdministratorInput {
  readonly db: Database;
  readonly email: EmailAddress;
  readonly password: string;
  readonly displayName: string | null;
}

export interface CreateAdministratorResult {
  readonly userId: string;
}

/**
 * D1's UNIQUE constraint violation message for the users.email index.
 * Used as a defensive backstop for race conditions. The primary guard is
 * the existence check at the top of the use case.
 */
const UNIQUE_EMAIL_VIOLATION = 'UNIQUE constraint failed: users.email';

/**
 * Creates the administrator user and advances the installation step to 'domain'.
 *
 * R-AUTH-002: users.status is 'active' for the new administrator.
 * ADR-006: Password is hashed with PBKDF2-SHA256, 600k iterations.
 *
 * @throws DomainError SETUP_ADMINISTRATOR_EXISTS (409) if a user already exists.
 * @throws DomainError USER_EMAIL_TAKEN (409) on race-condition duplicate email.
 */
export async function createAdministrator(
  input: CreateAdministratorInput,
  deps: { clock: Clock; ids: IdGenerator },
): Promise<CreateAdministratorResult> {
  // Guard: only one administrator can be created via setup.
  // Check BEFORE hashing (saves ~600ms PBKDF2 on rejected calls).
  const existing = await input.db.prepare('SELECT 1 FROM users LIMIT 1').first();
  if (existing) {
    throw new DomainError({
      code: 'SETUP_ADMINISTRATOR_EXISTS',
      message: 'An administrator has already been created',
      httpStatus: 409,
    });
  }

  const passwordHash = await hashPassword(input.password);
  const userId = deps.ids.uuid();
  // SQLite datetime format: 'YYYY-MM-DD HH:MM:SS' — matches datetime('now')
  // default in the DDL and the test-kit FIXED_TIMESTAMP convention.
  const now = deps.clock.now().toISOString().slice(0, 19).replace('T', ' ');

  // Prepare both statements and run them as one D1 batch (atomic).
  // If either fails, both roll back — preventing a wedged setup state.
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
  const advanceStep = prepareUpdateInstallationStep(input.db, 'domain', now);

  try {
    await input.db.batch([insertUser, advanceStep]);
  } catch (err) {
    // Defensive backstop: race condition where two requests pass the
    // existence check simultaneously. D1's UNIQUE constraint catches this.
    if (err instanceof Error && err.message.includes(UNIQUE_EMAIL_VIOLATION)) {
      throw new DomainError({
        code: 'USER_EMAIL_TAKEN',
        message: 'A user with this email already exists',
        httpStatus: 409,
      });
    }
    throw err;
  }

  return { userId };
}
