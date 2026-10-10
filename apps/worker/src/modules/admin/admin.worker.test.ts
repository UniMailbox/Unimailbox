// admin.worker.test.ts — CAP-017 roles, permissions, and requirePermission middleware.
//
// Worker-pool tests for the admin module's permission system.
// Tests:
// - seedRolesAndPermissions creates all 21 permissions, 2 roles, and 26 role_permissions
// - checkPermission returns true/false correctly
// - getUserRoleIds returns assigned roles
// - assignRole creates user_roles rows
// - completeSetup seeds and assigns admin role

import { describe, expect, it, beforeEach } from 'vitest';
import { resetAndMigrate, FIXED_TIMESTAMP, migrationsDb } from '@unimailbox/test-kit';
import { seedRolesAndPermissions, assignRole, checkPermission, getUserRoleIds } from './index';
import { systemClock } from '../../platform/clock';
import { randomUUID } from 'node:crypto';

/** Helper: Create a minimal user row for testing */
async function createTestUser(db: D1Database, userId?: string): Promise<string> {
  const id = userId ?? randomUUID();
  await db
    .prepare(
      `INSERT INTO users (id, email, display_name, status,
        password_algorithm, password_iterations, password_salt, password_hash,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      `${id}@example.test`,
      'Test User',
      'active',
      'pbkdf2-sha256',
      600000,
      new Uint8Array(16),
      new Uint8Array(32),
      FIXED_TIMESTAMP,
      FIXED_TIMESTAMP,
    )
    .run();
  return id;
}

describe('admin module — seedRolesAndPermissions', () => {
  beforeEach(resetAndMigrate);

  it('creates all 21 permissions with correct IDs (key = id)', async () => {
    const db = await migrationsDb();
    await seedRolesAndPermissions(db, FIXED_TIMESTAMP);

    const permissions = await db
      .prepare('SELECT id, key, description FROM permissions ORDER BY key')
      .all<{ id: string; key: string; description: string }>();

    expect(permissions.results).toHaveLength(21);

    // Verify deterministic IDs: id = key
    for (const perm of permissions.results ?? []) {
      expect(perm.id).toBe(perm.key);
    }

    // Verify all expected keys exist
    const keys = (permissions.results ?? []).map((p) => p.key);
    expect(keys).toContain('message.read');
    expect(keys).toContain('message.send');
    expect(keys).toContain('message.delete');
    expect(keys).toContain('mailbox.create');
    expect(keys).toContain('mailbox.manage');
    expect(keys).toContain('mailbox.share');
    expect(keys).toContain('user.read');
    expect(keys).toContain('user.manage');
    expect(keys).toContain('role.read');
    expect(keys).toContain('role.manage');
    expect(keys).toContain('domain.read');
    expect(keys).toContain('domain.manage');
    expect(keys).toContain('signature.read');
    expect(keys).toContain('signature.manage');
    expect(keys).toContain('settings.read');
    expect(keys).toContain('settings.manage');
    expect(keys).toContain('provider.sync');
    expect(keys).toContain('webhook_event.read');
    expect(keys).toContain('webhook_event.delete');
    expect(keys).toContain('analytics.read');
    // D-CAP-044-D (CAP-044 Slice 2): audit.read joins the closed set.
    expect(keys).toContain('audit.read');
  });

  it('creates the administrator role with all 21 permissions', async () => {
    const db = await migrationsDb();
    await seedRolesAndPermissions(db, FIXED_TIMESTAMP);

    const adminRole = await db
      .prepare('SELECT id, name, description, is_system FROM roles WHERE id = ?')
      .bind('administrator')
      .first<{ id: string; name: string; description: string; is_system: number }>();

    expect(adminRole).toBeDefined();
    expect(adminRole?.id).toBe('administrator');
    expect(adminRole?.name).toBe('administrator');
    expect(adminRole?.description).toBe('Full system access');
    expect(adminRole?.is_system).toBe(1);

    const adminPerms = await db
      .prepare('SELECT permission_id FROM role_permissions WHERE role_id = ?')
      .bind('administrator')
      .all<{ permission_id: string }>();

    expect(adminPerms.results).toHaveLength(21);
  });

  it('creates the member role with 5 permissions', async () => {
    const db = await migrationsDb();
    await seedRolesAndPermissions(db, FIXED_TIMESTAMP);

    const memberRole = await db
      .prepare('SELECT id, name, description, is_system FROM roles WHERE id = ?')
      .bind('member')
      .first<{ id: string; name: string; description: string; is_system: number }>();

    expect(memberRole).toBeDefined();
    expect(memberRole?.id).toBe('member');
    expect(memberRole?.name).toBe('member');
    expect(memberRole?.description).toBe('Standard user');
    expect(memberRole?.is_system).toBe(1);

    const memberPerms = await db
      .prepare(
        'SELECT permission_id FROM role_permissions WHERE role_id = ? ORDER BY permission_id',
      )
      .bind('member')
      .all<{ permission_id: string }>();

    expect(memberPerms.results).toHaveLength(5);

    const permKeys = (memberPerms.results ?? []).map((p) => p.permission_id);
    expect(permKeys).toEqual([
      'mailbox.create',
      'mailbox.manage',
      'message.delete',
      'message.read',
      'message.send',
    ]);
  });

  it('creates exactly 26 role_permissions rows (21 admin + 5 member)', async () => {
    const db = await migrationsDb();
    await seedRolesAndPermissions(db, FIXED_TIMESTAMP);

    const count = await db
      .prepare('SELECT COUNT(*) as count FROM role_permissions')
      .first<{ count: number }>();

    expect(count?.count).toBe(26);
  });

  it('is idempotent — calling twice does not duplicate rows', async () => {
    const db = await migrationsDb();
    await seedRolesAndPermissions(db, FIXED_TIMESTAMP);
    await seedRolesAndPermissions(db, FIXED_TIMESTAMP);

    const permCount = await db
      .prepare('SELECT COUNT(*) as count FROM permissions')
      .first<{ count: number }>();
    const roleCount = await db
      .prepare('SELECT COUNT(*) as count FROM roles')
      .first<{ count: number }>();
    const rpCount = await db
      .prepare('SELECT COUNT(*) as count FROM role_permissions')
      .first<{ count: number }>();

    expect(permCount?.count).toBe(21);
    expect(roleCount?.count).toBe(2);
    expect(rpCount?.count).toBe(26);
  });
});

describe('admin module — checkPermission', () => {
  let db: D1Database;

  beforeEach(async () => {
    await resetAndMigrate();
    db = await migrationsDb();
    await seedRolesAndPermissions(db, FIXED_TIMESTAMP);
  });

  it('returns true for administrator with any permission', async () => {
    const userId = await createTestUser(db);
    await assignRole(db, userId, 'administrator', FIXED_TIMESTAMP);

    const allPerms = [
      'message.read',
      'message.send',
      'message.delete',
      'mailbox.create',
      'mailbox.manage',
      'mailbox.share',
      'user.read',
      'user.manage',
      'role.read',
      'role.manage',
      'domain.read',
      'domain.manage',
      'signature.read',
      'signature.manage',
      'settings.read',
      'settings.manage',
      'provider.sync',
      'webhook_event.read',
      'webhook_event.delete',
      'analytics.read',
      'audit.read',
    ] as const;

    for (const perm of allPerms) {
      const has = await checkPermission(db, userId, perm);
      expect(has, `Expected admin to have ${perm}`).toBe(true);
    }
  });

  it('returns true for member with their 5 permissions', async () => {
    const userId = await createTestUser(db);
    await assignRole(db, userId, 'member', FIXED_TIMESTAMP);

    const memberPerms = [
      'message.read',
      'message.send',
      'message.delete',
      'mailbox.create',
      'mailbox.manage',
    ] as const;

    for (const perm of memberPerms) {
      const has = await checkPermission(db, userId, perm);
      expect(has, `Expected member to have ${perm}`).toBe(true);
    }
  });

  it('returns false for member with non-member permissions', async () => {
    const userId = await createTestUser(db);
    await assignRole(db, userId, 'member', FIXED_TIMESTAMP);

    const nonMemberPerms = [
      'user.manage',
      'role.manage',
      'domain.manage',
      'signature.manage',
      'settings.manage',
      'provider.sync',
      // D-CAP-044-D (CAP-044 Slice 2): audit.read is admin-only.
      'audit.read',
    ] as const;

    for (const perm of nonMemberPerms) {
      const has = await checkPermission(db, userId, perm);
      expect(has, `Expected member NOT to have ${perm}`).toBe(false);
    }
  });

  it('returns false for user with no roles', async () => {
    const userId = await createTestUser(db);

    const has = await checkPermission(db, userId, 'message.read');
    expect(has).toBe(false);
  });

  it('returns false for nonexistent permission key', async () => {
    const userId = await createTestUser(db);
    await assignRole(db, userId, 'administrator', FIXED_TIMESTAMP);

    // @ts-expect-error - testing invalid input
    const has = await checkPermission(db, userId, 'nonexistent.key');
    expect(has).toBe(false);
  });
});

describe('admin module — getUserRoleIds', () => {
  let db: D1Database;

  beforeEach(async () => {
    await resetAndMigrate();
    db = await migrationsDb();
    await seedRolesAndPermissions(db, FIXED_TIMESTAMP);
  });

  it('returns assigned role IDs', async () => {
    const userId = await createTestUser(db);
    await assignRole(db, userId, 'administrator', FIXED_TIMESTAMP);

    const roles = await getUserRoleIds(db, userId);
    expect(roles).toEqual(['administrator']);
  });

  it('returns empty array for user with no roles', async () => {
    const userId = await createTestUser(db);

    const roles = await getUserRoleIds(db, userId);
    expect(roles).toEqual([]);
  });

  it('returns multiple roles when user has multiple', async () => {
    const userId = await createTestUser(db);
    await assignRole(db, userId, 'administrator', FIXED_TIMESTAMP);
    await assignRole(db, userId, 'member', FIXED_TIMESTAMP);

    const roles = await getUserRoleIds(db, userId);
    expect(roles).toHaveLength(2);
    expect(roles).toContain('administrator');
    expect(roles).toContain('member');
  });
});

describe('admin module — assignRole', () => {
  let db: D1Database;

  beforeEach(async () => {
    await resetAndMigrate();
    db = await migrationsDb();
    await seedRolesAndPermissions(db, FIXED_TIMESTAMP);
  });

  it('creates a user_roles row', async () => {
    const userId = await createTestUser(db);
    await assignRole(db, userId, 'administrator', FIXED_TIMESTAMP);

    const row = await db
      .prepare('SELECT user_id, role_id, granted_at FROM user_roles WHERE user_id = ?')
      .bind(userId)
      .first<{ user_id: string; role_id: string; granted_at: string }>();

    expect(row).toBeDefined();
    expect(row?.user_id).toBe(userId);
    expect(row?.role_id).toBe('administrator');
    expect(row?.granted_at).toBe(FIXED_TIMESTAMP);
  });

  it('is idempotent — calling twice does not duplicate', async () => {
    const userId = await createTestUser(db);
    await assignRole(db, userId, 'administrator', FIXED_TIMESTAMP);
    await assignRole(db, userId, 'administrator', FIXED_TIMESTAMP);

    const count = await db
      .prepare('SELECT COUNT(*) as count FROM user_roles WHERE user_id = ?')
      .bind(userId)
      .first<{ count: number }>();

    expect(count?.count).toBe(1);
  });
});

describe('completeSetup integration', () => {
  let db: D1Database;

  beforeEach(async () => {
    await resetAndMigrate();
    db = await migrationsDb();
  });

  it('seeds roles, permissions, and assigns administrator role to first user', async () => {
    // Create the first user (administrator)
    const userId = await createTestUser(db, '00000000-0000-4000-8000-000000000001');

    // Seed the installation_state row (precondition for completeSetup)
    await db
      .prepare(
        `INSERT INTO installation_state (id, status, current_step, schema_version, updated_at, created_at)
         VALUES (1, ?, ?, 1, ?, ?)`,
      )
      .bind('setup', 'administrator', FIXED_TIMESTAMP, FIXED_TIMESTAMP)
      .run();

    // Import and run completeSetup
    const { completeSetup } = await import('../onboarding/complete-setup');

    await completeSetup({ db }, { clock: systemClock });

    // Verify roles and permissions were seeded
    const permCount = await db
      .prepare('SELECT COUNT(*) as count FROM permissions')
      .first<{ count: number }>();
    const roleCount = await db
      .prepare('SELECT COUNT(*) as count FROM roles')
      .first<{ count: number }>();
    const rpCount = await db
      .prepare('SELECT COUNT(*) as count FROM role_permissions')
      .first<{ count: number }>();

    expect(permCount?.count).toBe(21);
    expect(roleCount?.count).toBe(2);
    expect(rpCount?.count).toBe(26);

    // Verify administrator role was assigned to the first user
    const userRole = await db
      .prepare('SELECT role_id FROM user_roles WHERE user_id = ?')
      .bind(userId)
      .first<{ role_id: string }>();

    expect(userRole?.role_id).toBe('administrator');

    // Verify installation_state was flipped to complete
    const installationState = await db
      .prepare('SELECT status, current_step FROM installation_state WHERE id = 1')
      .first<{ status: string; current_step: string }>();

    expect(installationState?.status).toBe('complete');
    expect(installationState?.current_step).toBe('complete');
  });

  it('is idempotent — calling completeSetup twice succeeds', async () => {
    // Create the first user
    const userId = await createTestUser(db, '00000000-0000-4000-8000-000000000002');

    // Seed installation_state
    await db
      .prepare(
        `INSERT INTO installation_state (id, status, current_step, schema_version, updated_at, created_at)
         VALUES (1, ?, ?, 1, ?, ?)`,
      )
      .bind('setup', 'administrator', FIXED_TIMESTAMP, FIXED_TIMESTAMP)
      .run();

    // Import and run completeSetup twice
    const { completeSetup } = await import('../onboarding/complete-setup');

    await completeSetup({ db }, { clock: systemClock });
    await completeSetup({ db }, { clock: systemClock });

    // Verify no duplicates
    const permCount = await db
      .prepare('SELECT COUNT(*) as count FROM permissions')
      .first<{ count: number }>();
    const roleCount = await db
      .prepare('SELECT COUNT(*) as count FROM roles')
      .first<{ count: number }>();
    const userRoleCount = await db
      .prepare('SELECT COUNT(*) as count FROM user_roles WHERE user_id = ?')
      .bind(userId)
      .first<{ count: number }>();

    expect(permCount?.count).toBe(21);
    expect(roleCount?.count).toBe(2);
    expect(userRoleCount?.count).toBe(1);
  });
});
