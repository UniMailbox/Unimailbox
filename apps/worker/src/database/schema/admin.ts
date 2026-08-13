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
// Idempotency records — CAP-027 / ADR-004.
//
// R-API-004, R-OUTBOUND-005, R-OUTBOUND-006. The table is written from
// apps/worker/src/platform/idempotency.ts via D1 batch / prepared statements;
// Drizzle declarations are typing only (see docs/rebuild/05-target-architecture/
// data-model.md §Migration authority — SQL is the deployable artifact).
//
// actor_id is opaque on purpose: it may be a userId, a hash of a setup-session
// token, a hash of a registration code, or a hash of an email. The unique
// index on (actor_id, operation, idempotency_key) is what makes concurrent
// retries safe — the second INSERT collides and the handler replays.
// ---------------------------------------------------------------------------
export const idempotencyRecords = sqliteTable(
  'idempotency_records',
  {
    id: text('id').primaryKey(),
    actorId: text('actor_id').notNull(),
    operation: text('operation').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseJson: text('response_json').notNull(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => ({
    unique: uniqueIndex('idempotency_records_unique').on(
      t.actorId,
      t.operation,
      t.idempotencyKey,
    ),
    expiresAtIdx: index('idempotency_records_expires_at_idx').on(t.expiresAt),
  }),
);

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
export type IdempotencyRecord = typeof idempotencyRecords.$inferSelect;
export type NewIdempotencyRecord = typeof idempotencyRecords.$inferInsert;