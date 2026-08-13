// apps/worker/src/modules/outbound-mail/credential-repository.ts — CAP-014.
// Prepared statements for the encrypted_credentials table. Used by the
// setupBrevo use case to store the encrypted provider API key.
//
// ADR-007: Provider API keys live in encrypted_credentials with AES-GCM.
// The prepared statements enable batch writes with the connection and
// installation step updates.

import type { D1Database } from '@cloudflare/workers-types';

export interface CreateCredentialInput {
  id: string;
  name: string;
  version: number;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
  createdAt: string;
  updatedAt: string;
}

/**
 * Prepare a D1 statement for inserting into encrypted_credentials.
 *
 * Returns the prepared statement — the caller binds values and executes
 * (typically as part of a batch).
 *
 * @param db — The D1 database binding
 * @param input — Credential values including the encrypted key material
 * @returns A D1PreparedStatement ready to be bound and executed
 */
export function prepareCreateCredential(
  db: D1Database,
  input: CreateCredentialInput,
): D1PreparedStatement {
  return db.prepare(
    'INSERT INTO encrypted_credentials (id, name, version, ciphertext, iv, auth_tag, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    input.id,
    input.name,
    input.version,
    input.ciphertext,
    input.iv,
    input.authTag,
    input.createdAt,
    input.updatedAt,
  );
}
