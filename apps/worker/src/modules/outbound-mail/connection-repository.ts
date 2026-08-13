// apps/worker/src/modules/outbound-mail/connection-repository.ts — CAP-014.
// Prepared statements for the provider_connections table. Used by the
// setupBrevo use case to store the provider connection after the API key
// is encrypted.
//
// ADR-002: Modules call adapters through the OutboundProviderAdapter
// interface. The connection stores which provider and which credential.

import type { D1Database } from '@cloudflare/workers-types';

export interface CreateConnectionInput {
  id: string;
  providerKey: string;
  label: string;
  credentialId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Prepare a D1 statement for inserting into provider_connections.
 *
 * Returns the prepared statement — the caller binds values and executes
 * (typically as part of a batch with credential creation and step advance).
 *
 * @param db — The D1 database binding
 * @param input — Connection values including provider key and credential reference
 * @returns A D1PreparedStatement ready to be bound and executed
 */
export function prepareCreateConnection(
  db: D1Database,
  input: CreateConnectionInput,
): D1PreparedStatement {
  return db.prepare(
    'INSERT INTO provider_connections (id, provider_key, label, credential_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    input.id,
    input.providerKey,
    input.label,
    input.credentialId,
    input.status,
    input.createdAt,
    input.updatedAt,
  );
}
