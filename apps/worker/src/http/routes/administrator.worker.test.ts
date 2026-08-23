// administrator.worker.test.ts — POST /api/v1/setup/administrator.
//
// Worker-pool tests for the administrator endpoint. Uses SELF.fetch to exercise
// the full request pipeline through the real entrypoint, router, and middleware.
//
// Tests cover:
// - Valid session + body → 200 with userId
// - User row exists in D1 with correct password hash
// - Installation step advances to 'domain'
// - Duplicate email → 409 USER_EMAIL_TAKEN
// - No session → 401 SETUP_SESSION_REQUIRED
// - Short password → 400 VALIDATION_ERROR
// - Response does NOT include password hash, salt, or iterations

import { describe, expect, it, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate } from '@unimailbox/test-kit';

describe('POST /api/v1/setup/administrator', () => {
  let sessionToken: string;

  // Helper: claim a session before each test
  async function claimSession(): Promise<string> {
    const response = await SELF.fetch('http://localhost/api/v1/setup/claim', {
      method: 'POST',
      body: JSON.stringify({ token: 'test-installation-token' }),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'test-claim-session-key',
      },
    });

    if (response.status !== 200) {
      throw new Error(`Failed to claim session: ${response.status}`);
    }

    const body = await response.json();
    return body.data.sessionToken;
  }

  describe('valid session and body', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      sessionToken = await claimSession();
    });

    it('returns 200 with userId', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'securePassword123',
          displayName: 'Admin User',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-admin-returns-200-with-userId',
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json\b/);

      const body = await response.json();
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('userId');

      // userId should be a UUID
      expect(typeof body.data.userId).toBe('string');
      expect(body.data.userId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('creates a user row in D1 with correct fields', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'securePassword123',
          displayName: 'Admin User',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-admin-creates-user-row',
        },
      });

      const body = await response.json();
      const userId = body.data.userId;

      // Verify user row in D1
      const user = await env.DB.prepare(
        'SELECT id, email, display_name, status, password_algorithm, password_iterations, password_salt, password_hash FROM users WHERE id = ?',
      )
        .bind(userId)
        .first();

      expect(user).not.toBeNull();
      expect(user?.id).toBe(userId);
      expect(user?.email).toBe('admin@example.com');
      expect(user?.display_name).toBe('Admin User');
      expect(user?.status).toBe('active');
      expect(user?.password_algorithm).toBe('pbkdf2-sha256');
      expect(user?.password_iterations).toBe(600000);

      // BLOB columns are non-empty
      expect(user?.password_salt).not.toBeNull();
      expect(user?.password_hash).not.toBeNull();
    });

    it('creates user with status=active (R-AUTH-002)', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'securePassword123',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-admin-password-hash',
        },
      });

      const body = await response.json();
      const userId = body.data.userId;

      const user = await env.DB.prepare('SELECT status FROM users WHERE id = ?')
        .bind(userId)
        .first();

      expect(user?.status).toBe('active');
    });

    it('stores password with correct PBKDF2 parameters (ADR-006)', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'securePassword123',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-admin-pbkdf2-params',
        },
      });

      const body = await response.json();
      const userId = body.data.userId;

      const user = await env.DB.prepare(
        'SELECT password_algorithm, password_iterations, password_salt, password_hash FROM users WHERE id = ?',
      )
        .bind(userId)
        .first<{
          password_algorithm: string;
          password_iterations: number;
          password_salt: ArrayBuffer;
          password_hash: ArrayBuffer;
        }>();

      expect(user?.password_algorithm).toBe('pbkdf2-sha256');
      expect(user?.password_iterations).toBe(600000);

      // Salt should be 16 bytes (ADR-006)
      const salt = new Uint8Array(user?.password_salt ?? new ArrayBuffer(0));
      expect(salt.length).toBe(16);

      // Hash should be 32 bytes (256 bits, ADR-006)
      const hash = new Uint8Array(user?.password_hash ?? new ArrayBuffer(0));
      expect(hash.length).toBe(32);
    });

    it('advances installation step to domain', async () => {
      await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'securePassword123',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-admin-advances-step',
        },
      });

      const statusResponse = await SELF.fetch('http://localhost/api/v1/setup/status');
      const statusBody = await statusResponse.json();

      expect(statusBody.data).toEqual({
        status: 'setup',
        currentStep: 'domain',
      });
    });

    it('uses the deterministic email-prefix displayName when omitted', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'securePassword123',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-admin-no-display-name',
        },
      });

      const body = await response.json();
      const userId = body.data.userId;

      const user = await env.DB.prepare('SELECT display_name FROM users WHERE id = ?')
        .bind(userId)
        .first();

      expect(user?.display_name).toBe('admin');
    });

    it('returns the success envelope { data: T }', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'securePassword123',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-admin-success-envelope',
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();

      // Envelope must have a `data` key.
      expect(body).toHaveProperty('data');
      // And no other top-level keys.
      expect(Object.keys(body)).toEqual(['data']);
    });

    it('response does NOT include password hash, salt, or iterations', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'securePassword123',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-admin-no-password-response',
        },
      });

      const body = await response.json();

      // Response only contains userId
      expect(Object.keys(body.data)).toEqual(['userId']);
      expect(body.data).not.toHaveProperty('passwordHash');
      expect(body.data).not.toHaveProperty('passwordSalt');
      expect(body.data).not.toHaveProperty('passwordIterations');
      expect(body.data).not.toHaveProperty('passwordAlgorithm');
    });
  });

  describe('duplicate email', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      sessionToken = await claimSession();

      // Create first user
      await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'securePassword123',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-admin-success-envelope',
        },
      });
    });

    it('returns 409 SETUP_ADMINISTRATOR_EXISTS for duplicate email', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'differentPassword123',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-admin-no-password-in-response',
        },
      });

      expect(response.status).toBe(409);

      const body = await response.json();
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('SETUP_ADMINISTRATOR_EXISTS');
      expect(body.error.message).toBe('An administrator has already been created');
    });

    it('returns error envelope { error: { code, message } }', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'differentPassword123',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-admin-error-envelope',
        },
      });

      const body = await response.json();

      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');
      expect(Object.keys(body)).toEqual(['error']);
    });

    it('installation step remains at domain after duplicate email attempt', async () => {
      // After the beforeEach creates the first user, step is 'domain'
      // Attempting to create a duplicate email should not change this
      await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'differentPassword123',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-admin-step-remains-domain',
        },
      });

      const statusResponse = await SELF.fetch('http://localhost/api/v1/setup/status');
      const statusBody = await statusResponse.json();

      // Step should still be 'domain' (set by the successful creation in beforeEach)
      expect(statusBody.data.currentStep).toBe('domain');
    });
  });

  describe('case-insensitive email (R-AUTH-009)', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      sessionToken = await claimSession();

      // Create first user with lowercase email
      await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'securePassword123',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-admin-duplicate-first',
        },
      });
    });

    it('returns 409 SETUP_ADMINISTRATOR_EXISTS for same email with different case', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          email: 'ADMIN@EXAMPLE.COM',
          password: 'differentPassword123',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-admin-duplicate-second',
        },
      });

      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe('SETUP_ADMINISTRATOR_EXISTS');
    });
  });

  describe('no session', () => {
    beforeEach(resetAndMigrate);

    it('returns 401 SETUP_SESSION_REQUIRED', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'securePassword123',
        }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-admin-no-session-key',
        },
      });

      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('SETUP_SESSION_REQUIRED');
      expect(body.error.message).toBe('Authorization header required');
    });

    it('returns 401 for invalid session token', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'securePassword123',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer invalid-token',
          'Idempotency-Key': 'test-admin-invalid-session-key',
        },
      });

      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error.code).toBe('SETUP_SESSION_INVALID');
      expect(body.error.message).toBe('Invalid or expired session');
    });
  });

  describe('validation errors', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      sessionToken = await claimSession();
    });

    it('returns 400 VALIDATION_ERROR for missing email', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          password: 'securePassword123',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-admin-missing-email',
        },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 VALIDATION_ERROR for missing password', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-admin-missing-password',
        },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 VALIDATION_ERROR for short password (< 6 chars)', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'short',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-admin-missing-email',
        },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 VALIDATION_ERROR for long password (> 30 chars)', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'a'.repeat(31),
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-admin-short-password',
        },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 VALIDATION_ERROR for invalid email format', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          email: 'not-an-email',
          password: 'securePassword123',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-admin-long-password',
        },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 VALIDATION_ERROR for displayName > 100 chars', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'securePassword123',
          displayName: 'a'.repeat(101),
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-admin-key',
        },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  // -----------------------------------------------------------------------
  // CAP-031 / R-INPUT-002: malformed JSON returns 400 INVALID_JSON via
  // parseJsonBody. /setup/* has no authenticated userId, so actorUserId
  // is omitted from the warn log (TS2379).
  // -----------------------------------------------------------------------
  it('returns 400 INVALID_JSON when body is malformed JSON', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/setup/administrator', {
      method: 'POST',
      body: '{not valid json',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
        'Idempotency-Key': 'setup-administrator-invalid-json-' + crypto.randomUUID(),
      },
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('INVALID_JSON');
  });

  describe('minimum and maximum password lengths', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      sessionToken = await claimSession();
    });

    it('accepts minimum password length (6 chars)', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: '123456',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-admin-key',
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data).toHaveProperty('userId');
    });

    it('accepts maximum password length (30 chars)', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'a'.repeat(30),
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-admin-key',
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data).toHaveProperty('userId');
    });
  });

  describe('setup gate exemption', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      sessionToken = await claimSession();
    });

    it('is NOT 302-redirected by the setup gate (exempt path)', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'securePassword123',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-admin-key',
        },
        redirect: 'manual',
      });

      // Should succeed, not redirect
      expect(response.status).toBe(200);
      expect(response.headers.get('Location')).toBeNull();
    });
  });

  describe('email normalisation (R-DATA-001)', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      sessionToken = await claimSession();
    });

    it('stores email in lowercase and trimmed', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          email: '  ADMIN@Example.COM  ',
          password: 'securePassword123',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-admin-key',
        },
      });

      const body = await response.json();
      const userId = body.data.userId;

      const user = await env.DB.prepare('SELECT email FROM users WHERE id = ?')
        .bind(userId)
        .first();

      expect(user?.email).toBe('admin@example.com');
    });
  });

  describe('idempotency (CAP-027 / ADR-004)', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      sessionToken = await claimSession();
    });

    it('returns 400 IDEMPOTENCY_KEY_REQUIRED when Idempotency-Key is missing', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'securePassword123',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('replays the stored response when same key + same body', async () => {
      const idempotencyKey = 'test-administrator-key-abc123';

      const response1 = await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'securePassword123',
          displayName: 'Admin User',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': idempotencyKey,
        },
      });

      expect(response1.status).toBe(200);
      const body1 = await response1.json();
      const userId1 = body1.data.userId;

      // Second request with same key and body should replay
      const response2 = await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'securePassword123',
          displayName: 'Admin User',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': idempotencyKey,
        },
      });

      expect(response2.status).toBe(200);
      const body2 = await response2.json();
      // Should return the same userId as the first request
      expect(body2.data.userId).toBe(userId1);
    });

    it('returns 409 IDEMPOTENCY_KEY_REUSED when same key + different body', async () => {
      const idempotencyKey = 'test-administrator-key-xyz789';

      const response1 = await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'securePassword123',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': idempotencyKey,
        },
      });

      expect(response1.status).toBe(200);

      // Second request with same key but different body
      const response2 = await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin2@example.com',
          password: 'differentPassword123',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': idempotencyKey,
        },
      });

      expect(response2.status).toBe(409);
      const body2 = await response2.json();
      expect(body2.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });
  });
});
