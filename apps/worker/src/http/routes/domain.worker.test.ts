// domain.worker.test.ts — POST /api/v1/setup/domain.
//
// Worker-pool tests for the domain endpoint. Uses SELF.fetch to exercise
// the full request pipeline through the real entrypoint, router, and middleware.
//
// Tests cover:
// - Valid session + body → 200 with domainId, name, status
// - Domain row exists in D1 with correct values
// - Installation step advances to 'cloudflare-verify'
// - Duplicate domain → 409 DOMAIN_ALREADY_MANAGED
// - Case-insensitive duplicate → 409 DOMAIN_NAME_TAKEN
// - No session → 401 SETUP_SESSION_REQUIRED
// - Invalid domain name → 400 VALIDATION_ERROR
// - Response envelope { data: T }

import { describe, expect, it, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate } from '@unimailbox/test-kit';

describe('POST /api/v1/setup/domain', () => {
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

    it('returns 200 with domainId, name, status', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/domain', {
        method: 'POST',
        body: JSON.stringify({
          name: 'example.com',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-domain-key',
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json\b/);

      const body = await response.json();
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('domainId');
      expect(body.data).toHaveProperty('name', 'example.com');
      expect(body.data).toHaveProperty('status', 'active');

      // domainId should be a UUID
      expect(typeof body.data.domainId).toBe('string');
      expect(body.data.domainId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('creates a domain row in D1 with correct fields', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/domain', {
        method: 'POST',
        body: JSON.stringify({
          name: 'example.com',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-domain-key',
        },
      });

      const body = await response.json();
      const domainId = body.data.domainId;

      // Verify domain row in D1
      const domain = await env.DB.prepare(
        'SELECT id, name, status, outbound_connection_id, created_at, updated_at FROM managed_domains WHERE id = ?',
      )
        .bind(domainId)
        .first();

      expect(domain).not.toBeNull();
      expect(domain?.id).toBe(domainId);
      expect(domain?.name).toBe('example.com');
      expect(domain?.status).toBe('active');
      expect(domain?.outbound_connection_id).toBeNull();
    });

    it('creates domain with status=active', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/domain', {
        method: 'POST',
        body: JSON.stringify({
          name: 'example.com',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-domain-key',
        },
      });

      const body = await response.json();
      const domainId = body.data.domainId;

      const domain = await env.DB.prepare('SELECT status FROM managed_domains WHERE id = ?')
        .bind(domainId)
        .first();

      expect(domain?.status).toBe('active');
    });

    it('stores domain name in lowercase (R-DATA-001)', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/domain', {
        method: 'POST',
        body: JSON.stringify({
          name: 'EXAMPLE.COM',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-domain-key',
        },
      });

      const body = await response.json();
      const domainId = body.data.domainId;

      const domain = await env.DB.prepare('SELECT name FROM managed_domains WHERE id = ?')
        .bind(domainId)
        .first();

      expect(domain?.name).toBe('example.com');
    });

    it('advances installation step to cloudflare-verify', async () => {
      await SELF.fetch('http://localhost/api/v1/setup/domain', {
        method: 'POST',
        body: JSON.stringify({
          name: 'example.com',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-domain-key',
        },
      });

      const statusResponse = await SELF.fetch('http://localhost/api/v1/setup/status');
      const statusBody = await statusResponse.json();

      expect(statusBody.data).toEqual({
        status: 'setup',
        currentStep: 'cloudflare-verify',
      });
    });

    it('returns the success envelope { data: T }', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/domain', {
        method: 'POST',
        body: JSON.stringify({
          name: 'example.com',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-domain-key',
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();

      // Envelope must have a `data` key.
      expect(body).toHaveProperty('data');
      // And no other top-level keys.
      expect(Object.keys(body)).toEqual(['data']);
    });

    it('response includes domainId, name, and status only', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/domain', {
        method: 'POST',
        body: JSON.stringify({
          name: 'example.com',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-domain-key',
        },
      });

      const body = await response.json();

      expect(Object.keys(body.data)).toEqual(['domainId', 'name', 'status']);
    });
  });

  describe('duplicate domain', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      sessionToken = await claimSession();

      // Create first domain
      await SELF.fetch('http://localhost/api/v1/setup/domain', {
        method: 'POST',
        body: JSON.stringify({
          name: 'example.com',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-domain-key',
        },
      });
    });

    it('returns 409 DOMAIN_ALREADY_MANAGED for second domain', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/domain', {
        method: 'POST',
        body: JSON.stringify({
          name: 'another.com',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-second-domain-key',
        },
      });

      expect(response.status).toBe(409);

      const body = await response.json();
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('DOMAIN_ALREADY_MANAGED');
      expect(body.error.message).toBe('A domain has already been managed');
    });

    it('returns error envelope { error: { code, message } }', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/domain', {
        method: 'POST',
        body: JSON.stringify({
          name: 'another.com',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-second-domain-key',
        },
      });

      const body = await response.json();

      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');
      expect(Object.keys(body)).toEqual(['error']);
    });

    it('installation step remains at cloudflare-verify after duplicate attempt', async () => {
      // After the beforeEach creates the first domain, step is 'cloudflare-verify'
      // Attempting to create a second domain should not change this
      await SELF.fetch('http://localhost/api/v1/setup/domain', {
        method: 'POST',
        body: JSON.stringify({
          name: 'another.com',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-second-domain-key',
        },
      });

      const statusResponse = await SELF.fetch('http://localhost/api/v1/setup/status');
      const statusBody = await statusResponse.json();

      // Step should still be 'cloudflare-verify' (set by the successful creation in beforeEach)
      expect(statusBody.data.currentStep).toBe('cloudflare-verify');
    });
  });

  describe('case-insensitive domain name (R-DATA-001)', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      sessionToken = await claimSession();

      // Create first domain with lowercase name
      await SELF.fetch('http://localhost/api/v1/setup/domain', {
        method: 'POST',
        body: JSON.stringify({
          name: 'example.com',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-domain-key',
        },
      });
    });

    it('returns 409 DOMAIN_ALREADY_MANAGED for same domain with different case', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/domain', {
        method: 'POST',
        body: JSON.stringify({
          name: 'EXAMPLE.COM',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-uppercase-domain-key',
        },
      });

      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe('DOMAIN_ALREADY_MANAGED');
    });
  });

  describe('no session', () => {
    beforeEach(resetAndMigrate);

    it('returns 401 SETUP_SESSION_REQUIRED', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/domain', {
        method: 'POST',
        body: JSON.stringify({
          name: 'example.com',
        }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-no-session-key',
        },
      });

      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('SETUP_SESSION_REQUIRED');
      expect(body.error.message).toBe('Authorization header required');
    });

    it('returns 401 for invalid session token', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/domain', {
        method: 'POST',
        body: JSON.stringify({
          name: 'example.com',
        }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-invalid-token-key',
          Authorization: 'Bearer invalid-token',
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

    it('returns 400 VALIDATION_ERROR for missing name', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/domain', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-domain-key',
        },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 VALIDATION_ERROR for domain without dots', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/domain', {
        method: 'POST',
        body: JSON.stringify({
          name: 'example',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-domain-key',
        },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 VALIDATION_ERROR for domain starting with hyphen', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/domain', {
        method: 'POST',
        body: JSON.stringify({
          name: '-example.com',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-domain-key',
        },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 VALIDATION_ERROR for domain ending with hyphen', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/domain', {
        method: 'POST',
        body: JSON.stringify({
          name: 'example-.com',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-domain-key',
        },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 VALIDATION_ERROR for domain with special characters', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/domain', {
        method: 'POST',
        body: JSON.stringify({
          name: 'example_test.com',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-domain-key',
        },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 VALIDATION_ERROR for domain shorter than 4 chars', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/domain', {
        method: 'POST',
        body: JSON.stringify({
          name: 'a.b',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-domain-key',
        },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('accepts minimum valid domain length (4 chars)', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/domain', {
        method: 'POST',
        body: JSON.stringify({
          name: 'a.co',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-domain-key',
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.name).toBe('a.co');
    });

    it('returns 400 VALIDATION_ERROR for domain longer than 253 chars', async () => {
      const long = `${'a'.repeat(64)}.${'b'.repeat(64)}.${'c'.repeat(64)}.${'d'.repeat(64)}.com`;
      const response = await SELF.fetch('http://localhost/api/v1/setup/domain', {
        method: 'POST',
        body: JSON.stringify({
          name: long,
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-domain-key',
        },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('valid domain formats', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      sessionToken = await claimSession();
    });

    it('accepts subdomain format', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/domain', {
        method: 'POST',
        body: JSON.stringify({
          name: 'mail.example.com',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-domain-key',
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.name).toBe('mail.example.com');
    });

    it('accepts domain with hyphens in labels', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/domain', {
        method: 'POST',
        body: JSON.stringify({
          name: 'mail-server.example.com',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-domain-key',
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.name).toBe('mail-server.example.com');
    });
  });

  describe('setup gate exemption', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      sessionToken = await claimSession();
    });

    it('is NOT 302-redirected by the setup gate (exempt path)', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/domain', {
        method: 'POST',
        body: JSON.stringify({
          name: 'example.com',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-domain-key',
        },
        redirect: 'manual',
      });

      // Should succeed, not redirect
      expect(response.status).toBe(200);
      expect(response.headers.get('Location')).toBeNull();
    });
  });

  describe('domain name normalisation (R-DATA-001)', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      sessionToken = await claimSession();
    });

    it('stores domain name in lowercase and trimmed', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/domain', {
        method: 'POST',
        body: JSON.stringify({
          name: '  EXAMPLE.COM  ',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-domain-key',
        },
      });

      const body = await response.json();
      const domainId = body.data.domainId;

      const domain = await env.DB.prepare('SELECT name FROM managed_domains WHERE id = ?')
        .bind(domainId)
        .first();

      expect(domain?.name).toBe('example.com');
    });
  });
});
