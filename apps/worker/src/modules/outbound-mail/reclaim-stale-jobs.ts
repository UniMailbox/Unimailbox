// reclaim-stale-jobs — CAP-028 scheduled dispatcher use case.
// Owner: outbound-mail module. Private file — export through
// modules/outbound-mail/index.ts.
//
// Thin wrapper around `reclaimStaleOutboundJobs` (job-repository.ts) that
// re-enqueues each reclaimed job onto the OUTBOUND queue, sweeps `queued`
// rows whose enqueue was lost, and emits a single structured log line per
// cron tick. The repository handles the SQL — this file is the orchestrator
// that the scheduled entrypoint calls.
//
// R-LOG-001: log lines must NOT include message bodies, attachment bytes,
// provider API keys, Idempotency-Key values, or — in this case — `locked_by`
// (which is just a UUID but could correlate an attacker to a specific job if
// logged). Counts are safe; reclaimed job IDs are intentionally omitted from
// logs even though they cross this boundary (the caller passes them to the
// queue, which is not a log sink).
import type { Database } from '../../platform/database';
import { leaseCutoff, orphanSweepCutoff } from '../../platform/outbox-config';
import { logger } from '../../platform/logger';
import {
  findOrphanedQueuedJobs,
  reclaimStaleOutboundJobs,
  type ReclaimResult,
} from './job-repository';

/**
 * Structural subset of the Cloudflare Queue producer binding this module
 * needs. Declared here so the module does not import a Cloudflare binding
 * type directly (.claude/rules/architecture.md) and tests can pass a spy —
 * `env.OUTBOUND` from the entrypoint is assignable as-is.
 *
 * The send return type is `unknown`: the real binding resolves
 * `QueueSendResponse`, test fakes resolve `void`. The use case only cares
 * that the message was accepted, not the response payload.
 */
export interface OutboundJobEnqueuer {
  send(body: string): Promise<unknown>;
}

/**
 * Runs the scheduled reclaim, re-enqueues every reclaimed job, then sweeps
 * `queued` rows whose enqueue was lost, and emits one structured log line
 * with the outcome counts. A D1 failure inside the reclaim or the sweep
 * rejects straight through to the cron handler (the right behavior — the
 * next tick retries); a *queue* failure is contained per-send below.
 *
 * Re-enqueue uses `JSON.stringify({ jobId })` — byte-for-byte the body format
 * the queue consumer (entrypoints/queue.ts) parses — so a reclaimed row is
 * driven by exactly the same path as a fresh compose.
 *
 * A failed enqueue does NOT abort the remaining ones: each failure logs a
 * warn (without the job ID — R-LOG-001) and the loop continues. A row whose
 * re-enqueue failed is NOT lost: it sits in `queued` with a cleared lease,
 * and the orphan sweep below re-enqueues it on a later tick once it has been
 * `queued` longer than the sweep threshold (5 min).
 *
 * @param db — Database instance
 * @param now — The "now" used to compute the lease + orphan-sweep cutoffs.
 *             Production calls pass `new Date()`; tests inject a fixed clock.
 * @param outbound — Queue producer (or structural equivalent) for the
 *             OUTBOUND queue.
 */
export async function reclaimStaleJobs(
  db: Database,
  now: Date,
  outbound: OutboundJobEnqueuer,
): Promise<ReclaimResult> {
  const cutoff = leaseCutoff(now);
  const result = await reclaimStaleOutboundJobs(db, cutoff);

  let enqueued = 0;
  for (const jobId of result.reclaimedIds) {
    try {
      await outbound.send(JSON.stringify({ jobId }));
      enqueued += 1;
    } catch (error) {
      // R-LOG-001: no job ID here — the warn says what failed and why, not
      // which row. The row is already safely back in 'queued'; the orphan
      // sweep below re-drives it on a later tick once it has been queued
      // past the sweep threshold.
      logger.warn(
        { event: 'outbound.reclaim_reenqueue_failed' },
        {
          source: 'reclaim-stale-jobs',
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  // Orphan sweep (CAP-028 F1): a `queued` row older than the sweep threshold
  // has no live driver — its enqueue was lost (a failed post-reclaim
  // re-enqueue above, or a compose-path enqueue outage). Re-enqueue it in the
  // same body format. Double-enqueue safety when a sweep races a fresh queue
  // delivery is guaranteed downstream: the atomic claim means exactly one
  // consumer wins (the loser gets LOCK_CONTENTION → msg.retry()), the
  // pre-claim `sent` skip is idempotent (R-OUTBOUND-009), and the provider
  // call carries the message ID as its idempotency key (R-OUTBOUND-004) so a
  // duplicate send cannot double-deliver.
  let enqueuedOrphans = 0;
  const orphanedIds = await findOrphanedQueuedJobs(db, orphanSweepCutoff(now));
  for (const jobId of orphanedIds) {
    try {
      await outbound.send(JSON.stringify({ jobId }));
      enqueuedOrphans += 1;
    } catch (error) {
      // R-LOG-001: same shape as the re-enqueue warn above — what failed and
      // why, never which row. The row stays `queued`; the next tick's sweep
      // retries it.
      logger.warn(
        { event: 'outbound.orphan_sweep_reenqueue_failed' },
        {
          source: 'reclaim-stale-jobs',
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  // R-LOG-001: counts only. No job IDs, no `locked_by`, no error bodies.
  // Counts ride in `context` (free-form) — `LogFields` is a closed shape.
  logger.info(
    { event: 'outbound.reclaim' },
    {
      source: 'reclaim-stale-jobs',
      reclaimed: result.reclaimed,
      terminal: result.terminal,
      enqueued,
      enqueuedOrphans,
    },
  );

  return result;
}
