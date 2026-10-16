import type { ProviderSendResult } from '@unimailbox/contracts';
import type { Database } from '../../platform/database';
import { sqliteTimestamp } from '../../platform/idempotency';

export interface OutboundAttempt {
  id: string;
  job_id: string;
  provider_key: string;
  correlated: 0 | 1;
  status: 'prepared' | 'submitted' | 'accepted' | 'unknown' | 'rejected';
  provider_message_id: string | null;
  accepted_at: string | null;
  started_at: string;
  submitted_at: string | null;
  request_id: string | null;
}

export function getOutboundAttempt(db: Database, id: string) {
  return db
    .prepare('SELECT * FROM outbound_send_attempts WHERE id=?')
    .bind(id)
    .first<OutboundAttempt>();
}

export function findUnresolvedAttempt(db: Database, jobId: string) {
  return db
    .prepare(
      "SELECT * FROM outbound_send_attempts WHERE job_id=? AND status IN ('submitted','unknown','accepted')",
    )
    .bind(jobId)
    .first<OutboundAttempt>();
}

function requireTransition(db: Database) {
  return db.prepare('INSERT INTO outbound_send_attempts(id) SELECT NULL WHERE changes()=0');
}

export async function prepareOutboundAttempt(
  db: Database,
  input: {
    id: string;
    jobId: string;
    providerKey: string;
    lockedBy: string;
    now: Date;
    requestId: string | null;
  },
) {
  const now = sqliteTimestamp(input.now);
  await db.batch([
    db
      .prepare(
        `INSERT INTO outbound_send_attempts(id,job_id,provider_key,status,started_at,request_id,next_reconcile_at)
      SELECT ?,id,?,'prepared',?,?,? FROM outbound_jobs
      WHERE id=? AND status='sending' AND locked_by=? AND locked_at>?`,
      )
      .bind(
        input.id,
        input.providerKey,
        now,
        input.requestId,
        now,
        input.jobId,
        input.lockedBy,
        now,
      ),
    requireTransition(db),
  ]);
}

/** Commit before invoking the adapter. An ambiguous write can never authorize replay. */
export async function submitOutboundAttempt(
  db: Database,
  id: string,
  token: string,
  now: Date,
  deadline: Date,
) {
  await db.batch([
    db
      .prepare(
        `UPDATE outbound_send_attempts SET status='submitted', submitted_at=?,next_reconcile_at=?
      WHERE id=? AND status='prepared' AND EXISTS(SELECT 1 FROM outbound_jobs j
      WHERE j.id=job_id AND j.status='sending' AND j.locked_by=? AND j.locked_at>=?)`,
      )
      .bind(
        sqliteTimestamp(now),
        sqliteTimestamp(new Date(now.getTime() + 300_000)),
        id,
        token,
        sqliteTimestamp(deadline),
      ),
    requireTransition(db),
  ]);
}

export function prepareAcceptAttempt(
  db: Database,
  id: string,
  result: ProviderSendResult,
  now: Date,
) {
  return db
    .prepare(
      `UPDATE outbound_send_attempts SET status='accepted',provider_message_id=?,
    accepted_at=COALESCE(accepted_at,?),resolved_at=COALESCE(resolved_at,?),
    next_reconcile_at=CASE WHEN status='accepted' THEN next_reconcile_at ELSE ? END
    WHERE id=? AND status IN ('submitted','unknown','accepted')
    AND (provider_message_id IS NULL OR provider_message_id=?)`,
    )
    .bind(
      result.providerMessageId,
      result.acceptedAt,
      sqliteTimestamp(now),
      sqliteTimestamp(now),
      id,
      result.providerMessageId,
    );
}

export async function acceptOutboundAttempt(
  db: Database,
  id: string,
  result: ProviderSendResult,
  now: Date,
) {
  await db.batch([prepareAcceptAttempt(db, id, result, now), requireTransition(db)]);
}

export async function markAttemptUnknown(
  db: Database,
  attempt: OutboundAttempt,
  token: string,
  now: Date,
) {
  await db.batch([
    db
      .prepare(
        `UPDATE outbound_send_attempts SET status='unknown',next_reconcile_at=?
      WHERE id=? AND status='submitted'`,
      )
      .bind(sqliteTimestamp(new Date(now.getTime() + 300_000)), attempt.id),
    db
      .prepare(
        `UPDATE outbound_jobs SET error_code='SEND_OUTCOME_UNKNOWN',
      error_message='Provider submission outcome requires reconciliation',locked_at=NULL,locked_by=NULL,updated_at=?
      WHERE id=? AND status='sending' AND locked_by=?
      AND EXISTS(SELECT 1 FROM outbound_send_attempts WHERE id=? AND status='unknown')`,
      )
      .bind(sqliteTimestamp(now), attempt.job_id, token, attempt.id),
  ]);
}

export function prepareRejectAttempt(db: Database, id: string, now: Date) {
  return db
    .prepare(
      `UPDATE outbound_send_attempts SET status='rejected',resolved_at=?
    WHERE id=? AND status IN ('prepared','submitted')`,
    )
    .bind(sqliteTimestamp(now), id);
}

export function findAttemptForWebhook(
  db: Database,
  connectionId: string,
  providerKey: string,
  id: string,
  providerMessageId: string,
) {
  return db
    .prepare(
      `SELECT a.* FROM outbound_send_attempts a JOIN outbound_jobs j ON j.id=a.job_id
    WHERE a.id=? AND a.correlated=1 AND j.provider_connection_id=? AND a.provider_key=?
    AND a.status IN ('submitted','unknown','accepted') AND j.status IN ('queued','sending','sent')
    AND (a.provider_message_id IS NULL OR a.provider_message_id=?)`,
    )
    .bind(id, connectionId, providerKey, providerMessageId)
    .first<OutboundAttempt>();
}

/** Accepted evidence replaces the lease as authority; only sending -> sent is allowed. */
export function prepareRestoreAcceptedJob(db: Database, attempt: OutboundAttempt) {
  return db
    .prepare(
      `UPDATE outbound_jobs SET status='sending' WHERE id=? AND status='queued'
    AND EXISTS(SELECT 1 FROM outbound_send_attempts WHERE id=? AND status='accepted')`,
    )
    .bind(attempt.job_id, attempt.id);
}

export function prepareFinalizeAcceptedJob(db: Database, attempt: OutboundAttempt, now: Date) {
  return db
    .prepare(
      `UPDATE outbound_jobs SET status='sent',provider_message_id=?,error_code=NULL,error_message=NULL,
    locked_at=NULL,locked_by=NULL,next_attempt_at=NULL,updated_at=? WHERE id=? AND status='sending'
    AND EXISTS(SELECT 1 FROM outbound_send_attempts a WHERE a.id=? AND a.job_id=outbound_jobs.id
      AND a.status='accepted' AND a.provider_message_id=?)`,
    )
    .bind(
      attempt.provider_message_id,
      sqliteTimestamp(now),
      attempt.job_id,
      attempt.id,
      attempt.provider_message_id,
    );
}

/** Abort the surrounding batch when the preceding guarded transition lost a race. */
export function prepareRequireAttemptTransition(db: Database) {
  return requireTransition(db);
}

export function prepareFinishAttemptReconciliation(db: Database, id: string) {
  return db
    .prepare(
      `UPDATE outbound_send_attempts SET next_reconcile_at=NULL WHERE id=? AND status='accepted'
    AND EXISTS(SELECT 1 FROM outbound_jobs j WHERE j.id=job_id AND j.status='sent')`,
    )
    .bind(id);
}

export async function claimAttemptsForReconciliation(db: Database, now: Date) {
  const stamp = sqliteTimestamp(now);
  await db.batch([
    db
      .prepare(
        `UPDATE outbound_send_attempts SET status='unknown',next_reconcile_at=?
      WHERE id IN (SELECT a.id FROM outbound_send_attempts a JOIN outbound_jobs j ON j.id=a.job_id
        WHERE a.status='submitted' AND j.status='sending' AND (j.locked_at IS NULL OR j.locked_at<=?)
        ORDER BY j.locked_at,a.id LIMIT 100)`,
      )
      .bind(stamp, stamp),
    db.prepare(`UPDATE outbound_jobs SET locked_at=NULL,locked_by=NULL,error_code='SEND_OUTCOME_UNKNOWN',
      error_message='Provider submission outcome requires reconciliation'
      WHERE id IN (SELECT j.id FROM outbound_jobs j JOIN outbound_send_attempts a ON a.job_id=j.id
        WHERE j.status='sending' AND a.status='unknown'
        AND (j.locked_at IS NOT NULL OR j.locked_by IS NOT NULL OR j.error_code IS NULL OR j.error_code!='SEND_OUTCOME_UNKNOWN')
        ORDER BY j.updated_at,j.id LIMIT 100)`),
  ]);
  const rows = await db
    .prepare(
      `UPDATE outbound_send_attempts SET reconciliation_checks=reconciliation_checks+1,
    next_reconcile_at=datetime(?, '+' || min(3600,300*(1 << min(reconciliation_checks,4))) || ' seconds')
    WHERE id IN (SELECT a.id FROM outbound_send_attempts a JOIN outbound_jobs j ON j.id=a.job_id
      WHERE a.status IN ('unknown','accepted') AND a.next_reconcile_at<=? AND j.status IN ('queued','sending')
      ORDER BY a.next_reconcile_at,a.id LIMIT 10) RETURNING *`,
    )
    .bind(stamp, stamp)
    .all<OutboundAttempt>();
  return rows.results;
}
