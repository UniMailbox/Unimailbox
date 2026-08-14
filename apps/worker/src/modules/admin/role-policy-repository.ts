// role-policy-repository — D-CAP-021 / CAP-035.
// Owner: admin module. Private file — export through modules/admin/index.ts.
//
// R-INBOUND-006: role_policies holds banEmail + availDomain JSON arrays per
// role. One row per role (PRIMARY KEY = role_id). Empty arrays mean "allow
// all" for availDomain; banEmail is empty by default. R-DATA-005 is relaxed
// for these two columns — see migrations/0010_*.sql deferred-normalization
// comment.

import type { Database } from '../../platform/database';
import type {
  RolePolicy,
  RolePolicyReader,
  RolePolicyRow,
} from '@unimailbox/contracts';

export interface SetRolePolicyInput {
  readonly roleId: string;
  readonly banEmail: ReadonlyArray<string>;
  readonly availDomain: ReadonlyArray<string>;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

/**
 * Returns the role policy for a single role, or `null` when the role has
 * not been explicitly configured. A role with no row has the implicit
 * default (banEmail=[], availDomain=[]) — callers must not synthesize an
 * empty row in storage, they just treat absence as default.
 */
export async function getRolePolicy(
  db: Database,
  roleId: string,
): Promise<RolePolicy | null> {
  const row = await db
    .prepare(
      `SELECT role_id, ban_email_patterns_json, avail_domain_patterns_json,
              updated_by, updated_at
       FROM role_policies
       WHERE role_id = ?`,
    )
    .bind(roleId)
    .first<RolePolicyRow>();

  if (!row) return null;
  return rowToPolicy(row);
}

/**
 * Replaces both arrays atomically (PUT semantics — full replace, no
 * merge). Implemented as INSERT OR REPLACE so the same single statement
 * works whether the row already exists or not. role_id is the PRIMARY KEY,
 * so REPLACE is unambiguous.
 */
export async function setRolePolicy(
  db: Database,
  input: SetRolePolicyInput,
): Promise<RolePolicy> {
  await prepareSetRolePolicy(db, input).run();
  return {
    roleId: input.roleId,
    banEmail: [...input.banEmail],
    availDomain: [...input.availDomain],
    updatedBy: input.updatedBy,
    updatedAt: input.updatedAt,
  };
}

/**
 * Build the prepared INSERT OR REPLACE for a role policy so the handler
 * can fold it into a `db.batch([...])` together with the audit row and
 * the idempotency record. CAP-035 / R-AUDIT-001.
 */
export function prepareSetRolePolicy(
  db: Database,
  input: SetRolePolicyInput,
): D1PreparedStatement {
  const banJson = JSON.stringify(input.banEmail);
  const availJson = JSON.stringify(input.availDomain);
  return db
    .prepare(
      `INSERT OR REPLACE INTO role_policies
         (role_id, ban_email_patterns_json, avail_domain_patterns_json,
          updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(input.roleId, banJson, availJson, input.updatedBy, input.updatedAt);
}

/**
 * Loads role policies for a set of role IDs in a single query. Used by
 * the inbound-email entrypoint: lookup user → roleIds → policies, then
 * merge patterns across the recipient mailbox owners' roles.
 *
 * @param roleIds — Empty array returns an empty list — no SQL roundtrip.
 */
export async function loadRolePoliciesForRoleIds(
  db: Database,
  roleIds: ReadonlyArray<string>,
): Promise<ReadonlyArray<RolePolicyRow>> {
  if (roleIds.length === 0) return [];

  // D1 has no array-binding; expand to a parameterised IN list. Role IDs
  // are UUIDs injected from the user_roles table — bounded count, never
  // user-supplied raw SQL. N is small.
  const placeholders = roleIds.map(() => '?').join(', ');
  const rows = await db
    .prepare(
      `SELECT role_id, ban_email_patterns_json, avail_domain_patterns_json,
              updated_by, updated_at
       FROM role_policies
       WHERE role_id IN (${placeholders})`,
    )
    .bind(...roleIds)
    .all<RolePolicyRow>();

  return rows.results ?? [];
}

/**
 * Cross-module read surface. Wired into AppContext as `rolePolicyReader`
 * so the inbound-mail module can load role policies without importing the
 * admin module directly.
 */
export function createRolePolicyReader(db: Database): RolePolicyReader {
  return {
    async loadRolePoliciesForRoleIds(
      roleIds: ReadonlyArray<string>,
    ): Promise<ReadonlyArray<RolePolicyRow>> {
      return loadRolePoliciesForRoleIds(db, roleIds);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parsePatterns(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === 'string');
  } catch {
    // Defensive: a malformed JSON row must not crash the evaluator. Treat
    // as "no patterns" so the message is allowed under that role. This is
    // logged at the boundary where the row is read.
    return [];
  }
}

function rowToPolicy(row: RolePolicyRow): RolePolicy {
  return {
    roleId: row.role_id,
    banEmail: parsePatterns(row.ban_email_patterns_json),
    availDomain: parsePatterns(row.avail_domain_patterns_json),
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}