// platform/outbox-config — CAP-028 lease TTL for the outbound durable outbox.
//
// ADR-003 §Decision owns the durable outbox + queue consumer pattern. CAP-028
// adds the lease + reclaim machinery: a row is marked 'sending' only while a
// live worker holds the lock, and the scheduled dispatcher recovers rows whose
// lease has expired.
//
// This file holds the single, hardcoded TTL constant for that lease. Raising
// it is a one-line change here (and the cron cadence in wrangler.jsonc may
// need to follow); lowering it requires a migration if any rows are already
// holding leases computed from the old constant.
//
// R-OUTBOUND-007 (claim is atomic, lock predicates gate writes): the TTL
// plus the `leaseCutoff` helper define what "expired" means to the repository.

import { sqliteTimestamp } from './idempotency';

/**
 * Lease TTL for a claimed outbound job, in milliseconds.
 *
 * Picked to be at least 10× the expected single-job send duration (Brevo
 * send + decrypt + persist takes <1s in worker-pool tests; 60s is two orders
 * of magnitude of headroom). The cron in `apps/worker/wrangler.jsonc`
 * (every 5 minutes) reclaims rows whose lease has expired.
 */
export const OUTBOX_LEASE_TTL_MS = 60_000;
export const OUTBOUND_REQUEST_TIMEOUT_MS = 20_000;
export const OUTBOUND_LEASE_WRITE_MARGIN_MS = 5_000;
export const OUTBOUND_RECONCILE_TIMEOUT_MS = 5_000;

/**
 * Grace period before a `queued` row is treated as orphaned by the scheduled
 * sweep, in milliseconds.
 *
 * A healthy `queued` row is claimed within seconds of its enqueue. 5 minutes
 * is comfortably beyond a healthy enqueue-to-claim pipeline, so the sweep
 * avoids normal immediate queue delivery — it only catches rows whose
 * queue message was lost (a failed post-reclaim re-enqueue, or a compose-path
 * enqueue outage).
 */
export const OUTBOUND_ORPHAN_SWEEP_AFTER_MS = 300_000;

/**
 * The cutoff before which a lease is considered expired.
 *
 * `claimOutboundJob` and `reclaimStaleOutboundJobs` both compare against this
 * value as a TEXT literal in SQL. The `now` parameter is a plain `Date`:
 * production callers pass `new Date()` (or a `systemClock.now()`); tests pass
 * a fixed literal (.claude/rules/testing.md §Determinism). SQLite compares
 * datetimes as TEXT, and mixing formats here is a silent correctness bug (an
 * ISO string sorts above a SQLite one for the same instant) — hence the
 * shared `sqliteTimestamp` helper from platform/idempotency.
 */
export function leaseCutoff(now: Date): string {
  const cutoffMs = now.getTime() - OUTBOX_LEASE_TTL_MS;
  return sqliteTimestamp(new Date(cutoffMs));
}

/**
 * The cutoff before which a `queued` row counts as orphaned (its queue
 * message was likely lost and nothing will ever re-drive it).
 *
 * Same TEXT-literal discipline as `leaseCutoff` — see that docstring for why
 * the shared `sqliteTimestamp` format is load-bearing.
 */
export function orphanSweepCutoff(now: Date): string {
  const cutoffMs = now.getTime() - OUTBOUND_ORPHAN_SWEEP_AFTER_MS;
  return sqliteTimestamp(new Date(cutoffMs));
}
