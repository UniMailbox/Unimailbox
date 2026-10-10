import type { Database } from '../../platform/database';

/** Message-owned folder writer; only this scheduling lifecycle returns queued mail to draft. */
export function prepareRestoreScheduledDraft(
  db: Database,
  messageId: string,
  mailboxId: string,
  markerId: string,
  now: string,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE messages SET status='draft', updated_at=? WHERE id=? AND status='queued'
      AND EXISTS (SELECT 1 FROM idempotency_records WHERE id=?)`,
      )
      .bind(now, messageId, markerId),
    db
      .prepare(
        `UPDATE mailbox_messages SET folder='drafts' WHERE message_id=? AND mailbox_id=?
      AND EXISTS (SELECT 1 FROM idempotency_records WHERE id=?)`,
      )
      .bind(messageId, mailboxId, markerId),
  ];
}

export function prepareScheduledMessageSentFolder(
  db: Database,
  messageId: string,
  mailboxId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE mailbox_messages SET folder='sent' WHERE message_id=? AND mailbox_id=? AND folder='scheduled'`,
    )
    .bind(messageId, mailboxId);
}
