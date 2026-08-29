// CAP-051 scheduled expiry cleanup use case.
//
// Expiry is deliberately a small, repeat-safe sweep. The D1 transition and
// its audit insert happen before CACHE deletion; a failed delete leaves the
// upload `expired` so a later tick can retry. A D1 failure leaves both state
// and audit unchanged.

import type { AuditEventWriter } from '@unimailbox/contracts';
import {
  findAttachmentUploadStatus,
  listExpiredAttachmentUploads,
  prepareExpireAttachmentUpload,
  prepareRequireAttachmentExpiryTransition,
} from '../messages';
import type { Database } from '../../platform/database';
import type { AttachmentByteStore } from '../../platform/cache';
import type { Clock } from '../../platform/clock';
import { systemClock } from '../../platform/clock';
import type { IdGenerator } from '../../platform/ids';
import { systemIds } from '../../platform/ids';
import { sqliteTimestamp } from '../../platform/idempotency';

export interface ExpireAttachmentsInput {
  readonly now?: Date;
  readonly requestId: string;
}

export interface ExpireAttachmentsDependencies {
  readonly db: Database;
  readonly cache: AttachmentByteStore;
  readonly auditEventWriter: AuditEventWriter;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}

export interface ExpireAttachmentsResult {
  readonly found: number;
  readonly expired: number;
  readonly failed: number;
}

/**
 * Removes CACHE bytes and marks expired, unconsumed upload rows as terminal.
 * Each row is handled independently so one transient KV/D1 failure does not
 * prevent other expired uploads from being cleaned on this tick.
 */
export async function expireAttachments(
  dependencies: ExpireAttachmentsDependencies,
  input: ExpireAttachmentsInput,
): Promise<ExpireAttachmentsResult> {
  const now = input.now ?? (dependencies.clock ?? systemClock).now();
  const nowSqlite = sqliteTimestamp(now);
  const ids = dependencies.ids ?? systemIds;
  const expiredUploads = await listExpiredAttachmentUploads(dependencies.db, {
    now: nowSqlite,
  });

  let expired = 0;
  let failed = 0;
  for (const upload of expiredUploads) {
    let transitioned = upload.status === 'expired';

    if (upload.status === 'uploaded') {
      try {
        const auditStatement = dependencies.auditEventWriter.prepare({
          id: ids.uuid(),
          actorUserId: null,
          action: 'attachment.expired',
          resourceType: 'attachment_upload',
          resourceId: upload.uploadId,
          requestId: input.requestId,
          metadata: null,
          createdAt: nowSqlite,
        }).statement as unknown as D1PreparedStatement;

        // The state transition, a changes()-guarded conditional, and its
        // audit are one transaction. A stale cleanup (for example one that
        // lost a race to consume) aborts before the audit INSERT executes.
        await dependencies.db.batch([
          prepareExpireAttachmentUpload(dependencies.db, {
            uploadId: upload.uploadId,
            now: nowSqlite,
          }),
          prepareRequireAttachmentExpiryTransition(dependencies.db, {
            uploadId: upload.uploadId,
          }),
          auditStatement,
        ]);
        transitioned = true;
        expired += 1;
      } catch {
        // A concurrent cleanup may have won the transition. Re-read the
        // Messages-owned state so that case can still perform a byte-delete
        // retry, while a consume/missing-row race skips CACHE entirely.
        let currentStatus: Awaited<ReturnType<typeof findAttachmentUploadStatus>>;
        try {
          currentStatus = await findAttachmentUploadStatus(dependencies.db, {
            uploadId: upload.uploadId,
          });
        } catch {
          currentStatus = null;
        }
        if (currentStatus === 'expired') {
          transitioned = true;
        } else {
          failed += 1;
          continue;
        }
      }
    }

    if (!transitioned) continue;

    try {
      // Probe first so a completed previous deletion causes no repeated KV
      // write on subsequent ticks; a failed delete remains retryable because
      // the expired row is selected again.
      const bytes = await dependencies.cache.get(upload.kvKey);
      if (bytes !== null) {
        await dependencies.cache.delete(upload.kvKey);
      }
    } catch {
      // Never log attachment key, filename, bytes, or raw provider/runtime
      // error text. The row remains expired and is selected for a later
      // CACHE-delete retry.
      failed += 1;
    }
  }

  return { found: expiredUploads.length, expired, failed };
}
