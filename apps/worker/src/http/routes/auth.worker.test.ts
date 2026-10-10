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
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
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
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at) VALUES ('mailbox.manage', 'mailbox.manage', 'Manage mailboxes', datetime('now'))`,
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
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('member', 'mailbox.manage', datetime('now'))`,
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

// Helper: create a session for a user
async function createSession(userId: string): Promise<string> {
  const refreshToken = crypto.randomUUID();
  const refreshTokenHash = await hashToken(refreshToken);
  const sessionId = crypto.randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(sessionId, userId, refreshTokenHash, expiresAt, new Date().toISOString())
    .run();

  return refreshToken;
}

describe('POST /api/v1/auth/register', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
  });

  it('is disabled because administrators own account creation', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        code: 'legacy-registration-code',
        email: 'newuser@example.com',
        password: 'securePassword123',
      }),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'registration-disabled-' + crypto.randomUUID(),
      },
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error?: { code?: unknown } };
    expect(body.error?.code).toBe('REGISTRATION_DISABLED');
    const user = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
      .bind('newuser@example.com')
      .first();
    expect(user).toBeNull();
  });

  it('does not validate or consume legacy invite codes', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/auth/register', {
      method: 'POST',
      body: '{not valid json',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error?: { code?: unknown } };
    expect(body.error?.code).toBe('REGISTRATION_DISABLED');
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
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-key-' + crypto.randomUUID(),
        },
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
      expect(body.data.canAccessAdmin).toBe(true);
      expect(response.headers.get('set-cookie')).toContain('unimailbox_refresh=');
      expect(response.headers.get('set-cookie')).toContain('HttpOnly');
      expect(response.headers.get('set-cookie')).toContain('Path=/api/v1/auth');
    });

    it('refreshes after a hard reload using the HttpOnly cookie without a token body', async () => {
      const login = await SELF.fetch('http://localhost/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'adminPassword123',
        }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'cookie-login-' + crypto.randomUUID(),
        },
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get('set-cookie');
      expect(cookie).toBeTruthy();

      const refresh = await SELF.fetch('http://localhost/api/v1/auth/refresh', {
        method: 'POST',
        body: '{}',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie ?? '',
          'Idempotency-Key': 'cookie-refresh-' + crypto.randomUUID(),
        },
      });
      expect(refresh.status).toBe(200);
      expect((await refresh.json()).data.accessToken).toEqual(expect.any(String));
    });

    it('clears the refresh cookie even when the access token is already gone', async () => {
      const login = await SELF.fetch('http://localhost/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'admin@example.com', password: 'adminPassword123' }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'logout-cookie-login-' + crypto.randomUUID(),
        },
      });
      const cookie = login.headers.get('set-cookie');
      expect(cookie).toBeTruthy();

      const logout = await SELF.fetch('http://localhost/api/v1/auth/logout', {
        method: 'POST',
        headers: { Cookie: cookie ?? '' },
      });
      expect(logout.status).toBe(204);
      expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    });

    it('stores access token in KV with 15-minute TTL', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'adminPassword123',
        }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-key-' + crypto.randomUUID(),
        },
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
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-key-' + crypto.randomUUID(),
        },
      });

      const body = await response.json();
      const refreshToken = body.data.refreshToken;
      const refreshTokenHash = await hashToken(refreshToken);

      const session = await env.DB.prepare(
        `SELECT user_id, expires_at FROM sessions WHERE refresh_token_hash = ?`,
      )
        .bind(refreshTokenHash)
        .first();

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
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-key-' + crypto.randomUUID(),
        },
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
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-key-' + crypto.randomUUID(),
        },
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
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-key-' + crypto.randomUUID(),
        },
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('returns 401 INVALID_CREDENTIALS for deleted user', async () => {
      // Delete the user
      await env.DB.prepare(
        `UPDATE users SET status = 'deleted', deleted_at = datetime('now') WHERE id = ?`,
      )
        .bind(userId)
        .run();

      const response = await SELF.fetch('http://localhost/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'adminPassword123',
        }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-key-' + crypto.randomUUID(),
        },
      });

      expect(response.status).toBe(401);
    });

    it('returns 403 USER_BANNED for banned user', async () => {
      // Ban the user
      await env.DB.prepare(`UPDATE users SET status = 'banned' WHERE id = ?`).bind(userId).run();

      const response = await SELF.fetch('http://localhost/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'adminPassword123',
        }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-key-' + crypto.randomUUID(),
        },
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
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-key-' + crypto.randomUUID(),
        },
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
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-key-' + crypto.randomUUID(),
        },
      });

      expect(response.status).toBe(400);
    });
  });

  // CAP-031 / R-INPUT-002 / D-CAP-031-C: /login uses the local try/catch
  // (not the helper), but the surface is identical: 400 INVALID_JSON.
  it('returns 400 INVALID_JSON when body is malformed JSON', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/auth/login', {
      method: 'POST',
      body: '{not valid json',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'auth-login-invalid-json-' + crypto.randomUUID(),
      },
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('INVALID_JSON');
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
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-key-' + crypto.randomUUID(),
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data).toHaveProperty('accessToken');
    });

    it('stores new access token in KV', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refreshToken }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-key-' + crypto.randomUUID(),
        },
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
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-key-' + crypto.randomUUID(),
        },
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
      )
        .bind(
          crypto.randomUUID(),
          userId,
          expiredTokenHash,
          expiredExpiresAt,
          new Date().toISOString(),
        )
        .run();

      const response = await SELF.fetch('http://localhost/api/v1/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refreshToken: expiredToken }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-key-' + crypto.randomUUID(),
        },
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
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-key-' + crypto.randomUUID(),
        },
      });

      expect(response.status).toBe(400);
    });
  });

  // CAP-031 / R-INPUT-002 / D-CAP-031-C: /refresh uses the local try/catch
  // for the same reason as /register and /login.
  it('returns 400 INVALID_JSON when body is malformed JSON', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/auth/refresh', {
      method: 'POST',
      body: '{not valid json',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'auth-refresh-invalid-json-' + crypto.randomUUID(),
      },
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('INVALID_JSON');
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
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'test-key-' + crypto.randomUUID(),
      },
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
      expect(body.data.canAccessAdmin).toBe(true);
    });

    it('does not classify the ordinary member mailbox role as admin access', async () => {
      const memberId = crypto.randomUUID();
      const passwordHash = await hashPassword('memberPassword123');
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO users (id, email, display_name, status, password_algorithm,
           password_iterations, password_salt, password_hash, created_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
        ).bind(
          memberId,
          'member@example.com',
          'Member User',
          passwordHash.algorithm,
          passwordHash.iterations,
          passwordHash.salt,
          passwordHash.hash,
          now,
          now,
        ),
        env.DB.prepare(
          `INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, 'member', ?)`,
        ).bind(memberId, now),
      ]);
      const login = await SELF.fetch('http://localhost/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'member@example.com', password: 'memberPassword123' }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'member-login-' + crypto.randomUUID(),
        },
      });
      expect(login.status).toBe(200);
      const loginBody = (await login.json()) as {
        data: { accessToken: string; canAccessAdmin: boolean };
      };
      expect(loginBody.data.canAccessAdmin).toBe(false);
      const response = await SELF.fetch('http://localhost/api/v1/auth/me', {
        headers: { Authorization: `Bearer ${loginBody.data.accessToken}` },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { data: { canAccessAdmin: boolean } };
      expect(body.data.canAccessAdmin).toBe(false);
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

    it('R-AUTH-005 rejects a cached user-only token without a D1 session', async () => {
      const legacyToken = crypto.randomUUID();
      await env.CACHE.put(`auth:${legacyToken}`, JSON.stringify({ userId }), {
        expirationTtl: 900,
      });

      const response = await SELF.fetch('http://localhost/api/v1/auth/me', {
        headers: { Authorization: `Bearer ${legacyToken}` },
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('R-AUTH-005 rejects a token after its D1 session is revoked', async () => {
      const tokenPayload = await env.CACHE.get(`auth:${accessToken}`);
      expect(tokenPayload).not.toBeNull();
      const { sessionId } = JSON.parse(tokenPayload ?? '{}') as { sessionId?: string };
      expect(sessionId).toBeTruthy();
      await env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?')
        .bind(new Date().toISOString(), sessionId)
        .run();

      const response = await SELF.fetch('http://localhost/api/v1/auth/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('R-AUTH-005 rejects a token whose user ID does not own its D1 session', async () => {
      const tokenPayload = await env.CACHE.get(`auth:${accessToken}`);
      expect(tokenPayload).not.toBeNull();
      const { sessionId } = JSON.parse(tokenPayload ?? '{}') as { sessionId?: string };
      expect(sessionId).toBeTruthy();
      await env.CACHE.put(
        `auth:${accessToken}`,
        JSON.stringify({ userId: crypto.randomUUID(), sessionId }),
        { expirationTtl: 900 },
      );

      const response = await SELF.fetch('http://localhost/api/v1/auth/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('ignores Cloudflare Access identity headers without an application token', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/auth/me', {
        headers: {
          'Cf-Access-Jwt-Assertion': 'untrusted-assertion',
          'Cf-Access-Authenticated-User-Email': 'admin@example.com',
        },
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });
  });
});

// ---------------------------------------------------------------------------
// CAP-027 Idempotency tests
// ---------------------------------------------------------------------------

describe('POST /api/v1/auth/register — closed registration contract', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
  });

  it('returns REGISTRATION_DISABLED even without an Idempotency-Key', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: 'user@example.com', password: 'securePassword123' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error?: { code?: unknown } };
    expect(body.error?.code).toBe('REGISTRATION_DISABLED');
  });
});

describe('POST /api/v1/auth/login — idempotency', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
    await createAdminUser();
  });

  it('returns 400 IDEMPOTENCY_KEY_REQUIRED when header missing', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: 'admin@example.com',
        password: 'adminPassword123',
      }),
      headers: { 'Content-Type': 'application/json' }, // No Idempotency-Key
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('replays response when same key and body', async () => {
    const idempotencyKey = 'login-replay-' + crypto.randomUUID();
    const requestBody = JSON.stringify({
      email: 'admin@example.com',
      password: 'adminPassword123',
    });

    // First request
    const firstResponse = await SELF.fetch('http://localhost/api/v1/auth/login', {
      method: 'POST',
      body: requestBody,
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
    });

    expect(firstResponse.status).toBe(200);
    const firstBody = await firstResponse.json();
    const firstAccessToken = firstBody.data.accessToken;

    // Second request with same key and body: login is secret-bearing (Fix 1),
    // so it deletes the old record and re-executes, returning fresh tokens.
    const secondResponse = await SELF.fetch('http://localhost/api/v1/auth/login', {
      method: 'POST',
      body: requestBody,
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
    });

    expect(secondResponse.status).toBe(200);
    const secondBody = await secondResponse.json();
    // Each call gets fresh tokens (not replayed)
    expect(secondBody.data.accessToken).not.toBe(firstAccessToken);
  });

  it('returns 409 IDEMPOTENCY_KEY_REUSED when same key different body', async () => {
    const idempotencyKey = 'login-reuse-' + crypto.randomUUID();

    // First request with correct password
    const firstResponse = await SELF.fetch('http://localhost/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: 'admin@example.com',
        password: 'adminPassword123',
      }),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
    });

    expect(firstResponse.status).toBe(200);

    // Second request with same key but different password
    const secondResponse = await SELF.fetch('http://localhost/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: 'admin@example.com',
        password: 'wrongPassword',
      }),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
    });

    expect(secondResponse.status).toBe(409);
    const body = await secondResponse.json();
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('POST /api/v1/auth/refresh — idempotency', () => {
  let userId: string;
  let refreshToken: string;

  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
    userId = await createAdminUser();
    refreshToken = await createSession(userId);
  });

  it('returns 400 IDEMPOTENCY_KEY_REQUIRED when header missing', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
      headers: { 'Content-Type': 'application/json' }, // No Idempotency-Key
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('replays response when same key and body', async () => {
    const idempotencyKey = 'refresh-replay-' + crypto.randomUUID();
    const requestBody = JSON.stringify({ refreshToken });

    // First request
    const firstResponse = await SELF.fetch('http://localhost/api/v1/auth/refresh', {
      method: 'POST',
      body: requestBody,
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
    });

    expect(firstResponse.status).toBe(200);
    const firstBody = await firstResponse.json();
    const firstAccessToken = firstBody.data.accessToken;

    // Second request with same key and body: refresh is secret-bearing (Fix 1),
    // so it deletes the old record and re-executes, returning fresh tokens.
    const secondResponse = await SELF.fetch('http://localhost/api/v1/auth/refresh', {
      method: 'POST',
      body: requestBody,
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
    });

    expect(secondResponse.status).toBe(200);
    const secondBody = await secondResponse.json();
    // Each call gets fresh tokens (not replayed)
    expect(secondBody.data.accessToken).not.toBe(firstAccessToken);
  });

  it('different refresh tokens can each use their own idempotency key', async () => {
    const otherToken = await createSession(userId);
    const key1 = 'token1-' + crypto.randomUUID();
    const key2 = 'token2-' + crypto.randomUUID();

    // First request with refreshToken and key1
    const firstResponse = await SELF.fetch('http://localhost/api/v1/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key1,
      },
    });

    expect(firstResponse.status).toBe(200);
    const firstBody = await firstResponse.json();
    const firstAccessToken = firstBody.data.accessToken;

    // Second request with otherToken and key2 should also succeed
    const secondResponse = await SELF.fetch('http://localhost/api/v1/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: otherToken }),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key2,
      },
    });

    expect(secondResponse.status).toBe(200);
    const secondBody = await secondResponse.json();
    expect(secondBody.data.accessToken).not.toBe(firstAccessToken); // Different token, different result

    // Verify both tokens work (are in KV)
    const kv1 = await env.CACHE.get(`auth:${firstAccessToken}`);
    const kv2 = await env.CACHE.get(`auth:${secondBody.data.accessToken}`);
    expect(kv1).not.toBeNull();
    expect(kv2).not.toBeNull();
  });

  it('same idempotency key with different refresh token succeeds (different actor scope)', async () => {
    const otherToken = await createSession(userId);
    const sharedKey = 'shared-' + crypto.randomUUID();

    // First request with refreshToken
    const firstResponse = await SELF.fetch('http://localhost/api/v1/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': sharedKey,
      },
    });

    expect(firstResponse.status).toBe(200);

    // Second request with otherToken and same key succeeds because actorId is different
    // (actorId is derived from the refresh token itself)
    const secondResponse = await SELF.fetch('http://localhost/api/v1/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: otherToken }),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': sharedKey,
      },
    });

    expect(secondResponse.status).toBe(200);
    const secondBody = await secondResponse.json();
    expect(secondBody.data).toHaveProperty('accessToken');
  });
});

// ---------------------------------------------------------------------------
// Better Auth and Cloudflare Access are not runtime authentication authorities.
// The application-owned login route remains available regardless of any
// migration-only AUTH_PROVIDER value left in local configuration.
describe('POST /api/v1/auth/login — application-owned authority', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
    await createAdminUser();
  });

  it('issues the application Bearer token even when migration config names better-auth', async () => {
    (env as { AUTH_PROVIDER?: string }).AUTH_PROVIDER = 'better-auth';
    const response = await SELF.fetch('http://localhost/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@example.com', password: 'adminPassword123' }),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'application-auth-' + crypto.randomUUID(),
      },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data?: { accessToken?: unknown } };
    expect(body.data?.accessToken).toBeTruthy();
  });
});
