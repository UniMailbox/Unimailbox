// outbound-smoke-test.worker.test.ts — POST /api/v1/setup/outbound-smoke-test. CAP-015.
//
// Worker-pool tests for the outbound smoke test endpoint. Uses SELF.fetch to exercise
// the full request pipeline through the real entrypoint, router, and middleware.
//
// Tests cover:
// - Valid session + configured Brevo → 200 with providerMessageId
// - Installation step advances to 'complete' after success
// - No session → 401
// - Response does NOT include the decrypted API key (R-SECRET-003)
// - No administrator → 409 SETUP_ADMINISTRATOR_REQUIRED
// - No domain → 409 SETUP_DOMAIN_REQUIRED
// - Brevo not configured → 409 SETUP_BREVO_NOT_CONFIGURED
//
// Provider HTTP is intercepted by MSW; the full route and real storage bindings run.
// This suite needs no provider credentials and cannot send a real email.

import { describe, expect, it, beforeEach, beforeAll, afterEach, afterAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate, FIXED_TIMESTAMP } from '@unimailbox/test-kit';
import { BREVO_TEST_CONFIG, createBrevoNetwork } from '@unimailbox/test-kit/brevo-network';

describe('POST /api/v1/setup/outbound-smoke-test', () => {
  let sessionToken: string;

  const provider = createBrevoNetwork();
  beforeAll(() => provider.network.enable());
  beforeEach(() => provider.reset());
  afterEach(() => provider.network.resetHandlers());
  afterAll(() => provider.network.disable());

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

  // Helper: setup prerequisites (administrator + domain + brevo)
  async function setupPrerequisites(): Promise<void> {
    const config = BREVO_TEST_CONFIG;

    // Create administrator
    const adminResponse = await SELF.fetch('http://localhost/api/v1/setup/administrator', {
      method: 'POST',
      body: JSON.stringify({
        email: config.recipientEmail,
        password: 'securePassword123',
        displayName: 'Admin User',
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
        'Idempotency-Key': 'test-admin-key',
      },
    });
    if (adminResponse.status !== 200) {
      throw new Error(`Failed to create administrator: ${adminResponse.status}`);
    }

    // Create domain
    const domainResponse = await SELF.fetch('http://localhost/api/v1/setup/domain', {
      method: 'POST',
      body: JSON.stringify({ name: config.domain }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
        'Idempotency-Key': 'test-domain-key',
      },
    });
    if (domainResponse.status !== 200) {
      throw new Error(`Failed to create domain: ${domainResponse.status}`);
    }

    // Advance step to 'brevo'
    await env.DB.prepare(
      `UPDATE installation_state SET current_step = 'brevo', updated_at = ? WHERE id = 1`,
    )
      .bind(FIXED_TIMESTAMP)
      .run();

    const brevoResponse = await SELF.fetch('http://localhost/api/v1/setup/brevo', {
      method: 'POST',
      body: JSON.stringify({ apiKey: config.apiKey }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
        'Idempotency-Key': 'test-brevo-key',
      },
    });

    if (brevoResponse.status !== 200) {
      throw new Error(`Failed to setup Brevo: ${brevoResponse.status}`);
    }
  }

  beforeEach(async () => {
    await resetAndMigrate();
    sessionToken = await claimSession();
    await setupPrerequisites();
  });

  it('blocks unexpected external HTTP during the deployment gate', async () => {
    await expect(fetch('https://unexpected-provider.invalid/deployment-gate')).rejects.toThrow();
    expect(provider.sent).toHaveLength(0);
  });

  describe('valid session and configured Brevo', () => {
    it('returns 200 with providerMessageId', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/outbound-smoke-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-outbound-smoke-key',
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json\b/);

      const body = await response.json();
      expect(body).toHaveProperty('data');
      expect(body.data.providerMessageId).toEqual(expect.any(String));
      expect(body.data.providerMessageId.length).toBeGreaterThan(0);
    });

    it('advances the installation step to complete', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/outbound-smoke-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-outbound-smoke-key',
        },
      });

      expect(response.status).toBe(200);

      // Check the installation state
      const state = await env.DB.prepare(
        'SELECT current_step, updated_at FROM installation_state WHERE id = 1',
      ).first<{ current_step: string; updated_at: string }>();

      if (!state) {
        throw new Error('Installation state not found');
      }

      expect(state.current_step).toBe('complete');
      expect(state.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it('sends the test email to the admin user', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/outbound-smoke-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-outbound-smoke-key',
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.providerMessageId).toEqual(expect.any(String));
      expect(provider.sent).toHaveLength(1);
      expect(provider.sent[0]?.to).toEqual([
        expect.objectContaining({ email: BREVO_TEST_CONFIG.recipientEmail }),
      ]);
    });

    it('returns the success envelope { data: T }', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/outbound-smoke-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-outbound-smoke-key',
        },
      });

      const body = await response.json();
      expect(body).toHaveProperty('data');
      expect(Object.keys(body)).toEqual(['data']);
    });

    it('response does NOT include the decrypted API key (R-SECRET-003)', async () => {
      const config = BREVO_TEST_CONFIG;

      const response = await SELF.fetch('http://localhost/api/v1/setup/outbound-smoke-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-outbound-smoke-key',
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();

      // Verify API key is not in the response
      expect(body.data).not.toHaveProperty('apiKey');
      expect(JSON.stringify(body)).not.toContain(config.apiKey);
    });
  });

  describe('session requirement', () => {
    it('returns 401 without a session', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/outbound-smoke-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-no-session-key',
        },
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('SETUP_SESSION_REQUIRED');
    });

    it('returns 401 with an invalid session token', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/outbound-smoke-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-invalid-token-key',
          Authorization: 'Bearer invalid-session-token',
        },
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe('SETUP_SESSION_INVALID');
    });
  });

  describe('prerequisites not met', () => {
    it('returns 409 SETUP_ADMINISTRATOR_REQUIRED when no admin exists', async () => {
      // Create a fresh session without admin
      await resetAndMigrate();
      const newSessionToken = await claimSession();

      // Manually set up domain (bypassing admin creation)
      await env.DB.prepare(
        `INSERT INTO managed_domains (id, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`,
      )
        .bind('test-domain-id', 'example.com', FIXED_TIMESTAMP, FIXED_TIMESTAMP)
        .run();

      await env.DB.prepare(
        `UPDATE installation_state SET current_step = 'outbound-smoke', updated_at = ? WHERE id = 1`,
      )
        .bind(FIXED_TIMESTAMP)
        .run();

      const response = await SELF.fetch('http://localhost/api/v1/setup/outbound-smoke-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-no-admin-key',
          Authorization: `Bearer ${newSessionToken}`,
        },
      });

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error.code).toBe('SETUP_ADMINISTRATOR_REQUIRED');
    });

    it('returns 409 SETUP_DOMAIN_REQUIRED when no domain exists', async () => {
      // Remove the domain
      await env.DB.prepare('DELETE FROM managed_domains').run();

      const response = await SELF.fetch('http://localhost/api/v1/setup/outbound-smoke-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-outbound-smoke-key',
        },
      });

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error.code).toBe('SETUP_DOMAIN_REQUIRED');
    });

    it('returns 409 SETUP_BREVO_NOT_CONFIGURED when Brevo not configured', async () => {
      // Remove the provider connection first (due to foreign key constraint)
      await env.DB.prepare('DELETE FROM provider_connections').run();
      // Then remove the encrypted credential
      await env.DB.prepare('DELETE FROM encrypted_credentials').run();

      const response = await SELF.fetch('http://localhost/api/v1/setup/outbound-smoke-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-outbound-smoke-key',
        },
      });

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error.code).toBe('SETUP_BREVO_NOT_CONFIGURED');
    });
  });

  describe('idempotency (CAP-027 / ADR-004)', () => {
    it('returns 400 IDEMPOTENCY_KEY_REQUIRED when Idempotency-Key is missing', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/outbound-smoke-test', {
        method: 'POST',
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
      const idempotencyKey = 'test-outbound-smoke-key-abc123';

      const response1 = await SELF.fetch('http://localhost/api/v1/setup/outbound-smoke-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': idempotencyKey,
        },
      });

      expect(response1.status).toBe(200);
      const body1 = await response1.json();
      expect(body1.data.providerMessageId).toEqual(expect.any(String));

      // Reset step to allow second call (simulating a replay attempt)
      await env.DB.prepare(
        `UPDATE installation_state SET current_step = 'outbound-smoke', updated_at = ? WHERE id = 1`,
      )
        .bind(FIXED_TIMESTAMP)
        .run();

      const response2 = await SELF.fetch('http://localhost/api/v1/setup/outbound-smoke-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': idempotencyKey,
        },
      });

      expect(response2.status).toBe(200);
      const body2 = await response2.json();
      // Should return the SAME providerMessageId as the first request (replay)
      expect(body2.data.providerMessageId).toBe(body1.data.providerMessageId);
      expect(provider.sent).toHaveLength(1);
    });
  });
});
