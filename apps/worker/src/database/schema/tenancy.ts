// apps/worker/src/database/schema/tenancy.ts — Drizzle typing for
// tenancy-owned tables (managed_domains, mailboxes, mailbox_members).
// SQL in migrations/0002_managed_domains.sql is the deployable artifact;
// these declarations are typing only and must not be used to regenerate the SQL.
//
// R-DATA-001: managed_domains.name is case-insensitive (COLLATE NOCASE).
// ManagedDomain invariant: name is UNIQUE. New domains start as 'active'.
import { sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const managedDomains = sqliteTable(
  'managed_domains',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    status: text('status', { enum: ['active', 'disabled'] }).notNull(),
    outboundConnectionId: text('outbound_connection_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (_table) => ({
    nameUnique: uniqueIndex('managed_domains_name_unique').on(_table.name),
  }),
);

export type ManagedDomain = typeof managedDomains.$inferSelect;
export type NewManagedDomain = typeof managedDomains.$inferInsert;
