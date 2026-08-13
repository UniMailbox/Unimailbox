// preflight.worker.test.ts — POST /api/v1/setup/preflight.
//
// Worker-pool tests for the preflight endpoint. Uses SELF.fetch to exercise
// the full request pipeline through the real entrypoint, router, and middleware.
//
// Tests cover:
// - Valid session → 200 with binding report and schema version
// - No Authorization header → 401 SETUP_SESSION_REQUIRED
// - Invalid session token → 401 SETUP_SESSION_INVALID
// - All 7 bindings reported as present
// - Schema version from d1_migrations table

import { describe, expect, it, beforeEach } from 'vitest';
import { SELF } from 'cloudflare:test';
import { resetAndMigrate } from '@unimailbox/test-kit';

describe('POST /api/v1/setup/preflight', () => {
  let sessionToken: string;

  // Helper: claim a session before each test
  async function claimSession(): Promise<string> {
    const response = await SELF.fetch('http://localhost/api/v1/setup/claim', {
      method: 'POST',
      body: JSON.stringify({ token: 'test-installation-token' }),
      headers: { 'Content-Type': 'application/json' },
    });

    if (response.status !== 200) {
      throw new Error(`Failed to claim session: ${response.status}`);
    }

    const body = await response.json();
    return body.data.sessionToken;
  }

  describe('valid session token', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      sessionToken = await claimSession();
    });

    it('returns 200 with binding report and schema version', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionToken}` },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json\b/);

      const body = await response.json();
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('bindings');
      expect(body.data).toHaveProperty('schemaVersion');
    });

    it('reports all 7 bindings as present', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionToken}` },
      });

      const body = await response.json();
      const { bindings } = body.data;

      // All 7 bindings should be present and true
      expect(bindings).toEqual({
        DB: true,
        ATTACHMENTS: true,
        SETUP_SESSION: true,
        CACHE: true,
        OUTBOUND: true,
        INSTALLATION_TOKEN: true,
        CREDENTIAL_ENCRYPTION_KEY: true,
      });

      // Exactly 7 keys
      expect(Object.keys(bindings).length).toBe(7);
    });

    it('reports schema version from d1_migrations', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionToken}` },
      });

      const body = await response.json();
      expect(body.data.schemaVersion).toBe('0004');
    });

    it('returns the success envelope { data: T }', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionToken}` },
      });

      expect(response.status).toBe(200);
      const body = await response.json();

      // Envelope must have a `data` key.
      expect(body).toHaveProperty('data');
      // And no other top-level keys.
      expect(Object.keys(body)).toEqual(['data']);
    });
  });

  describe('no Authorization header', () => {
    beforeEach(resetAndMigrate);

    it('returns 401 SETUP_SESSION_REQUIRED', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
      });

      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('SETUP_SESSION_REQUIRED');
      expect(body.error.message).toBe('Authorization header required');
    });

    it('returns error envelope { error: { code, message } }', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
      });

      const body = await response.json();

      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');
      expect(Object.keys(body)).toEqual(['error']);
    });
  });

  describe('invalid session token', () => {
    beforeEach(resetAndMigrate);

    it('returns 401 SETUP_SESSION_INVALID', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
        headers: { Authorization: 'Bearer invalid-token' },
      });

      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('SETUP_SESSION_INVALID');
      expect(body.error.message).toBe('Invalid or expired session');
    });

    it('returns error envelope { error: { code, message } }', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
        headers: { Authorization: 'Bearer invalid-token' },
      });

      const body = await response.json();

      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');
      expect(Object.keys(body)).toEqual(['error']);
    });
  });

  describe('malformed Authorization header', () => {
    beforeEach(resetAndMigrate);

    it('returns 401 for "Bearer" prefix without token', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
        headers: { Authorization: 'Bearer' },
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe('SETUP_SESSION_REQUIRED');
    });

    it('returns 401 SETUP_SESSION_REQUIRED for "Bearer " (trailing space stripped)', async () => {
      // HTTP trims trailing whitespace from header values, so 'Bearer ' becomes
      // 'Bearer', which does not match startsWith('Bearer ') → REQUIRED.
      const response = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' },
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe('SETUP_SESSION_REQUIRED');
    });

    it('returns 401 for token without "Bearer" prefix', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
        headers: { Authorization: 'some-token' },
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe('SETUP_SESSION_REQUIRED');
    });
  });

  describe('setup gate exemption', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      sessionToken = await claimSession();
    });

    it('is NOT 302-redirected by the setup gate (exempt path)', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionToken}` },
        redirect: 'manual',
      });

      // Should succeed, not redirect
      expect(response.status).toBe(200);
      expect(response.headers.get('Location')).toBeNull();
    });
  });

  describe('/status and /claim remain public (no session required)', () => {
    beforeEach(resetAndMigrate);

    it('GET /status works without Authorization header', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/status');

      expect(response.status).toBe(200);
    });

    it('POST /claim works without Authorization header', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/claim', {
        method: 'POST',
        body: JSON.stringify({ token: 'test-installation-token' }),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(200);
    });
  });
});
