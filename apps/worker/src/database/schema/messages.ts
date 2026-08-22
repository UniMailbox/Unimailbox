// apps/worker/src/database/schema/messages.ts — Drizzle typing for
// messages-owned tables (messages, message_recipients, mailbox_messages, message_user_state).
// SQL in migrations/0006_messages.sql is the deployable artifact;
// these declarations are typing only and must not be used to regenerate the SQL.
//
// R-INBOUND-008: Message + recipients + mailbox_messages inserted in one D1 batch
import { sqliteTable, text, index, uniqueIndex, integer } from 'drizzle-orm/sqlite-core';
import { users } from './identity';
import { mailboxes } from './tenancy';

// messages — CAP-021
export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id'),
    fromAddress: text('from_address').notNull(),
    fromName: text('from_name').notNull().default(''),
    subject: text('subject').notNull().default(''),
    htmlBody: text('html_body').notNull().default(''),
    textBody: text('text_body').notNull().default(''),
    messageIdHeader: text('message_id_header'),
    inReplyToHeader: text('in_reply_to_header'),
    referencesHeader: text('references_header').notNull().default(''),
    status: text('status', {
      enum: [
        'draft',
        'queued',
        'sending',
        'sent',
        'delivered',
        'delayed',
        'bounced',
        'complained',
        'failed',
      ],
    })
      .notNull()
      .default('delivered'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    rawObjectKey: text('raw_object_key'),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    receivedAt: text('received_at'),
    sentAt: text('sent_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    threadIdIdx: index('messages_thread_id_idx').on(table.threadId),
    fromAddressIdx: index('messages_from_address_idx').on(table.fromAddress),
    statusIdx: index('messages_status_idx').on(table.status),
    createdAtIdx: index('messages_created_at_idx').on(table.createdAt),
  }),
);

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

// message_recipients — CAP-021
export const messageRecipients = sqliteTable(
  'message_recipients',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    address: text('address').notNull(),
    displayName: text('display_name').notNull().default(''),
    type: text('type', { enum: ['to', 'cc', 'bcc'] }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => ({
    messageIdx: index('message_recipients_message_idx').on(table.messageId),
  }),
);

export type MessageRecipient = typeof messageRecipients.$inferSelect;
export type NewMessageRecipient = typeof messageRecipients.$inferInsert;

// mailbox_messages — CAP-021
export const mailboxMessages = sqliteTable(
  'mailbox_messages',
  {
    id: text('id').primaryKey(),
    mailboxId: text('mailbox_id')
      .notNull()
      .references(() => mailboxes.id, { onDelete: 'cascade' }),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    isRead: integer('is_read', { mode: 'boolean' }).notNull().default(false),
    isStarred: integer('is_starred', { mode: 'boolean' }).notNull().default(false),
    folder: text('folder').notNull().default('inbox'),
    createdAt: text('created_at').notNull(),
  },
  (table) => ({
    mailboxIdx: index('mailbox_messages_mailbox_idx').on(table.mailboxId),
    messageIdx: index('mailbox_messages_message_idx').on(table.messageId),
    mailboxMessageUnique: uniqueIndex('mailbox_messages_mailbox_id_message_id_unique').on(
      table.mailboxId,
      table.messageId,
    ),
  }),
);

export type MailboxMessage = typeof mailboxMessages.$inferSelect;
export type NewMailboxMessage = typeof mailboxMessages.$inferInsert;

// message_user_state — CAP-021
export const messageUserState = sqliteTable(
  'message_user_state',
  {
    mailboxMessageId: text('mailbox_message_id')
      .primaryKey()
      .references(() => mailboxMessages.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    isRead: integer('is_read', { mode: 'boolean' }).notNull().default(false),
    readAt: text('read_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    userIdx: index('message_user_state_user_idx').on(table.userId),
  }),
);

export type MessageUserState = typeof messageUserState.$inferSelect;
export type NewMessageUserState = typeof messageUserState.$inferInsert;
