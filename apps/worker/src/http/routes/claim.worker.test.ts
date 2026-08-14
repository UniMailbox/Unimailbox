// claim.worker.test.ts — POST /api/v1/setup/claim.
//
// Worker-pool tests for the claim endpoint. Uses SELF.fetch to exercise
// the full request pipeline through the real entrypoint, router, and middleware.
//
// Tests cover:
// - Correct token → 200 with sessionToken + expiresIn
// - Wrong token → 401 SETUP_CLAIM_INVALID_TOKEN
// - Missing token → 400 VALIDATION_ERROR
// - Empty token → 400 VALIDATION_ERROR
// - Already complete → 409 SETUP_ALREADY_COMPLETE
// - Post-claim: installation_state seeded to currentStep='preflight'
// - Post-claim: sessionToken exists in KV
// - CAP-027 / ADR-004: Idempotency-Key required, replays return stored response
//   NOTE: IDEMPOTENCY_KEY_REUSED is not testable for /claim because its only
//   request field (token) determines the actorId for idempotency. Changing the
//   token changes the actorId, so the idempotency lookup fails to find the
//   previous record.

import { describe, expect, it, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { sha256Hex } from '../../platform/idempotency';

describe('POST /api/v1/setup/claim', () => {
  describe('correct token, fresh DB', () => {
    beforeEach(resetAndMigrate);

    it('returns 200 with sessionToken and expiresIn', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/claim', {
        method: 'POST',
        body: JSON.stringify({ token: 'test-installation-token' }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-claim-key',
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json\b/);

      const body = await response.json();
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('sessionToken');
      expect(body.data).toHaveProperty('expiresIn', 1800);

      // sessionToken should be a UUID
      expect(typeof body.data.sessionToken).toBe('string');
      expect(body.data.sessionToken).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('stores the sessionToken in KV with expiration', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/claim', {
        method: 'POST',
        body: JSON.stringify({ token: 'test-installation-token' }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-claim-key',
        },
      });

      const body = await response.json();
      const sessionToken = body.data.sessionToken;

      // Verify the session exists in KV
      const sessionData = await env.SETUP_SESSION.get(sessionToken);
      expect(sessionData).not.toBeNull();

      // Verify it stores createdAt
      const parsed = JSON.parse(sessionData ?? '{}');
      expect(parsed).toHaveProperty('createdAt');
      expect(typeof parsed.createdAt).toBe('string');
    });

    it('seeds installation_state to currentStep=preflight', async () => {
      await SELF.fetch('http://localhost/api/v1/setup/claim', {
        method: 'POST',
        body: JSON.stringify({ token: 'test-installation-token' }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-claim-key',
        },
      });

      // GET /status should now return preflight
      const statusResponse = await SELF.fetch('http://localhost/api/v1/setup/status');
      expect(statusResponse.status).toBe(200);

      const statusBody = await statusResponse.json();
      expect(statusBody.data).toEqual({
        status: 'setup',
        currentStep: 'preflight',
      });
    });
  });

  describe('wrong token', () => {
    beforeEach(resetAndMigrate);

    it('returns 401 SETUP_CLAIM_INVALID_TOKEN', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/claim', {
        method: 'POST',
        body: JSON.stringify({ token: 'wrong-token' }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-wrong-token-key',
        },
      });

      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('SETUP_CLAIM_INVALID_TOKEN');
      expect(body.error.message).toBe('Invalid installation token');
    });

    it('does not create a KV session', async () => {
      await SELF.fetch('http://localhost/api/v1/setup/claim', {
        method: 'POST',
        body: JSON.stringify({ token: 'wrong-token' }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-wrong-token-key',
        },
      });

      // List all keys in KV (should be empty)
      const list = await env.SETUP_SESSION.list();
      expect(list.keys.length).toBe(0);
    });
  });

  describe('missing token', () => {
    beforeEach(resetAndMigrate);

    it('returns 400 VALIDATION_ERROR', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/claim', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-missing-token-key',
        },
      });

      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('empty token', () => {
    beforeEach(resetAndMigrate);

    it('returns 400 VALIDATION_ERROR', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/claim', {
        method: 'POST',
        body: JSON.stringify({ token: '' }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-empty-token-key',
        },
      });

      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  // -----------------------------------------------------------------------
  // CAP-031 / R-INPUT-002: malformed JSON returns 400 INVALID_JSON
  // via parseJsonBody (R-INPUT-002). /setup/claim has no authenticated
  // userId, so actorUserId is omitted from the warn log (TS2379).
  // -----------------------------------------------------------------------
  it('returns 400 INVALID_JSON when body is malformed JSON', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/setup/claim', {
      method: 'POST',
      body: '{not valid json',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'setup-claim-invalid-json-' + crypto.randomUUID(),
      },
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('INVALID_JSON');
  });

  describe('already complete', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      await seedInstallationState({ status: 'complete', currentStep: 'complete' });
    });

    it('returns 409 SETUP_ALREADY_COMPLETE', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/claim', {
        method: 'POST',
        body: JSON.stringify({ token: 'test-installation-token' }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-already-complete-key',
        },
      });

      expect(response.status).toBe(409);

      const body = await response.json();
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('SETUP_ALREADY_COMPLETE');
      expect(body.error.message).toBe('Installation is already complete');
    });

    it('does not create a new session', async () => {
      await SELF.fetch('http://localhost/api/v1/setup/claim', {
        method: 'POST',
        body: JSON.stringify({ token: 'test-installation-token' }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-claim-key',
        },
      });

      const list = await env.SETUP_SESSION.list();
      expect(list.keys.length).toBe(0);
    });
  });

  describe('claim preserves existing installation_state (idempotent seed)', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      await seedInstallationState({ status: 'setup', currentStep: 'domain' });
    });

    it('preserves currentStep when installation_state already exists', async () => {
      await SELF.fetch('http://localhost/api/v1/setup/claim', {
        method: 'POST',
        body: JSON.stringify({ token: 'test-installation-token' }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-claim-key',
        },
      });

      // currentStep should still be 'domain', not 'preflight'
      const statusResponse = await SELF.fetch('http://localhost/api/v1/setup/status');
      expect(statusResponse.status).toBe(200);

      const statusBody = await statusResponse.json();
      expect(statusBody.data).toEqual({
        status: 'setup',
        currentStep: 'domain',
      });
    });
  });

  describe('response envelope shape', () => {
    beforeEach(resetAndMigrate);

    it('returns the success envelope { data: T }', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/claim', {
        method: 'POST',
        body: JSON.stringify({ token: 'test-installation-token' }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-claim-key',
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();

      // Envelope must have a `data` key.
      expect(body).toHaveProperty('data');
      // And no other top-level keys.
      expect(Object.keys(body)).toEqual(['data']);
    });

    it('error responses have { error: { code, message } } shape', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/claim', {
        method: 'POST',
        body: JSON.stringify({ token: 'wrong-token' }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-wrong-token-key',
        },
      });

      expect(response.status).toBe(401);
      const body = await response.json();

      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');
      expect(Object.keys(body)).toEqual(['error']);
    });
  });

  describe('setup gate exemption', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      await seedInstallationState({ status: 'setup', currentStep: 'claim' });
    });

    it('is NOT 302-redirected by the setup gate (exempt path)', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/claim', {
        method: 'POST',
        body: JSON.stringify({ token: 'test-installation-token' }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-claim-key',
        },
        redirect: 'manual',
      });

      // Should succeed, not redirect
      expect(response.status).toBe(200);
      expect(response.headers.get('Location')).toBeNull();
    });
  });

  describe('idempotency (CAP-027 / ADR-004)', () => {
    beforeEach(resetAndMigrate);

    it('returns 400 IDEMPOTENCY_KEY_REQUIRED when Idempotency-Key is missing', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/claim', {
        method: 'POST',
        body: JSON.stringify({ token: 'test-installation-token' }),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('deletes and re-executes on replay (Fix 1: secret-bearing endpoint)', async () => {
      const idempotencyKey = 'test-idempotency-key-abc123';

      const response1 = await SELF.fetch('http://localhost/api/v1/setup/claim', {
        method: 'POST',
        body: JSON.stringify({ token: 'test-installation-token' }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
      });

      expect(response1.status).toBe(200);
      const body1 = await response1.json();
      const sessionToken1 = body1.data.sessionToken;

      // Second request with same key + same body: claim endpoint is secret-bearing
      // (Fix 1), so it deletes the old record and re-executes, returning a fresh
      // session token.
      const response2 = await SELF.fetch('http://localhost/api/v1/setup/claim', {
        method: 'POST',
        body: JSON.stringify({ token: 'test-installation-token' }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
      });

      expect(response2.status).toBe(200);
      const body2 = await response2.json();
      // Each call gets a fresh session token (not replayed)
      expect(body2.data.sessionToken).not.toBe(sessionToken1);

      // Verify the old record was deleted and a new one written
      const record = await env.DB
        .prepare(
          `SELECT response_json FROM idempotency_records
           WHERE actor_id = ? AND operation = ? AND idempotency_key = ?`,
        )
        .bind(await sha256Hex('setup-session:test-installation-token'), 'POST /api/v1/setup/claim', idempotencyKey)
        .first<{ response_json: string }>();
      expect(record).toBeDefined();
      expect(record?.response_json).toContain('redacted');
    });

    // NOTE: IDEMPOTENCY_KEY_REUSED test is not applicable to /claim endpoint.
    // The only request field (token) determines the actorId for idempotency.
    // Changing the token changes the actorId, so the idempotency lookup fails
    // to find the previous record. This is tested on other endpoints where the
    // request body and actor identity are decoupled.
  });
});
