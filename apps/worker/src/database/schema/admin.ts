// apps/worker/src/database/schema/admin.ts — Drizzle typing for
// admin-owned tables. SQL in migrations/0001_initial.sql is the deployable
// artifact; these declarations are typing only.
//
// R-AUTHZ-005: admin identity comes from user_roles, never a flag on users.
// R-AUDIT-001..004: audit_events shape.
// R-WORKFLOW-005: maintenance_jobs cursor-based, idempotent.
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { users } from './identity';

export const systemSettings = sqliteTable('system_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
  createdAt: text('created_at').notNull(),
});

export const permissions = sqliteTable(
  'permissions',
  {
    id: text('id').primaryKey(),
    key: text('key').notNull(),
    description: text('description').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    keyUnique: uniqueIndex('permissions_key_unique').on(t.key),
  }),
);

export const roles = sqliteTable(
  'roles',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    isSystem: integer('is_system').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    nameUnique: uniqueIndex('roles_name_unique').on(t.name),
  }),
);

export const rolePermissions = sqliteTable('role_permissions', {
  roleId: text('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  permissionId: text('permission_id').notNull().references(() => permissions.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
});

export const userRoles = sqliteTable(
  'user_roles',
  {
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    roleId: text('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
    grantedAt: text('granted_at').notNull(),
    grantedBy: text('granted_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => ({
    roleIdIdx: index('user_roles_role_id_idx').on(t.roleId),
  }),
);

export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    requestId: text('request_id'),
    metadata: text('metadata'),
    ip: text('ip'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    resourceIdx: index('audit_events_resource_idx').on(t.resourceType, t.resourceId, t.createdAt),
    actorIdx: index('audit_events_actor_idx').on(t.actorUserId, t.createdAt),
    createdIdx: index('audit_events_created_idx').on(t.createdAt),
  }),
);

export const maintenanceJobs = sqliteTable(
  'maintenance_jobs',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    status: text('status', { enum: ['pending', 'running', 'done', 'failed'] }).notNull(),
    cursor: text('cursor'),
    attempts: integer('attempts').notNull(),
    lastError: text('last_error'),
    scheduledAt: text('scheduled_at').notNull(),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    statusScheduledAtIdx: index('maintenance_jobs_status_scheduled_at_idx').on(t.status, t.scheduledAt),
  }),
);

// ---------------------------------------------------------------------------
// D-CAP-021 / CAP-035: blocklist + per-role policies.
//
// R-INBOUND-005: blocklist_entries holds subject/content/from patterns
// (case-insensitive substring). The admin module owns this table.
//
// R-INBOUND-006: role_policies holds banEmail + availDomain JSON arrays per
// role. One row per role (PRIMARY KEY = role_id). Empty arrays mean "allow
// all" for availDomain; banEmail is empty by default. R-DATA-005 is relaxed
// for these two columns — see the migration's deferred-normalization comment.
//
// SQL in migrations/0010_blocklist_and_role_policies.sql is the deployable
// artifact; these declarations are typing only.
// ---------------------------------------------------------------------------

export const blocklistEntries = sqliteTable(
  'blocklist_entries',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['subject', 'content', 'from'] }).notNull(),
    pattern: text('pattern').notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    createdAtIdx: index('blocklist_entries_created_at_idx').on(t.createdAt),
  }),
);

export const rolePolicies = sqliteTable('role_policies', {
  roleId: text('role_id').primaryKey().references(() => roles.id, { onDelete: 'cascade' }),
  banEmailPatternsJson: text('ban_email_patterns_json').notNull(),
  availDomainPatternsJson: text('avail_domain_patterns_json').notNull(),
  updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: text('updated_at').notNull(),
});

export type SystemSetting = typeof systemSettings.$inferSelect;
export type NewSystemSetting = typeof systemSettings.$inferInsert;
export type Permission = typeof permissions.$inferSelect;
export type NewPermission = typeof permissions.$inferInsert;
export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
export type UserRole = typeof userRoles.$inferSelect;
export type NewUserRole = typeof userRoles.$inferInsert;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
export type MaintenanceJob = typeof maintenanceJobs.$inferSelect;
export type NewMaintenanceJob = typeof maintenanceJobs.$inferInsert;
export type BlocklistEntryRowDrizzle = typeof blocklistEntries.$inferSelect;
export type NewBlocklistEntryRowDrizzle = typeof blocklistEntries.$inferInsert;
export type RolePolicyRowDrizzle = typeof rolePolicies.$inferSelect;
export type NewRolePolicyRowDrizzle = typeof rolePolicies.$inferInsert;