// Typed Drizzle declaration for CAP-049 attachment_uploads.
// The SQL migration is the deployment authority; this file is typing only.

import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { users } from './identity';
import { mailboxes } from './tenancy';
import { messages } from './messages';

export const attachmentUploads = sqliteTable(
  'attachment_uploads',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mailboxId: text('mailbox_id')
      .notNull()
      .references(() => mailboxes.id, { onDelete: 'cascade' }),
    kvKey: text('kv_key').notNull(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    disposition: text('disposition', { enum: ['attachment', 'inline'] })
      .notNull()
      .default('attachment'),
    sizeBytes: integer('size_bytes').notNull(),
    status: text('status', { enum: ['uploaded', 'consumed', 'expired'] }).notNull(),
    expiresAt: text('expires_at').notNull(),
    consumedAt: text('consumed_at'),
    createdAt: text('created_at').notNull(),
  },
  (table) => ({
    kvKeyUnique: uniqueIndex('attachment_uploads_kv_key_unique').on(table.kvKey),
    ownerIdx: index('attachment_uploads_owner_idx').on(table.ownerUserId),
    mailboxIdx: index('attachment_uploads_mailbox_idx').on(table.mailboxId),
    expiresAtIdx: index('attachment_uploads_expires_at_idx').on(table.expiresAt),
  }),
);

export type AttachmentUpload = typeof attachmentUploads.$inferSelect;
export type NewAttachmentUpload = typeof attachmentUploads.$inferInsert;

/**
 * CAP-050 consumed attachment relations. Owned by the `messages` module.
 * `objectKey` mirrors the canonical `attachment:<uploadId>` CACHE KV key so
 * the queue consumer reads bytes without re-deriving the key shape.
 */
export const messageAttachments = sqliteTable(
  'message_attachments',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    uploadId: text('upload_id')
      .notNull()
      .references(() => attachmentUploads.id, { onDelete: 'restrict' }),
    objectKey: text('object_key').notNull(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    disposition: text('disposition', { enum: ['attachment', 'inline'] })
      .notNull()
      .default('attachment'),
    contentId: text('content_id'),
    sha256: text('sha256'),
    createdAt: text('created_at').notNull(),
  },
  (table) => ({
    uploadUnique: uniqueIndex('message_attachments_upload_unique').on(table.uploadId),
    messageIdx: index('message_attachments_message_idx').on(table.messageId),
  }),
);

export type MessageAttachment = typeof messageAttachments.$inferSelect;
export type NewMessageAttachment = typeof messageAttachments.$inferInsert;
