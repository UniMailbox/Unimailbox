// apps/worker/src/database/schema/outbound-mail.ts — Drizzle typing for
// the outbound-mail module tables. SQL in migrations/ is the deployable
// artifact; these declarations are typing only.
//
// ADR-007: ciphertext / iv / auth_tag / version — AES-GCM with a
// per-row version field for key rotation.
import { sqliteTable, text, integer, blob, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { messages } from './messages';

export const encryptedCredentials = sqliteTable(
  'encrypted_credentials',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    version: integer('version').notNull(),
    ciphertext: blob('ciphertext', { mode: 'buffer' }).notNull(),
    iv: blob('iv', { mode: 'buffer' }).notNull(),
    authTag: blob('auth_tag', { mode: 'buffer' }).notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    nameUnique: uniqueIndex('encrypted_credentials_name_unique').on(t.name),
  }),
);

export type EncryptedCredential = typeof encryptedCredentials.$inferSelect;
export type NewEncryptedCredential = typeof encryptedCredentials.$inferInsert;

// provider_connections — CAP-014
// Stores provider connections (Brevo, Resend, CF-Sendmail, etc.) with a
// foreign key to encrypted_credentials.
export const providerConnections = sqliteTable(
  'provider_connections',
  {
    id: text('id').primaryKey(),
    providerKey: text('provider_key').notNull(),
    label: text('label').notNull(),
    credentialId: text('credential_id').notNull().references(() => encryptedCredentials.id),
    status: text('status').notNull(), // 'active' | 'disabled' | 'invalid'
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
);

export type ProviderConnection = typeof providerConnections.$inferSelect;
export type NewProviderConnection = typeof providerConnections.$inferInsert;

// outbound_jobs — CAP-023
// One row per outbound message. Compose writes a 'queued' row in the same
// D1 batch as the message + mailbox_message (R-OUTBOUND-006); the queue
// consumer updates it through 'sending' → 'sent' (or 'failed').
export const outboundJobs = sqliteTable(
  'outbound_jobs',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
    providerConnectionId: text('provider_connection_id').notNull().references(() => providerConnections.id, { onDelete: 'cascade' }),
    status: text('status', {
      enum: ['queued', 'sending', 'sent', 'delayed', 'bounced', 'complained', 'failed'],
    }).notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    lockedAt: text('locked_at'),
    lockedBy: text('locked_by'),
    providerMessageId: text('provider_message_id'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    statusIdx: index('outbound_jobs_status_idx').on(t.status),
    messageIdx: index('outbound_jobs_message_idx').on(t.messageId),
  }),
);

export type OutboundJob = typeof outboundJobs.$inferSelect;
export type NewOutboundJob = typeof outboundJobs.$inferInsert;