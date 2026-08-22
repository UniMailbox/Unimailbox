// setup-gate.worker.test.ts — R-SETUP-001 through R-SETUP-004.
//
// Worker-pool tests for the setup-gate middleware. Uses SELF.fetch to exercise
// the full request pipeline through the real entrypoint, router, and middleware.
//
// IMPORTANT: SELF.fetch follows redirects by default. Tests that assert a 302
// must pass { redirect: 'manual' } to observe the redirect response itself,
// not the response from the followed redirect target.
//
// CAP-039 — Deployment substrate: the SPA fallback now serves
// `apps/web/dist/index.html` for any non-API GET. /setup is still exempt
// from the gate, but the response is the SPA shell (200 HTML), not 404.
// Tests that previously asserted 404 for "/setup is exempt" now assert
// 200 HTML — that's a stronger proof the gate exempts the path.

import { describe, expect, it, beforeEach } from 'vitest';
import { SELF } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';

/** Reset without migrating — the installation_state table won't exist. */
async function resetWithoutMigrate() {
  const { reset } = await import('cloudflare:test');
  await reset();
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
      await seedInstallationState({ status: 'setup', currentStep: 'claim' });
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

    it('/setup is exempt — returns 200 HTML app shell (SPA fallback)', async () => {
      const response = await SELF.fetch('http://localhost/setup');
      // CAP-039: the SPA fallback now serves index.html for /setup
      // because the gate exempts it. The 200 HTML proves the path
      // bypassed the gate; the absence of Location proves it was not
      // redirected.
      expect(response.status).toBe(200);
      expect(response.headers.get('Location')).toBeNull();
      const ct = response.headers.get('Content-Type') ?? '';
      expect(ct).toMatch(/text\/html/);
    });

    it('/setup/anything is exempt — returns 200 HTML app shell (SPA fallback)', async () => {
      const response = await SELF.fetch('http://localhost/setup/dashboard');
      // Same as above — /setup/* is exempt and the SPA fallback serves
      // index.html for any path under it.
      expect(response.status).toBe(200);
      expect(response.headers.get('Location')).toBeNull();
      const ct = response.headers.get('Content-Type') ?? '';
      expect(ct).toMatch(/text\/html/);
    });

    // CAP-007 added GET /api/v1/setup/status — it now returns 200 instead of
    // 404. The test still proves the path is exempt (not redirected).
    it('/api/v1/setup/status is exempt — returns 200 (has handler)', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/status');
      expect(response.status).toBe(200);
      expect(response.headers.get('Location')).toBeNull();
    });

    it('/api/v1/setup/claim is exempt — returns 400 (validation error, not 404)', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/claim', { method: 'POST' });
      // Route exists now (added in CAP-008), so returns 400 for missing body
      // rather than 404. The important part is it's NOT 302 (exempt from gate).
      expect(response.status).toBe(400);
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
      await seedInstallationState({ status: 'complete', currentStep: 'complete' });
    });

    it('GET / does NOT redirect — returns 200 HTML app shell', async () => {
      const response = await SELF.fetch('http://localhost/');
      // CAP-039: the SPA fallback serves the real Vite-built
      // index.html now. The lowercase `<!doctype html>` is the live
      // bundle's exact text.
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('text/html');
      expect(response.headers.get('Location')).toBeNull();
      const text = await response.text();
      expect(text).toContain('<!doctype html>');
      expect(text).toContain('<title>Unimailbox</title>');
    });

    it('R-SETUP-003: /healthz returns 200', async () => {
      const response = await SELF.fetch('http://localhost/healthz');
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ ok: true, surface: 'router' });
    });

    it('/setup is still exempt — returns 200 HTML app shell (SPA fallback)', async () => {
      const response = await SELF.fetch('http://localhost/setup');
      // CAP-039: SPA fallback serves index.html for /setup now that
      // the hand-written HTML shell is gone.
      expect(response.status).toBe(200);
      expect(response.headers.get('Location')).toBeNull();
      const ct = response.headers.get('Content-Type') ?? '';
      expect(ct).toMatch(/text\/html/);
    });
  });

  describe('path exemption variations', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      await seedInstallationState({ status: 'setup', currentStep: 'claim' });
    });

    it('/setup/step1 is exempt (SPA fallback returns 200 HTML)', async () => {
      const response = await SELF.fetch('http://localhost/setup/step1');
      // CAP-039: SPA fallback serves index.html for any path under
      // /setup because the gate exempts the whole subtree.
      expect(response.status).toBe(200);
      expect(response.headers.get('Location')).toBeNull();
      const ct = response.headers.get('Content-Type') ?? '';
      expect(ct).toMatch(/text\/html/);
    });

    it('/api/v1/setup/preflight is exempt (401, not 302)', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-preflight-key',
        },
      });
      // The endpoint exists but requires session auth (401), not a 302 redirect.
      // A 302 would mean the setup gate redirected it.
      expect(response.status).toBe(401);
      expect(response.headers.get('Location')).toBeNull();
    });

    it('/api/v1/setup/cloudflare/verify is exempt (401, not 302)', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/cloudflare/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-verify-key',
        },
      });
      // The endpoint exists but requires session auth (401), not a 302 redirect.
      // A 302 would mean the setup gate redirected it.
      expect(response.status).toBe(401);
      expect(response.headers.get('Location')).toBeNull();
    });

    it('/api/v1/non-setup is NOT exempt — redirects', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/non-setup', {
        redirect: 'manual',
      });
      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('/setup');
    });

    it('exact /setup match is exempt (SPA fallback returns 200 HTML)', async () => {
      const response = await SELF.fetch('http://localhost/setup');
      expect(response.status).toBe(200);
      expect(response.headers.get('Location')).toBeNull();
      const ct = response.headers.get('Content-Type') ?? '';
      expect(ct).toMatch(/text\/html/);
    });

    it('/api/v1/setup with trailing slash is exempt (no such route → SPA fallback)', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/');
      // /api/v1/setup/ is matched by the apiV1 sub-app. Without a route
      // at the bare path, Hono returns 404 from inside the sub-app —
      // not the SPA fallback, which only mounts at GET * on the parent
      // router. The exempt-path check still holds: no Location header.
      expect(response.status).toBe(404);
      expect(response.headers.get('Location')).toBeNull();
    });
  });
});
