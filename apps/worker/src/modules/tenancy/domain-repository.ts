// domain-repository — creates and reads managed domain rows.
// Owner: tenancy module. Private file — export through modules/tenancy/index.ts.
//
// R-DATA-001: managed_domains.name is case-insensitive (COLLATE NOCASE).
// ManagedDomain invariant: name is UNIQUE. New domains start as 'active'.
// outbound_connection_id is nullable — FK added when provider_connections exists.

import type { Database } from '../../platform/database';
import type { ManagedDomainStatus } from '@unimailbox/contracts';

export interface CreateDomainInput {
  readonly id: string;
  readonly name: string;
  readonly status: 'active' | 'disabled';
  readonly outboundConnectionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ManagedDomainInfo {
  readonly id: string;
  readonly name: string;
  readonly status: ManagedDomainStatus;
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

/**
 * Reads the first managed domain row. Returns null when no domain exists.
 * Used by setup to verify a domain was created before advancing the step.
 */
export async function getManagedDomain(db: Database): Promise<ManagedDomainInfo | null> {
  const result = await db
    .prepare(
      'SELECT id, name, status, created_at, updated_at FROM managed_domains ORDER BY created_at ASC, id ASC LIMIT 1',
    )
    .first<ManagedDomainStorageRow>();
  return result === null ? null : mapManagedDomain(result);
}

/** Lists every managed domain in a stable newest-first order. */
export async function listManagedDomains(db: Database): Promise<ManagedDomainInfo[]> {
  const result = await db
    .prepare(
      'SELECT id, name, status, created_at, updated_at FROM managed_domains ORDER BY created_at DESC, id DESC',
    )
    .all<ManagedDomainStorageRow>();
  return (result.results ?? []).map(mapManagedDomain);
}

/** Finds one managed domain by its opaque resource id. */
export async function findManagedDomainById(
  db: Database,
  id: string,
): Promise<ManagedDomainInfo | null> {
  const result = await db
    .prepare(
      'SELECT id, name, status, created_at, updated_at FROM managed_domains WHERE id = ? LIMIT 1',
    )
    .bind(id)
    .first<ManagedDomainStorageRow>();
  return result === null ? null : mapManagedDomain(result);
}

/** Returns the number of mailboxes that would be orphaned by a domain delete. */
export async function countMailboxesForDomain(db: Database, domainId: string): Promise<number> {
  const result = await db
    .prepare('SELECT COUNT(*) AS count FROM mailboxes WHERE domain_id = ?')
    .bind(domainId)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

/**
 * Deletes an unused domain. The mailbox predicate is repeated inside the
 * write so a concurrent mailbox creation cannot turn a preflight check into
 * an orphaned mailbox. The route follows this statement with the guard below
 * in the same D1 batch so a zero-row delete rolls the whole batch back.
 */
export function prepareDeleteDomain(db: Database, domainId: string): D1PreparedStatement {
  return db
    .prepare(
      'DELETE FROM managed_domains WHERE id = ? AND NOT EXISTS (SELECT 1 FROM mailboxes WHERE domain_id = ?)',
    )
    .bind(domainId, domainId);
}

/**
 * Fails a surrounding batch when the preceding guarded DELETE changed no
 * row. SQLite's changes() is scoped to the previous statement. The invalid
 * sentinel is inserted conditionally rather than updated so the guard also
 * fails when the target was the last row in managed_domains; an UPDATE would
 * silently affect zero rows in that case. The admin route maps the failed
 * batch to the stable post-race outcome.
 */
export function prepareRequireManagedDomainDeleted(db: Database): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO managed_domains
       (id, name, status, outbound_connection_id, created_at, updated_at)
     SELECT '__managed_domain_delete_guard__', '__managed_domain_delete_guard__', 'invalid', NULL,
            datetime('now'), datetime('now')
     WHERE changes() = 0`,
  );
}

interface ManagedDomainStorageRow {
  readonly id: string;
  readonly name: string;
  readonly status: ManagedDomainStatus;
  readonly created_at: string;
  readonly updated_at: string;
}

function mapManagedDomain(row: ManagedDomainStorageRow): ManagedDomainInfo {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
