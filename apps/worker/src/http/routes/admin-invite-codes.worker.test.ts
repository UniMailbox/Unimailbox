// admin-invite-codes.worker.test.ts — CAP-019 admin invite codes endpoints.
//
// Worker-pool tests for POST /admin/invite-codes, GET /admin/invite-codes.
// Uses SELF.fetch to exercise the full request pipeline.

import { describe, expect, it, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { hashPassword } from '../../platform/crypto';

// Helper: hash a token
async function hashToken(token: string): Promise<string> {
  const buffer = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Helper: complete setup before tests
async function completeSetup(): Promise<void> {
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
    // Then roles
    env.DB.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at) VALUES ('administrator', 'administrator', 'Full system access', 1, datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at) VALUES ('member', 'member', 'Standard user', 1, datetime('now'))`,
    ),
    // Then role_permissions (depends on both permissions and roles)
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('administrator', 'user.manage', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('member', 'message.read', datetime('now'))`,
    ),
  ]);
}

// Helper: create an admin user and return their ID and access token
async function createAdminUser(): Promise<{ userId: string; accessToken: string }> {
  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword('adminPassword123');
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, email, display_name, status, password_algorithm, password_iterations, password_salt, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      userId,
      'admin@example.com',
      'Admin User',
      'active',
      passwordHash.algorithm,
      passwordHash.iterations,
      passwordHash.salt,
      passwordHash.hash,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, 'administrator', ?)`,
    ).bind(userId, now),
  ]);

  // Login to get access token
  const response = await SELF.fetch('http://localhost/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      email: 'admin@example.com',
      password: 'adminPassword123',
    }),
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'test-key-' + crypto.randomUUID() },
  });

  const body = await response.json();
  return { userId, accessToken: body.data.accessToken };
}

// Helper: create a member user without permissions
async function createMemberUser(): Promise<string> {
  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword('memberPassword123');
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, email, display_name, status, password_algorithm, password_iterations, password_salt, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      userId,
      'member@example.com',
      'Member User',
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
  ]);

  return userId;
}

describe('POST /api/v1/admin/invite-codes', () => {
  let adminToken: string;

  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
    const { accessToken } = await createAdminUser();
    adminToken = accessToken;
  });

  describe('authenticated admin', () => {
    it('returns 200 with code, id, maxUses, expiresAt', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/admin/invite-codes', {
        method: 'POST',
        body: JSON.stringify({
          maxUses: 5,
          expiresInHours: 24,
        }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-key-' + crypto.randomUUID(),
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data).toHaveProperty('code');
      expect(body.data).toHaveProperty('id');
      expect(body.data).toHaveProperty('maxUses', 5);
      expect(body.data).toHaveProperty('expiresAt');

      // Code should be 64 hex chars
      expect(body.data.code).toMatch(/^[0-9a-f]{64}$/);
    });

    it('stores code hash in registration_keys table', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/admin/invite-codes', {
        method: 'POST',
        body: JSON.stringify({ maxUses: 1 }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-key-' + crypto.randomUUID(),
          Authorization: `Bearer ${adminToken}`,
        },
      });

      const body = await response.json();
      const code = body.data.code;
      const codeHash = await hashToken(code);

      const key = await env.DB.prepare(
        `SELECT id, max_uses, used_count FROM registration_keys WHERE code_hash = ?`,
      ).bind(codeHash).first();

      expect(key).toBeDefined();
      expect(key?.max_uses).toBe(1);
      expect(key?.used_count).toBe(0);
    });

    it('uses default maxUses=1 when not provided', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/admin/invite-codes', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-key-' + crypto.randomUUID(),
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.maxUses).toBe(1);
    });

    it('accepts optional roleId', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/admin/invite-codes', {
        method: 'POST',
        body: JSON.stringify({
          maxUses: 1,
          roleId: 'administrator',
        }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-key-' + crypto.randomUUID(),
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.status).toBe(200);
    });

    it('accepts optional expiresInHours', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/admin/invite-codes', {
        method: 'POST',
        body: JSON.stringify({
          maxUses: 1,
          expiresInHours: 48,
        }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-key-' + crypto.randomUUID(),
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();

      // Verify expiresAt is approximately 48 hours from now
      const expiresAt = new Date(body.data.expiresAt);
      const now = new Date();
      const diffHours = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60);
      expect(diffHours).toBeCloseTo(48, 0);
    });

    it('returns null expiresAt when expiresInHours not provided', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/admin/invite-codes', {
        method: 'POST',
        body: JSON.stringify({ maxUses: 1 }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-key-' + crypto.randomUUID(),
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.expiresAt).toBeNull();
    });
  });

  describe('authorization', () => {
    it('returns 403 PERMISSION_DENIED for non-admin user', async () => {
      await createMemberUser();

      // Login as member
      const loginResponse = await SELF.fetch('http://localhost/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: 'member@example.com',
          password: 'memberPassword123',
        }),
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'test-key-' + crypto.randomUUID() },
      });

      const { accessToken } = (await loginResponse.json()).data;

      const response = await SELF.fetch('http://localhost/api/v1/admin/invite-codes', {
        method: 'POST',
        body: JSON.stringify({ maxUses: 1 }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error.code).toBe('PERMISSION_DENIED');
    });

    it('returns 401 AUTHENTICATION_REQUIRED without token', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/admin/invite-codes', {
        method: 'POST',
        body: JSON.stringify({ maxUses: 1 }),
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'test-key-' + crypto.randomUUID() },
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 401 AUTHENTICATION_REQUIRED with invalid token', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/admin/invite-codes', {
        method: 'POST',
        body: JSON.stringify({ maxUses: 1 }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer invalid-token',
        },
      });

      expect(response.status).toBe(401);
    });
  });

  describe('validation errors', () => {
    it('returns 400 VALIDATION_ERROR for invalid maxUses', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/admin/invite-codes', {
        method: 'POST',
        body: JSON.stringify({ maxUses: 0 }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-key-' + crypto.randomUUID(),
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.status).toBe(400);
    });

    it('returns 400 VALIDATION_ERROR for negative maxUses', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/admin/invite-codes', {
        method: 'POST',
        body: JSON.stringify({ maxUses: -5 }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-key-' + crypto.randomUUID(),
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.status).toBe(400);
    });

    it('returns 400 VALIDATION_ERROR for invalid expiresInHours', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/admin/invite-codes', {
        method: 'POST',
        body: JSON.stringify({
          maxUses: 1,
          expiresInHours: -10,
        }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-key-' + crypto.randomUUID(),
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.status).toBe(400);
    });
  });

  // -----------------------------------------------------------------------
  // CAP-031 / R-INPUT-002: malformed JSON returns 400 INVALID_JSON
  // (stable code from parseJsonBody), not a raw SyntaxError or 500.
  // -----------------------------------------------------------------------
  it('returns 400 INVALID_JSON when request body is not valid JSON', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/admin/invite-codes', {
      method: 'POST',
      body: '{not valid json',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'invite-codes-invalid-json-' + crypto.randomUUID(),
        Authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('INVALID_JSON');
  });
});

describe('GET /api/v1/admin/invite-codes', () => {
  let adminToken: string;

  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
    const { accessToken } = await createAdminUser();
    adminToken = accessToken;
  });

  describe('authenticated admin', () => {
    it('returns 200 with keys list', async () => {
      // Create a test key
      await SELF.fetch('http://localhost/api/v1/admin/invite-codes', {
        method: 'POST',
        body: JSON.stringify({ maxUses: 5 }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-key-' + crypto.randomUUID(),
          Authorization: `Bearer ${adminToken}`,
        },
      });

      const response = await SELF.fetch('http://localhost/api/v1/admin/invite-codes', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data).toHaveProperty('keys');
      expect(Array.isArray(body.data.keys)).toBe(true);
      expect(body.data.keys.length).toBeGreaterThan(0);
    });

    it('does not include code or code_hash in response', async () => {
      // Create a test key
      await SELF.fetch('http://localhost/api/v1/admin/invite-codes', {
        method: 'POST',
        body: JSON.stringify({ maxUses: 1 }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-key-' + crypto.randomUUID(),
          Authorization: `Bearer ${adminToken}`,
        },
      });

      const response = await SELF.fetch('http://localhost/api/v1/admin/invite-codes', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      const body = await response.json();
      const key = body.data.keys[0];

      // Should include these fields
      expect(key).toHaveProperty('id');
      expect(key).toHaveProperty('maxUses');
      expect(key).toHaveProperty('usedCount');
      expect(key).toHaveProperty('expiresAt');
      expect(key).toHaveProperty('revokedAt');
      expect(key).toHaveProperty('createdBy');
      expect(key).toHaveProperty('createdAt');

      // Should NOT include code or code_hash
      expect(key).not.toHaveProperty('code');
      expect(key).not.toHaveProperty('code_hash');
    });

    it('returns empty array when no keys exist', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/admin/invite-codes', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.keys).toEqual([]);
    });

    it('orders keys by created_at DESC', async () => {
      // Create multiple keys
      await SELF.fetch('http://localhost/api/v1/admin/invite-codes', {
        method: 'POST',
        body: JSON.stringify({ maxUses: 1 }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-key-' + crypto.randomUUID(),
          Authorization: `Bearer ${adminToken}`,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10)); // Small delay

      await SELF.fetch('http://localhost/api/v1/admin/invite-codes', {
        method: 'POST',
        body: JSON.stringify({ maxUses: 1 }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-key-' + crypto.randomUUID(),
          Authorization: `Bearer ${adminToken}`,
        },
      });

      const response = await SELF.fetch('http://localhost/api/v1/admin/invite-codes', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      const body = await response.json();
      const keys = body.data.keys;

      // Second key should be first (newer createdAt)
      expect(keys.length).toBe(2);
      expect(new Date(keys[0].createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(keys[1].createdAt).getTime(),
      );
    });
  });

  describe('authorization', () => {
    it('returns 403 PERMISSION_DENIED for non-admin user', async () => {
      await createMemberUser();

      // Login as member
      const loginResponse = await SELF.fetch('http://localhost/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: 'member@example.com',
          password: 'memberPassword123',
        }),
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'test-key-' + crypto.randomUUID() },
      });

      const { accessToken } = (await loginResponse.json()).data;

      const response = await SELF.fetch('http://localhost/api/v1/admin/invite-codes', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error.code).toBe('PERMISSION_DENIED');
    });

    it('returns 401 AUTHENTICATION_REQUIRED without token', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/admin/invite-codes');

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 401 AUTHENTICATION_REQUIRED with invalid token', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/admin/invite-codes', {
        headers: { Authorization: 'Bearer invalid-token' },
      });

      expect(response.status).toBe(401);
    });
  });
});

// ---------------------------------------------------------------------------
// CAP-027 Idempotency tests
// ---------------------------------------------------------------------------

describe('POST /api/v1/admin/invite-codes — idempotency', () => {
  let adminToken: string;
  let adminId: string;

  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
    const { userId, accessToken } = await createAdminUser();
    adminId = userId;
    adminToken = accessToken;
  });

  it('returns 400 IDEMPOTENCY_KEY_REQUIRED when header missing', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/admin/invite-codes', {
      method: 'POST',
      body: JSON.stringify({ maxUses: 1 }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      }, // No Idempotency-Key
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('returns 400 IDEMPOTENCY_KEY_INVALID for malformed key', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/admin/invite-codes', {
      method: 'POST',
      body: JSON.stringify({ maxUses: 1 }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'short', // Too short (< 8 chars)
      },
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_INVALID');
  });

  it('replays response when same key and body', async () => {
    const idempotencyKey = 'invite-replay-' + crypto.randomUUID();
    const requestBody = JSON.stringify({ maxUses: 5, expiresInHours: 24 });

    // First request
    const firstResponse = await SELF.fetch('http://localhost/api/v1/admin/invite-codes', {
      method: 'POST',
      body: requestBody,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': idempotencyKey,
      },
    });

    expect(firstResponse.status).toBe(200);
    const firstBody = await firstResponse.json();
    const firstCode = firstBody.data.code;
    const firstId = firstBody.data.id;

    // Second request with same key and body: invite-codes is secret-bearing (Fix 1),
    // so it deletes the old record and re-executes, returning a fresh code.
    const secondResponse = await SELF.fetch('http://localhost/api/v1/admin/invite-codes', {
      method: 'POST',
      body: requestBody,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': idempotencyKey,
      },
    });

    expect(secondResponse.status).toBe(200);
    const secondBody = await secondResponse.json();
    // Each call gets a fresh code (not replayed)
    expect(secondBody.data.code).not.toBe(firstCode);
    expect(secondBody.data.id).not.toBe(firstId);

    // Verify the old record was deleted and a new one written (with redacted code)
    const record = await env.DB
      .prepare(
        `SELECT response_json FROM idempotency_records
         WHERE actor_id = ? AND operation = ? AND idempotency_key = ?`,
      )
      .bind(adminId, 'POST /api/v1/admin/invite-codes', idempotencyKey)
      .first<{ response_json: string }>();
    expect(record).toBeDefined();
    expect(record?.response_json).toContain('redacted');
  });

  it('returns 409 IDEMPOTENCY_KEY_REUSED when same key different body', async () => {
    const idempotencyKey = 'invite-reuse-' + crypto.randomUUID();

    // First request with maxUses: 1
    const firstResponse = await SELF.fetch('http://localhost/api/v1/admin/invite-codes', {
      method: 'POST',
      body: JSON.stringify({ maxUses: 1 }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': idempotencyKey,
      },
    });

    expect(firstResponse.status).toBe(200);

    // Second request with same key but different body (maxUses: 5)
    const secondResponse = await SELF.fetch('http://localhost/api/v1/admin/invite-codes', {
      method: 'POST',
      body: JSON.stringify({ maxUses: 5 }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': idempotencyKey,
      },
    });

    expect(secondResponse.status).toBe(409);
    const body = await secondResponse.json();
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});
