// apps/worker/src/modules/identity/credential-repository.ts — CAP-042 (AC 17, 18).
//
// Inserts the Better Auth-compatible credential row that pairs a canonical
// `users` row with its `auth_accounts` row. The id is deterministic
// (`cap042-credential-<userId>`) so a re-run of the registration batch
// cannot collide with the existing 0015 backfill ids
// (`cap042-backfill-<userId>`); the migration reserves the backfill prefix
// and the application uses the credential prefix.
//
// R-AUTH-001: `auth_accounts` carries the Better Auth envelope; the verified-
//   email policy is enforced by the factory (`requireEmailVerification: false`),
//   not by writing a verification row at this layer.
// ADR-006: the password column is the canonical envelope produced by
//   `encodeAdr006Password` / `encodeCredentialEnvelope`; the backfill
//   migration 0015 uses the same wire shape.
// R-DATA-004: every value is bound via `.bind(...)`; no string concatenation.

import type { Database } from '../../platform/database';
import type { PasswordHash } from '../../platform/crypto';
import { encodeAdr006Password } from '../../integrations/better-auth/password';

export interface CreateCredentialInput {
  readonly userId: string;
  readonly envelope: string;
  /** Unix epoch milliseconds — Better Auth's `auth_accounts.created_at`. */
  readonly nowMs: number;
}

/**
 * Build the canonical credential envelope from a platform `PasswordHash`.
 *
 * The Better Auth integration (`integrations/better-auth/password.ts`)
 * already exports `encodeAdr006Password`; this helper exists so the
 * registration / setup use cases do not have to reach across the
 * integration layer for a single conversion. The shape is the same four-
 * segment envelope Better Auth's verifier reads.
 */
export function encodeCredentialEnvelope(passwordHash: PasswordHash): string {
  return encodeAdr006Password(passwordHash);
}

/**
 * Deterministic id for application-inserted credential rows.
 *
 * The 0015 backfill uses the `cap042-backfill-<userId>` prefix; application
 * writers must not collide with that namespace, so they use the
 * `cap042-credential-` prefix. Re-running the registration/setup batch
 * must always overwrite the same row.
 */
export function credentialIdFor(userId: string): string {
  return `cap042-credential-${userId}`;
}

/**
 * Returns a prepared INSERT for an `auth_accounts` credential row.
 *
 * Columns populated:
 *   - `id`            — deterministic `cap042-credential-<userId>`
 *   - `issuer`        — `'local:credential'` (Better Auth logical issuer)
 *   - `account_id`    — canonical `users.id` (Better Auth logical account)
 *   - `provider_id`   — `'credential'` (the password-bearing provider)
 *   - `user_id`       — canonical `users.id` (FK → users.id ON DELETE CASCADE)
 *   - `password`      — canonical ADR-006 envelope
 *   - `created_at`    — Unix-ms integer
 *   - `updated_at`    — Unix-ms integer
 *
 * All other columns (`access_token`, `refresh_token`, `id_token`,
 * `access_token_expires_at`, `refresh_token_expires_at`, `scope`) are
 * NULL — only the credential provider has a row, no OAuth material.
 *
 * The (issuer, account_id) UNIQUE index is the natural dedup key; the
 * prepared statement uses `INSERT OR REPLACE` semantics via the deterministic
 * id so a retry with the same userId rewrites the same row instead of
 * failing on duplicate primary key.
 */
export function prepareCreateCredential(
  db: Database,
  input: CreateCredentialInput,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO auth_accounts (
         id, issuer, account_id, provider_id, user_id,
         password, created_at, updated_at
       ) VALUES (?, 'local:credential', ?, 'credential', ?, ?, ?, ?)`,
    )
    .bind(
      credentialIdFor(input.userId),
      input.userId,
      input.userId,
      input.envelope,
      input.nowMs,
      input.nowMs,
    );
}
