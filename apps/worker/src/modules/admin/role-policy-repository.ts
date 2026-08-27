// role-policy-repository — D-CAP-021 / CAP-035 / CAP-036.
// Owner: admin module. Private file — export through modules/admin/index.ts.
//
// R-INBOUND-006: per-role banEmail + availDomain policies. After CAP-036
// (0019_role_policy_normalize.sql) the legacy JSON columns are gone; the
// patterns live in role_policy_ban_emails / role_policy_avail_domains and
// role_policies is metadata-only (role_id PK, updated_by, updated_at).
//
// Reads are 3-query (metadata + ban patterns + avail patterns). Writes are
// a fixed 5-statement batch (delete ban, delete avail, set-based insert
// ban, set-based insert avail, metadata UPSERT). The set-based insert
// uses INSERT ... SELECT ?, value FROM json_each(?) WHERE type = 'text'
// so the bound JSON is transient transport only — the bound payload is
// one parameter per collection regardless of array length. D1's
// 100-bound-parameter-per-query limit applies to a single statement, so a
// 500-element array is 1 param + json_each expansion.

import type { Database } from '../../platform/database';
import { rolePolicySchema, type RolePolicy, type RolePolicyReader } from '@unimailbox/contracts';

export interface SetRolePolicyInput {
  readonly roleId: string;
  readonly banEmail: ReadonlyArray<string>;
  readonly availDomain: ReadonlyArray<string>;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

interface RolePolicyMetadataRow {
  readonly role_id: string;
  readonly updated_by: string | null;
  readonly updated_at: string;
}

interface RolePolicyPatternRow {
  readonly role_id: string;
  readonly pattern: string;
}

type RawRolePolicyRow = Record<string, unknown>;

/**
 * Returns the role policy for a single role, or `null` when the role has
 * not been explicitly configured. A role with no row has the implicit
 * default (banEmail=[], availDomain=[]) — callers must not synthesize an
 * empty row in storage, they just treat absence as default.
 *
 * Three bounded queries in one transactional read batch (CAP-036):
 *   1. metadata row
 *   2. banEmail patterns
 *   3. availDomain patterns
 *
 * Never JOIN the two child tables — they are independent one-to-many
 * collections over the same role_id, so joining them in a single query
 * would produce a Cartesian product.
 */
export async function getRolePolicy(db: Database, roleId: string): Promise<RolePolicy | null> {
  const [metadataResult, banResult, availResult] = await db.batch<RawRolePolicyRow>([
    db
      .prepare(
        `SELECT role_id, updated_by, updated_at
         FROM role_policies
         WHERE role_id = ?`,
      )
      .bind(roleId),
    db
      .prepare(
        `SELECT role_id, pattern
         FROM role_policy_ban_emails
         WHERE role_id = ?
         ORDER BY pattern`,
      )
      .bind(roleId),
    db
      .prepare(
        `SELECT role_id, pattern
         FROM role_policy_avail_domains
         WHERE role_id = ?
         ORDER BY pattern`,
      )
      .bind(roleId),
  ]);

  const metadataRows = requireBatchRows(metadataResult, 'metadata').map(parseMetadataRow);
  const banRows = requireBatchRows(banResult, 'banEmail').map(parsePatternRow);
  const availRows = requireBatchRows(availResult, 'availDomain').map(parsePatternRow);
  if (metadataRows.length > 1) {
    throw new Error(`Malformed role policy metadata result for role ${roleId}`);
  }
  const meta = metadataRows[0];
  if (!meta) {
    if (banRows.length > 0 || availRows.length > 0) {
      throw new Error(`Role policy child rows exist without metadata for role ${roleId}`);
    }
    return null;
  }
  assertRowsBelongToRole(roleId, [meta], banRows, availRows);

  return rolePolicySchema.parse({
    roleId: meta.role_id,
    banEmail: banRows.map((row) => row.pattern),
    availDomain: availRows.map((row) => row.pattern),
    updatedBy: meta.updated_by,
    updatedAt: meta.updated_at,
  });
}

/**
 * Loads role policies for a set of role IDs in one transactional batch of
 * three bounded queries (CAP-036). Group child rows in application code so
 * a multi-role read never JOINs the two one-to-many child tables.
 *
 * Used by the inbound-email entrypoint: lookup user → roleIds → policies,
 * then merge patterns across the recipient mailbox owners' roles.
 *
 * @param roleIds — Empty array returns an empty list — no SQL roundtrip.
 */
export async function loadRolePoliciesForRoleIds(
  db: Database,
  roleIds: ReadonlyArray<string>,
): Promise<ReadonlyArray<RolePolicy>> {
  if (roleIds.length === 0) return [];

  // D1 has no array-binding; expand to a parameterised IN list. Role IDs
  // are UUIDs injected from the user_roles table — bounded count, never
  // user-supplied raw SQL. N is small.
  const placeholders = roleIds.map(() => '?').join(', ');

  const [metadataResult, banResult, availResult] = await db.batch<RawRolePolicyRow>([
    db
      .prepare(
        `SELECT role_id, updated_by, updated_at
         FROM role_policies
         WHERE role_id IN (${placeholders})
         ORDER BY role_id`,
      )
      .bind(...roleIds),
    db
      .prepare(
        `SELECT role_id, pattern
         FROM role_policy_ban_emails
         WHERE role_id IN (${placeholders})
         ORDER BY role_id, pattern`,
      )
      .bind(...roleIds),
    db
      .prepare(
        `SELECT role_id, pattern
         FROM role_policy_avail_domains
         WHERE role_id IN (${placeholders})
         ORDER BY role_id, pattern`,
      )
      .bind(...roleIds),
  ]);

  const metadataRows = requireBatchRows(metadataResult, 'metadata').map(parseMetadataRow);
  const banRows = requireBatchRows(banResult, 'banEmail').map(parsePatternRow);
  const availRows = requireBatchRows(availResult, 'availDomain').map(parsePatternRow);
  const metadataRoleIds = new Set(metadataRows.map((row) => row.role_id));
  assertChildRowsHaveMetadata(metadataRoleIds, banRows, availRows);

  const bansByRole = groupPatternsByRole(banRows);
  const availsByRole = groupPatternsByRole(availRows);

  return metadataRows.map((meta) =>
    rolePolicySchema.parse({
      roleId: meta.role_id,
      banEmail: bansByRole.get(meta.role_id) ?? [],
      availDomain: availsByRole.get(meta.role_id) ?? [],
      updatedBy: meta.updated_by,
      updatedAt: meta.updated_at,
    }),
  );
}

/**
 * Cross-module read surface. Wired into AppContext as `rolePolicyReader`
 * so the inbound-mail module can load role policies without importing the
 * admin module directly. Returns hydrated `RolePolicy` objects — the
 * cross-module edge never exposes the raw storage row (CAP-036).
 */
export function createRolePolicyReader(db: Database): RolePolicyReader {
  return {
    async loadRolePoliciesForRoleIds(
      roleIds: ReadonlyArray<string>,
    ): Promise<ReadonlyArray<RolePolicy>> {
      return loadRolePoliciesForRoleIds(db, roleIds);
    },
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Build the five prepared statements that replace a role's policy. The
 * caller is expected to spread them into a `db.batch([...])` together
 * with the audit row and the idempotency record so the whole logical
 * operation lands atomically (R-AUDIT-001 + ADR-004 / CAP-027 / CAP-046).
 *
 * Statement shape (fixed order):
 *   1. DELETE existing banned-email rows for the role
 *   2. DELETE existing available-domain rows for the role
 *   3. INSERT ... SELECT banned-email rows from a transient JSON parameter
 *   4. INSERT ... SELECT available-domain rows from a transient JSON parameter
 *   5. INSERT OR REPLACE metadata row (role_id, updated_by, updated_at)
 *
 * The bound JSON parameter on statements 3 + 4 is transport only — it
 * never persists. json_each() expands the array inside SQLite; the
 * `WHERE type = 'text'` filter drops non-string elements defensively.
 * D1's 100-bound-parameter-per-query limit is not reached: each statement
 * has at most 3 bound parameters, regardless of array length.
 *
 * Empty arrays still DELETE existing child rows — no replacements are
 * inserted, and the metadata row is updated to the new (empty) policy.
 */
export function prepareSetRolePolicyBatch(
  db: Database,
  input: SetRolePolicyInput,
): ReadonlyArray<D1PreparedStatement> {
  const banJson = JSON.stringify(input.banEmail);
  const availJson = JSON.stringify(input.availDomain);

  return [
    db.prepare(`DELETE FROM role_policy_ban_emails WHERE role_id = ?`).bind(input.roleId),
    db.prepare(`DELETE FROM role_policy_avail_domains WHERE role_id = ?`).bind(input.roleId),
    db
      .prepare(
        `INSERT INTO role_policy_ban_emails (role_id, pattern)
         SELECT ?, je.value
           FROM json_each(?) AS je
           WHERE je.type = 'text'`,
      )
      .bind(input.roleId, banJson),
    db
      .prepare(
        `INSERT INTO role_policy_avail_domains (role_id, pattern)
         SELECT ?, je.value
           FROM json_each(?) AS je
           WHERE je.type = 'text'`,
      )
      .bind(input.roleId, availJson),
    db
      .prepare(
        `INSERT OR REPLACE INTO role_policies (role_id, updated_by, updated_at)
         VALUES (?, ?, ?)`,
      )
      .bind(input.roleId, input.updatedBy, input.updatedAt),
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function groupPatternsByRole(rows: ReadonlyArray<RolePolicyPatternRow>): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const list = map.get(row.role_id);
    if (list) {
      list.push(row.pattern);
    } else {
      map.set(row.role_id, [row.pattern]);
    }
  }
  return map;
}

function requireBatchRows(
  result: D1Result<RawRolePolicyRow> | undefined,
  collection: string,
): ReadonlyArray<RawRolePolicyRow> {
  if (!result || !Array.isArray(result.results)) {
    throw new Error(`Malformed role policy ${collection} batch result`);
  }
  return result.results;
}

function parseMetadataRow(row: RawRolePolicyRow): RolePolicyMetadataRow {
  if (
    typeof row.role_id !== 'string' ||
    (row.updated_by !== null && typeof row.updated_by !== 'string') ||
    typeof row.updated_at !== 'string'
  ) {
    throw new Error('Malformed role policy metadata row');
  }
  return {
    role_id: row.role_id,
    updated_by: row.updated_by,
    updated_at: row.updated_at,
  };
}

function parsePatternRow(row: RawRolePolicyRow): RolePolicyPatternRow {
  if (typeof row.role_id !== 'string' || typeof row.pattern !== 'string') {
    throw new Error('Malformed role policy pattern row');
  }
  return { role_id: row.role_id, pattern: row.pattern };
}

function assertRowsBelongToRole(
  roleId: string,
  metadataRows: ReadonlyArray<RolePolicyMetadataRow>,
  banRows: ReadonlyArray<RolePolicyPatternRow>,
  availRows: ReadonlyArray<RolePolicyPatternRow>,
): void {
  const rows = [...metadataRows, ...banRows, ...availRows];
  if (rows.some((row) => row.role_id !== roleId)) {
    throw new Error(`Role policy read mixed rows across roles for ${roleId}`);
  }
}

function assertChildRowsHaveMetadata(
  metadataRoleIds: ReadonlySet<string>,
  ...childCollections: ReadonlyArray<ReadonlyArray<RolePolicyPatternRow>>
): void {
  for (const row of childCollections.flat()) {
    if (!metadataRoleIds.has(row.role_id)) {
      throw new Error(`Role policy child rows exist without metadata for role ${row.role_id}`);
    }
  }
}
