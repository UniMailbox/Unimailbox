import type { Database } from '../../platform/database';

export interface InboundAttachmentInput {
  readonly id: string;
  readonly messageId: string;
  readonly objectKey: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly disposition: 'attachment' | 'inline';
  readonly contentId: string | null;
  readonly createdAt: string;
}

export function prepareCreateInboundAttachment(
  db: Database,
  input: InboundAttachmentInput,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO inbound_message_attachments
         (id, message_id, object_key, filename, content_type, size_bytes,
          disposition, content_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.messageId,
      input.objectKey,
      input.filename,
      input.contentType,
      input.sizeBytes,
      input.disposition,
      input.contentId,
      input.createdAt,
    );
}

export async function findInboundAttachmentForDownload(
  db: Database,
  input: { readonly mailboxId: string; readonly attachmentId: string; readonly userId: string },
): Promise<{
  readonly objectKey: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly disposition: 'attachment' | 'inline';
} | null> {
  const row = await db
    .prepare(
      `SELECT ia.object_key, ia.filename, ia.content_type, ia.size_bytes, ia.disposition
         FROM inbound_message_attachments ia
         JOIN mailbox_messages mm ON mm.message_id = ia.message_id AND mm.mailbox_id = ?
    LEFT JOIN message_user_state mus
           ON mus.mailbox_message_id = mm.id AND mus.user_id = ?
        WHERE ia.id = ? AND COALESCE(mus.is_deleted, 0) = 0
        LIMIT 1`,
    )
    .bind(input.mailboxId, input.userId, input.attachmentId)
    .first<{
      object_key: string;
      filename: string;
      content_type: string;
      size_bytes: number;
      disposition: 'attachment' | 'inline';
    }>();
  return row
    ? {
        objectKey: row.object_key,
        filename: row.filename,
        contentType: row.content_type,
        sizeBytes: row.size_bytes,
        disposition: row.disposition,
      }
    : null;
}
