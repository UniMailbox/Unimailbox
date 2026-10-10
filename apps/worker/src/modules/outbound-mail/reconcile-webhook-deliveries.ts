// reconcile-webhook-deliveries — CAP-040 early-event reconciliation.
//
// Owner: outbound-mail module. Private file — export through
// modules/outbound-mail/index.ts.
//
// Brevo (and every outbound provider) can deliver a webhook event BEFORE
// the queue consumer has finished sending the message — the provider returns
// the canonical `providerMessageId` on its send response, and an `accepted`
// event can fire milliseconds later. The CAP-029 webhook processor resolves
// `messageId` by joining on `outbound_jobs.provider_message_id`, but the job
// row does not yet carry the provider id when the event arrives (the
// consumer writes it on `markOutboundJobSent` AFTER the adapter returns).
//
// To prevent losing the event when the join misses, the processor persists
// the `webhook_deliveries` row with `message_id = NULL` (so the row is
// durable) and reconciliation back-fills `message_id` and replays its status
// once the canonical provider id becomes known. `processOutboundJob` calls
// `reconcileWebhookDeliveries` AFTER `markOutboundJobSent`.
//
// The use case is split in two:
//   - `prepareReconciliationStatements` builds the batch statements for the
//     caller to fold into a D1 batch (the audit row, per-delivery link and
//     status UPDATEs). Returning prepared statements keeps the contract
//     atomic — the reconciliation either fully applies or fully fails.
//   - The plain `reconcileWebhookDeliveries` runs those statements in one
//     D1 batch for callers without a larger transaction.
//
// The reconciliation is idempotent: the `WHERE message_id IS NULL`
// predicate on each UPDATE means a second reconciliation pass finds nothing
// to update, and the audit row uses the unique delivery ids in its metadata
// so two passes are distinguishable from one pass with no rows.
//
// CAP-040 / R-AUDIT-001: every reconciliation run that the caller commits
// writes an audit row recording the providerMessageId, the count of rows
// back-filled, and the delivery ids that were updated. The audit row lives
// even when the reconciliation is a no-op (count=0) so the operator has a
// full trail.
//
// Note: the audit row is built inside the same D1 batch as the back-fill
// UPDATEs. If the batch fails, neither the back-fills nor the audit row
// land (R-AUDIT-001 is satisfied — the audit reflects reality, not the
// attempt). Callers that batch this with their own writes inherit the same
// atomicity. The standalone `reconcileWebhookDeliveries` wrapper below also
// includes the audit row in that batch.

import type { Database } from '../../platform/database';
import type { AuditEventWriter } from '@unimailbox/contracts';
import { systemIds } from '../../platform/ids';
import { prepareUpdateMessageStatus } from '../messages';
import {
  findUnmatchedDeliveriesByProviderMessageId,
  prepareBackfillDeliveryMessageId,
} from './webhook-repository';

export interface ReconcileResult {
  /** Number of webhook_deliveries rows whose message_id was back-filled. */
  readonly backfilled: number;
  /** IDs of the rows that were updated (NOT logged per R-LOG-001). */
  readonly backfilledIds: ReadonlyArray<string>;
}

/**
 * Find unmatched webhook deliveries for the given providerMessageId and
 * build the prepared statements to back-fill their message_id, plus the
 * audit row. Returned for the caller to fold into a D1 batch.
 *
 * The caller is responsible for:
 *   - calling `db.batch([...statements])`
 *   - supplying the canonical `messageId` (the queue consumer's claimed
 *     `claimed.message_id`)
 *
 * `auditEventWriter` is the cross-module seam (CAP-040 / D-CAP-029-A):
 * the outbound-mail module cannot import the admin module directly
 * (.claude/rules/architecture.md), so the route layer / process-outbound-job
 * pulls the writer off AppContext.
 */
export async function prepareReconciliationStatements(
  db: Database,
  params: {
    readonly connectionId: string;
    readonly providerMessageId: string;
    readonly messageId: string;
    readonly actorUserId: string | null;
    readonly requestId: string | null;
    readonly createdAt: string;
    readonly auditEventWriter: AuditEventWriter;
  },
): Promise<{
  readonly statements: ReadonlyArray<D1PreparedStatement>;
  readonly backfilledIds: ReadonlyArray<string>;
}> {
  const unmatched = await findUnmatchedDeliveriesByProviderMessageId(
    db,
    params.connectionId,
    params.providerMessageId,
  );

  const statements: D1PreparedStatement[] = [];
  const backfilledIds: string[] = [];
  for (const row of unmatched) {
    statements.push(
      prepareBackfillDeliveryMessageId(db, row.id, params.connectionId, params.messageId),
    );
    const status = row.message_status;
    if (status !== null && row.event_time !== null) {
      statements.push(
        prepareUpdateMessageStatus(db, {
          messageId: params.messageId,
          status,
          providerEventTimeMs: row.event_time,
          now: params.createdAt,
        }),
      );
    }
    backfilledIds.push(row.id);
  }

  // Audit row (R-AUDIT-001). Written for every reconciliation pass — even
  // when no rows were updated (count=0 in metadata) — so the operator has
  // a complete trail of every post-send reconciliation.
  const auditMetadata = JSON.stringify({
    connectionId: params.connectionId,
    providerMessageId: params.providerMessageId,
    messageId: params.messageId,
    backfilled: backfilledIds.length,
    backfilledIds,
  });
  statements.push(
    params.auditEventWriter.prepare({
      id: systemIds.uuid(),
      actorUserId: params.actorUserId,
      action: 'webhook_delivery.reconcile',
      resourceType: 'message',
      resourceId: params.messageId,
      requestId: params.requestId,
      metadata: auditMetadata,
      createdAt: params.createdAt,
    }).statement as unknown as D1PreparedStatement,
  );

  return { statements, backfilledIds };
}

/**
 * Run reconciliation as a single function: find unmatched deliveries,
 * back-fill them, and write the audit row in one D1 batch. Returns the
 * count of rows that were updated. Idempotent: a second call with no
 * matching unmatched rows writes only the audit row (count=0).
 */
export async function reconcileWebhookDeliveries(
  db: Database,
  params: {
    readonly connectionId: string;
    readonly providerMessageId: string;
    readonly messageId: string;
    readonly actorUserId: string | null;
    readonly requestId: string | null;
    readonly createdAt: string;
    readonly auditEventWriter: AuditEventWriter;
  },
): Promise<ReconcileResult> {
  const { statements, backfilledIds } = await prepareReconciliationStatements(db, params);
  await db.batch([...statements]);
  return {
    backfilled: backfilledIds.length,
    backfilledIds,
  };
}
