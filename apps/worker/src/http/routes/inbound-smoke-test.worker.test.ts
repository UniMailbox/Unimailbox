// inbound-smoke-test.worker.test.ts — POST /api/v1/setup/inbound-smoke-test,
// POST /api/v1/setup/inbound-smoke-test/check, and email handler smoke test detection.
//
// Worker-pool tests for the inbound smoke test endpoints. Uses SELF.fetch to exercise
// the full request pipeline through the real entrypoint, router, and middleware.
//
// Tests cover:
// - Start returns 200 with smokeTestAddress in format smoke+<uuid>@<domain>
// - Start stores token in CACHE KV
// - Check before email returns { status: "pending" }
// - Check after email returns { status: "received" } and advances step to 'brevo'
// - Email handler accepts smoke+<token>@ messages with valid token
// - Email handler rejects non-smoke-test messages
// - Start returns 409 when no domain exists
// - Both endpoints require a valid session → 401 without one

import { describe, expect, it, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate, FIXED_TIMESTAMP } from '@unimailbox/test-kit';
import inboundEmailHandler from '../../entrypoints/inbound-email';
import type { ForwardableEmailMessage } from '@cloudflare/workers-types';

describe('POST /api/v1/setup/inbound-smoke-test', () => {
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

    it('returns 200 with smokeTestAddress in correct format', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/inbound-smoke-test', {
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
      expect(body.data).toHaveProperty('smokeTestAddress');

      // Format: smoke+<uuid>@<domain>
      const address = body.data.smokeTestAddress as string;
      expect(address).toMatch(/^smoke\+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@example\.com$/i);
    });

    it('returns the success envelope { data: T }', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/inbound-smoke-test', {
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

    it('stores smoke test token in CACHE KV', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/inbound-smoke-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      const body = await response.json();
      const address = body.data.smokeTestAddress as string;
      // Extract token from smoke+<token>@domain
      const match = address.match(/^smoke\+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@/i);
      const token = match ? match[1] : '';

      // Verify the token exists in KV
      const smokeData = await env.CACHE.get(`smoke:${token}`);
      expect(smokeData).toBeTruthy();

      // Verify the active token is set
      const activeToken = await env.CACHE.get('smoke:active');
      expect(activeToken).toBe(token);
    });

    it('response includes only the smokeTestAddress field', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/inbound-smoke-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      const body = await response.json();

      expect(Object.keys(body.data)).toEqual(['smokeTestAddress']);
    });

    it('does NOT advance the installation step', async () => {
      // Set initial step to 'inbound-smoke'
      await env.DB.prepare(
        `UPDATE installation_state SET current_step = 'inbound-smoke', updated_at = ? WHERE id = 1`,
      )
        .bind(FIXED_TIMESTAMP)
        .run();

      // Call start
      await SELF.fetch('http://localhost/api/v1/setup/inbound-smoke-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      // Verify step is still 'inbound-smoke'
      const statusResponse = await SELF.fetch('http://localhost/api/v1/setup/status');
      const statusBody = await statusResponse.json();

      expect(statusBody.data).toEqual({
        status: 'setup',
        currentStep: 'inbound-smoke',
      });
    });
  });

  describe('no domain exists', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      sessionToken = await claimSession();
      // Do NOT create a domain
    });

    it('returns 409 SETUP_DOMAIN_REQUIRED', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/inbound-smoke-test', {
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
      expect(body.error.message).toBe('A managed domain must be created before the smoke test');
    });

    it('returns error envelope { error: { code, message } }', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/inbound-smoke-test', {
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
  });

  describe('no session', () => {
    beforeEach(resetAndMigrate);

    it('returns 401 SETUP_SESSION_REQUIRED', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/inbound-smoke-test', {
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
      const response = await SELF.fetch('http://localhost/api/v1/setup/inbound-smoke-test', {
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
      const response = await SELF.fetch('http://localhost/api/v1/setup/inbound-smoke-test', {
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

describe('POST /api/v1/setup/inbound-smoke-test/check', () => {
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

  // Helper: start smoke test and return token
  async function startSmokeTest(): Promise<{ token: string; address: string }> {
    const response = await SELF.fetch('http://localhost/api/v1/setup/inbound-smoke-test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
    });

    if (response.status !== 200) {
      throw new Error(`Failed to start smoke test: ${response.status}`);
    }

    const body = await response.json();
    const address = body.data.smokeTestAddress as string;
    const match = address.match(/^smoke\+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@/i);
    const token = match ? match[1] : '';
    return { token, address };
  }

  describe('valid session', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      sessionToken = await claimSession();
      await createDomain('example.com', sessionToken);
    });

    it('returns { status: "pending" } before email is received', async () => {
      // Start the smoke test
      await startSmokeTest();

      // Check status
      const response = await SELF.fetch('http://localhost/api/v1/setup/inbound-smoke-test/check', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.data).toEqual({ status: 'pending' });
    });

    it('returns { status: "received" } after email is received', async () => {
      // Start the smoke test
      const { token } = await startSmokeTest();

      // Simulate email received by setting KV flag
      await env.CACHE.put(`smoke-result:${token}`, '1', { expirationTtl: 300 });

      // Check status
      const response = await SELF.fetch('http://localhost/api/v1/setup/inbound-smoke-test/check', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.data).toEqual({ status: 'received' });
    });

    it('advances installation step to brevo after email is received', async () => {
      // Set initial step to 'inbound-smoke'
      await env.DB.prepare(
        `UPDATE installation_state SET current_step = 'inbound-smoke', updated_at = ? WHERE id = 1`,
      )
        .bind(FIXED_TIMESTAMP)
        .run();

      // Start the smoke test
      const { token } = await startSmokeTest();

      // Simulate email received
      await env.CACHE.put(`smoke-result:${token}`, '1', { expirationTtl: 300 });

      // Check status (should advance to brevo)
      await SELF.fetch('http://localhost/api/v1/setup/inbound-smoke-test/check', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      // Verify step is now 'brevo'
      const statusResponse = await SELF.fetch('http://localhost/api/v1/setup/status');
      const statusBody = await statusResponse.json();

      expect(statusBody.data.currentStep).toBe('brevo');
    });

    it('does NOT advance step when status is pending', async () => {
      // Set initial step to 'inbound-smoke'
      await env.DB.prepare(
        `UPDATE installation_state SET current_step = 'inbound-smoke', updated_at = ? WHERE id = 1`,
      )
        .bind(FIXED_TIMESTAMP)
        .run();

      // Start the smoke test
      await startSmokeTest();

      // Check status (no email received yet)
      await SELF.fetch('http://localhost/api/v1/setup/inbound-smoke-test/check', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      // Verify step is still 'inbound-smoke'
      const statusResponse = await SELF.fetch('http://localhost/api/v1/setup/status');
      const statusBody = await statusResponse.json();

      expect(statusBody.data.currentStep).toBe('inbound-smoke');
    });

    it('returns the success envelope { data: T }', async () => {
      // Start the smoke test
      await startSmokeTest();

      const response = await SELF.fetch('http://localhost/api/v1/setup/inbound-smoke-test/check', {
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

    it('response includes only the status field', async () => {
      // Start the smoke test
      await startSmokeTest();

      const response = await SELF.fetch('http://localhost/api/v1/setup/inbound-smoke-test/check', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      const body = await response.json();

      expect(Object.keys(body.data)).toEqual(['status']);
    });
  });

  describe('no session', () => {
    beforeEach(resetAndMigrate);

    it('returns 401 SETUP_SESSION_REQUIRED', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/inbound-smoke-test/check', {
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
      const response = await SELF.fetch('http://localhost/api/v1/setup/inbound-smoke-test/check', {
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
      await startSmokeTest();
    });

    it('is NOT 302-redirected by the setup gate (exempt path)', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/inbound-smoke-test/check', {
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

describe('email handler smoke test detection', () => {
  let sessionToken: string;
  let smokeToken: string;
  let smokeAddress: string;

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

  // Helper: start smoke test and return token
  async function startSmokeTest(): Promise<void> {
    const response = await SELF.fetch('http://localhost/api/v1/setup/inbound-smoke-test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
    });

    if (response.status !== 200) {
      throw new Error(`Failed to start smoke test: ${response.status}`);
    }

    const body = await response.json();
    smokeAddress = body.data.smokeTestAddress as string;
    const match = smokeAddress.match(/^smoke\+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@/i);
    smokeToken = match ? match[1] : '';
  }

  // Helper: create a mock email message
  function createMockMessage(to: string): ForwardableEmailMessage {
    let rejectReason: string | null = null;
    return {
      to,
      from: 'sender@example.org',
      headers: new Headers(),
      raw: new ReadableStream(),
      rawSize: 0,
      setReject: async (reason: string) => {
        rejectReason = reason;
      },
      forward: async (_address: string) => {},
      reply: async (_message: unknown) => {},
      // @ts-expect-error - for testing
      _getRejectReason: () => rejectReason,
    };
  }

  beforeEach(async () => {
    await resetAndMigrate();
    sessionToken = await claimSession();
    await createDomain('example.com', sessionToken);
    await startSmokeTest();
  });

  it('accepts messages with smoke+<token>@ prefix when token is valid', async () => {
    const mockMessage = createMockMessage(smokeAddress);

    await inboundEmailHandler.email(mockMessage, env);

    // Message should NOT be rejected
    expect(mockMessage._getRejectReason()).toBeNull();

    // KV flag should be set
    const result = await env.CACHE.get(`smoke-result:${smokeToken}`);
    expect(result).toBe('1');
  });

  it('rejects messages with smoke+ prefix but invalid token', async () => {
    const invalidAddress = `smoke+00000000-0000-0000-0000-000000000000@example.com`;
    const mockMessage = createMockMessage(invalidAddress);

    await inboundEmailHandler.email(mockMessage, env);

    // Message should be rejected
    expect(mockMessage._getRejectReason()).toBe(
      'Inbound email not yet enabled. Only smoke-test messages are accepted during setup.',
    );
  });

  it('rejects messages without smoke+ prefix', async () => {
    const mockMessage = createMockMessage('user@example.com');

    await inboundEmailHandler.email(mockMessage, env);

    // Message should be rejected
    expect(mockMessage._getRejectReason()).toBe(
      'Inbound email not yet enabled. Only smoke-test messages are accepted during setup.',
    );
  });

  it('accepts messages with valid token regardless of domain (token-based validation)', async () => {
    // The handler validates the token, not the domain. If the token is valid,
    // the message is accepted. Email routing ensures only messages to the
    // managed domain reach the worker.
    const wrongDomainAddress = `smoke+${smokeToken}@otherdomain.com`;
    const mockMessage = createMockMessage(wrongDomainAddress);

    await inboundEmailHandler.email(mockMessage, env);

    // Message should be accepted (valid token)
    expect(mockMessage._getRejectReason()).toBeNull();

    // KV flag should be set
    const result = await env.CACHE.get(`smoke-result:${smokeToken}`);
    expect(result).toBe('1');
  });

  it('handles case-insensitive UUID in smoke+ prefix', async () => {
    // Convert UUID to uppercase
    const upperCaseToken = smokeToken.toUpperCase();
    const upperCaseAddress = `smoke+${upperCaseToken}@example.com`;
    const mockMessage = createMockMessage(upperCaseAddress);

    await inboundEmailHandler.email(mockMessage, env);

    // Message should NOT be rejected (case-insensitive match)
    expect(mockMessage._getRejectReason()).toBeNull();

    // KV flag should be set (using lowercase token)
    const result = await env.CACHE.get(`smoke-result:${smokeToken}`);
    expect(result).toBe('1');
  });
});
