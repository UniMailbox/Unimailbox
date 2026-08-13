// complete-setup.worker.test.ts — POST /api/v1/setup/complete + GET /. CAP-016.
//
// Worker-pool tests for the complete setup endpoint and the GET / handler.
// Uses SELF.fetch to exercise the full request pipeline through the real
// entrypoint, router, and middleware.
//
// Tests cover:
// - POST /complete with valid session → 200 with status='complete'
// - After complete, GET /setup/status returns status='complete', currentStep='complete'
// - After complete, GET / returns 200 with HTML (not 302 to /setup)
// - Before complete, GET / still 302s to /setup
// - No session → 401

import { describe, expect, it, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate, FIXED_TIMESTAMP } from '@unimailbox/test-kit';

describe('POST /api/v1/setup/complete', () => {
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

  // Helper: setup prerequisites through outbound-smoke step
  async function setupPrerequisites(): Promise<void> {
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
        'Idempotency-Key': 'test-admin-key',
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
        'Idempotency-Key': 'test-domain-key',
      },
    });
    if (domainResponse.status !== 200) {
      throw new Error(`Failed to create domain: ${domainResponse.status}`);
    }

    // Advance step to 'complete' (simulating outbound-smoke-test success)
    await env.DB.prepare(
      `UPDATE installation_state SET current_step = 'complete', updated_at = ? WHERE id = 1`,
    )
      .bind(FIXED_TIMESTAMP)
      .run();
  }

  beforeEach(async () => {
    await resetAndMigrate();
    sessionToken = await claimSession();
    await setupPrerequisites();
  });

  describe('valid session', () => {
    it('returns 200 with status="complete"', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-complete-key',
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json\b/);

      const body = await response.json();
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('status', 'complete');
    });

    it('returns the success envelope { data: T }', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-complete-key',
        },
      });

      const body = await response.json();
      expect(body).toHaveProperty('data');
      expect(Object.keys(body)).toEqual(['data']);
    });

    it('sets installation_state.status to "complete"', async () => {
      await SELF.fetch('http://localhost/api/v1/setup/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-complete-key',
        },
      });

      const state = await env.DB
        .prepare('SELECT status FROM installation_state WHERE id = 1')
        .first<{ status: string }>();

      if (!state) {
        throw new Error('Installation state not found');
      }

      expect(state.status).toBe('complete');
    });

    it('sets installation_state.current_step to "complete"', async () => {
      await SELF.fetch('http://localhost/api/v1/setup/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-complete-key',
        },
      });

      const state = await env.DB
        .prepare('SELECT current_step FROM installation_state WHERE id = 1')
        .first<{ current_step: string }>();

      if (!state) {
        throw new Error('Installation state not found');
      }

      expect(state.current_step).toBe('complete');
    });

    it('updates updated_at timestamp', async () => {
      const beforeResponse = await SELF.fetch('http://localhost/api/v1/setup/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-complete-key',
        },
      });

      expect(beforeResponse.status).toBe(200);

      const state = await env.DB
        .prepare('SELECT updated_at FROM installation_state WHERE id = 1')
        .first<{ updated_at: string }>();

      if (!state) {
        throw new Error('Installation state not found');
      }

      expect(state.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it('is idempotent — calling twice succeeds', async () => {
      const response1 = await SELF.fetch('http://localhost/api/v1/setup/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-complete-key',
        },
      });

      expect(response1.status).toBe(200);

      const response2 = await SELF.fetch('http://localhost/api/v1/setup/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-complete-key',
        },
      });

      expect(response2.status).toBe(200);

      const body1 = await response1.json();
      const body2 = await response2.json();

      expect(body1).toEqual(body2);
    });
  });

  describe('idempotency (CAP-027 / ADR-004)', () => {
    it('returns 400 IDEMPOTENCY_KEY_REQUIRED when Idempotency-Key is missing', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/complete', {
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
      const idempotencyKey = 'test-complete-key-abc123';

      const response1 = await SELF.fetch('http://localhost/api/v1/setup/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': idempotencyKey,
        },
      });

      expect(response1.status).toBe(200);
      const body1 = await response1.json();

      // Second request with same key should replay
      const response2 = await SELF.fetch('http://localhost/api/v1/setup/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': idempotencyKey,
        },
      });

      expect(response2.status).toBe(200);
      const body2 = await response2.json();
      // Should return the same status
      expect(body2.data.status).toBe(body1.data.status);
      expect(body2.data.status).toBe('complete');
    });
  });

  describe('session requirement', () => {
    it('returns 401 without a session', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/complete', {
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
      const response = await SELF.fetch('http://localhost/api/v1/setup/complete', {
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

  describe('GET /setup/status after complete', () => {
    it('returns status="complete" and currentStep="complete"', async () => {
      // First complete setup
      await SELF.fetch('http://localhost/api/v1/setup/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-complete-key',
        },
      });

      // Then check status
      const statusResponse = await SELF.fetch('http://localhost/api/v1/setup/status');

      expect(statusResponse.status).toBe(200);
      const body = await statusResponse.json();

      expect(body.data.status).toBe('complete');
      expect(body.data.currentStep).toBe('complete');
    });
  });
});

describe('GET /', () => {
  let sessionToken: string;

  // Helper: claim a session
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

  // Helper: complete setup
  async function completeSetup(sessionToken: string): Promise<void> {
    // Create admin
    await SELF.fetch('http://localhost/api/v1/setup/administrator', {
      method: 'POST',
      body: JSON.stringify({
        email: 'admin@example.com',
        password: 'securePassword123',
        displayName: 'Admin User',
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
        'Idempotency-Key': 'test-admin-key',
      },
    });

    // Create domain
    await SELF.fetch('http://localhost/api/v1/setup/domain', {
      method: 'POST',
      body: JSON.stringify({ name: 'example.com' }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
        'Idempotency-Key': 'test-domain-key',
      },
    });

    // Advance to complete step
    await env.DB.prepare(
      `UPDATE installation_state SET current_step = 'complete', updated_at = ? WHERE id = 1`,
    )
      .bind(FIXED_TIMESTAMP)
      .run();

    // Call complete
    await SELF.fetch('http://localhost/api/v1/setup/complete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
        'Idempotency-Key': 'test-complete-key',
      },
    });
  }

  beforeEach(async () => {
    await resetAndMigrate();
    sessionToken = await claimSession();
  });

  describe('before installation is complete', () => {
    it('returns 302 redirect to /setup', async () => {
      const response = await SELF.fetch('http://localhost/', { redirect: 'manual' });

      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('/setup');
    });

    it('redirects when installation is in progress', async () => {
      // Create admin to move past initial step
      await SELF.fetch('http://localhost/api/v1/setup/administrator', {
        method: 'POST',
        body: JSON.stringify({
          email: 'admin@example.com',
          password: 'securePassword123',
          displayName: 'Admin User',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-admin-key',
        },
      });

      const response = await SELF.fetch('http://localhost/', { redirect: 'manual' });

      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('/setup');
    });
  });

  describe('after installation is complete', () => {
    beforeEach(async () => {
      await completeSetup(sessionToken);
    });

    it('returns 200 with HTML content', async () => {
      const response = await SELF.fetch('http://localhost/');

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('text/html');

      const text = await response.text();
      expect(text).toContain('<!DOCTYPE html>');
      expect(text).toContain('<title>Unimailbox</title>');
      expect(text).toContain('<div id="root"></div>');
      expect(text).toContain('<script type="module" src="/assets/index.js"></script>');
    });

    it('returns the minimal HTML app shell', async () => {
      const response = await SELF.fetch('http://localhost/');

      const text = await response.text();

      // Verify the HTML structure
      expect(text).toMatch(/<!DOCTYPE html>/);
      expect(text).toMatch(/<html>/);
      expect(text).toMatch(/<head>/);
      expect(text).toMatch(/<title>Unimailbox<\/title>/);
      expect(text).toMatch(/<\/head>/);
      expect(text).toMatch(/<body>/);
      expect(text).toMatch(/<div id="root"><\/div>/);
      expect(text).toMatch(/<script type="module" src="\/assets\/index\.js"><\/script>/);
      expect(text).toMatch(/<\/body>/);
      expect(text).toMatch(/<\/html>/);
    });

    it('does not redirect when installation is complete', async () => {
      const response = await SELF.fetch('http://localhost/');

      expect(response.status).toBe(200);
      expect(response.headers.get('Location')).toBeNull();
    });
  });

  describe('setup gate exemption', () => {
    it('/healthz is exempt and always returns 200', async () => {
      const response = await SELF.fetch('http://localhost/healthz');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ ok: true, surface: 'router' });
    });

    it('/setup/* paths are exempt', async () => {
      const response = await SELF.fetch('http://localhost/setup');

      // Should not redirect even though installation is incomplete
      // (The client would serve the setup React app in production)
      expect(response.status).not.toBe(302);
    });

    it('/api/v1/setup/* paths are exempt', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/status');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data).toHaveProperty('status');
    });
  });
});
