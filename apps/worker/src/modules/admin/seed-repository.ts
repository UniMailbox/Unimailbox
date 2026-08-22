// seed-repository — seeds roles, permissions, and role_permissions.
// Owner: admin module. Private file — export through modules/admin/index.ts.
//
// Uses deterministic IDs: permission id = permission key (e.g., 'message.read'),
// role id = role name (e.g., 'administrator'). This makes seeding idempotent
// via INSERT OR IGNORE and simplifies the role_permissions mapping.
//
// System seed data is not a domain aggregate — the UUID identity rule applies
// to user-generated entities, not to system configuration rows.

import type { Database } from '../../platform/database';
import type { PermissionKey } from '@unimailbox/contracts';

/**
 * All 20 permission keys with human-readable descriptions.
 * From .claude/rules/security.md §Authorization.
 */
const ALL_PERMISSIONS: ReadonlyArray<{
  key: PermissionKey;
  description: string;
}> = [
  { key: 'message.read', description: 'Read messages' },
  { key: 'message.send', description: 'Send messages' },
  { key: 'message.delete', description: 'Delete messages' },
  { key: 'mailbox.create', description: 'Create mailboxes' },
  { key: 'mailbox.manage', description: 'Manage mailboxes' },
  { key: 'mailbox.share', description: 'Share mailboxes' },
  { key: 'user.read', description: 'Read users' },
  { key: 'user.manage', description: 'Manage users' },
  { key: 'role.read', description: 'Read roles' },
  { key: 'role.manage', description: 'Manage roles' },
  { key: 'domain.read', description: 'Read domains' },
  { key: 'domain.manage', description: 'Manage domains' },
  { key: 'signature.read', description: 'Read signatures' },
  { key: 'signature.manage', description: 'Manage signatures' },
  { key: 'settings.read', description: 'Read settings' },
  { key: 'settings.manage', description: 'Manage settings' },
  { key: 'provider.sync', description: 'Sync provider state' },
  { key: 'webhook_event.read', description: 'Read webhook events' },
  { key: 'webhook_event.delete', description: 'Delete webhook events' },
  { key: 'analytics.read', description: 'Read analytics' },
];

/**
 * Role definitions with their assigned permissions.
 * From .claude/rules/security.md §Authorization.
 */
const ROLE_PERMISSIONS: ReadonlyArray<{
  role: string;
  description: string;
  permissions: PermissionKey[];
}> = [
  {
    role: 'administrator',
    description: 'Full system access',
    permissions: ALL_PERMISSIONS.map((p) => p.key),
  },
  {
    role: 'member',
    description: 'Standard user',
    permissions: [
      'message.read',
      'message.send',
      'message.delete',
      'mailbox.create',
      'mailbox.manage',
    ],
  },
];

/**
 * Seeds the permissions and roles tables with system defaults.
 *
 * Uses INSERT OR IGNORE for idempotency — safe to run multiple times.
 * Permission ID = permission key, role ID = role name (deterministic).
 *
 * The seeding generates ~27 statements:
 * - 20 permissions
 * - 2 roles
 * - 25 role_permissions (20 for admin + 5 for member)
 *
 * @param db — D1 database binding
 * @param timestamp — ISO datetime string for created_at columns
 */
export async function seedRolesAndPermissions(db: Database, timestamp: string): Promise<void> {
  const stmts: D1PreparedStatement[] = [];

  // Permissions — ID = key (deterministic for idempotent seeding)
  for (const perm of ALL_PERMISSIONS) {
    stmts.push(
      db
        .prepare(
          'INSERT OR IGNORE INTO permissions (id, key, description, created_at) VALUES (?, ?, ?, ?)',
        )
        .bind(perm.key, perm.key, perm.description, timestamp),
    );
  }

  // Roles — ID = name (deterministic)
  stmts.push(
    db
      .prepare(
        'INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at) VALUES (?, ?, ?, 1, ?)',
      )
      .bind('administrator', 'administrator', 'Full system access', timestamp),
  );

  stmts.push(
    db
      .prepare(
        'INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at) VALUES (?, ?, ?, 1, ?)',
      )
      .bind('member', 'member', 'Standard user', timestamp),
  );

  // Role-permission mappings
  for (const rp of ROLE_PERMISSIONS) {
    for (const perm of rp.permissions) {
      stmts.push(
        db
          .prepare(
            'INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES (?, ?, ?)',
          )
          .bind(rp.role, perm, timestamp),
      );
    }
  }

  await db.batch(stmts);
}

/**
 * Assigns a role to a user.
 *
 * Uses INSERT OR IGNORE for idempotency — safe if the role is already assigned.
 *
 * @param db — D1 database binding
 * @param userId — UUID of the user
 * @param roleId — Role ID (e.g., 'administrator', 'member')
 * @param timestamp — ISO datetime string for granted_at column
 */
export async function assignRole(
  db: Database,
  userId: string,
  roleId: string,
  timestamp: string,
): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_at) VALUES (?, ?, ?)')
    .bind(userId, roleId, timestamp)
    .run();
}
