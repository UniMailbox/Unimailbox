// setup-status.worker.test.ts — GET /api/v1/setup/status.
//
// Worker-pool tests for the setup status endpoint. Uses SELF.fetch to exercise
// the full request pipeline through the real entrypoint, router, and middleware.
//
// Tests cover:
// - Fresh DB (no installation_state row) → { status: 'setup', currentStep: 'claim' }
// - Seeded states at each step → returns the seeded state
// - Response envelope shape { data: ... }
// - Content-Type header
// - The endpoint is NOT 302'd by the setup gate (exempt path)

import { describe, expect, it, beforeEach } from 'vitest';
import { SELF } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';

describe('GET /api/v1/setup/status', () => {
  describe('fresh DB (no installation_state row)', () => {
    beforeEach(resetAndMigrate);

    it('returns 200 with { status: "setup", currentStep: "claim" }', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/status');

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json\b/);

      const body = await response.json();
      expect(body).toEqual({
        data: {
          status: 'setup',
          currentStep: 'claim',
        },
      });
    });

    it('is NOT 302-redirected by the setup gate (exempt path)', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/status', {
        redirect: 'manual',
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Location')).toBeNull();
    });
  });

  describe('installation_state with status=setup, current_step=claim', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      await seedInstallationState({ status: 'setup', currentStep: 'claim' });
    });

    it('returns 200 with { status: "setup", currentStep: "claim" }', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/status');

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json\b/);

      const body = await response.json();
      expect(body).toEqual({
        data: {
          status: 'setup',
          currentStep: 'claim',
        },
      });
    });

    it('is NOT 302-redirected by the setup gate (exempt path)', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/status', {
        redirect: 'manual',
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Location')).toBeNull();
    });
  });

  describe('installation_state with status=setup, current_step=domain', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      await seedInstallationState({ status: 'setup', currentStep: 'domain' });
    });

    it('returns 200 with { status: "setup", currentStep: "domain" }', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/status');

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json\b/);

      const body = await response.json();
      expect(body).toEqual({
        data: {
          status: 'setup',
          currentStep: 'domain',
        },
      });
    });

    it('is NOT 302-redirected by the setup gate (exempt path)', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/status', {
        redirect: 'manual',
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Location')).toBeNull();
    });
  });

  describe('installation_state with status=complete, current_step=complete', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      await seedInstallationState({ status: 'complete', currentStep: 'complete' });
    });

    it('returns 200 with { status: "complete", currentStep: "complete" }', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/status');

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json\b/);

      const body = await response.json();
      expect(body).toEqual({
        data: {
          status: 'complete',
          currentStep: 'complete',
        },
      });
    });

    it('is NOT 302-redirected by the setup gate (exempt path)', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/status', {
        redirect: 'manual',
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Location')).toBeNull();
    });
  });

  describe('response envelope shape', () => {
    beforeEach(resetAndMigrate);

    it('returns the success envelope { data: T }', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/status');

      expect(response.status).toBe(200);
      const body = await response.json();

      // Envelope must have a `data` key.
      expect(body).toHaveProperty('data');
      // And no other top-level keys.
      expect(Object.keys(body)).toEqual(['data']);
    });
  });
});
