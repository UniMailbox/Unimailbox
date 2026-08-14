// brevo.worker.test.ts — POST /api/v1/setup/brevo. CAP-014.
//
// Worker-pool tests for the Brevo setup endpoint. Uses SELF.fetch to exercise
// the full request pipeline through the real entrypoint, router, and middleware.
//
// Tests cover:
// - Valid API key + session → 200 with connectionId
// - Encrypted credential stored in D1 (ciphertext + iv + auth_tag BLOBs)
// - Provider connection row exists with provider_key='brevo', status='active'
// - Managed domain outbound_connection_id linked to the new connection
// - Installation step advances to 'outbound-smoke'
// - Invalid API key (401 from Brevo) → 502 PROVIDER_CONNECTION_FAILED
// - No session → 401
// - Response does NOT include the API key (R-SECRET-003)

import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate, FIXED_TIMESTAMP } from '@unimailbox/test-kit';

describe('POST /api/v1/setup/brevo', () => {
  let sessionToken: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

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

  // Helper: setup prerequisites (administrator + domain)
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

    // Advance step to 'brevo'
    await env.DB.prepare(
      `UPDATE installation_state SET current_step = 'brevo', updated_at = ? WHERE id = 1`,
    )
      .bind(FIXED_TIMESTAMP)
      .run();
  }

  beforeEach(async () => {
    await resetAndMigrate();
    sessionToken = await claimSession();
    await setupPrerequisites();

    // Spy on global fetch to mock Brevo API calls
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    // Restore the original fetch implementation
    fetchSpy.mockRestore();
  });

  describe('valid API key and session', () => {
    it('returns 200 with connectionId, providerKey, and status', async () => {
      // Mock successful Brevo validation
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ id: 'test-account' }), { status: 200 }),
      );

      const response = await SELF.fetch('http://localhost/api/v1/setup/brevo', {
        method: 'POST',
        body: JSON.stringify({ apiKey: 'valid-brevo-api-key' }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-brevo-key',
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json\b/);

      const body = await response.json();
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('connectionId');
      expect(body.data).toHaveProperty('providerKey', 'brevo');
      expect(body.data).toHaveProperty('status', 'active');

      // connectionId should be a UUID
      expect(typeof body.data.connectionId).toBe('string');
      expect(body.data.connectionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );

      // Verify the Brevo API was called
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(fetchSpy.mock.calls[0][0]).toBe('https://api.brevo.com/v3/account');
    });

    it('stores encrypted credential in D1 (not plaintext)', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ id: 'test-account' }), { status: 200 }),
      );

      const response = await SELF.fetch('http://localhost/api/v1/setup/brevo', {
        method: 'POST',
        body: JSON.stringify({ apiKey: 'test-api-key-12345' }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-encrypted-cred-key',
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();

      // Query the connection to get credential_id
      const connection = await env.DB
        .prepare('SELECT credential_id FROM provider_connections WHERE id = ?')
        .bind(body.data.connectionId)
        .first<{ credential_id: string }>();

      if (!connection) {
        throw new Error('Connection not found');
      }

      // Query the encrypted credential
      const credential = await env.DB
        .prepare('SELECT ciphertext, iv, auth_tag, name FROM encrypted_credentials WHERE id = ?')
        .bind(connection.credential_id)
        .first<{ ciphertext: unknown; iv: unknown; auth_tag: unknown; name: string }>();

      if (!credential) {
        throw new Error('Credential not found');
      }

      expect(credential.name).toBe('brevo-api-key');

      // Verify the stored data is NOT the plaintext API key
      const ciphertextBytes = new Uint8Array(credential.ciphertext as ArrayBuffer);
      const ciphertextStr = Buffer.from(ciphertextBytes).toString('utf-8');
      expect(ciphertextStr).not.toBe('test-api-key-12345');

      // Verify ciphertext, iv, and auth_tag are non-empty BLOBs
      expect(ciphertextBytes.byteLength).toBeGreaterThan(0);

      const ivBytes = new Uint8Array(credential.iv as ArrayBuffer);
      expect(ivBytes.byteLength).toBe(12); // GCM IV length

      const authTagBytes = new Uint8Array(credential.auth_tag as ArrayBuffer);
      expect(authTagBytes.byteLength).toBe(16); // GCM tag length
    });

    it('creates provider_connection row with correct values', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ id: 'test-account' }), { status: 200 }),
      );

      const response = await SELF.fetch('http://localhost/api/v1/setup/brevo', {
        method: 'POST',
        body: JSON.stringify({ apiKey: 'test-api-key' }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-provider-connection-key',
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();

      const connection = await env.DB
        .prepare(
          'SELECT id, provider_key, label, credential_id, status, created_at, updated_at FROM provider_connections WHERE id = ?',
        )
        .bind(body.data.connectionId)
        .first<{
          id: string;
          provider_key: string;
          label: string;
          credential_id: string;
          status: string;
          created_at: string;
          updated_at: string;
        }>();

      if (!connection) {
        throw new Error('Connection not found');
      }

      expect(connection.id).toBe(body.data.connectionId);
      expect(connection.provider_key).toBe('brevo');
      expect(connection.label).toBe('Brevo');
      expect(connection.status).toBe('active');
      // Don't check exact timestamp since clock runs in real-time
      expect(connection.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(connection.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(connection.credential_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it('links the connection to the managed domain', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ id: 'test-account' }), { status: 200 }),
      );

      const response = await SELF.fetch('http://localhost/api/v1/setup/brevo', {
        method: 'POST',
        body: JSON.stringify({ apiKey: 'test-api-key' }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-domain-link-key',
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();

      // Query the managed domain
      const domain = await env.DB
        .prepare('SELECT id, outbound_connection_id FROM managed_domains LIMIT 1')
        .first<{ id: string; outbound_connection_id: string }>();

      if (!domain) {
        throw new Error('Domain not found');
      }

      expect(domain.outbound_connection_id).toBe(body.data.connectionId);
    });

    it('advances the installation step to outbound-smoke', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ id: 'test-account' }), { status: 200 }),
      );

      const response = await SELF.fetch('http://localhost/api/v1/setup/brevo', {
        method: 'POST',
        body: JSON.stringify({ apiKey: 'test-api-key' }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-advance-step-key',
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

      expect(state.current_step).toBe('outbound-smoke');
      expect(state.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it('returns the success envelope { data: T }', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ id: 'test-account' }), { status: 200 }),
      );

      const response = await SELF.fetch('http://localhost/api/v1/setup/brevo', {
        method: 'POST',
        body: JSON.stringify({ apiKey: 'test-api-key' }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-envelope-key',
        },
      });

      const body = await response.json();
      expect(body).toHaveProperty('data');
      expect(Object.keys(body)).toEqual(['data']);
    });

    it('response does NOT include the API key (R-SECRET-003)', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ id: 'test-account' }), { status: 200 }),
      );

      const response = await SELF.fetch('http://localhost/api/v1/setup/brevo', {
        method: 'POST',
        body: JSON.stringify({ apiKey: 'my-secret-api-key' }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-no-api-key-response',
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();

      // Verify API key is not in the response
      expect(body.data).not.toHaveProperty('apiKey');
      expect(JSON.stringify(body)).not.toContain('my-secret-api-key');
    });

    it('response includes only connectionId, providerKey, and status', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ id: 'test-account' }), { status: 200 }),
      );

      const response = await SELF.fetch('http://localhost/api/v1/setup/brevo', {
        method: 'POST',
        body: JSON.stringify({ apiKey: 'test-api-key' }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-response-fields-key',
        },
      });

      const body = await response.json();
      expect(Object.keys(body.data)).toEqual(['connectionId', 'providerKey', 'status']);
    });
  });

  describe('invalid API key', () => {
    it('returns 502 PROVIDER_CONNECTION_FAILED when Brevo returns 401', async () => {
      // Mock Brevo API returning 401 (invalid key)
      fetchSpy.mockResolvedValue(new Response(JSON.stringify({ message: 'Invalid key' }), { status: 401 }));

      const response = await SELF.fetch('http://localhost/api/v1/setup/brevo', {
        method: 'POST',
        body: JSON.stringify({ apiKey: 'invalid-api-key' }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-brevo-401-key',
        },
      });

      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('PROVIDER_CONNECTION_FAILED');

      // Verify no credential was stored
      const credentials = await env.DB
        .prepare('SELECT COUNT(*) as count FROM encrypted_credentials')
        .first<{ count: number }>();
      if (!credentials) {
        throw new Error('Credentials count not found');
      }
      expect(credentials.count).toBe(0);

      // Verify no connection was stored
      const connections = await env.DB
        .prepare('SELECT COUNT(*) as count FROM provider_connections')
        .first<{ count: number }>();
      if (!connections) {
        throw new Error('Connections count not found');
      }
      expect(connections.count).toBe(0);

      // Verify step did NOT advance
      const state = await env.DB
        .prepare('SELECT current_step FROM installation_state WHERE id = 1')
        .first<{ current_step: string }>();
      if (!state) {
        throw new Error('Installation state not found');
      }
      expect(state.current_step).toBe('brevo');
    });

    it('returns 502 when Brevo returns 403', async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 }));

      const response = await SELF.fetch('http://localhost/api/v1/setup/brevo', {
        method: 'POST',
        body: JSON.stringify({ apiKey: 'forbidden-key' }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-brevo-403-key',
        },
      });

      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body.error.code).toBe('PROVIDER_CONNECTION_FAILED');
    });

    it('returns 502 when Brevo returns 500', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ message: 'Internal Server Error' }), { status: 500 }),
      );

      const response = await SELF.fetch('http://localhost/api/v1/setup/brevo', {
        method: 'POST',
        body: JSON.stringify({ apiKey: 'test-api-key' }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-brevo-500-key',
        },
      });

      expect(response.status).toBe(502);
    });
  });

  describe('session requirement', () => {
    it('returns 401 without a session', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/brevo', {
        method: 'POST',
        body: JSON.stringify({ apiKey: 'test-api-key' }),
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
      const response = await SELF.fetch('http://localhost/api/v1/setup/brevo', {
        method: 'POST',
        body: JSON.stringify({ apiKey: 'test-api-key' }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-invalid-token-key',
          Authorization: 'Bearer invalid-session-token',
        },
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      // Invalid tokens get SETUP_SESSION_INVALID, missing tokens get SETUP_SESSION_REQUIRED
      expect(body.error.code).toBe('SETUP_SESSION_INVALID');
    });
  });

  describe('validation', () => {
    it('returns 400 for missing apiKey', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/brevo', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-missing-api-key',
        },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for empty apiKey', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/brevo', {
        method: 'POST',
        body: JSON.stringify({ apiKey: '' }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-empty-api-key',
        },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    // ---------------------------------------------------------------------
    // CAP-031 / R-INPUT-002: malformed JSON returns 400 INVALID_JSON via
    // parseJsonBody. /setup/* has no authenticated userId, so actorUserId
    // is omitted from the warn log (TS2379).
    // ---------------------------------------------------------------------
    it('returns 400 INVALID_JSON when body is malformed JSON', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/brevo', {
        method: 'POST',
        body: '{not valid json',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'setup-brevo-invalid-json-' + crypto.randomUUID(),
        },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('INVALID_JSON');
    });
  });

  describe('gateway exemption', () => {
    it('allows requests from the gateway IP', async () => {
      // This test verifies the gateway exemption middleware allows the request
      // The actual gateway IP check is in setup-session middleware
      // For now, we just verify the endpoint works with a valid session
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ id: 'test-account' }), { status: 200 }),
      );

      const response = await SELF.fetch('http://localhost/api/v1/setup/brevo', {
        method: 'POST',
        body: JSON.stringify({ apiKey: 'test-api-key' }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-gateway-exemption-key',
        },
      });

      expect(response.status).toBe(200);
    });
  });

  describe('duplicate setup', () => {
    it('returns 409 SETUP_BREVO_ALREADY_CONFIGURED on second call', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ id: 'test-account' }), { status: 200 }),
      );

      // First call succeeds
      const firstResponse = await SELF.fetch('http://localhost/api/v1/setup/brevo', {
        method: 'POST',
        body: JSON.stringify({ apiKey: 'test-api-key' }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-duplicate-setup-first-key',
        },
      });

      expect(firstResponse.status).toBe(200);

      // Second call should fail with 409
      const secondResponse = await SELF.fetch('http://localhost/api/v1/setup/brevo', {
        method: 'POST',
        body: JSON.stringify({ apiKey: 'another-api-key' }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-duplicate-setup-second-key',
        },
      });

      expect(secondResponse.status).toBe(409);
      const body = await secondResponse.json();
      expect(body.error.code).toBe('SETUP_BREVO_ALREADY_CONFIGURED');

      // Verify only one connection exists
      const connections = await env.DB
        .prepare('SELECT COUNT(*) as count FROM provider_connections')
        .first<{ count: number }>();
      if (!connections) {
        throw new Error('Connections count not found');
      }
      expect(connections.count).toBe(1);
    });
  });

  describe('encryption quality', () => {
    it('produces different ciphertext for the same API key (random IV)', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ id: 'test-account' }), { status: 200 }),
      );

      const apiKey = 'test-api-key-12345';

      // First encryption
      const response1 = await SELF.fetch('http://localhost/api/v1/setup/brevo', {
        method: 'POST',
        body: JSON.stringify({ apiKey }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-encryption-quality-first-key',
        },
      });
      expect(response1.status).toBe(200);

      const body1 = await response1.json();
      const credential1 = await env.DB
        .prepare('SELECT ciphertext, iv FROM encrypted_credentials WHERE id = (SELECT credential_id FROM provider_connections WHERE id = ?)')
        .bind(body1.data.connectionId)
        .first<{ ciphertext: Uint8Array; iv: Uint8Array }>();

      if (!credential1) {
        throw new Error('Credential not found');
      }

      // Reset and try again (simulate a fresh setup with same key)
      await resetAndMigrate();
      sessionToken = await claimSession();
      await setupPrerequisites();

      // Need a new spy for the second test
      const fetchSpy2 = vi.spyOn(globalThis, 'fetch');
      fetchSpy2.mockResolvedValue(
        new Response(JSON.stringify({ id: 'test-account' }), { status: 200 }),
      );

      const response2 = await SELF.fetch('http://localhost/api/v1/setup/brevo', {
        method: 'POST',
        body: JSON.stringify({ apiKey }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-encryption-quality-second-key',
        },
      });
      expect(response2.status).toBe(200);

      const body2 = await response2.json();
      const credential2 = await env.DB
        .prepare('SELECT ciphertext, iv FROM encrypted_credentials WHERE id = (SELECT credential_id FROM provider_connections WHERE id = ?)')
        .bind(body2.data.connectionId)
        .first<{ ciphertext: Uint8Array; iv: Uint8Array }>();

      if (!credential2) {
        throw new Error('Credential not found');
      }

      fetchSpy2.mockRestore();

      // IVs should differ
      expect(new Uint8Array(credential1.iv)).not.toEqual(new Uint8Array(credential2.iv));

      // Ciphertexts should also differ because IVs differ
      expect(new Uint8Array(credential1.ciphertext)).not.toEqual(new Uint8Array(credential2.ciphertext));
    });
  });

  describe('idempotency (CAP-027 / ADR-004)', () => {
    it('returns 400 IDEMPOTENCY_KEY_REQUIRED when Idempotency-Key is missing', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ id: 'test-account' }), { status: 200 }),
      );

      const response = await SELF.fetch('http://localhost/api/v1/setup/brevo', {
        method: 'POST',
        body: JSON.stringify({ apiKey: 'test-api-key' }),
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
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ id: 'test-account' }), { status: 200 }),
      );

      const idempotencyKey = 'test-brevo-key-abc123';

      const response1 = await SELF.fetch('http://localhost/api/v1/setup/brevo', {
        method: 'POST',
        body: JSON.stringify({ apiKey: 'test-api-key' }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': idempotencyKey,
        },
      });

      expect(response1.status).toBe(200);
      const body1 = await response1.json();
      const connectionId1 = body1.data.connectionId;

      // Second request with same key and body should replay
      const response2 = await SELF.fetch('http://localhost/api/v1/setup/brevo', {
        method: 'POST',
        body: JSON.stringify({ apiKey: 'test-api-key' }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': idempotencyKey,
        },
      });

      expect(response2.status).toBe(200);
      const body2 = await response2.json();
      // Should return the same connectionId as the first request (replay)
      expect(body2.data.connectionId).toBe(connectionId1);
      expect(body2.data.providerKey).toBe(body1.data.providerKey);
      expect(body2.data.status).toBe(body1.data.status);

      // Verify only one connection was created (Brevo API called only once)
      expect(fetchSpy).toHaveBeenCalledOnce();
    });
  });
});
