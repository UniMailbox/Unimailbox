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
// secret reveal).
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