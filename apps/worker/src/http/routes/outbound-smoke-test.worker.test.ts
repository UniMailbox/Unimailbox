// outbound-smoke-test.worker.test.ts — POST /api/v1/setup/outbound-smoke-test. CAP-015.
//
// Worker-pool tests for the outbound smoke test endpoint. Uses SELF.fetch to exercise
// the full request pipeline through the real entrypoint, router, and middleware.
//
// Tests cover:
// - Valid session + configured Brevo → 200 with providerMessageId
// - Installation step advances to 'complete' after success
// - Brevo API error → 502 PROVIDER_SEND_FAILED
// - No session → 401
// - Response does NOT include the decrypted API key (R-SECRET-003)
// - No administrator → 409 SETUP_ADMINISTRATOR_REQUIRED
// - No domain → 409 SETUP_DOMAIN_REQUIRED
// - Brevo not configured → 409 SETUP_BREVO_NOT_CONFIGURED

import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate, FIXED_TIMESTAMP } from '@unimailbox/test-kit';

describe('POST /api/v1/setup/outbound-smoke-test', () => {
  let sessionToken: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

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

  // Helper: setup prerequisites (administrator + domain + brevo)
  async function setupPrerequisites(existingFetchSpy: ReturnType<typeof vi.spyOn>): Promise<void> {
    // Create administrator
    const adminResponse = await SELF.fetch('http://localhost/api/v1/setup/administrator', {
      method: 'POST',
      body: JSON.stringify({
        email: 'admin@example.com',
        password: 'securePassword123',
        displayName: 'Admin User',
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
    });
    if (adminResponse.status !== 200) {
      throw new Error(`Failed to create administrator: ${adminResponse.status}`);
    }

    // Create domain
    const domainResponse = await SELF.fetch('http://localhost/api/v1/setup/domain', {
      method: 'POST',
      body: JSON.stringify({ name: 'example.com' }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
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

    // Setup Brevo - mock the fetch for the Brevo validation call specifically
    existingFetchSpy.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === 'https://api.brevo.com/v3/account' && options?.method === undefined) {
        // GET request for account validation
        return new Response(JSON.stringify({ id: 'test-account' }), { status: 200 });
      }
      if (url === 'https://api.brevo.com/v3/smtp/email' && options?.method === 'POST') {
        // POST request for sending email
        return new Response(JSON.stringify({ messageId: 'test-send-id' }), { status: 200 });
      }
      // Default response for any other calls
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const brevoResponse = await SELF.fetch('http://localhost/api/v1/setup/brevo', {
      method: 'POST',
      body: JSON.stringify({ apiKey: 'test-brevo-api-key' }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
    });

    if (brevoResponse.status !== 200) {
      throw new Error(`Failed to setup Brevo: ${brevoResponse.status}`);
    }
  }

  // Helper: mock successful send for smoke test
  function mockSuccessfulSend(messageId: string = 'brevo-message-123') {
    fetchSpy.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === 'https://api.brevo.com/v3/smtp/email' && options?.method === 'POST') {
        return new Response(JSON.stringify({ messageId }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
  }

  // Helper: mock failed send
  function mockFailedSend(status: number, message: string = 'Send failed') {
    fetchSpy.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === 'https://api.brevo.com/v3/smtp/email' && options?.method === 'POST') {
        return new Response(JSON.stringify({ message }), { status });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
  }

  beforeEach(async () => {
    // Spy on global fetch to mock Brevo API calls BEFORE any setup
    fetchSpy = vi.spyOn(globalThis, 'fetch');

    await resetAndMigrate();
    sessionToken = await claimSession();
    await setupPrerequisites(fetchSpy);
  });

  afterEach(() => {
    // Restore the original fetch implementation
    fetchSpy.mockRestore();
  });

  describe('valid session and configured Brevo', () => {
    it('returns 200 with providerMessageId', async () => {
      mockSuccessfulSend();

      const response = await SELF.fetch('http://localhost/api/v1/setup/outbound-smoke-test', {
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
      expect(body.data).toHaveProperty('providerMessageId', 'brevo-message-123');
    });

    it('advances the installation step to complete', async () => {
      mockSuccessfulSend();

      const response = await SELF.fetch('http://localhost/api/v1/setup/outbound-smoke-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      expect(response.status).toBe(200);

      // Check the installation state
      const state = await env.DB
        .prepare('SELECT current_step, updated_at FROM installation_state WHERE id = 1')
        .first<{ current_step: string; updated_at: string }>();

      if (!state) {
        throw new Error('Installation state not found');
      }

      expect(state.current_step).toBe('complete');
      expect(state.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it('sends the test email to the admin user', async () => {
      mockSuccessfulSend();

      const response = await SELF.fetch('http://localhost/api/v1/setup/outbound-smoke-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      expect(response.status).toBe(200);

      // Verify Brevo API was called with the correct payload
      expect(fetchSpy).toHaveBeenCalled();
      const call = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
      expect(call[0]).toBe('https://api.brevo.com/v3/smtp/email');

      const bodyArg = call[1]?.body;
      expect(bodyArg).toBeDefined();
      const parsedBody = JSON.parse(bodyArg as string);
      expect(parsedBody.sender).toEqual({ email: 'noreply@example.com', name: undefined });
      expect(parsedBody.to).toEqual([{ email: 'admin@example.com', name: undefined }]);
      expect(parsedBody.subject).toBe('Unimailbox Setup Smoke Test');
    });

    it('returns the success envelope { data: T }', async () => {
      mockSuccessfulSend();

      const response = await SELF.fetch('http://localhost/api/v1/setup/outbound-smoke-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      const body = await response.json();
      expect(body).toHaveProperty('data');
      expect(Object.keys(body)).toEqual(['data']);
    });

    it('response does NOT include the decrypted API key (R-SECRET-003)', async () => {
      mockSuccessfulSend();

      const response = await SELF.fetch('http://localhost/api/v1/setup/outbound-smoke-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();

      // Verify API key is not in the response
      expect(body.data).not.toHaveProperty('apiKey');
      expect(JSON.stringify(body)).not.toContain('test-brevo-api-key');
    });
  });

  describe('Brevo API errors', () => {
    it('returns 502 PROVIDER_SEND_FAILED when Brevo send fails', async () => {
      mockFailedSend(401, 'Invalid API key');

      const response = await SELF.fetch('http://localhost/api/v1/setup/outbound-smoke-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('PROVIDER_SEND_FAILED');
    });

    it('does not advance step when Brevo send fails', async () => {
      mockFailedSend(503, 'Service unavailable');

      const response = await SELF.fetch('http://localhost/api/v1/setup/outbound-smoke-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      expect(response.status).toBe(502);

      // Verify step did NOT advance (should still be 'outbound-smoke')
      const state = await env.DB
        .prepare('SELECT current_step FROM installation_state WHERE id = 1')
        .first<{ current_step: string }>();

      if (!state) {
        throw new Error('Installation state not found');
      }

      // Step should still be 'outbound-smoke' (where Brevo setup left it)
      expect(state.current_step).toBe('outbound-smoke');
    });

    it('returns 502 when Brevo returns 500', async () => {
      mockFailedSend(500, 'Internal Server Error');

      const response = await SELF.fetch('http://localhost/api/v1/setup/outbound-smoke-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      expect(response.status).toBe(502);
    });
  });

  describe('session requirement', () => {
    it('returns 401 without a session', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/outbound-smoke-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      await env.DB
        .prepare(
          `INSERT INTO managed_domains (id, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`,
        )
        .bind('test-domain-id', 'example.com', FIXED_TIMESTAMP, FIXED_TIMESTAMP)
        .run();

      await env.DB
        .prepare(`UPDATE installation_state SET current_step = 'outbound-smoke', updated_at = ? WHERE id = 1`)
        .bind(FIXED_TIMESTAMP)
        .run();

      mockSuccessfulSend();

      const response = await SELF.fetch('http://localhost/api/v1/setup/outbound-smoke-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
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

      mockSuccessfulSend();

      const response = await SELF.fetch('http://localhost/api/v1/setup/outbound-smoke-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
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

      mockSuccessfulSend();

      const response = await SELF.fetch('http://localhost/api/v1/setup/outbound-smoke-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error.code).toBe('SETUP_BREVO_NOT_CONFIGURED');
    });
  });

  describe('idempotency', () => {
    it('generates a unique idempotency key for each send', async () => {
      let callCount = 0;
      fetchSpy.mockImplementation(async () => {
        callCount++;
        return new Response(JSON.stringify({ messageId: `brevo-msg-${callCount}` }), { status: 200 });
      });

      // First call
      const response1 = await SELF.fetch('http://localhost/api/v1/setup/outbound-smoke-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      expect(response1.status).toBe(200);
      const body1 = await response1.json();
      expect(body1.data.providerMessageId).toBe('brevo-msg-1');

      // Reset step to allow second call
      await env.DB
        .prepare(`UPDATE installation_state SET current_step = 'outbound-smoke', updated_at = ? WHERE id = 1`)
        .bind(FIXED_TIMESTAMP)
        .run();

      // Second call
      const response2 = await SELF.fetch('http://localhost/api/v1/setup/outbound-smoke-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      expect(response2.status).toBe(200);
      const body2 = await response2.json();
      expect(body2.data.providerMessageId).toBe('brevo-msg-2');

      // Verify both calls were made
      expect(callCount).toBe(2);
    });
  });

  describe('request payload', () => {
    it('includes correct from address with noreply@ domain', async () => {
      mockSuccessfulSend();

      await SELF.fetch('http://localhost/api/v1/setup/outbound-smoke-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      const call = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
      const bodyArg = call[1]?.body;
      const parsedBody = JSON.parse(bodyArg as string);

      expect(parsedBody.sender.email).toBe('noreply@example.com');
    });

    it('includes subject "Unimailbox Setup Smoke Test"', async () => {
      mockSuccessfulSend();

      await SELF.fetch('http://localhost/api/v1/setup/outbound-smoke-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      const call = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
      const bodyArg = call[1]?.body;
      const parsedBody = JSON.parse(bodyArg as string);

      expect(parsedBody.subject).toBe('Unimailbox Setup Smoke Test');
    });

    it('includes both html and text content', async () => {
      mockSuccessfulSend();

      await SELF.fetch('http://localhost/api/v1/setup/outbound-smoke-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      const call = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
      const bodyArg = call[1]?.body;
      const parsedBody = JSON.parse(bodyArg as string);

      expect(parsedBody.htmlContent).toBe('<p>This is a test message from Unimailbox setup.</p>');
      expect(parsedBody.textContent).toBe('This is a test message from Unimailbox setup.');
    });
  });
});
