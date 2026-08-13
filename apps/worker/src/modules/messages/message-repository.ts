// message-repository — persists messages and mailbox associations.
// Owner: messages module. Private file — export through modules/messages/index.ts.
//
// R-INBOUND-008: Message + recipients + mailbox_messages inserted in one D1 batch
// All prepare functions return D1PreparedStatement for batch execution.

import type { Database } from '../../platform/database';
import type { ParsedEmail } from '@unimailbox/email-core';

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
