import { beforeEach, describe, expect, it } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { hashPassword } from '../../platform/crypto';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';

const ADMIN_EMAIL = 'lifecycle-admin@example.com';

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function seedAdmin(): Promise<{ userId: string; token: string }> {
  const userId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const token = crypto.randomUUID();
  const password = await hashPassword('AdminPass123');
  const now = '2026-10-03 00:00:00';
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, email, display_name, status, password_algorithm,
         password_iterations, password_salt, password_hash, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      userId,
      ADMIN_EMAIL,
      'Lifecycle admin',
      password.algorithm,
      password.iterations,
      password.salt,
      password.hash,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, 'administrator', ?)`,
    ).bind(userId, now),
    env.DB.prepare(
      `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
    ).bind(sessionId, userId, await sha256(crypto.randomUUID()), 2_000_000_000, now),
  ]);
  await env.CACHE.put(`auth:${token}`, JSON.stringify({ userId, sessionId }), {
    expirationTtl: 900,
  });
  return { userId, token };
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`http://localhost${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

beforeEach(async () => {
  await resetAndMigrate();
  await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description) VALUES ('user.manage', 'user.manage', 'Manage users')`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system) VALUES ('administrator', 'administrator', 'Full system access', 1)`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system) VALUES ('member', 'member', 'Standard user', 1)`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES ('administrator', 'user.manage')`,
    ),
  ]);
});

describe('admin-managed user lifecycle', () => {
  it('creates an account with a one-time initial password', async () => {
    const admin = await seedAdmin();
    const response = await request('/api/v1/admin/users', {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin.token}`, 'Idempotency-Key': 'create-user-1' },
      body: JSON.stringify({ email: 'managed@example.com', displayName: 'Managed User' }),
    });
    const createText = await response.text();
    expect(response.status, createText).toBe(201);
    const body = JSON.parse(createText) as {
      data: { user: { id: string }; initialPassword: string };
    };
    expect(body.data.initialPassword).toMatch(/^um_[A-Za-z0-9_-]+$/);
    const row = await env.DB.prepare('SELECT must_change_password FROM users WHERE id = ?')
      .bind(body.data.user.id)
      .first<{ must_change_password: number }>();
    expect(row?.must_change_password).toBe(1);
    const role = await env.DB.prepare(`SELECT role_id FROM user_roles WHERE user_id = ?`)
      .bind(body.data.user.id)
      .first<{ role_id: string }>();
    expect(role?.role_id).toBe('member');
    const audit = await env.DB.prepare(
      `SELECT action, metadata FROM audit_events WHERE resource_id = ?`,
    )
      .bind(body.data.user.id)
      .all<{ action: string; metadata: string | null }>();
    expect(audit.results).toHaveLength(1);
    expect(audit.results?.[0]?.action).toBe('user.created');
    expect(audit.results?.[0]?.metadata).toContain('managed@example.com');
    const idempotency = await env.DB.prepare(
      `SELECT response_json FROM idempotency_records WHERE actor_id = ? AND operation = ?`,
    )
      .bind(admin.userId, 'POST /api/v1/admin/users')
      .first<{ response_json: string }>();
    expect(idempotency?.response_json).toContain('redacted');
    expect(idempotency?.response_json).not.toContain(body.data.initialPassword);
  });

  it('rejects public registration and allows the initial user to change password', async () => {
    const registration = await request('/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ code: 'x'.repeat(64), email: 'x@example.com', password: 'secret1' }),
    });
    expect(registration.status).toBe(403);
    expect((await registration.json()).error.code).toBe('REGISTRATION_DISABLED');

    const admin = await seedAdmin();
    const created = await request('/api/v1/admin/users', {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin.token}`, 'Idempotency-Key': 'create-user-2' },
      body: JSON.stringify({ email: 'change-me@example.com' }),
    });
    const createdBody = (await created.json()) as {
      data: { user: { id: string }; initialPassword: string };
    };
    const login = await request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'login-user-1' },
      body: JSON.stringify({
        email: 'change-me@example.com',
        password: createdBody.data.initialPassword,
      }),
    });
    expect(login.status).toBe(200);
    const loginBody = (await login.json()) as { data: { accessToken: string } };
    const change = await request('/api/v1/auth/change-password', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${loginBody.data.accessToken}`,
        'Idempotency-Key': 'change-user-1',
      },
      body: JSON.stringify({
        currentPassword: createdBody.data.initialPassword,
        newPassword: 'NewPass123',
      }),
    });
    expect(change.status).toBe(200);
    const me = await request('/api/v1/auth/me', {
      headers: { Authorization: `Bearer ${loginBody.data.accessToken}` },
    });
    expect(me.status).toBe(200);
    expect((await me.json()).data.mustChangePassword).toBe(false);
  });

  it('revokes sessions when an account is banned', async () => {
    const admin = await seedAdmin();
    const created = await request('/api/v1/admin/users', {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin.token}`, 'Idempotency-Key': 'create-user-3' },
      body: JSON.stringify({ email: 'ban-me@example.com' }),
    });
    const createdBody = (await created.json()) as {
      data: { user: { id: string }; initialPassword: string };
    };
    const login = await request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'login-user-2' },
      body: JSON.stringify({
        email: 'ban-me@example.com',
        password: createdBody.data.initialPassword,
      }),
    });
    const loginBody = (await login.json()) as { data: { accessToken: string } };
    const status = await request(`/api/v1/admin/users/${createdBody.data.user.id}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${admin.token}`, 'Idempotency-Key': 'ban-user-1' },
      body: JSON.stringify({ status: 'banned' }),
    });
    expect(status.status).toBe(200);
    const me = await request('/api/v1/auth/me', {
      headers: { Authorization: `Bearer ${loginBody.data.accessToken}` },
    });
    expect(me.status).toBe(401);
    const audit = await env.DB.prepare(`SELECT action FROM audit_events WHERE resource_id = ?`)
      .bind(createdBody.data.user.id)
      .all<{ action: string }>();
    expect(audit.results?.map((row) => row.action).sort()).toEqual(
      ['user.created', 'user.status_changed'].sort(),
    );
  });

  it('prevents the current administrator from deactivating or deleting their own account', async () => {
    const admin = await seedAdmin();
    for (const status of ['banned', 'deleted'] as const) {
      const response = await request(`/api/v1/admin/users/${admin.userId}/status`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${admin.token}`,
          'Idempotency-Key': `self-status-${status}`,
        },
        body: JSON.stringify({ status }),
      });
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe('PERMISSION_DENIED');
    }
    const user = await env.DB.prepare('SELECT status FROM users WHERE id = ?')
      .bind(admin.userId)
      .first<{ status: string }>();
    expect(user?.status).toBe('active');
    const audit = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM audit_events WHERE resource_id = ? AND action = 'user.status_changed'`,
    )
      .bind(admin.userId)
      .first<{ count: number }>();
    expect(audit?.count).toBe(0);
    const me = await request('/api/v1/auth/me', {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    expect(me.status).toBe(200);
  });

  it('does not duplicate the account or audit when an idempotency key is retried', async () => {
    const admin = await seedAdmin();
    const input = JSON.stringify({ email: 'retry@example.com' });
    const first = await request('/api/v1/admin/users', {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin.token}`, 'Idempotency-Key': 'retry-user-1' },
      body: input,
    });
    expect(first.status).toBe(201);
    const second = await request('/api/v1/admin/users', {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin.token}`, 'Idempotency-Key': 'retry-user-1' },
      body: input,
    });
    expect(second.status).toBe(409);
    const users = await env.DB.prepare(`SELECT COUNT(*) AS count FROM users WHERE email = ?`)
      .bind('retry@example.com')
      .first<{ count: number }>();
    expect(users?.count).toBe(1);
    const audits = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM audit_events WHERE action = 'user.created' AND resource_id IN (SELECT id FROM users WHERE email = ?)`,
    )
      .bind('retry@example.com')
      .first<{ count: number }>();
    expect(audits?.count).toBe(1);
  });

  it('rolls back account and idempotency writes when audit insertion fails', async () => {
    const admin = await seedAdmin();
    await env.DB.prepare(
      `CREATE TRIGGER fail_user_create_audit BEFORE INSERT ON audit_events
       WHEN NEW.action = 'user.created'
       BEGIN SELECT RAISE(ABORT, 'forced user audit failure'); END`,
    ).run();
    try {
      const response = await request('/api/v1/admin/users', {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin.token}`, 'Idempotency-Key': 'audit-failure-1' },
        body: JSON.stringify({ email: 'rollback@example.com' }),
      });
      expect(response.status).toBe(500);
      const user = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`)
        .bind('rollback@example.com')
        .first<{ id: string }>();
      expect(user).toBeNull();
      const record = await env.DB.prepare(
        `SELECT id FROM idempotency_records WHERE actor_id = ? AND idempotency_key = ?`,
      )
        .bind(admin.userId, 'audit-failure-1')
        .first<{ id: string }>();
      expect(record).toBeNull();
    } finally {
      await env.DB.prepare('DROP TRIGGER IF EXISTS fail_user_create_audit').run();
    }
  });
});
