// user-repository — creates a user row. Owner: identity module.
// Private file — export through modules/identity/index.ts.
//
// R-AUTH-002: users.status enum (active, banned, deleted).
// R-AUTH-009: users.email is case-insensitive (COLLATE NOCASE in DDL).
// ADR-006: Password stored as algorithm + iterations + salt + hash.

import type { Database } from '../../platform/database';
import type { EmailAddress } from '@unimailbox/contracts';

export interface CreateUserInput {
  readonly id: string;
  readonly email: EmailAddress;
  readonly displayName: string | null;
  readonly status: 'active' | 'banned' | 'deleted';
  readonly passwordAlgorithm: string;
  readonly passwordIterations: number;
  readonly passwordSalt: Uint8Array;
  readonly passwordHash: Uint8Array;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Inserts a user row into the users table.
 *
 * R-DATA-004: Uses parameterized query, never string concatenation.
 * BLOB columns accept Uint8Array via .bind().
 *
 * @throws D1 error with "UNIQUE constraint failed: users.email" on duplicate email.
 * The caller is responsible for catching this and mapping to 409 USER_EMAIL_TAKEN.
 */
/**
 * Returns a prepared INSERT statement for batching. Use this when the user
 * insert must be atomic with other writes (e.g., setup step advancement).
 * Otherwise use `createUser` which runs the statement directly.
 */
export function prepareCreateUser(db: Database, input: CreateUserInput): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO users (id, email, display_name, status,
        password_algorithm, password_iterations, password_salt, password_hash,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.email,
      input.displayName,
      input.status,
      input.passwordAlgorithm,
      input.passwordIterations,
      input.passwordSalt,
      input.passwordHash,
      input.createdAt,
      input.updatedAt,
    );
}

export async function createUser(db: Database, input: CreateUserInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (id, email, display_name, status,
        password_algorithm, password_iterations, password_salt, password_hash,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.email,
      input.displayName,
      input.status,
      input.passwordAlgorithm,
      input.passwordIterations,
      input.passwordSalt,
      input.passwordHash,
      input.createdAt,
      input.updatedAt,
    )
    .run();
}
