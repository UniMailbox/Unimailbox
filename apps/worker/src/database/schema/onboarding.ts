// apps/worker/src/database/schema/onboarding.ts — Drizzle typing for the
// installation_state single-row table. SQL in migrations/0001_initial.sql
// is the deployable artifact; these declarations are typing only.
//
// The full setup state-machine lands with CAP-006 (setup gate) through
// CAP-008 (claim). CAP-004 only shapes the table so CAP-006 can write
// the first row without a migration.
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