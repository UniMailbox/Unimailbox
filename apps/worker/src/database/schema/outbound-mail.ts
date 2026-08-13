// apps/worker/src/database/schema/outbound-mail.ts — Drizzle typing for
// the outbound-mail module tables. SQL in migrations/ is the deployable
// artifact; these declarations are typing only.
//
// ADR-007: ciphertext / iv / auth_tag / version — AES-GCM with a
// per-row version field for key rotation.
import { sqliteTable, text, integer, blob, uniqueIndex } from 'drizzle-orm/sqlite-core';

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