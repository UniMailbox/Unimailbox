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

import { describe, expect, it, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';

describe('POST /api/v1/setup/claim', () => {
  describe('correct token, fresh DB', () => {
    beforeEach(resetAndMigrate);

    it('returns 200 with sessionToken and expiresIn', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/claim', {
        method: 'POST',
        body: JSON.stringify({ token: 'test-installation-token' }),
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
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
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
        redirect: 'manual',
      });

      // Should succeed, not redirect
      expect(response.status).toBe(200);
      expect(response.headers.get('Location')).toBeNull();
    });
  });
});
