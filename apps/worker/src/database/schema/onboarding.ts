// apps/worker/src/database/schema/onboarding.ts — Drizzle typing for
// installation_state and registration_keys tables. SQL in
// migrations/0001_initial.sql and migrations/0004_registration_keys.sql
// is the deployable artifact; these declarations are typing only.
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';

export const installationState = sqliteTable('installation_state', {
  id: integer('id').primaryKey(),
  status: text('status', { enum: ['setup', 'complete'] }).notNull(),
  currentStep: text('current_step', {
    enum: [
      'claim',
      'preflight',
      'administrator',
      'domain',
      'cloudflare-verify',
      'inbound-smoke',
      'brevo',
      'outbound-smoke',
      'complete',
    ],
  }).notNull(),
  schemaVersion: integer('schema_version').notNull(),
  claimedBy: text('claimed_by'),
  updatedAt: text('updated_at').notNull(),
  createdAt: text('created_at').notNull(),
});

export type InstallationState = typeof installationState.$inferSelect;
export type NewInstallationState = typeof installationState.$inferInsert;

// Registration keys table — CAP-018
// Stores invite codes for user registration. The code itself is never stored
// in plaintext — only the SHA-256 hash.
export const registrationKeys = sqliteTable('registration_keys', {
  id: text('id').primaryKey(),
  codeHash: text('code_hash').notNull(),
  roleId: text('role_id'),
  maxUses: integer('max_uses').notNull().default(1),
  usedCount: integer('used_count').notNull().default(0),
  expiresAt: text('expires_at'),
  revokedAt: text('revoked_at'),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(),
});

export type RegistrationKey = typeof registrationKeys.$inferSelect;
export type NewRegistrationKey = typeof registrationKeys.$inferInsert;
