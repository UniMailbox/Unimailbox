// message-repository — persists messages and mailbox associations.
// Owner: messages module. Private file — export through modules/messages/index.ts.
//
// R-INBOUND-008: Message + recipients + mailbox_messages inserted in one D1 batch
// All prepare functions return D1PreparedStatement for batch execution.
//
// CAP-029: updateMessageStatus is the single `messages` row writer for status
// transitions from outbound-mail. It carries the R-MESSAGE-007 rank-aware
// predicate so an out-of-order webhook cannot clobber a newer status.

import type { Database } from '../../platform/database';
import type { ParsedEmail } from '@unimailbox/email-core';
import { statusRank, type MessageStatus } from '@unimailbox/contracts';

export interface CreateMessageInput {
  readonly id: string;
  readonly parsed: ParsedEmail;
  readonly receivedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateRecipientInput {
  readonly id: string;
  readonly messageId: string;
  readonly address: string;
  readonly displayName: string;
  readonly type: 'to' | 'cc' | 'bcc';
  readonly createdAt: string;
}

export interface CreateMailboxMessageInput {
  readonly id: string;
  readonly mailboxId: string;
  readonly messageId: string;
  readonly createdAt: string;
}

/**
 * Prepares a D1 statement for inserting the message row.
 *
 * The message includes from_address, from_name, subject, html_body, text_body,
 * message_id_header, in_reply_to_header, references_header, status='delivered',
 * received_at (for inbound), and timestamps.
 *
 * @param db — Database instance
 * @param input — Message data from parsed email
 * @returns D1PreparedStatement ready for batch
 */
export function prepareCreateMessage(
  db: Database,
  input: CreateMessageInput,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO messages (
      id, from_address, from_name, subject, html_body, text_body,
      message_id_header, in_reply_to_header, references_header,
      status, received_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'delivered', ?, ?, ?)`,
  ).bind(
    input.id,
    input.parsed.from.address,
    input.parsed.from.name,
    input.parsed.subject,
    input.parsed.htmlBody,
    input.parsed.textBody,
    input.parsed.messageId,
    input.parsed.inReplyTo,
    input.parsed.references,
    input.receivedAt,
    input.createdAt,
    input.updatedAt,
  );
}

/**
 * Prepares a D1 statement for inserting a recipient row.
 *
 * Recipients are extracted from parsed.to and parsed.cc (bcc is not included
 * in inbound emails). Each recipient gets its own row with type='to' or 'cc'.
 *
 * @param db — Database instance
 * @param input — Recipient data
 * @returns D1PreparedStatement ready for batch
 */
export function prepareCreateRecipient(
  db: Database,
  input: CreateRecipientInput,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO message_recipients (id, message_id, address, display_name, type, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    input.id,
    input.messageId,
    input.address,
    input.displayName,
    input.type,
    input.createdAt,
  );
}

/**
 * Prepares a D1 statement for inserting a mailbox_message row.
 *
 * Associates a message with a mailbox. One message can be associated with
 * multiple mailboxes (when sent to multiple recipients on the same domain).
 *
 * @param db — Database instance
 * @param input — Mailbox-message association data
 * @returns D1PreparedStatement ready for batch
 */
export function prepareCreateMailboxMessage(
  db: Database,
  input: CreateMailboxMessageInput,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO mailbox_messages (id, mailbox_id, message_id, is_read, is_starred, folder, created_at)
     VALUES (?, ?, ?, 0, 0, 'inbox', ?)`,
  ).bind(input.id, input.mailboxId, input.messageId, input.createdAt);
}

/**
 * Creates message + recipients + mailbox_messages in one atomic D1 batch.
 *
 * R-INBOUND-008: This function ensures that the message and all related rows
 * are inserted together. If any insert fails, the entire batch rolls back.
 *
 * @param db — Database instance
 * @param statements — Array of prepared statements (message + N recipients + N mailbox_messages)
 * @throws D1 error if batch fails
 */
export async function createMessageWithRelations(
  db: Database,
  statements: D1PreparedStatement[],
): Promise<void> {
  // D1 batch executes all statements atomically
  await db.batch(statements);
}

export interface UpdateMessageStatusInput {
  readonly messageId: string;
  readonly status: MessageStatus;
  /**
   * Epoch milliseconds the caller associates with the status. Used for
   * R-MESSAGE-007 ordering (provider_payload timestamp first; server fallback
   * is allowed when the provider sent none). The value is stored in
   * `messages.provider_event_time` so future events can compare against it.
   */
  readonly providerEventTimeMs: number;
  /**
   * Optional ISO-8601 timestamp for the `sent` column. Supplied by the
   * outbound-mail queue consumer on the post-send write (Q3 decision: this
   * function owns `sent_at` to keep `messages` row writes consolidated).
   * COALESCE means an earlier `sent_at` is never overwritten.
   */
  readonly sentAt?: string;
  /**
   * SQLite datetime string ('YYYY-MM-DD HH:MM:SS' UTC). The caller controls
   * the clock so tests can drive deterministic timestamps.
   */
  readonly now: string;
}

/**
 * Updates a message's status with the R-MESSAGE-007 rank-aware predicate.
 *
 * The single D1 statement encodes the entire ordering rule: an update applies
 * iff the stored `provider_event_time` is NULL (no prior event), strictly
 * less than the incoming event time (this event is newer), or equal to the
 * incoming event time AND the stored status has a strictly lower rank
 * (R-MESSAGE-007 tie-breaker: equal-time terminal-state promotion).
 *
 * `sent_at` is written with `COALESCE(?, sent_at)` so a status update that
 * does not carry a `sent_at` (e.g. a webhook `delivered` event) never
 * overwrites the value set by the queue consumer on post-send.
 *
 * A6: the writer is a single D1 statement, so the read-compute-write is
 * atomic — there is no concurrent-update concern (D1 serialises per row).
 * Returns whether the write applied; callers use the boolean for
 * observability (e.g. the divergence warn in process-outbound-job's success
 * path), never for control flow.
 *
 * D-CAP-028-D: this function is the public surface for outbound-mail to
 * transition `messages.status`. There is no other `UPDATE messages SET
 * status = ?` statement outside this module.
 *
 * @param db — Database instance
 * @param input — messageId, new status, provider event time, optional sentAt
 * @returns true when the status was applied; false when the predicate
 *          rejected the update (older or equal-lower-rank event)
 */
export async function updateMessageStatus(
  db: Database,
  input: UpdateMessageStatusInput,
): Promise<boolean> {
  const newRank = statusRank(input.status);
  // CASE in the WHERE maps each MessageStatus to its rank (STATUS_RANK_TABLE)
  // without duplicating the enum in SQL. statusRank is the single source of
  // truth for the rank — the SQL below must match it. The literal defaults
  // are mirrored exactly; if STATUS_RANK_TABLE changes, update here too.
  // The single-D1-statement structure is the predicate — any race between
  // concurrent webhooks for the same message is resolved by SQLite's
  // per-row write serialisation (A6).
  const result = await db
    .prepare(
      `UPDATE messages
          SET status = ?,
              provider_event_time = ?,
              sent_at = COALESCE(?, sent_at),
              updated_at = ?
        WHERE id = ?
          AND (
            provider_event_time IS NULL
            OR provider_event_time < ?
            OR (
              provider_event_time = ?
              AND CASE status
                    WHEN 'failed' THEN 100
                    WHEN 'bounced' THEN 100
                    WHEN 'complained' THEN 100
                    WHEN 'delivered' THEN 80
                    WHEN 'delayed' THEN 60
                    WHEN 'queued' THEN 40
                    WHEN 'sending' THEN 30
                    WHEN 'sent' THEN 20
                    WHEN 'draft' THEN 10
                    ELSE -1
                  END < ?
            )
          )`,
    )
    .bind(
      input.status,
      input.providerEventTimeMs,
      input.sentAt ?? null,
      input.now,
      input.messageId,
      input.providerEventTimeMs,
      input.providerEventTimeMs,
      newRank,
    )
    .run();
  return (result.meta?.changes ?? 0) > 0;
}
