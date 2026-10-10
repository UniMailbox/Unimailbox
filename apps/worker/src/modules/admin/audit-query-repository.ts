// audit-query-repository — read-side queries for audit_events.
// Owner: admin module. Private file — export through modules/admin/index.ts.
//
// CAP-044 Slice 2 (AC 9; CAP-033 absorbed, D-CAP-044-E): composable filters
// + cursor pagination for GET /api/v1/admin/audit-events.
//
// R-AUDIT-003/004: the query surface is READ-ONLY. Rows are immutable and
// returned as stored — `metadata` is the opaque JSON text, never parsed or
// re-shaped here. No mutation is offered on this surface.
//
// R-API-005 (same convention as the messages list): the cursor is an
// HMAC-SHA-256 signed `(createdAt, id, surface)` token; this endpoint's
// surface is 'audit-events' (CAP-044 Slice 2 fix (d)) so a cursor minted
// by another paginated API cannot be replayed here. A tampered, malformed,
// or cross-surface cursor surfaces as AuditCursorInvalidError; the route
// maps it to a stable 400 INVALID_CURSOR envelope. The repository receives
// the resolved key string from the route and never reads the env directly.
//
// Index shaping (fix pass (a)): one statement per ACTIVE filter
// combination. Each set filter appends a bare parameterized predicate
// (`actor_user_id = ?`; `resource_type = ? AND resource_id = ?` as a
// pair; `action = ?`) so the plan chosen at prepare time can select
// `audit_events_actor_idx (actor_user_id, created_at DESC)` or
// `audit_events_resource_idx (resource_type, resource_id, created_at
// DESC)`; an unfiltered walk uses `audit_events_created_idx`. A
// `? IS NULL OR …` guard around a FILTER column defeats index selection —
// the plan never changes with bindings, so that shape always scans (the
// Slice 2 review's EXPLAIN QUERY PLAN finding on this table, the one
// append-only unbounded-growth table billed by D1 rows-read). The
// null-bound slots appear ONLY around the cursor boundary, exactly the
// message-read-repository precedent. SQL fragments are fixed strings;
// user values only ever go through .bind().

import type { Database } from '../../platform/database';
import { auditActionSchema, type AuditAction, type AuditEventItem } from '@unimailbox/contracts';
import { signCursor, verifyCursor } from '../../platform/cursor';

/**
 * Thrown when the client-supplied cursor cannot be verified. The route
 * catches this and renders 400 INVALID_CURSOR. Malformed and tampered
 * tokens are observationally equivalent; one error code keeps the API
 * surface stable (R-API-002 / R-API-005).
 */
export class AuditCursorInvalidError extends Error {
  constructor() {
    super('Audit event cursor is invalid or tampered with');
    this.name = 'AuditCursorInvalidError';
  }
}

/**
 * Thrown when a stored audit row violates the read contract — an
 * `action` outside the closed `AuditAction` enum (a legacy row whose
 * enum value was later removed, a rogue writer, or a manual D1 insert).
 * The route maps this to 500 AUDIT_ROW_INVALID. Rows are never silently
 * skipped: this is a forensic surface (R-AUDIT-003), and a
 * contract-violating row must surface as a visible server-side error
 * rather than a 200 the client page dies parsing (fix pass (b)).
 */
export class AuditRowInvalidError extends Error {
  constructor(rowId: string, action: string) {
    super(`Audit event row ${rowId} carries unknown action ${JSON.stringify(action)}`);
    this.name = 'AuditRowInvalidError';
  }
}

/**
 * Thrown when a caller supplies exactly one half of the
 * (`resourceType`, `resourceId`) pair. The route's zod schema rejects
 * the half pair with 400 VALIDATION_ERROR before this can fire; the
 * guard exists so the exported repository contract is honest — a half
 * pair is a programming error, never a silent "match nothing"
 * (fix pass (c)).
 */
export class AuditFilterPairError extends Error {
  constructor() {
    super('resourceType and resourceId must be supplied together');
    this.name = 'AuditFilterPairError';
  }
}

/**
 * Composable filters. The (`resourceType`, `resourceId`) pair must arrive
 * together — the route's zod schema enforces the pair rule (400 when one
 * is supplied without the other), and the repository itself THROWS
 * `AuditFilterPairError` on a half pair (fix pass (c)) so the exported
 * contract is honest; "no resource filter" means BOTH are absent.
 */
export interface AuditEventFilters {
  actorUserId?: string;
  resourceType?: string;
  resourceId?: string;
  action?: AuditAction;
}

export interface AuditEventQueryResult {
  items: AuditEventItem[];
  nextCursor: string | null;
}

interface AuditEventRow {
  id: string;
  actor_user_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  request_id: string | null;
  metadata: string | null;
  ip: string | null;
  created_at: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 50;

/**
 * Lists audit events, newest first, with cursor pagination (R-AUDIT-003).
 *
 * The cursor is verified BEFORE the page query runs: nothing the client
 * sent can be misinterpreted as a valid page boundary. Filters compose
 * as bare equality predicates per ACTIVE filter (see "Index shaping"
 * above); the cursor boundary alone uses null-bound slots so the same
 * statement serves both the first page and cursor continuations.
 *
 * `limit` is clamped here (default 50, max 50) — the contract validates
 * shape at the route boundary, clamping is a server-side policy, same
 * contract as the messages list.
 *
 * @param db — D1 database binding (admin module owns audit_events)
 * @param filters — composable, each optional; resource pair together
 * @param opts — cursor + limit + signing key (resolved by the route)
 */
export async function queryAuditEvents(
  db: Database,
  filters: AuditEventFilters,
  opts: { cursor?: string; limit?: number; cursorSigningKey: string },
): Promise<AuditEventQueryResult> {
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  // Pair rule (fix pass (c)): a half-set resource pair is a programming
  // error, not a silent no-match. See AuditFilterPairError.
  const hasResourceType = filters.resourceType !== undefined;
  const hasResourceId = filters.resourceId !== undefined;
  if (hasResourceType !== hasResourceId) {
    throw new AuditFilterPairError();
  }

  let cursorCreatedAt: string | null = null;
  let cursorId: string | null = null;
  if (opts.cursor !== undefined && opts.cursor.length > 0) {
    // Fix pass (d): 'audit-events' is this endpoint's surface; a cursor
    // minted by the messages API fails verification here.
    const verified = await verifyCursor(opts.cursor, opts.cursorSigningKey, 'audit-events');
    if (verified === null) {
      throw new AuditCursorInvalidError();
    }
    cursorCreatedAt = verified.createdAt;
    cursorId = verified.id;
  }

  // Per-shape WHERE composition (fix pass (a)). Binds are appended in
  // the same order as their predicates — see "Index shaping" above.
  const where: string[] = [];
  const binds: Array<string | number | null> = [];

  if (filters.actorUserId !== undefined) {
    where.push('actor_user_id = ?');
    binds.push(filters.actorUserId);
  }
  // Direct undefined checks (not the boolean flags) so TypeScript narrows
  // both halves of the pair to string for the binds below; the pair-rule
  // guard above has already ruled out the half-set case.
  if (filters.resourceType !== undefined && filters.resourceId !== undefined) {
    where.push('resource_type = ? AND resource_id = ?');
    binds.push(filters.resourceType, filters.resourceId);
  }
  if (filters.action !== undefined) {
    where.push('action = ?');
    binds.push(filters.action);
  }
  // Cursor boundary only (R-API-005): null-bound slots when no cursor
  // rides the request — the predicate is a no-op and the page starts at
  // the top. This is the messages-list precedent, verbatim.
  where.push('(? IS NULL OR (created_at < ? OR (created_at = ? AND id < ?)))');
  binds.push(cursorCreatedAt, cursorCreatedAt, cursorCreatedAt, cursorId);

  const rows = await db
    .prepare(
      `SELECT id, actor_user_id, action, resource_type, resource_id,
              request_id, metadata, ip, created_at
         FROM audit_events
        WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .bind(...binds, limit)
    .all<AuditEventRow>();

  // Fix pass (b): the server-side enum detection point. A row whose
  // action sits outside the closed AuditAction enum must fail HERE —
  // typed, visible, 500 — never 200-and-crash-the-client-on-parse, and
  // never a silently skipped row (forensic surface, R-AUDIT-003).
  const items: AuditEventItem[] = [];
  for (const row of rows.results ?? []) {
    const action = auditActionSchema.safeParse(row.action);
    if (!action.success) {
      throw new AuditRowInvalidError(row.id, row.action);
    }
    items.push({
      id: row.id,
      actorUserId: row.actor_user_id,
      action: action.data,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      requestId: row.request_id,
      // R-AUDIT-003: metadata is returned as the stored JSON text, opaque.
      metadata: row.metadata,
      ip: row.ip,
      createdAt: row.created_at,
    });
  }

  // Next cursor only when the page was full (more may follow). Signed with
  // the same key the request verified with so the chain is end-to-end.
  let nextCursor: string | null = null;
  if (items.length === limit && items.length > 0) {
    const last = items[items.length - 1];
    if (last) {
      nextCursor = await signCursor(
        { createdAt: last.createdAt, id: last.id, surface: 'audit-events' },
        opts.cursorSigningKey,
      );
    }
  }

  return { items, nextCursor };
}
