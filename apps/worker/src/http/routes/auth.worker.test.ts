// auth.worker.test.ts — CAP-019 auth endpoints.
//
// Worker-pool tests for POST /register, POST /login, POST /refresh, GET /me.
// Uses SELF.fetch to exercise the full request pipeline.

import { describe, expect, it, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { hashPassword } from '../../platform/crypto';

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

// Helper: complete setup before auth tests
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

// Helper: create an admin user and return their ID
async function createAdminUser(): Promise<string> {
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

  return userId;
}

// Helper: create a registration key
async function createRegistrationKey(options: {
  maxUses?: number;
  expiresInHours?: number | null;
  createdBy?: string;
}): Promise<string> {
  const codeBytes = crypto.getRandomValues(new Uint8Array(32));
  const code = Array.from(codeBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  const codeHash = await hashToken(code);

  let expiresAt: string | null = null;
  if (options.expiresInHours) {
    const expiryDate = new Date(Date.now() + options.expiresInHours * 60 * 60 * 1000);
    expiresAt = expiryDate.toISOString();
  }

  // Use the provided createdBy or create a test admin user
  let createdBy = options.createdBy;
  if (!createdBy) {
    // Create a minimal admin user for FK constraint
    const adminId = crypto.randomUUID();
    const passwordHash = await hashPassword('testPassword123');
    const now = new Date().toISOString();

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, email, display_name, status, password_algorithm, password_iterations, password_salt, password_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        adminId,
        'test-admin@example.com',
        'Test Admin',
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
      ).bind(adminId, now),
    ]);
    createdBy = adminId;
  }

  await env.DB.prepare(
    `INSERT INTO registration_keys (id, code_hash, role_id, max_uses, used_count, expires_at, revoked_at, created_by, created_at)
     VALUES (?, ?, NULL, ?, 0, ?, NULL, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    codeHash,
    options.maxUses ?? 1,
    expiresAt,
    createdBy,
    new Date().toISOString(),
  ).run();

  return code;
}

// Helper: create a session for a user
async function createSession(userId: string): Promise<string> {
  const refreshToken = crypto.randomUUID();
  const refreshTokenHash = await hashToken(refreshToken);
  const sessionId = crypto.randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(sessionId, userId, refreshTokenHash, expiresAt, new Date().toISOString()).run();

  return refreshToken;
}

describe('POST /api/v1/auth/register', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
  });

  describe('valid code and email', () => {
    it('returns 200 with user info', async () => {
      const code = await createRegistrationKey({ maxUses: 1 });

      const response = await SELF.fetch('http://localhost/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          code,
          email: 'newuser@example.com',
          password: 'securePassword123',
          displayName: 'New User',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('user');
      expect(body.data.user).toHaveProperty('id');
      expect(body.data.user).toHaveProperty('email', 'newuser@example.com');
      expect(body.data.user).toHaveProperty('displayName', 'New User');
    });

    it('creates user with PBKDF2 password hash', async () => {
      const code = await createRegistrationKey({ maxUses: 1 });

      await SELF.fetch('http://localhost/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          code,
          email: 'pbkdf2test@example.com',
          password: 'securePassword123',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      const user = await env.DB.prepare(
        `SELECT id, password_algorithm, password_iterations FROM users WHERE email = ?`,
      ).bind('pbkdf2test@example.com').first();

      expect(user).toBeDefined();
      expect(user?.password_algorithm).toBe('pbkdf2-sha256');
      expect(user?.password_iterations).toBe(600000);
    });

    it('assigns member role to new user', async () => {
      const code = await createRegistrationKey({ maxUses: 1 });

      const response = await SELF.fetch('http://localhost/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          code,
          email: 'memberuser@example.com',
          password: 'securePassword123',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      const body = await response.json();
      const userId = body.data.user.id;

      const userRole = await env.DB.prepare(
        `SELECT r.id, r.name FROM user_roles ur JOIN roles r ON ur.role_id = r.id WHERE ur.user_id = ?`,
      ).bind(userId).first();

      expect(userRole).toBeDefined();
      expect(userRole?.name).toBe('member');
    });

    it('increments key usage', async () => {
      const code = await createRegistrationKey({ maxUses: 2 });

      await SELF.fetch('http://localhost/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          code,
          email: 'user1@example.com',
          password: 'securePassword123',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      const key = await env.DB.prepare(
        `SELECT used_count FROM registration_keys WHERE code_hash = ?`,
      ).bind(await hashToken(code)).first();

      expect(key?.used_count).toBe(1);
    });

    it('allows optional displayName', async () => {
      const code = await createRegistrationKey({ maxUses: 1 });

      const response = await SELF.fetch('http://localhost/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          code,
          email: 'nodisplay@example.com',
          password: 'securePassword123',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.user.displayName).toBeNull();
    });
  });

  describe('invalid code', () => {
    it('returns 409 REGISTRATION_CODE_INVALID for non-existent code', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          code: 'a'.repeat(64), // Valid hex but doesn't exist
          email: 'user@example.com',
          password: 'securePassword123',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error.code).toBe('REGISTRATION_CODE_INVALID');
    });

    it('returns 409 REGISTRATION_CODE_EXPIRED for expired code', async () => {
      const code = await createRegistrationKey({ expiresInHours: -1 }); // Expired 1 hour ago

      const response = await SELF.fetch('http://localhost/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          code,
          email: 'user@example.com',
          password: 'securePassword123',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error.code).toBe('REGISTRATION_CODE_EXPIRED');
    });

    it('returns 409 REGISTRATION_CODE_REVOKED for revoked code', async () => {
      const code = await createRegistrationKey({ maxUses: 1 });

      // Revoke the key
      await env.DB.prepare(
        `UPDATE registration_keys SET revoked_at = datetime('now') WHERE code_hash = ?`,
      ).bind(await hashToken(code)).run();

      const response = await SELF.fetch('http://localhost/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          code,
          email: 'user@example.com',
          password: 'securePassword123',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error.code).toBe('REGISTRATION_CODE_REVOKED');
    });

    it('returns 409 REGISTRATION_CODE_EXHAUSTED for fully-used code', async () => {
      const code = await createRegistrationKey({ maxUses: 1 });

      // First registration succeeds
      await SELF.fetch('http://localhost/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          code,
          email: 'user1@example.com',
          password: 'securePassword123',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      // Second registration should fail
      const response = await SELF.fetch('http://localhost/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          code,
          email: 'user2@example.com',
          password: 'securePassword123',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error.code).toBe('REGISTRATION_CODE_EXHAUSTED');
    });
  });

  describe('duplicate email', () => {
    it('returns 409 USER_EMAIL_TAKEN', async () => {
      const code = await createRegistrationKey({ maxUses: 2 });

      // First registration
      await SELF.fetch('http://localhost/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          code,
          email: 'duplicate@example.com',
          password: 'securePassword123',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      // Second registration with same email
      const response = await SELF.fetch('http://localhost/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          code,
          email: 'duplicate@example.com',
          password: 'differentPassword123',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error.code).toBe('USER_EMAIL_TAKEN');
    });
  });

  describe('validation errors', () => {
    it('returns 400 VALIDATION_ERROR for invalid code length', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          code: 'tooshort',
          email: 'user@example.com',
          password: 'securePassword123',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(400);
    });

    it('returns 400 VALIDATION_ERROR for invalid email', async () => {
      const code = await createRegistrationKey({ maxUses: 1 });

      const response = await SELF.fetch('http://localhost/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          code,
          email: 'notanemail',
          password: 'securePassword123',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(400);
    });

    it('returns 400 VALIDATION_ERROR for short password', async () => {
      const code = await createRegistrationKey({ maxUses: 1 });

      const response = await SELF.fetch('http://localhost/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          code,
          email: 'user@example.com',
          password: 'short',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(400);
    });
  });
});

describe('POST /api/v1/auth/login', () => {
  let userId: string;

  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
    userId = await createAdminUser();
  });

  describe('correct credentials', () => {
    it('returns 200 with tokens and user info', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'adminPassword123',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      if (response.status !== 200) {
        const errorBody = await response.json();
        console.error('Login failed:', response.status, errorBody);
      }

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data).toHaveProperty('accessToken');
      expect(body.data).toHaveProperty('refreshToken');
      expect(body.data).toHaveProperty('user');
      expect(body.data.user).toHaveProperty('id', userId);
      expect(body.data.user).toHaveProperty('email', 'admin@example.com');
    });

    it('stores access token in KV with 15-minute TTL', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'adminPassword123',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      const body = await response.json();
      const accessToken = body.data.accessToken;

      const tokenData = await env.CACHE.get(`auth:${accessToken}`);
      expect(tokenData).not.toBeNull();
      expect(JSON.parse(tokenData ?? '{}')).toHaveProperty('userId', userId);
    });

    it('stores session in D1 with refresh token hash', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'adminPassword123',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      const body = await response.json();
      const refreshToken = body.data.refreshToken;
      const refreshTokenHash = await hashToken(refreshToken);

      const session = await env.DB.prepare(
        `SELECT user_id, expires_at FROM sessions WHERE refresh_token_hash = ?`,
      ).bind(refreshTokenHash).first();

      expect(session).toBeDefined();
      expect(session?.user_id).toBe(userId);
    });

    it('case-insensitive email lookup', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: 'ADMIN@EXAMPLE.COM', // Uppercase
          password: 'adminPassword123',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(200);
    });
  });

  describe('wrong credentials', () => {
    it('returns 401 INVALID_CREDENTIALS for wrong password', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'wrongPassword',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('returns 401 INVALID_CREDENTIALS for non-existent email', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: 'nonexistent@example.com',
          password: 'adminPassword123',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('returns 401 INVALID_CREDENTIALS for deleted user', async () => {
      // Delete the user
      await env.DB.prepare(
        `UPDATE users SET status = 'deleted', deleted_at = datetime('now') WHERE id = ?`,
      ).bind(userId).run();

      const response = await SELF.fetch('http://localhost/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'adminPassword123',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(401);
    });

    it('returns 403 USER_BANNED for banned user', async () => {
      // Ban the user
      await env.DB.prepare(
        `UPDATE users SET status = 'banned' WHERE id = ?`,
      ).bind(userId).run();

      const response = await SELF.fetch('http://localhost/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'adminPassword123',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error.code).toBe('USER_BANNED');
    });
  });

  describe('validation errors', () => {
    it('returns 400 VALIDATION_ERROR for invalid email', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: 'notanemail',
          password: 'adminPassword123',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(400);
    });

    it('returns 400 VALIDATION_ERROR for empty password', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: '',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(400);
    });
  });
});

describe('POST /api/v1/auth/refresh', () => {
  let userId: string;
  let refreshToken: string;

  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
    userId = await createAdminUser();
    refreshToken = await createSession(userId);
  });

  describe('valid refresh token', () => {
    it('returns 200 with new access token', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refreshToken }),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data).toHaveProperty('accessToken');
    });

    it('stores new access token in KV', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refreshToken }),
        headers: { 'Content-Type': 'application/json' },
      });

      const body = await response.json();
      const accessToken = body.data.accessToken;

      const tokenData = await env.CACHE.get(`auth:${accessToken}`);
      expect(tokenData).not.toBeNull();
      expect(JSON.parse(tokenData ?? '{}')).toHaveProperty('userId', userId);
    });
  });

  describe('invalid refresh token', () => {
    it('returns 401 REFRESH_TOKEN_INVALID for non-existent token', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refreshToken: crypto.randomUUID() }),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe('REFRESH_TOKEN_INVALID');
    });

    it('returns 401 REFRESH_TOKEN_EXPIRED for expired token', async () => {
      // Create an expired session
      const expiredToken = crypto.randomUUID();
      const expiredTokenHash = await hashToken(expiredToken);
      const expiredExpiresAt = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago

      await env.DB.prepare(
        `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        userId,
        expiredTokenHash,
        expiredExpiresAt,
        new Date().toISOString(),
      ).run();

      const response = await SELF.fetch('http://localhost/api/v1/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refreshToken: expiredToken }),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe('REFRESH_TOKEN_EXPIRED');
    });
  });

  describe('validation errors', () => {
    it('returns 400 VALIDATION_ERROR for invalid UUID', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refreshToken: 'not-a-uuid' }),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(400);
    });
  });
});

describe('GET /api/v1/auth/me', () => {
  let userId: string;
  let accessToken: string;

  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
    userId = await createAdminUser();

    // Login to get access token
    const response = await SELF.fetch('http://localhost/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: 'admin@example.com',
        password: 'adminPassword123',
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const body = await response.json();
    accessToken = body.data.accessToken;
  });

  describe('authenticated request', () => {
    it('returns 200 with user info', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/auth/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data).toHaveProperty('user');
      expect(body.data.user).toHaveProperty('id', userId);
      expect(body.data.user).toHaveProperty('email', 'admin@example.com');
    });
  });

  describe('unauthenticated request', () => {
    it('returns 401 AUTHENTICATION_REQUIRED without token', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/auth/me');

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 401 AUTHENTICATION_REQUIRED with invalid token', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/auth/me', {
        headers: { Authorization: 'Bearer invalid-token-123' },
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 401 AUTHENTICATION_REQUIRED with wrong format', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/auth/me', {
        headers: { Authorization: `WrongFormat ${accessToken}` },
      });

      expect(response.status).toBe(401);
    });
  });
});
