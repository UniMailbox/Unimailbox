// apps/worker/src/modules/admin/audit-event-writer.ts — CAP-040.
//
// Cross-module write seam for audit_events. The outbound-mail route layer
// cannot import the admin module directly (.claude/rules/architecture.md),
// so this file provides the only shape the rest of the codebase can use to
// fold an audit row into a D1 batch.
//
// The shape mirrors the inbound-mail → admin read seams
// (createBlocklistReader, createRolePolicyReader in this same module) and
// the outbound provider registry: an interface declared in
// packages/contracts, an implementation here, wired through
// apps/worker/src/app-context.ts (composition root).
//
// R-AUDIT-001 + D-CAP-029-A: the route handler must batch the messages
// UPDATE + webhook_deliveries INSERT + audit_events INSERT in ONE
// `db.batch([...])`. The HTTP error envelope must NOT be touched here —
// this is a write-side helper, the existing error middleware handles
// translation.

import type { Database } from '../../platform/database';
import type { AuditEventInput, AuditEventWriter, D1StatementLike } from '@unimailbox/contracts';
import { prepareCreateAuditEvent } from './audit-event-repository';

/**
 * Wrap the existing `prepareCreateAuditEvent` (already batch-friendly,
 * CAP-026) inside the contracts-declared `AuditEventWriter` shape so the
 * outbound-mail route handler can read it off `AppContext` and stay
 * inside the architecture rules.
 *
 * The single method `prepare` returns a structural-subset object
 * (`D1StatementLike`) ready to be passed to `db.batch([...])`. The
 * admin implementation casts the real `D1PreparedStatement` at the
 * seam boundary because the contracts package deliberately does not
 * depend on Cloudflare runtime types (see `packages/contracts/tsconfig.json`
 * `"types": []`). The caller is responsible for assigning the id +
 * createdAt — same pattern as `prepareCreateAuditEvent`.
 */
export function createAuditEventWriter(db: Database): AuditEventWriter {
  return {
    prepare(
      input: AuditEventInput,
      guard?: { readonly idempotencyMarkerId: string },
    ): { statement: D1StatementLike } {
      const prepared = guard
        ? db
            .prepare(
              `INSERT INTO audit_events
          (id, actor_user_id, action, resource_type, resource_id, request_id, metadata, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM idempotency_records WHERE id = ?)`,
            )
            .bind(
              input.id,
              input.actorUserId,
              input.action,
              input.resourceType,
              input.resourceId,
              input.requestId ?? null,
              input.metadata ?? null,
              input.createdAt,
              guard.idempotencyMarkerId,
            )
        : prepareCreateAuditEvent(db, input);
      return { statement: prepared as unknown as D1StatementLike };
    },
  };
}
