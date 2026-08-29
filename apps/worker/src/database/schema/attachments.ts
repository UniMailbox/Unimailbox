// Typed Drizzle declaration for CAP-049 attachment_uploads.
// The SQL migration is the deployment authority; this file is typing only.

import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { users } from './identity';
import { mailboxes } from './tenancy';

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
