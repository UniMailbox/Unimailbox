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
  readonly mustChangePassword?: boolean;
  readonly initialPasswordExpiresAt?: string | null;
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
        created_at, updated_at, must_change_password, initial_password_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      input.mustChangePassword ? 1 : 0,
      input.initialPasswordExpiresAt ?? null,
    );
}

export async function createUser(db: Database, input: CreateUserInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (id, email, display_name, status,
        password_algorithm, password_iterations, password_salt, password_hash,
        created_at, updated_at, must_change_password, initial_password_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      input.mustChangePassword ? 1 : 0,
      input.initialPasswordExpiresAt ?? null,
    )
    .run();
}

/**
 * Gets the first user (administrator) created during setup.
 * Returns null if no user exists.
 */
export async function getFirstUser(db: Database): Promise<{ id: string; email: string } | null> {
  return db
    .prepare('SELECT id, email FROM users ORDER BY created_at LIMIT 1')
    .first<{ id: string; email: string }>();
}

/**
 * Full user row shape including password columns.
 * Used by login to verify credentials.
 *
 * Note: D1 returns BLOB columns as ArrayBuffer, not Uint8Array.
 */
export interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  status: 'active' | 'banned' | 'deleted';
  password_algorithm: string;
  password_iterations: number;
  password_salt: ArrayBuffer;
  password_hash: ArrayBuffer;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  must_change_password: number;
  initial_password_expires_at: string | null;
}

/**
 * Find a user by email address.
 *
 * R-DATA-001: email is case-insensitive (COLLATE NOCASE in DDL).
 * Returns the full user row including password columns for verification.
 *
 * @param db — D1 database binding
 * @param email — Email address to look up (case-insensitive)
 * @returns User row if found, null otherwise
 */
export async function findUserByEmail(db: Database, email: string): Promise<UserRow | null> {
  const result = await db
    .prepare(
      `SELECT id, email, display_name, status,
              password_algorithm, password_iterations, password_salt, password_hash,
              created_at, updated_at, deleted_at,
              must_change_password, initial_password_expires_at
       FROM users
       WHERE email = ?`,
    )
    .bind(email)
    .first<UserRow>();

  return result ?? null;
}

export interface ManagedUserInput {
  readonly id: string;
  readonly email: EmailAddress;
  readonly displayName: string | null;
  readonly passwordAlgorithm: string;
  readonly passwordIterations: number;
  readonly passwordSalt: Uint8Array;
  readonly passwordHash: Uint8Array;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly initialPasswordExpiresAt: string;
  readonly grantedBy: string;
}

/**
 * Atomically creates an admin-managed member account and its initial role.
 * The caller supplies a PBKDF2 hash; plaintext passwords never cross this
 * repository boundary. Role assignment is kept in the same D1 batch so an
 * account cannot be created without the member role.
 */
export async function createManagedUser(db: Database, input: ManagedUserInput): Promise<void> {
  await db.batch(prepareCreateManagedUser(db, input));
}

/**
 * Returns the user and default-member-role statements for an admin-created
 * account. Callers that also need an audit/idempotency record can append these
 * statements to the same D1 batch.
 */
export function prepareCreateManagedUser(
  db: Database,
  input: ManagedUserInput,
): D1PreparedStatement[] {
  const user = prepareCreateUser(db, {
    ...input,
    status: 'active',
    mustChangePassword: true,
  });
  const role = db
    .prepare(
      `INSERT INTO user_roles (user_id, role_id, granted_by, granted_at)
       VALUES (?, 'member', ?, ?)`,
    )
    .bind(input.id, input.grantedBy, input.createdAt);
  return [user, role];
}

export function prepareUpdatePassword(
  db: Database,
  input: {
    userId: string;
    passwordAlgorithm: string;
    passwordIterations: number;
    passwordSalt: Uint8Array;
    passwordHash: Uint8Array;
    updatedAt: string;
    mustChangePassword: boolean;
    initialPasswordExpiresAt?: string | null;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE users
       SET password_algorithm = ?, password_iterations = ?, password_salt = ?, password_hash = ?,
           updated_at = ?, must_change_password = ?, initial_password_expires_at = ?
       WHERE id = ?`,
    )
    .bind(
      input.passwordAlgorithm,
      input.passwordIterations,
      input.passwordSalt,
      input.passwordHash,
      input.updatedAt,
      input.mustChangePassword ? 1 : 0,
      input.initialPasswordExpiresAt ?? null,
      input.userId,
    );
}

export function prepareUpdateUserStatus(
  db: Database,
  userId: string,
  status: UserRow['status'],
  updatedAt: string,
): D1PreparedStatement {
  return db
    .prepare(`UPDATE users SET status = ?, updated_at = ?, deleted_at = ? WHERE id = ?`)
    .bind(status, updatedAt, status === 'deleted' ? updatedAt : null, userId);
}

export async function findUserById(db: Database, userId: string): Promise<UserRow | null> {
  return db
    .prepare(
      `SELECT id, email, display_name, status,
              password_algorithm, password_iterations, password_salt, password_hash,
              created_at, updated_at, deleted_at,
              must_change_password, initial_password_expires_at
       FROM users WHERE id = ?`,
    )
    .bind(userId)
    .first<UserRow>();
}

export async function setMustChangePassword(
  db: Database,
  userId: string,
  mustChangePassword: boolean,
  expiresAt: string | null,
  updatedAt: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE users SET must_change_password = ?, initial_password_expires_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(mustChangePassword ? 1 : 0, expiresAt, updatedAt, userId)
    .run();
}

/**
 * Lightweight user info shape (no password columns).
 * Returned by login/register/me endpoints.
 */
export interface UserInfo {
  id: string;
  email: string;
  displayName: string | null;
}
