// setup-gate.worker.test.ts — R-SETUP-001 through R-SETUP-004.
//
// Worker-pool tests for the setup-gate middleware. Uses SELF.fetch to exercise
// the full request pipeline through the real entrypoint, router, and middleware.
//
// IMPORTANT: SELF.fetch follows redirects by default. Tests that assert a 302
// must pass { redirect: 'manual' } to observe the redirect response itself,
// not the response from the followed redirect target.

import { describe, expect, it, beforeEach } from 'vitest';
import { SELF } from 'cloudflare:test';
import { migrationsDb } from '@unimailbox/test-kit';

// Fixed timestamp — determinism rule (testing.md §Determinism).
const FIXED_TIMESTAMP = '2026-01-01 00:00:00';

async function resetAndMigrate() {
  const { reset } = await import('cloudflare:test');
  await reset();
  await migrationsDb();
}

/** Reset without migrating — the installation_state table won't exist. */
async function resetWithoutMigrate() {
  const { reset } = await import('cloudflare:test');
  await reset();
}

async function seedInstallationState(status: 'setup' | 'complete', currentStep: string) {
  const db = await migrationsDb();
  await db
    .prepare(
      `INSERT INTO installation_state (id, status, current_step, schema_version, updated_at, created_at)
       VALUES (1, ?, ?, 1, ?, ?)`,
    )
    .bind(status, currentStep, FIXED_TIMESTAMP, FIXED_TIMESTAMP)
    .run();
}

describe('setup-gate middleware', () => {
  describe('R-SETUP-002: fresh DB (no installation_state row)', () => {
    beforeEach(resetAndMigrate);

    it('redirects GET / to /setup with 302', async () => {
      const response = await SELF.fetch('http://localhost/', { redirect: 'manual' });
      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('/setup');
    });

    it('redirects GET /api/v1/messages to /setup with 302', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/messages', { redirect: 'manual' });
      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('/setup');
    });

    it('R-SETUP-003: /healthz returns 200 (exempt path)', async () => {
      const response = await SELF.fetch('http://localhost/healthz');
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ ok: true, surface: 'router' });
    });
  });

  describe('R-SETUP-001: status = setup (installation incomplete)', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      await seedInstallationState('setup', 'claim');
    });

    it('redirects GET / to /setup with 302', async () => {
      const response = await SELF.fetch('http://localhost/', { redirect: 'manual' });
      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('/setup');
    });

    it('redirects GET /api/v1/messages to /setup with 302', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/messages', { redirect: 'manual' });
      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('/setup');
    });

    it('R-SETUP-003: /healthz returns 200 (exempt path)', async () => {
      const response = await SELF.fetch('http://localhost/healthz');
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ ok: true, surface: 'router' });
    });

    it('/setup is exempt — returns 404 (no handler yet, not 302)', async () => {
      const response = await SELF.fetch('http://localhost/setup');
      expect(response.status).toBe(404);
      expect(response.headers.get('Location')).toBeNull();
    });

    it('/setup/anything is exempt — returns 404', async () => {
      const response = await SELF.fetch('http://localhost/setup/dashboard');
      expect(response.status).toBe(404);
      expect(response.headers.get('Location')).toBeNull();
    });

    it('/api/v1/setup/status is exempt — returns 404', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/status');
      expect(response.status).toBe(404);
      expect(response.headers.get('Location')).toBeNull();
    });

    it('/api/v1/setup/claim is exempt — returns 404', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/claim', { method: 'POST' });
      expect(response.status).toBe(404);
      expect(response.headers.get('Location')).toBeNull();
    });
  });

  describe('R-SETUP-004: DB query failure (fail-closed)', () => {
    beforeEach(resetWithoutMigrate);

    it('redirects to /setup when installation_state table does not exist', async () => {
      // No migrations applied — the table is absent, so the query throws.
      // The middleware catches it and redirects (fail-closed).
      const response = await SELF.fetch('http://localhost/', { redirect: 'manual' });
      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('/setup');
    });
  });

  describe('status = complete (installation complete)', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      await seedInstallationState('complete', 'complete');
    });

    it('GET / does NOT redirect — falls through to normal router (404)', async () => {
      const response = await SELF.fetch('http://localhost/');
      expect(response.status).toBe(404);
      expect(response.headers.get('Location')).toBeNull();
    });

    it('R-SETUP-003: /healthz returns 200', async () => {
      const response = await SELF.fetch('http://localhost/healthz');
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ ok: true, surface: 'router' });
    });

    it('/setup is still exempt — returns 404', async () => {
      const response = await SELF.fetch('http://localhost/setup');
      expect(response.status).toBe(404);
      expect(response.headers.get('Location')).toBeNull();
    });
  });

  describe('path exemption variations', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      await seedInstallationState('setup', 'claim');
    });

    it('/setup/step1 is exempt', async () => {
      const response = await SELF.fetch('http://localhost/setup/step1');
      expect(response.status).toBe(404);
      expect(response.headers.get('Location')).toBeNull();
    });

    it('/api/v1/setup/preflight is exempt', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/preflight', { method: 'POST' });
      expect(response.status).toBe(404);
      expect(response.headers.get('Location')).toBeNull();
    });

    it('/api/v1/setup/cloudflare/verify is exempt', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/cloudflare/verify', { method: 'POST' });
      expect(response.status).toBe(404);
      expect(response.headers.get('Location')).toBeNull();
    });

    it('/api/v1/non-setup is NOT exempt — redirects', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/non-setup', { redirect: 'manual' });
      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('/setup');
    });

    it('exact /setup match is exempt', async () => {
      const response = await SELF.fetch('http://localhost/setup');
      expect(response.status).toBe(404);
      expect(response.headers.get('Location')).toBeNull();
    });

    it('/api/v1/setup with trailing slash is exempt', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/');
      expect(response.status).toBe(404);
      expect(response.headers.get('Location')).toBeNull();
    });
  });
});
