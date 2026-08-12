// apps/worker/src/database/schema/outbound-mail.ts — Drizzle typing for
// the encrypted_credentials table. SQL in migrations/0001_initial.sql is
// the deployable artifact; these declarations are typing only.
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