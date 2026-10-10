import type { Database } from '../../platform/database';
import type { OutboundJobEnqueuer } from './reclaim-stale-jobs';
import { scheduleDelaySeconds, QUEUE_DELAY_MAX_SECONDS } from './schedule-time';

/** Long-range tasks stay in D1 until the existing recovery scan reaches the delay window. */
export async function enqueueScheduledJob(
  db: Database,
  outbound: OutboundJobEnqueuer,
  jobId: string,
  scheduledAt: string | null,
  now: Date,
): Promise<void> {
  const delaySeconds = scheduleDelaySeconds(scheduledAt, now);
  if (delaySeconds > QUEUE_DELAY_MAX_SECONDS) return;
  const body = JSON.stringify({ jobId });
  if (scheduledAt === null) {
    await outbound.send(body);
    return;
  }
  await outbound.send(body, { delaySeconds });
  // A confirmed delayed delivery is not an orphan until after its due time.
  await db
    .prepare(
      `UPDATE outbound_jobs SET updated_at=? WHERE id=? AND status='queued' AND scheduled_at=?`,
    )
    .bind(scheduledAt, jobId, scheduledAt)
    .run();
}
