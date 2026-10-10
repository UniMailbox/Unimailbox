// Typing only; migrations 0029/0030 are authoritative.
import { sqliteTable, text, integer, index, primaryKey } from 'drizzle-orm/sqlite-core';
import { users } from './identity';
import { mailboxes, managedDomains } from './tenancy';
export const editorAssets = sqliteTable(
  'editor_assets',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id),
    mailboxId: text('mailbox_id').references(() => mailboxes.id),
    domainId: text('domain_id').references(() => managedDomains.id),
    secretHash: text('secret_hash').notNull(),
    objectKey: text('object_key').notNull().unique(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    kind: text('kind', { enum: ['image', 'file'] }).notNull(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (table) => ({
    pending: index('editor_assets_pending').on(table.expiresAt),
    owner: index('editor_assets_owner').on(table.ownerUserId),
  }),
);
export const editorAssetUsages = sqliteTable(
  'editor_asset_usages',
  {
    assetId: text('asset_id')
      .notNull()
      .references(() => editorAssets.id, { onDelete: 'restrict' }),
    resourceType: text('resource_type', { enum: ['message', 'signature'] }).notNull(),
    resourceId: text('resource_id').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.assetId, table.resourceType, table.resourceId] }),
  }),
);
