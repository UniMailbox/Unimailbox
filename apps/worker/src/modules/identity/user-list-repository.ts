// user-list-repository — read-side query for the admin users list.
// Owner: identity module. Private file — export through
// modules/identity/index.ts.
//
// CAP-044 Slice 3 (AC 15; D-CAP-044-H): the users table stays
// identity-owned; the admin route consumes this public read through the
// allowed admin → identity edge (the same pattern the admin module's
// own audit query uses — no cross-module table access, ever).
//
// R-SECRET-003 / AC 16: the SELECT enumerates EXACTLY the five
// non-credential columns (id, email, display_name, status, created_at).
// The users table also carries password_algorithm,
// password_iterations, password_salt, password_hash — those columns are
// NEVER selected here, so they cannot leak into a response even if a
// future row-mapping change fat-fingers a field name. The contracts
// schema (userListItemSchema) is additionally .strict() so a leaked key
// cannot parse client-side either.
//
// AC 16 status clause: `status` exists (migration 0001, R-AUTH-002
// CHECK) and is returned as stored. Soft-deleted users (status
// 'deleted') remain visible — this is an administrative personnel read,
// not a public directory; hiding them would make un-deletion workflows
// and incident forensics impossible.
//
// R-API-005 (same convention as the messages and audit-events lists):
// the cursor is an HMAC-SHA-256 signed `(createdAt, id, surface)`
// token; this endpoint's surface is 'admin-users' so a cursor minted by
// another paginated API cannot be replayed here (CAP-044 Slice 2 fix
// (d)). A tampered, malformed, or cross-surface cursor surfaces as
// UserCursorInvalidError; the route maps it to a stable 400
// INVALID_CURSOR envelope. The repository receives the resolved key
// string from the route and never reads the env directly.
//
// Index note: users has no created_at index (only users_email_unique
// and users_status_idx). Unlike the append-only audit_events table, a
// deployment's users table is bounded by its personnel, so the keyset
// walk scans a small table; adding users_created_idx would be
// speculative until a deployment proves otherwise.

import { userStatusSchema, type UserListItem } from '@unimailbox/contracts';
import type { Database } from '../../platform/database';
import { signCursor, verifyCursor } from '../../platform/cursor';

/**
 * Thrown when the client-supplied cursor cannot be verified. The route
 * catches this and renders 400 INVALID_CURSOR. Malformed and tampered
 * tokens are observationally equivalent; one error code keeps the API
 * surface stable (R-API-002 / R-API-005).
 */
export class UserCursorInvalidError extends Error {
  constructor() {
    super('Admin users cursor is invalid or tampered with');
    this.name = 'UserCursorInvalidError';
  }
}

/**
 * Thrown when a stored user row violates the read contract — a `status`
 * outside the users.status CHECK (a rogue writer or a manual D1 edit).
 * The route maps this to 500 USER_ROW_INVALID. Rows are never silently
 * skipped, mirroring the audit-query-repository precedent (CAP-044
 * Slice 2 fix pass (b)): a contract-violating row must surface as a
 * visible server-side error rather than a 200 the client page dies
 * parsing.
 */
export class UserRowInvalidError extends Error {
  constructor(rowId: string, status: string) {
    super(`User row ${rowId} carries unknown status ${JSON.stringify(status)}`);
    this.name = 'UserRowInvalidError';
  }
}

export interface UserListResult {
  items: UserListItem[];
  nextCursor: string | null;
}

interface UserListRow {
  id: string;
  email: string;
  display_name: string | null;
  status: string;
  created_at: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 50;

/**
 * Lists users, newest first, with cursor pagination (AC 15).
 *
 * The cursor is verified BEFORE the page query runs: nothing the client
 * sent can be misinterpreted as a valid page boundary. The users list
 * has no filters (keyset ordering only), so the WHERE clause is the
 * cursor boundary alone — null-bound slots when no cursor rides the
 * request, exactly the message-read-repository / audit-query-repository
 * precedent. SQL is a fixed string; user values only ever go through
 * .bind().
 *
 * `limit` is clamped here (default 50, max 50) — the contract validates
 * shape at the route boundary, clamping is a server-side policy, same
 * contract as the sibling list endpoints.
 *
 * @param db — D1 database binding (identity module owns users)
 * @param opts — cursor + limit + signing key (resolved by the route)
 */
export async function listUsers(
  db: Database,
  opts: { cursor?: string; limit?: number; cursorSigningKey: string },
): Promise<UserListResult> {
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  let cursorCreatedAt: string | null = null;
  let cursorId: string | null = null;
  if (opts.cursor !== undefined && opts.cursor.length > 0) {
    // 'admin-users' is this endpoint's surface; a cursor minted by the
    // messages or audit-events API fails verification here.
    const verified = await verifyCursor(opts.cursor, opts.cursorSigningKey, 'admin-users');
    if (verified === null) {
      throw new UserCursorInvalidError();
    }
    cursorCreatedAt = verified.createdAt;
    cursorId = verified.id;
  }

  // R-SECRET-003: explicit column enumeration — the password columns
  // are not selected, so they cannot appear in any response.
  const rows = await db
    .prepare(
      `SELECT id, email, display_name, status, created_at
         FROM users
        WHERE (? IS NULL OR (created_at < ? OR (created_at = ? AND id < ?)))
     ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .bind(cursorCreatedAt, cursorCreatedAt, cursorCreatedAt, cursorId, limit)
    .all<UserListRow>();

  // Server-side enum detection point (the audit-query-repository
  // precedent): a row whose status sits outside the closed enum fails
  // HERE — typed, visible, 500 — never 200-and-crash-the-client-on-parse,
  // never a silently skipped row.
  const items: UserListItem[] = [];
  for (const row of rows.results ?? []) {
    const status = userStatusSchema.safeParse(row.status);
    if (!status.success) {
      throw new UserRowInvalidError(row.id, row.status);
    }
    items.push({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      status: status.data,
      createdAt: row.created_at,
    });
  }

  // Next cursor only when the page was full (more may follow). Signed
  // with the same key the request verified with so the chain is
  // end-to-end.
  let nextCursor: string | null = null;
  if (items.length === limit && items.length > 0) {
    const last = items[items.length - 1];
    if (last) {
      nextCursor = await signCursor(
        { createdAt: last.createdAt, id: last.id, surface: 'admin-users' },
        opts.cursorSigningKey,
      );
    }
  }

  return { items, nextCursor };
}
