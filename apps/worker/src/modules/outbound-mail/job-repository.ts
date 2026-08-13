// job-repository — outbound_jobs CRUD. CAP-023.
// Owner: outbound-mail module. Private file — export through
// modules/outbound-mail/index.ts.
//
// R-OUTBOUND-006: prepareCreateOutboundJob returns a D1PreparedStatement so the
// compose route can include the insert in the same D1 batch as the message +
// mailbox_message writes (atomicity: a crash between them cannot produce a
// queued message with no job).

import type { Database } from '../../platform/database';

export interface CreateJobInput {
  readonly id: string;
  readonly messageId: string;
  readonly providerConnectionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OutboundJobRow {
  readonly id: string;
  readonly message_id: string;
  readonly provider_connection_id: string;
  readonly status: 'queued' | 'sending' | 'sent' | 'delayed' | 'bounced' | 'complained' | 'failed';
  readonly attempts: number;
  readonly max_attempts: number;
  readonly locked_at: string | null;
  readonly locked_by: string | null;
  readonly provider_message_id: string | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly created_at: string;
  readonly updated_at: string;
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
export function prepareCreateOutboundJob(
  db: Database,
  input: CreateJobInput,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO outbound_jobs (id, message_id, provider_connection_id, status, attempts, max_attempts, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', 0, 3, ?, ?)`,
  ).bind(
    input.id,
    input.messageId,
    input.providerConnectionId,
    input.createdAt,
    input.updatedAt,
  );
}

/**
 * Reads a single outbound job by ID. Returns null if not found.
 */
export async function getOutboundJob(
  db: Database,
  jobId: string,
): Promise<OutboundJobRow | null> {
  return db
    .prepare('SELECT * FROM outbound_jobs WHERE id = ?')
    .bind(jobId)
    .first<OutboundJobRow>();
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
 */
export async function updateJobStatus(
  db: Database,
  jobId: string,
  status: OutboundJobRow['status'],
  extra?: UpdateJobStatusInput,
): Promise<void> {
  // SQLite datetime: YYYY-MM-DD HH:MM:SS (UTC), matching the migration default.
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  if (extra?.providerMessageId) {
    await db.prepare(
      'UPDATE outbound_jobs SET status = ?, provider_message_id = ?, updated_at = ? WHERE id = ?',
    ).bind(status, extra.providerMessageId, now, jobId).run();
  } else if (extra?.errorCode) {
    // Failure path: record the error and bump attempts so max_attempts can
    // gate retries in the queue consumer.
    await db.prepare(
      'UPDATE outbound_jobs SET status = ?, error_code = ?, error_message = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?',
    ).bind(status, extra.errorCode, extra.errorMessage ?? '', now, jobId).run();
  } else {
    await db.prepare(
      'UPDATE outbound_jobs SET status = ?, updated_at = ? WHERE id = ?',
    ).bind(status, now, jobId).run();
  }
}
