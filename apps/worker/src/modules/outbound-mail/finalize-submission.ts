import type { AuditEventWriter } from '@unimailbox/contracts';
import type { Database } from '../../platform/database';
import { sqliteTimestamp } from '../../platform/idempotency';
import { systemIds } from '../../platform/ids';
import { prepareUpdateMessageStatus, prepareScheduledMessageSentFolder } from '../messages';
import { getOutboundJob, isJobTerminal } from './job-repository';
import { prepareReconciliationStatements } from './reconcile-webhook-deliveries';
import {
  getOutboundAttempt,
  prepareFinalizeAcceptedJob,
  prepareRequireAttemptTransition,
  prepareRestoreAcceptedJob,
  prepareFinishAttemptReconciliation,
} from './attempt-repository';

/** Repair accepted work without invoking provider.send, including a failed message/audit batch. */
export async function finalizeAcceptedSubmission(
  db: Database,
  attemptId: string,
  now: Date,
  audit?: AuditEventWriter,
) {
  const attempt = await getOutboundAttempt(db, attemptId);
  if (
    !attempt ||
    attempt.status !== 'accepted' ||
    !attempt.provider_message_id ||
    !attempt.accepted_at
  )
    return;
  const job = await getOutboundJob(db, attempt.job_id);
  if (!job || isJobTerminal(job.status)) return;
  const stamp = sqliteTimestamp(now);
  const statements = [
    prepareRestoreAcceptedJob(db, attempt),
    prepareFinalizeAcceptedJob(db, attempt, now),
    prepareRequireAttemptTransition(db),
    prepareUpdateMessageStatus(db, {
      messageId: job.message_id,
      status: 'sent',
      providerEventTimeMs: Date.parse(attempt.accepted_at),
      sentAt: sqliteTimestamp(new Date(attempt.accepted_at)),
      preserveProviderEventTime: true,
      now: stamp,
    }),
    prepareFinishAttemptReconciliation(db, attempt.id),
  ];
  if (job.scheduled_at && job.mailbox_id)
    statements.push(prepareScheduledMessageSentFolder(db, job.message_id, job.mailbox_id));
  if (audit) {
    const reconciliation = await prepareReconciliationStatements(db, {
      connectionId: job.provider_connection_id,
      providerMessageId: attempt.provider_message_id,
      messageId: job.message_id,
      actorUserId: null,
      requestId: attempt.request_id,
      createdAt: stamp,
      auditEventWriter: audit,
    });
    statements.push(
      ...reconciliation.statements,
      audit.prepare({
        id: systemIds.uuid(),
        actorUserId: null,
        action: 'message.send',
        metadata: JSON.stringify({ stage: 'provider_accepted' }),
        resourceType: 'message',
        resourceId: job.message_id,
        requestId: attempt.request_id,
        createdAt: stamp,
      }).statement as D1PreparedStatement,
    );
  }
  try {
    await db.batch(statements);
  } catch (error) {
    if ((await getOutboundJob(db, attempt.job_id))?.status === 'sent') return;
    throw error;
  }
}
