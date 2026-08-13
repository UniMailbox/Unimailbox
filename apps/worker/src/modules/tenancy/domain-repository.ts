// domain-repository — creates a managed domain row.
// Owner: tenancy module. Private file — export through modules/tenancy/index.ts.
//
// R-DATA-001: managed_domains.name is case-insensitive (COLLATE NOCASE).
// ManagedDomain invariant: name is UNIQUE. New domains start as 'active'.
// outbound_connection_id is nullable — FK added when provider_connections exists.

import type { Database } from '../../platform/database';

export interface CreateDomainInput {
  readonly id: string;
  readonly name: string;
  readonly status: 'active' | 'disabled';
  readonly outboundConnectionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Inserts a managed domain row into the managed_domains table.
 *
 * R-DATA-004: Uses parameterized query, never string concatenation.
 *
 * @throws D1 error with "UNIQUE constraint failed: managed_domains.name" on duplicate name.
 * The caller is responsible for catching this and mapping to 409 DOMAIN_ALREADY_MANAGED.
 */
/**
 * Returns a prepared INSERT statement for batching. Use this when the domain
 * insert must be atomic with other writes (e.g., setup step advancement).
 * Otherwise use `createDomain` which runs the statement directly.
 */
export function prepareCreateDomain(db: Database, input: CreateDomainInput): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO managed_domains (id, name, status, outbound_connection_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.name,
      input.status,
      input.outboundConnectionId,
      input.createdAt,
      input.updatedAt,
    );
}

export async function createDomain(db: Database, input: CreateDomainInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO managed_domains (id, name, status, outbound_connection_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.name,
      input.status,
      input.outboundConnectionId,
      input.createdAt,
      input.updatedAt,
    )
    .run();
}
