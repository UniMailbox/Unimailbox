// permission-repository — checks user permissions via RBAC.
// Owner: admin module. Private file — export through modules/admin/index.ts.
//
// R-AUTHZ-001: Permissions are a closed enum (PermissionKey).
// R-AUTHZ-002: Authorization checks hit the database per request; no cache older than 5 minutes.
// R-AUTHZ-005: Admin identity comes from user_roles, never a flag on users.

import type { Database } from '../../platform/database';
import type { PermissionKey } from '@unimailbox/contracts';

/**
 * Checks if a user has a specific permission.
 *
 * Joins across user_roles → role_permissions → permissions to find the permission.
 * Returns true if the user has the permission via any of their assigned roles.
 *
 * @param db — D1 database binding
 * @param userId — UUID of the user to check
 * @param permissionKey — PermissionKey to check for
 * @returns true if the user has the permission, false otherwise
 */
export async function checkPermission(
  db: Database,
  userId: string,
  permissionKey: PermissionKey,
): Promise<boolean> {
  const result = await db
    .prepare(
      `SELECT 1 FROM user_roles ur
       JOIN role_permissions rp ON ur.role_id = rp.role_id
       JOIN permissions p ON rp.permission_id = p.id
       WHERE ur.user_id = ? AND p.key = ?
       LIMIT 1`,
    )
    .bind(userId, permissionKey)
    .first<{ '1': number }>();

  return !!result;
}

/**
 * UI hint for the administrative workspace. Mailbox and message permissions
 * belong to the mailbox surface (the default member role has several of
 * them), so only permissions backed by an admin page qualify. Individual
 * admin API routes still enforce their own permission on every request.
 */
export async function hasAdministrativePermission(db: Database, userId: string): Promise<boolean> {
  const result = await db
    .prepare(
      `SELECT 1 FROM user_roles ur
       JOIN role_permissions rp ON ur.role_id = rp.role_id
       JOIN permissions p ON rp.permission_id = p.id
       WHERE ur.user_id = ?
         AND p.key IN (
           'user.read', 'user.manage', 'role.read', 'role.manage',
           'domain.read', 'domain.manage', 'signature.read', 'signature.manage',
           'settings.read', 'settings.manage', 'provider.sync',
           'webhook_event.read', 'webhook_event.delete', 'analytics.read', 'audit.read'
         )
       LIMIT 1`,
    )
    .bind(userId)
    .first<{ '1': number }>();
  return !!result;
}

/**
 * Gets all role IDs assigned to a user.
 *
 * Useful for UI rendering of user roles or audit logging.
 *
 * @param db — D1 database binding
 * @param userId — UUID of the user
 * @returns Array of role IDs (strings) assigned to the user
 */
export async function getUserRoleIds(db: Database, userId: string): Promise<string[]> {
  const rows = await db
    .prepare('SELECT role_id FROM user_roles WHERE user_id = ?')
    .bind(userId)
    .all<{ role_id: string }>();

  return rows.results?.map((r) => r.role_id) ?? [];
}
