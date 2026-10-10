// blocklist-repository — D-CAP-021 / CAP-035.
// Owner: admin module. Private file — export through modules/admin/index.ts.
//
// R-INBOUND-005: blocklist_entries holds subject/content/from patterns
// (case-insensitive substring). The admin module owns the table and
// exposes CRUD functions for the admin API surface; inbound-mail reads
// through the `BlocklistReader` factory created here and wired into
// AppContext (architecture edge: inbound-mail → admin via contracts).

import type { Database } from '../../platform/database';
import type { BlocklistEntryRow, BlocklistKind, BlocklistReader } from '@unimailbox/contracts';

export interface CreateBlocklistEntryInput {
  readonly id: string;
  readonly kind: BlocklistKind;
  readonly pattern: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

/**
 * Inserts a blocklist entry. R-INBOUND-005: kind ∈
 * {'subject' | 'content' | 'from'}, pattern is the raw case-insensitive
 * substring to match.
 *
 * @throws D1 error on CHECK constraint violation (e.g. empty pattern).
 */
export async function createBlocklistEntry(
  db: Database,
  input: CreateBlocklistEntryInput,
): Promise<void> {
  await prepareCreateBlocklistEntry(db, input).run();
}

/**
 * Build the prepared INSERT for a blocklist entry so the handler can fold
 * it into a `db.batch([...])` together with the audit row and the
 * idempotency record. CAP-035 / R-AUDIT-001.
 */
export function prepareCreateBlocklistEntry(
  db: Database,
  input: CreateBlocklistEntryInput,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO blocklist_entries (id, kind, pattern, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(input.id, input.kind, input.pattern, input.createdBy, input.createdAt);
}

/**
 * Lists all blocklist entries, newest first. The list view does not need
 * pagination at the expected scale (tens of entries).
 */
export async function listBlocklistEntries(
  db: Database,
): Promise<ReadonlyArray<BlocklistEntryRow>> {
  const rows = await db
    .prepare(
      `SELECT id, kind, pattern, created_by, created_at
       FROM blocklist_entries
       ORDER BY created_at DESC`,
    )
    .all<BlocklistEntryRow>();

  return rows.results ?? [];
}

/**
 * Deletes a blocklist entry by id. Returns true when a row was removed,
 * false when no row matched.
 */
export async function deleteBlocklistEntry(db: Database, id: string): Promise<boolean> {
  const result = await prepareDeleteBlocklistEntry(db, id).run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * Build the prepared DELETE for a blocklist entry so the handler can fold
 * it into a `db.batch([...])` together with the audit row and the
 * idempotency record. CAP-035 / R-AUDIT-001.
 */
export function prepareDeleteBlocklistEntry(db: Database, id: string): D1PreparedStatement {
  return db.prepare('DELETE FROM blocklist_entries WHERE id = ?').bind(id);
}

/**
 * Looks up a single blocklist entry by id. Returns the row when present,
 * or `null` when no row matches. Used by the DELETE route to decide
 * whether to fold an audit row into the same D1 batch as the DELETE — the
 * audit row only exists when the business write actually removed a row
 * (no audit for a 404).
 */
export async function findBlocklistEntryById(
  db: Database,
  id: string,
): Promise<BlocklistEntryRow | null> {
  const row = await db
    .prepare(
      `SELECT id, kind, pattern, created_by, created_at
       FROM blocklist_entries
       WHERE id = ?`,
    )
    .bind(id)
    .first<BlocklistEntryRow>();
  return row ?? null;
}

/**
 * Cross-module read surface. Wired into AppContext as `blocklistReader`
 * so the inbound-mail module can load the active list without importing
 * the admin module directly.
 */
export function createBlocklistReader(db: Database): BlocklistReader {
  return {
    async loadActiveBlocklistEntries(): Promise<ReadonlyArray<BlocklistEntryRow>> {
      return listBlocklistEntries(db);
    },
  };
}
