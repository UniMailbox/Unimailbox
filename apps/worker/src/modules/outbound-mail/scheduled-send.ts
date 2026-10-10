import type { AuditEventWriter } from '@unimailbox/contracts';
import { assertCan } from '../tenancy';
import { listMessagesByMailbox, prepareRestoreScheduledDraft } from '../messages';
import type { Database } from '../../platform/database';
import { systemIds } from '../../platform/ids';
import { systemClock } from '../../platform/clock';
import { DomainError } from '../../platform/errors';
import {
  findIdempotencyRecord,
  assertSameRequestHash,
  replayResponse,
  prepareCreateIdempotencyRecord,
  sqliteTimestamp,
  isIdempotencyUniqueViolation,
  replayAfterRace,
  sha256Hex,
} from '../../platform/idempotency';
import { validateScheduledAt, scheduleRecoveryAt } from './schedule-time';
import { enqueueScheduledJob } from './enqueue-scheduled-job';
import type { OutboundJobEnqueuer } from './reclaim-stale-jobs';

export async function listScheduledSends(
  db: Database,
  mailboxId: string,
  userId: string,
  options: { cursor?: string; cursorSigningKey: string },
) {
  await assertCan(db, userId, mailboxId, 'read');
  const page = await listMessagesByMailbox(db, mailboxId, userId, {
    ...options,
    limit: 50,
    folder: 'scheduled',
  });
  if (!page.items.length) return page;
  const times = await db
    .prepare(
      `SELECT message_id, scheduled_at, schedule_revision FROM outbound_jobs WHERE mailbox_id=? AND status='queued' AND scheduled_at IS NOT NULL AND message_id IN (${page.items.map(() => '?').join(',')})`,
    )
    .bind(mailboxId, ...page.items.map((item) => item.id))
    .all<{ message_id: string; scheduled_at: string; schedule_revision: number }>();
  const byId = new Map(times.results.map((row) => [row.message_id, row]));
  return {
    nextCursor: page.nextCursor,
    items: page.items.flatMap((item) => {
      const row = byId.get(item.id);
      return row
        ? [
            {
              ...item,
              scheduledAt: row.scheduled_at.replace(' ', 'T') + '.000Z',
              revision: row.schedule_revision,
            },
          ]
        : [];
    }),
  };
}

/** CAS + audit + replay + optional draft restore are one D1 transaction. */
export async function changeScheduledSend(
  deps: { db: Database; outbound: OutboundJobEnqueuer; audit: AuditEventWriter },
  input: {
    mailboxId: string;
    messageId: string;
    userId: string;
    idempotencyKey: string;
    rawBody: string;
    expectedRevision: number;
    scheduledAt?: string;
    requestId: string | null;
  },
): Promise<Response> {
  const { db } = deps;
  await assertCan(db, input.userId, input.mailboxId, 'send');
  const cancelling = input.scheduledAt === undefined;
  const operation = cancelling
    ? 'POST /api/v1/mailboxes/:mailboxId/scheduled-sends/:messageId/cancel'
    : 'PATCH /api/v1/mailboxes/:mailboxId/scheduled-sends/:messageId';
  const hash = await sha256Hex(
    JSON.stringify({ body: input.rawBody, mailboxId: input.mailboxId, messageId: input.messageId }),
  );
  const existing = await findIdempotencyRecord(db, input.userId, operation, input.idempotencyKey);
  if (existing) {
    assertSameRequestHash(existing, hash);
    return replayResponse(existing);
  }
  const now = systemClock.now();
  const nowSql = sqliteTimestamp(now);
  const scheduledAt = input.scheduledAt ? validateScheduledAt(input.scheduledAt, now) : null;
  const job = await db
    .prepare(
      `SELECT id FROM outbound_jobs WHERE mailbox_id=? AND message_id=? AND scheduled_at IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .bind(input.mailboxId, input.messageId)
    .first<{ id: string }>();
  if (!job)
    throw new DomainError({
      code: 'MESSAGE_NOT_FOUND',
      message: 'Scheduled message not found.',
      httpStatus: 404,
    });
  const marker = systemIds.uuid();
  const response = JSON.stringify({
    data: {
      messageId: input.messageId,
      status: cancelling ? 'draft' : 'queued',
      ...(scheduledAt
        ? {
            scheduledAt: scheduledAt.replace(' ', 'T') + '.000Z',
            revision: input.expectedRevision + 1,
          }
        : {}),
    },
  });
  const update = cancelling
    ? db
        .prepare(
          `UPDATE outbound_jobs SET status='failed',error_code='SCHEDULE_CANCELLED',error_message=NULL,schedule_revision=schedule_revision+1,updated_at=? WHERE id=? AND status='queued' AND schedule_revision=?`,
        )
        .bind(nowSql, job.id, input.expectedRevision)
    : db
        .prepare(
          `UPDATE outbound_jobs SET scheduled_at=?,updated_at=?,schedule_revision=schedule_revision+1 WHERE id=? AND status='queued' AND schedule_revision=?`,
        )
        .bind(scheduledAt, scheduleRecoveryAt(scheduledAt, now), job.id, input.expectedRevision);
  const audit = deps.audit.prepare({
    id: systemIds.uuid(),
    actorUserId: input.userId,
    action: cancelling ? 'message.schedule_cancelled' : 'message.schedule_updated',
    resourceType: 'message',
    resourceId: input.messageId,
    requestId: input.requestId,
    createdAt: nowSql,
  }).statement as unknown as D1PreparedStatement;
  try {
    await db.batch([
      update,
      // A lost CAS must roll back the entire batch, including replay/audit/draft writes.
      db
        .prepare(
          `INSERT INTO outbound_jobs (id,message_id,provider_connection_id,created_at,updated_at) SELECT ?,NULL,NULL,?,? WHERE changes()=0`,
        )
        .bind(marker, nowSql, nowSql),
      prepareCreateIdempotencyRecord(db, {
        id: marker,
        actorId: input.userId,
        operation,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
        responseStatus: 200,
        responseJson: response,
        createdAt: nowSql,
      }),
      ...(cancelling
        ? prepareRestoreScheduledDraft(db, input.messageId, input.mailboxId, marker, nowSql)
        : []),
      audit,
    ]);
  } catch (error) {
    if (isIdempotencyUniqueViolation(error))
      return replayAfterRace(db, input.userId, operation, input.idempotencyKey, hash);
    if (
      error instanceof Error &&
      error.message.includes('NOT NULL constraint failed: outbound_jobs.message_id')
    ) {
      // A concurrent identical request may have committed before this CAS.
      const winner = await findIdempotencyRecord(db, input.userId, operation, input.idempotencyKey);
      if (winner) {
        assertSameRequestHash(winner, hash);
        return replayResponse(winner);
      }
      throw new DomainError({
        code: 'SCHEDULE_STATE_CONFLICT',
        message: 'The schedule changed or sending has started. Refresh and try again.',
        httpStatus: 409,
      });
    }
    throw error;
  }
  if (scheduledAt) await enqueueScheduledJob(db, deps.outbound, job.id, scheduledAt, now);
  return new Response(response, { status: 200, headers: { 'Content-Type': 'application/json' } });
}
