// job-repository — outbound_jobs CRUD. CAP-023 + CAP-028.
// Owner: outbound-mail module. Private file — export through
// modules/outbound-mail/index.ts.
//
// R-OUTBOUND-006: prepareCreateOutboundJob returns a D1PreparedStatement so the
// compose route can include the insert in the same D1 batch as the message +
// mailbox_message writes (atomicity: a crash between them cannot produce a
// queued message with no job).
//
// R-OUTBOUND-007 / R-OUTBOUND-008 / R-OUTBOUND-009 (CAP-028): the claim +
// lock-holding writes + reclaim functions live in this file. Each write
// predicates on `locked_by = ?` so a stale worker cannot overwrite a
// recovered row. The reclaim helper never increments attempts — that
// happens only on a real attempt that was attempted and failed.

import type { Database } from '../../platform/database';
import { sqliteTimestamp } from '../../platform/idempotency';

export interface CreateJobInput {
  readonly id: string;
  readonly messageId: string;
  readonly providerConnectionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly scheduledAt?: string;
  readonly mailboxId?: string;
}

/**
 * Marker-guarded variant of `CreateJobInput` for `prepareCreateOutboundJobGuarded`.
 * The marker binds to `idempotency_records.id` (the row's primary key), never to
 * the client-supplied `Idempotency-Key` header — so the guard cannot be spoofed
 * by a duplicate client request.
 */
export interface CreateJobGuardedInput extends CreateJobInput {
  readonly idempotencyMarkerId: string;
}

export interface OutboundJobRow {
  readonly id: string;
  readonly message_id: string;
  readonly provider_connection_id: string;
  readonly status: 'queued' | 'sending' | 'sent' | 'delayed' | 'bounced' | 'complained' | 'failed';
  readonly scheduled_at: string | null;
  readonly mailbox_id: string | null;
  readonly schedule_revision: number;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly locked_at: string | null;
  readonly locked_by: string | null;
  readonly provider_message_id: string | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly next_attempt_at: string | null;
}

/**
 * Narrow helper for R-OUTBOUND-009: a job in any of these states is
 * terminal — the consumer must skip it, the reclaim must leave it alone,
 * and no write may move it back to a non-terminal state. `sent` and `failed`
 * are the CAP-028 terminals; `bounced` and `complained` (set by the webhook
 * layer, CAP-029) are terminal too once they land.
 */
export function isJobTerminal(status: OutboundJobRow['status']): boolean {
  return (
    status === 'sent' || status === 'failed' || status === 'bounced' || status === 'complained'
  );
}

/**
 * Prepares a D1 statement for inserting an outbound_jobs row in status
 * 'queued'. Returns the prepared statement so the caller can include it in
 * the same batch as the message + mailbox_message writes (R-OUTBOUND-006).
 *
 * @param db — Database instance
 * @param input — Job values (id, messageId, providerConnectionId, timestamps)
 * @returns D1PreparedStatement ready for batch execution
 */
export function prepareCreateOutboundJob(db: Database, input: CreateJobInput): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO outbound_jobs (id, message_id, provider_connection_id, status, attempts, max_attempts, created_at, updated_at, scheduled_at, mailbox_id)
     VALUES (?, ?, ?, 'queued', 0, 3, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.messageId,
      input.providerConnectionId,
      input.createdAt,
      input.updatedAt,
      input.scheduledAt ?? null,
      input.mailboxId ?? null,
    );
}

/**
 * Marker-guarded variant of `prepareCreateOutboundJob` (CAP-047). Inserts the
 * `outbound_jobs` row in `status='queued'` only when the idempotency marker
 * row exists in `idempotency_records` for the same D1 batch.
 *
 * Shape: INSERT ... SELECT ... WHERE EXISTS (SELECT 1 FROM idempotency_records WHERE id = ?)
 *
 * The marker id binds to `idempotency_records.id` (primary key) so the guard
 * is per-row, not per-(actor, operation, key) tuple.
 *
 * Semantics: the route folds the idempotency-record INSERT and this
 * INSERT ... SELECT into the same `db.batch([...])`. SQLite executes
 * statements in order inside the batch, so by the time this statement runs
 * the marker row exists iff the idempotency INSERT succeeded (the alternative
 * is a UNIQUE collision that aborted the batch). When the marker is absent
 * — a duplicate client request lost the idempotency race — the SELECT yields
 * zero rows and this statement writes nothing. That is the desired
 * protection: a replay must not produce a second outbound_jobs row.
 *
 * The companion writer, `prepareQueueDraftForSend` (messages module), lives in
 * the same batch as this guarded INSERT so a send commits the message
 * transition, the outbound_jobs row, and the idempotency record together or
 * not at all.
 *
 * `prepareCreateOutboundJob` is preserved unchanged for callers that already
 * gate on idempotency at a higher layer (the compose handler's
 * R-OUTBOUND-006 batch for new messages).
 */
export function prepareCreateOutboundJobGuarded(
  db: Database,
  input: CreateJobGuardedInput,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO outbound_jobs (
         id, message_id, provider_connection_id,
         status, attempts, max_attempts, created_at, updated_at
       )
       SELECT ?, ?, ?, 'queued', 0, 3, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM idempotency_records WHERE id = ?
         )`,
    )
    .bind(
      input.id,
      input.messageId,
      input.providerConnectionId,
      input.createdAt,
      input.updatedAt,
      input.idempotencyMarkerId,
    );
}

/**
 * Reads a single outbound job by ID. Returns null if not found.
 */
export async function getOutboundJob(db: Database, jobId: string): Promise<OutboundJobRow | null> {
  return db.prepare('SELECT * FROM outbound_jobs WHERE id = ?').bind(jobId).first<OutboundJobRow>();
}

export interface UpdateJobStatusInput {
  readonly providerMessageId?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

/**
 * Updates an outbound job's status, and optionally the provider message ID
 * (on success) or the error code/message + attempts counter (on failure).
 *
 * The three branches are mutually exclusive — passing both providerMessageId
 * and errorCode is a caller bug; providerMessageId wins (success path).
 *
 * **CAP-028 / C1 adjudication.** This function remains the single
 * unconditional status writer inside the module. Two distinct consumers:
 *
 *   1. Code paths that have not yet taken a lease (compose inserts,
 *      idempotency replay). For these there is no `locked_by` to predicate
 *      against — the row is being inserted or the lease has already been
 *      released and a new owner will claim.
 *   2. Admin / migration scripts that need to update `status` outside the
 *      queue flow (e.g. draining stuck `sending` leases).
 *
 * The queue consumer does **not** call this function. The lease-aware
 * writes below — `markOutboundJobSent`, `markOutboundJobRetryable`,
 * `markOutboundJobTerminal` — are the writes that gate on `locked_by` and
 * are the only ones invoked from `process-outbound-job`. CAP-028 review
 * triage (D-CAP-028-C) explicitly chose **document, do not consolidate** —
 * splitting the unconditional writer off into a separate helper would
 * duplicate SQL for no behavioural benefit, since the consumer path is
 * already routed through the lease-aware functions.
 */
export async function updateJobStatus(
  db: Database,
  jobId: string,
  status: OutboundJobRow['status'],
  extra?: UpdateJobStatusInput,
): Promise<void> {
  // SQLite datetime: YYYY-MM-DD HH:MM:SS (UTC), matching the migration default.
  const now = sqliteTimestamp(new Date());

  if (extra?.providerMessageId) {
    await db
      .prepare(
        'UPDATE outbound_jobs SET status = ?, provider_message_id = ?, updated_at = ? WHERE id = ?',
      )
      .bind(status, extra.providerMessageId, now, jobId)
      .run();
  } else if (extra?.errorCode) {
    // Failure path: record the error and bump attempts so max_attempts can
    // gate retries in the queue consumer.
    await db
      .prepare(
        'UPDATE outbound_jobs SET status = ?, error_code = ?, error_message = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?',
      )
      .bind(status, extra.errorCode, extra.errorMessage ?? '', now, jobId)
      .run();
  } else {
    await db
      .prepare('UPDATE outbound_jobs SET status = ?, updated_at = ? WHERE id = ?')
      .bind(status, now, jobId)
      .run();
  }
}

/**
 * Atomic claim: marks the job 'sending' only when no live lease is held.
 *
 * R-OUTBOUND-007: the WHERE clause enforces a single active consumer per
 * job. A row already in 'sent' / 'failed' (R-OUTBOUND-009) is provably
 * terminal — the claim returns null and the caller skips.
 *
 * Returns the claimed row (so the caller can use `provider_connection_id`
 * and `message_id` without a second SELECT), or `null` when another worker
 * holds a live lease or the row is in a terminal state.
 *
 * @param db — Database instance
 * @param jobId — UUID of the outbound_jobs row
 * @param lockedBy — per-invocation UUID (generated by the consumer via
 *                   `systemIds.uuid()`); recorded so a reclaim that steals
 *                   the row cannot be overwritten by the original consumer's
 *                   stale writes
 * @param leaseUntil — SQLite datetime string ('YYYY-MM-DD HH:MM:SS' UTC)
 *                     representing the lease expiry. Computed once by the
 *                     caller via `clock.unixMs() + OUTBOX_LEASE_TTL_MS`
 *                     (the use case injects a `Clock`; default `systemClock`)
 *                     so the claim and the eventual expiry compare against
 *                     the same instant.
 */
export async function claimOutboundJob(
  db: Database,
  jobId: string,
  lockedBy: string,
  leaseUntil: string,
  now = sqliteTimestamp(new Date()),
): Promise<OutboundJobRow | null> {
  // The WHERE clause is the invariant. It enforces three things in one UPDATE:
  //   1. status='queued' — not already in flight or terminal
  //   2. locked_at IS NULL OR locked_at < leaseUntil — the previous holder
  //      either released cleanly (cleared locked_at) or its lease expired
  //      while it was still processing (a crashed consumer)
  // Terminal statuses ('sent', 'failed', ...) are excluded by the status check.
  // Race between two concurrent claims: SQLite serialises the UPDATE, and
  // whichever one runs second finds the row in 'sending' with a fresh
  // locked_at and skips (0 rows updated).
  // CAP-030 direction guard (D-CAP-030-C): the hard-coded `status='queued'`
  // predicate is the FROM-state 'queued' for the only legal target 'sending'
  // (see ALLOWED_JOB_TRANSITIONS.get('queued') in packages/contracts). A
  // future widening (e.g. adding 'delayed' as a legal FROM-state for 'sending'
  // to support a deferred-claim path) MUST update the direction table in the
  // same change so the policy stays in one place.
  const result = await db
    .prepare(
      `UPDATE outbound_jobs
         SET status = 'sending',
             locked_at = ?,
             locked_by = ?,
             updated_at = ?
       WHERE id = ?
         AND status = 'queued'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         AND NOT EXISTS(SELECT 1 FROM outbound_send_attempts a WHERE a.job_id=outbound_jobs.id
           AND a.status IN ('submitted','unknown','accepted'))
         AND (scheduled_at IS NULL OR scheduled_at <= ?)
         AND (locked_at IS NULL OR locked_at < ?)`,
    )
    .bind(leaseUntil, lockedBy, now, jobId, now, now, leaseUntil)
    .run();

  if (!result.meta || result.meta.changes === undefined || result.meta.changes === 0) {
    return null;
  }
  return getOutboundJob(db, jobId);
}

/**
 * Lock-holding success write.
 *
 * R-OUTBOUND-007: the `locked_by = ?` predicate defeats a stale worker —
 * if a reclaim already stole the row, this UPDATE finds `locked_by`
 * pointing at a different UUID and writes nothing.
 *
 * R-OUTBOUND-009: the `status = 'sending'` predicate additionally prevents
 * advancing a row that was reclaimed and marked `failed` mid-flight.
 *
 * CAP-030 direction guard (D-CAP-030-C): the hard-coded `status='sending'`
 * predicate is the FROM-state 'sending' for the target 'sent' (see
 * ALLOWED_JOB_TRANSITIONS.get('sending') in packages/contracts). The
 * single-status predicate is a strict subset of the direction table —
 * adding a wider `IN (...)` clause here would be cosmetic, since the only
 * legal legal `from` for this writer is 'sending'.
 *
 * Returns `true` when the row was advanced, `false` when the predicate
 * matched nothing (stale-worker race — the row was resolved by whoever
 * stole the lock). The caller surfaces the divergence as a warn, not an
 * error (adjudicated at CAP-028 review triage).
 */
export async function markOutboundJobSent(
  db: Database,
  jobId: string,
  lockedBy: string,
  providerMessageId: string,
): Promise<boolean> {
  const now = sqliteTimestamp(new Date());
  const result = await db
    .prepare(
      `UPDATE outbound_jobs
         SET status = 'sent',
             provider_message_id = ?,
             locked_at = NULL,
             locked_by = NULL,
             updated_at = ?
       WHERE id = ?
         AND status = 'sending'
         AND locked_by = ?`,
    )
    .bind(providerMessageId, now, jobId, lockedBy)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * Lock-holding retryable failure write. Clears the lock and increments
 * `attempts`. R-OUTBOUND-008: the queue consumer will retry on this path;
 * the lock release lets the next attempt (or the cron reclaim) re-claim
 * the row cleanly.
 *
 * The `status='queued'` write is intentional: the row is back in the
 * work pool, with a fresh `attempts` count. The use case rethrows so the
 * queue consumer can apply its retry policy; the reclaim path is the
 * backstop if the consumer dies between the release and the retry.
 *
 * CAP-030 direction guard (D-CAP-030-C): the hard-coded
 * `status='sending'` predicate is the FROM-state 'sending' for the target
 * 'queued' — retry reset (R-OUTBOUND-008). ALLOWED_JOB_TRANSITIONS
 * explicitly lists 'queued' as a legal target of 'sending' for this
 * reason; D-CAP-030-B records the retry reset so a reviewer does not
 * file it as a regression.
 */
export async function markOutboundJobRetryable(
  db: Database,
  jobId: string,
  lockedBy: string,
  errorCode: string,
  errorMessage: string,
  nextAttemptAt: string | null = null,
): Promise<void> {
  const now = sqliteTimestamp(new Date());
  await db
    .prepare(
      `UPDATE outbound_jobs
         SET status = 'queued',
             attempts = attempts + 1,
             error_code = ?,
             error_message = ?,
             locked_at = NULL,
             locked_by = NULL,
             updated_at = ?, next_attempt_at = ?
       WHERE id = ?
         AND status = 'sending'
         AND locked_by = ?
         AND NOT EXISTS(SELECT 1 FROM outbound_send_attempts a WHERE a.job_id=outbound_jobs.id
           AND a.status IN ('submitted','unknown','accepted'))`,
    )
    .bind(errorCode, errorMessage, now, nextAttemptAt, jobId, lockedBy)
    .run();
}

/**
 * Lock-holding terminal failure write. R-OUTBOUND-008: a terminal error
 * marks the job `failed` permanently — no reclaim, no retry, no overwrite.
 *
 * The use case must gate on `attempts + 1 >= max_attempts` BEFORE calling
 * this; this function does not check. It only predicates on
 * `status='sending' AND locked_by = ?` so a stale worker is a no-op
 * (R-OUTBOUND-007).
 *
 * `attempts` is NOT incremented here — the failed-final-attempt count is
 * already reflected in `attempts` from earlier retryable writes; this
 * just flips the terminal bit.
 *
 * CAP-030 direction guard (D-CAP-030-C): the hard-coded
 * `status='sending'` predicate is the FROM-state 'sending' for the target
 * 'failed' (R-OUTBOUND-008/009). ALLOWED_JOB_TRANSITIONS.get('sending')
 * contains 'failed'; `failed` itself is terminal (empty allowed-from set).
 */
export async function markOutboundJobTerminal(
  db: Database,
  jobId: string,
  lockedBy: string,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  const now = sqliteTimestamp(new Date());
  await db
    .prepare(
      `UPDATE outbound_jobs
         SET status = 'failed',
             error_code = ?,
             error_message = ?,
             locked_at = NULL,
             locked_by = NULL,
             updated_at = ?
       WHERE id = ?
         AND status = 'sending'
         AND locked_by = ?`,
    )
    .bind(errorCode, errorMessage, now, jobId, lockedBy)
    .run();
}

/**
 * The subset of columns the reclaim path needs. We don't load full rows
 * because the reclaim runs once per cron tick and could process every
 * in-flight job in the system; a narrow projection keeps the index seek
 * cheap.
 */
interface ReclaimCandidate {
  readonly id: string;
  readonly attempts: number;
  readonly max_attempts: number;
}

export interface ReclaimResult {
  /** Number of rows that were successfully re-queued for another attempt. */
  readonly reclaimed: number;
  /** Number of rows that were marked `failed` because they hit `max_attempts`. */
  readonly terminal: number;
  /**
   * IDs of the rows that were re-queued (NOT the terminal ones — those are
   * not re-drivable). The scheduled entrypoint re-enqueues each of these onto
   * the OUTBOUND queue so recovery does not depend on the queue consumer's
   * redelivery budget. R-LOG-001: these IDs are never logged.
   */
  readonly reclaimedIds: string[];
}

/**
 * Scheduled reclaim. Selects at most 100 expired leases and either
 * resets it to `queued` for another attempt or marks it `failed` if the
 * row has hit `max_attempts`.
 *
 * R-OUTBOUND-007 / R-OUTBOUND-008: the reclaim does NOT increment
 * `attempts`. The retry counter is bumped only by an actual attempt that
 * failed, never by an aborted attempt whose consumer crashed.
 *
 * R-OUTBOUND-009: `sent` / `failed` rows are excluded by the WHERE clause
 * (`status='sending'`).
 *
 * Returns `{ reclaimed, terminal, reclaimedIds }` — counts for the
 * entrypoint to log, IDs for the entrypoint to re-enqueue onto the OUTBOUND
 * queue. Both numbers are 0 in the steady-state case (no leases expired).
 *
 * @param db — Database instance
 * @param leaseCutoff — SQLite datetime string for "before this, the lease
 *                      is expired". The caller computes it via
 *                      `platform/outbox-config.ts#leaseCutoff(now)` and
 *                      passes it in so this function is deterministic
 *                      against an injected clock.
 */
export async function reclaimStaleOutboundJobs(
  db: Database,
  leaseCutoffSql: string,
): Promise<ReclaimResult> {
  const candidates = await db
    .prepare(
      `SELECT id, attempts, max_attempts
         FROM outbound_jobs
        WHERE status = 'sending'
          AND NOT EXISTS(SELECT 1 FROM outbound_send_attempts a WHERE a.job_id=outbound_jobs.id
            AND a.status IN ('submitted','unknown','accepted'))
          AND locked_at IS NOT NULL
          AND locked_at < ?
        ORDER BY locked_at, id LIMIT 100`,
    )
    .bind(leaseCutoffSql)
    .all<ReclaimCandidate>();

  const rows = candidates.results ?? [];
  let reclaimed = 0;
  let terminal = 0;
  const reclaimedIds: string[] = [];

  for (const row of rows) {
    if (row.attempts >= row.max_attempts) {
      // Burned through all attempts. Mark failed; do NOT increment
      // attempts (the last attempt that ran already bumped it).
      const res = await db
        .prepare(
          `UPDATE outbound_jobs
             SET status = 'failed',
                 error_code = 'RECLAIM_EXHAUSTED',
                 error_message = 'Lease expired and attempts exhausted',
                 locked_at = NULL,
                 locked_by = NULL,
                 updated_at = ?
           WHERE id = ?
             AND status = 'sending'
             AND locked_at < ?
             AND NOT EXISTS(SELECT 1 FROM outbound_send_attempts a WHERE a.job_id=outbound_jobs.id
               AND a.status IN ('submitted','unknown','accepted'))`,
        )
        .bind(sqliteTimestamp(new Date()), row.id, leaseCutoffSql)
        .run();
      if (res.meta?.changes && res.meta.changes > 0) {
        terminal += 1;
      }
    } else {
      // Release the lock and put the row back on the queue. NO attempts++
      // here — the failed attempt that would have caused an increment never
      // completed; the consumer crashed before reporting.
      const res = await db
        .prepare(
          `UPDATE outbound_jobs
             SET status = 'queued',
                 locked_at = NULL,
                 locked_by = NULL,
                 updated_at = ?
           WHERE id = ?
             AND status = 'sending'
             AND locked_at < ?
             AND NOT EXISTS(SELECT 1 FROM outbound_send_attempts a WHERE a.job_id=outbound_jobs.id
               AND a.status IN ('submitted','unknown','accepted'))`,
        )
        .bind(sqliteTimestamp(new Date()), row.id, leaseCutoffSql)
        .run();
      if (res.meta?.changes && res.meta.changes > 0) {
        reclaimed += 1;
        reclaimedIds.push(row.id);
      }
    }
  }

  return { reclaimed, terminal, reclaimedIds };
}

/**
 * Orphaned-`queued` sweep (CAP-028 F1). Reserves at most 100 rows sitting in
 * `queued` whose `updated_at` is older than the cutoff — rows whose queue
 * message was likely lost (a failed post-reclaim re-enqueue, or a
 * compose-path enqueue outage), so nothing will ever re-drive them without
 * this sweep.
 *
 * The cutoff comes from `orphanSweepCutoff(now)` (5 min past the lease TTL +
 * cron cadence), which keeps the sweep clear of the healthy
 * enqueue→claim pipeline — a fresh `queued` row is claimed within seconds.
 *
 * Terminal rows are excluded by the `status = 'queued'` predicate
 * (R-OUTBOUND-009); the caller re-enqueues each ID in the exact body format
 * the queue consumer parses.
 *
 * @param db — Database instance
 * The atomic timestamp update suppresses concurrent/repeated enqueue while
 * preserving status and send attempts. A crash or send failure becomes eligible
 * again after the grace period. Monitoring measures total delivery age from
 * created_at, so these retry reservations cannot hide a stalled delivery.
 *
 * @param cutoffSql — SQLite datetime string from `orphanSweepCutoff(now)`
 * @param nowSql — start of the durable retry window.
 */
export async function claimOrphanedQueuedJobs(
  db: Database,
  cutoffSql: string,
  nowSql: string,
): Promise<ReadonlyArray<{ id: string; scheduledAt: string | null }>> {
  const orphans = await db
    .prepare(
      `UPDATE outbound_jobs SET updated_at = ?
       WHERE (scheduled_at IS NULL OR scheduled_at <= datetime(?, '+24 hours')) AND status = 'queued' AND updated_at < ? AND id IN (
         SELECT id FROM outbound_jobs WHERE status = 'queued' AND updated_at < ?
         AND (next_attempt_at IS NULL OR next_attempt_at<=?)
         AND NOT EXISTS(SELECT 1 FROM outbound_send_attempts a WHERE a.job_id=outbound_jobs.id
           AND a.status IN ('submitted','unknown','accepted'))
         AND (scheduled_at IS NULL OR scheduled_at <= datetime(?, '+24 hours'))
         ORDER BY updated_at, id LIMIT 100
       ) RETURNING id, scheduled_at`,
    )
    .bind(nowSql, nowSql, cutoffSql, cutoffSql, nowSql, nowSql)
    .all<{ id: string; scheduled_at: string | null }>();
  return (orphans.results ?? []).map((row) => ({ id: row.id, scheduledAt: row.scheduled_at }));
}
