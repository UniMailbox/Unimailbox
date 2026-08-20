// audit-event-repository — CAP-026 audit_events row writes.
// Owner: admin module. Private file — export through modules/admin/index.ts.
//
// R-AUDIT-001..004: every state transition writes an audit_events row.
// `createAuditEvent` is for standalone emits; `prepareCreateAuditEvent`
// returns a D1PreparedStatement for inclusion in a batch so the audit row
// can be written atomically with the business write.

import type { Database } from '../../platform/database';
import type { AuditAction } from '@unimailbox/contracts';

// R-AUDIT-001..004: every state transition writes an audit_events row.
// The `action` field is the CLOSED enum from
// packages/contracts/src/admin/audit.ts — adding an action there is a
// deliberate change, and the union type surfaces undeclared strings at the
// call site instead of letting them reach the database unvalidated.
// `AuditAction` is re-declared here (rather than re-imported as
// `AuditEventInput`) because this file also services the standalone
// `createAuditEvent` path used by admin-webhooks.ts, which has its own
// narrow input shape (e.g. the reveal endpoint does not set `metadata`).
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

/** Insert an audit event row. Use for standalone audit emits (outside a batch). */
export async function createAuditEvent(db: Database, input: AuditEventInput): Promise<void> {
  await db.prepare(
    `INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, request_id, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    input.id,
    input.actorUserId,
    input.action,
    input.resourceType,
    input.resourceId,
    input.requestId ?? null,
    input.metadata ?? null,
    input.createdAt,
  ).run();
}

/** Prepare an audit event insert for inclusion in a D1 batch. */
export function prepareCreateAuditEvent(db: Database, input: AuditEventInput): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, request_id, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    input.id,
    input.actorUserId,
    input.action,
    input.resourceType,
    input.resourceId,
    input.requestId ?? null,
    input.metadata ?? null,
    input.createdAt,
  );
}
