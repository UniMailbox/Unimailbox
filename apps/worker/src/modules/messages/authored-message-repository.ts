import type { Database } from '../../platform/database';
import { DomainError } from '../../platform/errors';
import { assertCan } from '../tenancy';

/** Authored-message persistence belongs to messages, including compose-side writes. */
export function prepareAuthoredMessage(
  db: Database,
  input: {
    id: string;
    fromAddress: string;
    subject: string;
    htmlBody: string;
    textBody: string;
    inReplyTo: string | null;
    references: string | null;
    status: 'draft' | 'queued';
    actorUserId: string;
    now: string;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO messages (
    id, from_address, from_name, subject, html_body, text_body,
    message_id_header, in_reply_to_header, references_header,
    status, created_by_user_id, created_at, updated_at
  ) VALUES (?, ?, '', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.fromAddress,
      input.subject,
      input.htmlBody,
      input.textBody,
      input.inReplyTo,
      input.references,
      input.status,
      input.actorUserId,
      input.now,
      input.now,
    );
}

export function prepareAuthoredMailboxMessage(
  db: Database,
  input: {
    id: string;
    mailboxId: string;
    messageId: string;
    folder: 'drafts' | 'sent' | 'scheduled';
    now: string;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO mailbox_messages
    (id, mailbox_id, message_id, is_read, is_starred, folder, created_at)
    VALUES (?, ?, ?, 1, 0, ?, ?)`,
    )
    .bind(input.id, input.mailboxId, input.messageId, input.folder, input.now);
}

export function prepareDraftSentFolder(
  db: Database,
  messageId: string,
  markerId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE mailbox_messages SET folder = 'sent'
    WHERE message_id = ? AND folder = 'drafts'
    AND EXISTS (SELECT 1 FROM idempotency_records WHERE id = ?)`,
    )
    .bind(messageId, markerId);
}

/** Resolve real associations before replay, including when a draft has already been queued. */
export async function resolveAuthorizedMessageMailbox(
  db: Database,
  input: {
    actorUserId: string;
    messageId: string;
    operation: 'read' | 'send';
    draftOnly: boolean;
    mailboxId?: string;
  },
): Promise<string> {
  const rows = await db
    .prepare(
      `SELECT mm.mailbox_id FROM messages m
    JOIN mailbox_messages mm ON mm.message_id = m.id
    WHERE m.id = ? AND (? = 0 OR m.status = 'draft')
    AND (? IS NULL OR mm.mailbox_id = ?)
    ORDER BY mm.created_at ASC, mm.id ASC`,
    )
    .bind(
      input.messageId,
      input.draftOnly ? 1 : 0,
      input.mailboxId ?? null,
      input.mailboxId ?? null,
    )
    .all<{ mailbox_id: string }>();
  for (const row of rows.results ?? []) {
    try {
      await assertCan(db, input.actorUserId, row.mailbox_id, input.operation);
      return row.mailbox_id;
    } catch (error) {
      if (
        error instanceof DomainError &&
        (error.code === 'MAILBOX_ACCESS_DENIED' || error.code === 'MAILBOX_NOT_FOUND')
      )
        continue;
      throw error;
    }
  }
  throw new DomainError({
    code: 'MESSAGE_NOT_FOUND',
    message: 'Message not found',
    httpStatus: 404,
  });
}
