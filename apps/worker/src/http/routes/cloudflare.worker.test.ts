// cloudflare.worker.test.ts — POST /api/v1/setup/cloudflare/dashboard-link, POST /api/v1/setup/cloudflare/verify.
//
// Worker-pool tests for the Cloudflare setup endpoints. Uses SELF.fetch to exercise
// the full request pipeline through the real entrypoint, router, and middleware.
//
// Tests cover:
// - Dashboard-link returns 200 with { url: "https://dash.cloudflare.com" }
// - Dashboard-link does NOT advance the installation step
// - Verify with existing domain returns 200 with { verified: true, domain: "<name>" }
// - Verify advances installation step to 'inbound-smoke'
// - Verify with no domain returns 409 SETUP_DOMAIN_REQUIRED
// - Both endpoints require a valid session → 401 without one

import { describe, expect, it, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate, FIXED_TIMESTAMP } from '@unimailbox/test-kit';

describe('POST /api/v1/setup/cloudflare/dashboard-link', () => {
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

  describe('valid session', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      sessionToken = await claimSession();
    });

    it('returns 200 with Cloudflare dashboard URL', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/cloudflare/dashboard-link', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json\b/);

      const body = await response.json();
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('url', 'https://dash.cloudflare.com');
    });

    it('returns the success envelope { data: T }', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/cloudflare/dashboard-link', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      const body = await response.json();

      // Envelope must have a `data` key.
      expect(body).toHaveProperty('data');
      // And no other top-level keys.
      expect(Object.keys(body)).toEqual(['data']);
    });

    it('response includes only the url field', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/cloudflare/dashboard-link', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      const body = await response.json();

      expect(Object.keys(body.data)).toEqual(['url']);
    });

    it('does NOT advance the installation step', async () => {
      // Set initial step to 'cloudflare-verify'
      await env.DB.prepare(
        `UPDATE installation_state SET current_step = 'cloudflare-verify', updated_at = ? WHERE id = 1`,
      )
        .bind(FIXED_TIMESTAMP)
        .run();

      // Call dashboard-link
      await SELF.fetch('http://localhost/api/v1/setup/cloudflare/dashboard-link', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      // Verify step is still 'cloudflare-verify'
      const statusResponse = await SELF.fetch('http://localhost/api/v1/setup/status');
      const statusBody = await statusResponse.json();

      expect(statusBody.data).toEqual({
        status: 'setup',
        currentStep: 'cloudflare-verify',
      });
    });
  });

  describe('no session', () => {
    beforeEach(resetAndMigrate);

    it('returns 401 SETUP_SESSION_REQUIRED', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/cloudflare/dashboard-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('SETUP_SESSION_REQUIRED');
      expect(body.error.message).toBe('Authorization header required');
    });

    it('returns 401 for invalid session token', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/cloudflare/dashboard-link', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer invalid-token',
        },
      });

      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error.code).toBe('SETUP_SESSION_INVALID');
      expect(body.error.message).toBe('Invalid or expired session');
    });
  });

  describe('setup gate exemption', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      sessionToken = await claimSession();
    });

    it('is NOT 302-redirected by the setup gate (exempt path)', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/cloudflare/dashboard-link', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
        redirect: 'manual',
      });

      // Should succeed, not redirect
      expect(response.status).toBe(200);
      expect(response.headers.get('Location')).toBeNull();
    });
  });
});

describe('POST /api/v1/setup/cloudflare/verify', () => {
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

  // Helper: create a domain for testing
  // NOTE: Use a fresh session for domain creation to avoid step advancement conflicts
  async function createDomain(name: string, token: string): Promise<string> {
    const response = await SELF.fetch('http://localhost/api/v1/setup/domain', {
      method: 'POST',
      body: JSON.stringify({ name }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });

    if (response.status !== 200) {
      throw new Error(`Failed to create domain: ${response.status}`);
    }

    const body = await response.json();
    return body.data.domainId;
  }

  describe('valid session with existing domain', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      sessionToken = await claimSession();
      // Create a domain first
      await createDomain('example.com', sessionToken);
    });

    it('returns 200 with verified: true and domain name', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/cloudflare/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json\b/);

      const body = await response.json();
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('verified', true);
      expect(body.data).toHaveProperty('domain', 'example.com');
    });

    it('returns the success envelope { data: T }', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/cloudflare/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      const body = await response.json();

      // Envelope must have a `data` key.
      expect(body).toHaveProperty('data');
      // And no other top-level keys.
      expect(Object.keys(body)).toEqual(['data']);
    });

    it('response includes only verified and domain fields', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/cloudflare/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      const body = await response.json();

      expect(Object.keys(body.data)).toEqual(['verified', 'domain']);
    });

    it('advances installation step to inbound-smoke', async () => {
      // Before verify, step should be 'cloudflare-verify'
      const beforeResponse = await SELF.fetch('http://localhost/api/v1/setup/status');
      const beforeBody = await beforeResponse.json();
      expect(beforeBody.data.currentStep).toBe('cloudflare-verify');

      // Call verify
      await SELF.fetch('http://localhost/api/v1/setup/cloudflare/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      // After verify, step should be 'inbound-smoke'
      const afterResponse = await SELF.fetch('http://localhost/api/v1/setup/status');
      const afterBody = await afterResponse.json();

      expect(afterBody.data).toEqual({
        status: 'setup',
        currentStep: 'inbound-smoke',
      });
    });

    it('returns the domain name from the managed domain', async () => {
      // The domain was created in beforeEach with name 'example.com'
      const response = await SELF.fetch('http://localhost/api/v1/setup/cloudflare/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      const body = await response.json();
      expect(body.data.domain).toBe('example.com');
    });
  });

  describe('no domain exists', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      sessionToken = await claimSession();
      // Do NOT create a domain
    });

    it('returns 409 SETUP_DOMAIN_REQUIRED', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/cloudflare/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      expect(response.status).toBe(409);

      const body = await response.json();
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('SETUP_DOMAIN_REQUIRED');
      expect(body.error.message).toBe('A managed domain must be created before verifying Cloudflare');
    });

    it('returns error envelope { error: { code, message } }', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/cloudflare/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      const body = await response.json();

      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');
      expect(Object.keys(body)).toEqual(['error']);
    });

    it('does NOT advance the installation step when no domain exists', async () => {
      // Set initial step to 'cloudflare-verify'
      await env.DB.prepare(
        `UPDATE installation_state SET current_step = 'cloudflare-verify', updated_at = ? WHERE id = 1`,
      )
        .bind(FIXED_TIMESTAMP)
        .run();

      // Call verify (will fail with 409)
      await SELF.fetch('http://localhost/api/v1/setup/cloudflare/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      // Verify step is still 'cloudflare-verify'
      const statusResponse = await SELF.fetch('http://localhost/api/v1/setup/status');
      const statusBody = await statusResponse.json();

      expect(statusBody.data.currentStep).toBe('cloudflare-verify');
    });
  });

  describe('no session', () => {
    beforeEach(resetAndMigrate);

    it('returns 401 SETUP_SESSION_REQUIRED', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/cloudflare/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('SETUP_SESSION_REQUIRED');
      expect(body.error.message).toBe('Authorization header required');
    });

    it('returns 401 for invalid session token', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/cloudflare/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer invalid-token',
        },
      });

      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error.code).toBe('SETUP_SESSION_INVALID');
      expect(body.error.message).toBe('Invalid or expired session');
    });
  });

  describe('setup gate exemption', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      sessionToken = await claimSession();
      await createDomain('example.com', sessionToken);
    });

    it('is NOT 302-redirected by the setup gate (exempt path)', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/cloudflare/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
        redirect: 'manual',
      });

      // Should succeed, not redirect
      expect(response.status).toBe(200);
      expect(response.headers.get('Location')).toBeNull();
    });
  });

  describe('idempotency', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      sessionToken = await claimSession();
      await createDomain('example.com', sessionToken);
    });

    it('calling verify multiple times returns the same result', async () => {
      // First call
      const firstResponse = await SELF.fetch('http://localhost/api/v1/setup/cloudflare/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      const firstBody = await firstResponse.json();
      expect(firstBody.data).toEqual({
        verified: true,
        domain: 'example.com',
      });

      // Second call (step is already 'inbound-smoke')
      const secondResponse = await SELF.fetch('http://localhost/api/v1/setup/cloudflare/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      const secondBody = await secondResponse.json();
      expect(secondBody.data).toEqual({
        verified: true,
        domain: 'example.com',
      });

      // Step should still be 'inbound-smoke'
      const statusResponse = await SELF.fetch('http://localhost/api/v1/setup/status');
      const statusBody = await statusResponse.json();

      expect(statusBody.data.currentStep).toBe('inbound-smoke');
    });
  });
});
