// packages/contracts/src/admin/audit.ts — CAP-040 cross-module audit seam.
//
// The audit_events table is owned by the admin module. The webhook route
// (apps/worker/src/http/routes/webhooks.ts) needs to emit an audit row
// ATOMICALLY with the messages UPDATE and webhook_deliveries INSERT it
// performs (D-CAP-029-A: a webhook status advance and its audit row must
// land in the same D1 batch — a crash between them cannot leave an
// unaudited transition).
//
// Per .claude/rules/architecture.md, the outbound-mail / routes code CANNOT
// import the admin module directly. The seam mirrors the existing pattern
// (BlocklistReader / RolePolicyReader for inbound-mail → admin): an
// interface declared in contracts, an implementation in
// apps/worker/src/modules/admin/audit-event-writer.ts, wired through
// apps/worker/src/app-context.ts (composition root).
//
// This is the WRITE counterpart to the inbound-mail reader seams — only
// the writer is in scope for CAP-040.
//
// CAP-044 Slice 2 (D-CAP-044-E, CAP-033 absorbed) adds the READ-side
// schemas at the bottom of this file: the audit-event row, the list
// envelope, and the query-params contract for
// GET /api/v1/admin/audit-events.
//
// The `Statement` interface below is intentionally a structural subset of
// D1's `D1PreparedStatement` — the contracts package does not depend on
// Cloudflare types (`tsconfig.json` sets `"types": []`), so the seam
// declares the surface it needs (`.bind(...).run()` or `.bind(...)` for
// batch inclusion) and the admin implementation casts at the boundary.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Statement surface — minimal subset of D1PreparedStatement.
// ---------------------------------------------------------------------------

/**
 * Minimal structural subset of `D1PreparedStatement` required by the seam.
 * The admin implementation casts a real `D1PreparedStatement` to this
 * shape so callers do not need to import a Cloudflare runtime type. The
 * contract is "the returned object is something you can pass into a D1
 * `db.batch([...])` call" — that is the only behaviour callers rely on.
 */
export interface D1StatementLike {
  readonly bind: (...args: unknown[]) => unknown;
}

// ---------------------------------------------------------------------------
// Audit action vocabulary — closed enum; adding a value is a deliberate change.
// ---------------------------------------------------------------------------
//
// The catalogue is the source of truth for every audit action code in the
// system. Existing entries are inherited from CAP-026 / CAP-027 / CAP-029;
// CAP-040 adds two for the new flows (reconciliation back-fill + admin
// secret reveal); CAP-043 Slice 3 fix (D-CAP-043-I) adds the two message
// presentation-state transitions — star toggle and per-user soft delete;
// CAP-047 adds the server draft lifecycle transitions; CAP-051 adds the
// scheduled attachment expiry transition.
export const auditActionSchema = z.enum([
  // CAP-026 / CAP-027 setup + admin
  'setup.claim',
  'setup.complete',
  // CAP-026 mailbox / message
  'mailbox.create',
  'message.receive',
  'message.send',
  // CAP-029 webhook receiver
  'webhook.delivered',
  // CAP-035 admin blocklist + role policies
  'blocklist.create',
  'blocklist.delete',
  'role_policy.set',
  // CAP-040 reconciliation + reveal
  'webhook_delivery.reconcile',
  'webhook_secret.reveal',
  // CAP-043 Slice 3 fix / D-CAP-043-I — message presentation state
  'message.star_toggled',
  'message.soft_deleted',
  // CAP-047 server draft-create slice — draft creation transition.
  'draft.created',
  // CAP-047 draft PATCH slice — draft update transition (D-CAP-047-PATCH).
  'draft.updated',
  // CAP-047 draft send slice — queue transition before provider delivery.
  'draft.sent',
  // CAP-049 attachment staging lifecycle creation.
  'attachment.uploaded',
  // CAP-050 attachment consume/send integration — each successful compose
  // writes one `attachment.consumed` audit row per attachment.
  'attachment.consumed',
  // CAP-051 scheduled cleanup — one row per uploaded attachment whose
  // CACHE bytes were removed and D1 lifecycle transitioned to expired.
  'attachment.expired',
]);

export type AuditAction = z.infer<typeof auditActionSchema>;

// ---------------------------------------------------------------------------
// Audit event input — matches the shape audit-event-repository consumes.
// ---------------------------------------------------------------------------

/**
 * The minimum columns needed to write an audit row. Mirrors
 * `AuditEventInput` in apps/worker/src/modules/admin/audit-event-repository.ts
 * verbatim — the seam declares the shape once so the admin module's
 * implementation does not need to be imported by callers.
 */
export interface AuditEventInput {
  readonly id: string;
  readonly actorUserId: string | null;
  readonly action: AuditAction;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly requestId?: string | null;
  readonly metadata?: string | null;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Cross-module write surface
// ---------------------------------------------------------------------------

/**
 * The outbound-mail route layer depends on this interface — never on the
 * admin module directly. Implementations live in
 * apps/worker/src/modules/admin/audit-event-writer.ts and are wired through
 * apps/worker/src/app-context.ts (composition root). Same shape as the
 * outbound provider registry (ADR-002).
 *
 * `prepare` returns a `D1StatementLike` so the caller can fold the
 * audit row into a `db.batch([...])` together with the business write(s)
 * (R-AUDIT-001 + D-CAP-029-A).
 */
export interface AuditEventWriter {
  prepare(input: AuditEventInput): { statement: D1StatementLike };
}

// ---------------------------------------------------------------------------
// Read-side schemas — CAP-044 Slice 2 (AC 12; CAP-033 absorbed, D-CAP-044-E).
// ---------------------------------------------------------------------------

/**
 * One row in the `GET /api/v1/admin/audit-events` response
 * (R-AUDIT-003/004). Field names are camelCase wire forms of the
 * `audit_events` columns.
 *
 * `metadata` is the stored JSON text, returned OPAQUE (`string | null`) —
 * the query surface neither parses nor rewrites it. It is the same R-DATA-005
 * exception the column declares: audit metadata is an opaque payload, not a
 * relational projection.
 *
 * `ip` is nullable and currently ALWAYS null: no audit writer in the
 * system populates it today (verified across every audit-event call
 * site at CAP-044 Slice 2 fix (f)). The field is reserved for future
 * request-IP capture and is returned as stored.
 */
export const auditEventSchema = z.object({
  id: z.string().uuid(),
  actorUserId: z.string().nullable(),
  action: auditActionSchema,
  resourceType: z.string().min(1).max(64),
  resourceId: z.string().nullable(),
  requestId: z.string().nullable(),
  metadata: z.string().nullable(),
  ip: z.string().nullable(),
  createdAt: z.string().min(1),
});

export type AuditEventItem = z.infer<typeof auditEventSchema>;

/**
 * Inner shape of the GET /api/v1/admin/audit-events response body (the
 * envelope's `data` object): `{ data: { items, nextCursor } }` — same
 * envelope/cursor convention as `messageListResponseSchema` (R-API-004/005).
 */
export const auditEventListResponseSchema = z.object({
  items: z.array(auditEventSchema),
  nextCursor: z.string().nullable(),
});

export type AuditEventListResponse = z.infer<typeof auditEventListResponseSchema>;

/**
 * Query parameters for GET /api/v1/admin/audit-events, validated at the
 * route boundary from the raw string query record.
 *
 * Filters are composable and each optional, with ONE pairing rule: a
 * resource filter arrives as the (`resourceType`, `resourceId`) PAIR —
 * `resourceType` without `resourceId` (or the reverse) is invalid input
 * (400), because "all events for every resource of a type" is not a
 * query this surface offers.
 *
 * `limit` is coerced from its string wire form; clamping to the page max
 * happens server-side in the repository (same contract as the messages
 * list, which validates shape here and clamps there).
 */
export const auditEventQueryParamsSchema = z
  .object({
    actorUserId: z.string().uuid().optional(),
    resourceType: z.string().trim().min(1).max(64).optional(),
    resourceId: z.string().trim().min(1).max(128).optional(),
    action: auditActionSchema.optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().positive().optional(),
  })
  .refine((params) => (params.resourceType === undefined) === (params.resourceId === undefined), {
    message: 'resourceType and resourceId must be supplied together',
  });

export type AuditEventQueryParams = z.infer<typeof auditEventQueryParamsSchema>;
