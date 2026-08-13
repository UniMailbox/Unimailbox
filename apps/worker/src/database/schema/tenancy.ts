// apps/worker/src/database/schema/tenancy.ts — Drizzle typing for
// tenancy-owned tables (managed_domains, mailboxes, mailbox_members).
// SQL in migrations/0002_managed_domains.sql and 0005_mailboxes.sql are the deployable artifacts;
// these declarations are typing only and must not be used to regenerate the SQL.
//
// R-DATA-001: managed_domains.name is case-insensitive (COLLATE NOCASE).
// ManagedDomain invariant: name is UNIQUE. New domains start as 'active'.
// R-MAILBOX-003: Owner is implicitly a member; no explicit row needed in mailbox_members.
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

// mailboxes — CAP-020
export const mailboxes = sqliteTable(
  'mailboxes',
  {
    id: text('id').primaryKey(),
    domainId: text('domain_id').notNull().references(() => managedDomains.id),
    ownerUserId: text('owner_user_id').notNull(),
    localPart: text('local_part').notNull(),
    displayName: text('display_name').notNull().default(''),
    status: text('status', { enum: ['active', 'disabled', 'deleted'] }).notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (_table) => ({
    domainLocalUnique: uniqueIndex('mailboxes_domain_local_unique').on(_table.domainId, _table.localPart),
    ownerIdx: uniqueIndex('mailboxes_owner_idx').on(_table.ownerUserId),
  }),
);

export type Mailbox = typeof mailboxes.$inferSelect;
export type NewMailbox = typeof mailboxes.$inferInsert;

// mailbox_members — CAP-020
export const mailboxMembers = sqliteTable(
  'mailbox_members',
  {
    mailboxId: text('mailbox_id').notNull().references(() => mailboxes.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    role: text('role', { enum: ['viewer', 'sender', 'admin'] }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => ({
    pk: uniqueIndex('mailbox_members_pk').on(table.mailboxId, table.userId),
  }),
);

export type MailboxMember = typeof mailboxMembers.$inferSelect;
export type NewMailboxMember = typeof mailboxMembers.$inferInsert;
