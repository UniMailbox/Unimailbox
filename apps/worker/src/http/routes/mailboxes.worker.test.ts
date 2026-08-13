// mailboxes.worker.test.ts — CAP-020 mailbox endpoints.
//
// Worker-pool tests for POST /api/v1/mailboxes, GET /api/v1/mailboxes.
// Uses SELF.fetch to exercise the full request pipeline.

import { describe, expect, it, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { hashPassword } from '../../platform/crypto';
import { assertCan } from '../../modules/tenancy';

// Helper: complete setup before tests
async function completeSetup(): Promise<void> {
  // Seed installation_state as complete
  await seedInstallationState({ status: 'complete', currentStep: 'complete' });

  // Seed roles and permissions (order matters for foreign keys)
  await env.DB.batch([
    // Permissions first
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at) VALUES ('user.manage', 'user.manage', 'Manage users', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at) VALUES ('message.read', 'message.read', 'Read messages', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at) VALUES ('mailbox.create', 'mailbox.create', 'Create mailboxes', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at) VALUES ('role.manage', 'role.manage', 'Manage roles', datetime('now'))`,
    ),
    // Then roles
    env.DB.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at) VALUES ('administrator', 'administrator', 'Full system access', 1, datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at) VALUES ('member', 'member', 'Standard user', 1, datetime('now'))`,
    ),
    // Then role_permissions
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('administrator', 'user.manage', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('administrator', 'message.read', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('administrator', 'mailbox.create', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('administrator', 'role.manage', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('member', 'message.read', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('member', 'mailbox.create', datetime('now'))`,
    ),
  ]);
}

// Helper: create a user with specific role
async function createUserWithRole(roleName: 'administrator' | 'member'): Promise<string> {
  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword('testPassword123');
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, email, display_name, status, password_algorithm, password_iterations, password_salt, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      userId,
      `${roleName}@example.com`,
      `${roleName.charAt(0).toUpperCase() + roleName.slice(1)} User`,
      'active',
      passwordHash.algorithm,
      passwordHash.iterations,
      passwordHash.salt,
      passwordHash.hash,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, ?, ?)`,
    ).bind(userId, roleName, now),
  ]);

  return userId;
}

// Helper: hash a token (same as in auth routes)
async function hashToken(token: string): Promise<string> {
  const buffer = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Helper: create a session for a user and return access token
async function createSession(userId: string): Promise<string> {
  const accessToken = crypto.randomUUID();
  const refreshToken = crypto.randomUUID();
  const refreshTokenHash = await hashToken(refreshToken);
  const sessionId = crypto.randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(sessionId, userId, refreshTokenHash, expiresAt, new Date().toISOString()),
  ]);

  await env.CACHE.put(
    `auth:${accessToken}`,
    JSON.stringify({ userId }),
    { expirationTtl: 15 * 60 },
  );

  return accessToken;
}

describe('POST /api/v1/mailboxes', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
  });

  it('returns 401 without authentication', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/mailboxes', {
      method: 'POST',
      body: JSON.stringify({
        localPart: 'john.doe',
        domainId: crypto.randomUUID(),
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('returns 403 without mailbox.create permission', async () => {
    // Create a user without mailbox.create permission
    const userId = crypto.randomUUID();
    const passwordHash = await hashPassword('testPassword123');
    const now = new Date().toISOString();

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, email, display_name, status, password_algorithm, password_iterations, password_salt, password_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        userId,
        'noperm@example.com',
        'No Permission User',
        'active',
        passwordHash.algorithm,
        passwordHash.iterations,
        passwordHash.salt,
        passwordHash.hash,
        now,
        now,
      ),
      // Only message.read permission
      env.DB.prepare(
        `INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, 'member', ?)`,
      ).bind(userId, now),
      env.DB.prepare(
        `DELETE FROM role_permissions WHERE role_id = 'member' AND permission_id = 'mailbox.create'`,
      ),
    ]);

    const accessToken = await createSession(userId);

    const response = await SELF.fetch('http://localhost/api/v1/mailboxes', {
      method: 'POST',
      body: JSON.stringify({
        localPart: 'john.doe',
        domainId: crypto.randomUUID(),
      }),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe('PERMISSION_DENIED');
  });

  it('creates mailbox with valid input', async () => {
    const userId = await createUserWithRole('member');
    const accessToken = await createSession(userId);

    // Create a managed domain
    const domainId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO managed_domains (id, name, status, outbound_connection_id, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    ).bind(domainId, 'example.com', 'active', new Date().toISOString(), new Date().toISOString()).run();

    const response = await SELF.fetch('http://localhost/api/v1/mailboxes', {
      method: 'POST',
      body: JSON.stringify({
        localPart: 'john.doe',
        domainId,
        displayName: 'John Doe',
      }),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toHaveProperty('id');
    expect(body.data).toHaveProperty('address', 'john.doe@example.com');
    expect(body.data).toHaveProperty('displayName', 'John Doe');
    expect(body.data).toHaveProperty('status', 'active');
    expect(body.data).toHaveProperty('ownerUserId', userId);
  });

  it('creates mailbox without displayName', async () => {
    const userId = await createUserWithRole('member');
    const accessToken = await createSession(userId);

    const domainId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO managed_domains (id, name, status, outbound_connection_id, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    ).bind(domainId, 'example.com', 'active', new Date().toISOString(), new Date().toISOString()).run();

    const response = await SELF.fetch('http://localhost/api/v1/mailboxes', {
      method: 'POST',
      body: JSON.stringify({
        localPart: 'info',
        domainId,
      }),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toHaveProperty('displayName', '');
  });

  it('returns 409 for duplicate address (case-insensitive)', async () => {
    const userId = await createUserWithRole('member');
    const accessToken = await createSession(userId);

    const domainId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO managed_domains (id, name, status, outbound_connection_id, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    ).bind(domainId, 'example.com', 'active', new Date().toISOString(), new Date().toISOString()).run();

    // Create first mailbox
    await SELF.fetch('http://localhost/api/v1/mailboxes', {
      method: 'POST',
      body: JSON.stringify({
        localPart: 'john.doe',
        domainId,
      }),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    // Try to create duplicate with different case
    const response = await SELF.fetch('http://localhost/api/v1/mailboxes', {
      method: 'POST',
      body: JSON.stringify({
        localPart: 'John.Doe',
        domainId,
      }),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.code).toBe('DOMAIN_ADDRESS_TAKEN');
  });

  it('returns 404 for non-existent domain', async () => {
    const userId = await createUserWithRole('member');
    const accessToken = await createSession(userId);

    const response = await SELF.fetch('http://localhost/api/v1/mailboxes', {
      method: 'POST',
      body: JSON.stringify({
        localPart: 'john.doe',
        domainId: crypto.randomUUID(),
      }),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('DOMAIN_NOT_FOUND');
  });

  it('returns 409 for disabled domain', async () => {
    const userId = await createUserWithRole('member');
    const accessToken = await createSession(userId);

    const domainId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO managed_domains (id, name, status, outbound_connection_id, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    ).bind(domainId, 'example.com', 'disabled', new Date().toISOString(), new Date().toISOString()).run();

    const response = await SELF.fetch('http://localhost/api/v1/mailboxes', {
      method: 'POST',
      body: JSON.stringify({
        localPart: 'john.doe',
        domainId,
      }),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.code).toBe('DOMAIN_NOT_ACTIVE');
  });
});

describe('GET /api/v1/mailboxes', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
  });

  it('returns 401 without authentication', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/mailboxes');

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('returns 403 without message.read permission', async () => {
    const userId = crypto.randomUUID();
    const passwordHash = await hashPassword('testPassword123');
    const now = new Date().toISOString();

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, email, display_name, status, password_algorithm, password_iterations, password_salt, password_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        userId,
        'noperm@example.com',
        'No Permission User',
        'active',
        passwordHash.algorithm,
        passwordHash.iterations,
        passwordHash.salt,
        passwordHash.hash,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, 'member', ?)`,
      ).bind(userId, now),
      // Remove message.read permission
      env.DB.prepare(
        `DELETE FROM role_permissions WHERE role_id = 'member' AND permission_id = 'message.read'`,
      ),
    ]);

    const accessToken = await createSession(userId);

    const response = await SELF.fetch('http://localhost/api/v1/mailboxes', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe('PERMISSION_DENIED');
  });

  it('returns empty list when user owns no mailboxes', async () => {
    const userId = await createUserWithRole('member');
    const accessToken = await createSession(userId);

    const response = await SELF.fetch('http://localhost/api/v1/mailboxes', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toHaveProperty('items');
    expect(body.data.items).toEqual([]);
  });

  it('returns only owned mailboxes', async () => {
    const user1Id = await createUserWithRole('member');
    const user2Id = await createUserWithRole('administrator');
    const user1Token = await createSession(user1Id);

    // Create domain
    const domainId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO managed_domains (id, name, status, outbound_connection_id, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    ).bind(domainId, 'example.com', 'active', new Date().toISOString(), new Date().toISOString()).run();

    // Create mailbox for user1
    await env.DB.prepare(
      `INSERT INTO mailboxes (id, domain_id, owner_user_id, local_part, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      domainId,
      user1Id,
      'user1',
      'User 1',
      'active',
      new Date().toISOString(),
      new Date().toISOString(),
    ).run();

    // Create mailbox for user2
    await env.DB.prepare(
      `INSERT INTO mailboxes (id, domain_id, owner_user_id, local_part, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      domainId,
      user2Id,
      'user2',
      'User 2',
      'active',
      new Date().toISOString(),
      new Date().toISOString(),
    ).run();

    const response = await SELF.fetch('http://localhost/api/v1/mailboxes', {
      headers: {
        'Authorization': `Bearer ${user1Token}`,
      },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]).toHaveProperty('localPart', 'user1');
    expect(body.data.items[0]).toHaveProperty('ownerUserId', user1Id);
  });

  it('returns mailboxes with full address', async () => {
    const userId = await createUserWithRole('member');
    const accessToken = await createSession(userId);

    const domainId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO managed_domains (id, name, status, outbound_connection_id, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    ).bind(domainId, 'example.com', 'active', new Date().toISOString(), new Date().toISOString()).run();

    const mailboxId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO mailboxes (id, domain_id, owner_user_id, local_part, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      mailboxId,
      domainId,
      userId,
      'john.doe',
      'John Doe',
      'active',
      new Date().toISOString(),
      new Date().toISOString(),
    ).run();

    const response = await SELF.fetch('http://localhost/api/v1/mailboxes', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items[0]).toHaveProperty('address', 'john.doe@example.com');
  });
});

/**
 * R-MAILBOX-003: The owner is implicitly a member; no explicit row in
 * mailbox_members is needed. The authorizer short-circuits on ownership
 * (authorizer.ts:68) before consulting the members table, so the owner
 * of a mailbox with no mailbox_members row can perform every operation
 * the permission matrix grants owners.
 */
describe('R-MAILBOX-003 — owner implicit membership', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
  });

  it('lets the owner perform every operation without an explicit mailbox_members row', async () => {
    const ownerId = await createUserWithRole('member');
    const domainId = crypto.randomUUID();
    const mailboxId = crypto.randomUUID();

    await env.DB.prepare(
      `INSERT INTO managed_domains (id, name, status, outbound_connection_id, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    ).bind(domainId, 'example.com', 'active', new Date().toISOString(), new Date().toISOString()).run();

    await env.DB.prepare(
      `INSERT INTO mailboxes (id, domain_id, owner_user_id, local_part, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      mailboxId,
      domainId,
      ownerId,
      'owner.local',
      'Owner',
      'active',
      new Date().toISOString(),
      new Date().toISOString(),
    ).run();

    // Confirm no mailbox_members row exists for the owner. R-MAILBOX-003
    // is the *absence* of this row.
    const memberRow = await env.DB
      .prepare('SELECT 1 FROM mailbox_members WHERE mailbox_id = ? AND user_id = ?')
      .bind(mailboxId, ownerId)
      .first();
    expect(memberRow).toBeNull();

    // Every owner-permitted operation must succeed implicitly.
    const ops = [
      'read',
      'send',
      'rename',
      'manage_members',
      'delete_message',
      'delete_mailbox',
    ] as const;
    for (const op of ops) {
      await expect(assertCan(env.DB, ownerId, mailboxId, op)).resolves.toBeUndefined();
    }
  });
});
