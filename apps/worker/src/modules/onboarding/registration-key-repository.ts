// apps/worker/src/modules/onboarding/registration-key-repository.ts — CAP-018.
// Repository for registration_keys table. The code itself is never stored
// in plaintext — only the SHA-256 hash. This is the only place we read or
// write registration_keys in the onboarding module.
//
// Functions:
// - createRegistrationKey — INSERT a new key with hashed code
// - findKeyByCodeHash — SELECT by hash, returns row or null
// - prepareIncrementKeyUsage — returns D1PreparedStatement for UPDATE

import type { Database } from '../../platform/database';

/**
 * Input for creating a registration key. All fields except expiresAt are required.
 */
export interface CreateRegistrationKeyInput {
  id: string;
  codeHash: string;
  roleId: string | null;
  maxUses: number;
  createdBy: string;
  expiresAt: string | null;
  createdAt: string;
}

/**
 * Create a new registration key. The code_hash is stored, never the plaintext code.
 * Returns void on success; throws on error.
 */
export async function createRegistrationKey(
  db: Database,
  input: CreateRegistrationKeyInput,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO registration_keys (id, code_hash, role_id, max_uses, used_count, expires_at, revoked_at, created_by, created_at)
       VALUES (?, ?, ?, ?, 0, ?, NULL, ?, ?)`,
    )
    .bind(
      input.id,
      input.codeHash,
      input.roleId,
      input.maxUses,
      input.expiresAt,
      input.createdBy,
      input.createdAt,
    )
    .run();
}

/**
 * Registration key row shape as returned from the database.
 */
export interface RegistrationKeyRow {
  id: string;
  code_hash: string;
  role_id: string | null;
  max_uses: number;
  used_count: number;
  expires_at: string | null;
  revoked_at: string | null;
  created_by: string;
  created_at: string;
}

/**
 * Find a registration key by its code hash. Returns the row if found, null otherwise.
 * This is used during user registration to validate an invite code.
 */
export async function findKeyByCodeHash(
  db: Database,
  codeHash: string,
): Promise<RegistrationKeyRow | null> {
  const result = await db
    .prepare(
      `SELECT id, code_hash, role_id, max_uses, used_count, expires_at, revoked_at, created_by, created_at
       FROM registration_keys
       WHERE code_hash = ?`,
    )
    .bind(codeHash)
    .first<RegistrationKeyRow>();

  return result ?? null;
}

/**
 * Prepare a statement to increment the used_count for a key atomically.
 * The caller must execute the prepared statement with .bind(keyId).run().
 * This is used in the same D1 batch as user creation to ensure atomicity.
 */
export function prepareIncrementKeyUsage(db: Database): D1PreparedStatement {
  return db.prepare(`UPDATE registration_keys SET used_count = used_count + 1 WHERE id = ?`);
}
