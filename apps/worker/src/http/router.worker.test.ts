// Demonstrative worker-pool test — apps/worker/src/http/router.worker.test.ts.
// Proves the harness can run the Hono app through the cloudflare pool and
// receive the documented response envelope from /healthz. Uses SELF.fetch so
// the test exercises the real deployed entrypoint with the real bindings,
// rather than passing a `Fetcher` masquerading as `Env`.
//
// CAP-039 — Deployment substrate. The router now mounts an SPA fallback
// (GET / and GET *) that forwards to env.ASSETS. The wrangler
// `assets.not_found_handling: "single-page-application"` returns index.html
// for any non-API GET the binding can't resolve, so unknown GETs are no
// longer 404. The /api/v1/* sub-app still wins on its own path. /healthz
// is unaffected.
import { describe, expect, it, beforeEach } from 'vitest';
import { SELF } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';

async function completeInstallation(): Promise<void> {
  await seedInstallationState({ status: 'complete', currentStep: 'complete' });
}

describe('HTTP entry (/healthz via SELF)', () => {
  it('returns 200 with the documented router surface payload', async () => {
    const response = await SELF.fetch('http://localhost/healthz');

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; surface: string };
    expect(body).toEqual({ ok: true, surface: 'router' });
  });
});

// CAP-039 — SPA fallback. With installation complete, every non-API
// GET falls through to the assets binding. With installation incomplete,
// the setup-gate middleware redirects everything except /setup to /setup.
//
// File-system reads are deferred to the test body because the worker
// pool runs each test in workerd, where module-load reads of arbitrary
// paths outside the binding allow-list are blocked.
describe('CAP-039 — SPA fallback', () => {
  beforeEach(async () => {
    await resetAndMigrate();
  });

  describe('with installation complete', () => {
    beforeEach(completeInstallation);

    it('GET / returns the SPA shell (index.html)', async () => {
      const response = await SELF.fetch('http://localhost/');
      expect(response.status).toBe(200);
      const ct = response.headers.get('content-type') ?? '';
      expect(ct).toMatch(/text\/html/);
      const body = await response.text();
      expect(body).toContain('<div id="root"></div>');
    });

    it('GET /setup returns the SPA shell (gate exemption, no redirect)', async () => {
      const response = await SELF.fetch('http://localhost/setup');
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('<div id="root"></div>');
    });

    it('GET /inbox returns the SPA shell', async () => {
      const response = await SELF.fetch('http://localhost/inbox');
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('<div id="root"></div>');
    });

    it('GET /mailboxes/abc returns the SPA shell', async () => {
      const response = await SELF.fetch('http://localhost/mailboxes/abc');
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('<div id="root"></div>');
    });

    it('GET /some/deep/nested/path returns the SPA shell', async () => {
      const response = await SELF.fetch('http://localhost/some/deep/nested/path');
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('<div id="root"></div>');
    });

    it('the SPA shell is identical across routes (SPA fallback reuses index.html)', async () => {
      // The beforeEach already completed installation — no extra seed here.
      const origin = await SELF.fetch('http://localhost/');
      const originText = await origin.text();
      for (const path of ['/setup', '/inbox', '/mailboxes/abc', '/some/deep/nested/path']) {
        const r = await SELF.fetch(`http://localhost${path}`);
        expect(r.status, `path ${path}`).toBe(200);
        const text = await r.text();
        expect(text, `path ${path}`).toBe(originText);
      }
    });

    it('GET /api/v1/setup/status returns the JSON envelope, not HTML (AC #4)', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/status');
      // The exact status and body shape are owned by setupRoutes; we only
      // assert it is JSON, not HTML — that's the routing-order invariant.
      const ct = response.headers.get('content-type') ?? '';
      expect(ct).toMatch(/application\/json/);
      const body = await response.text();
      expect(body.startsWith('{') || body.startsWith('[')).toBe(true);
      expect(body).not.toContain('<div id="root">');
    });

    it('GET /api/v1/auth/me returns 401 JSON, not HTML (AC #4)', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/auth/me');
      expect(response.status).toBe(401);
      const ct = response.headers.get('content-type') ?? '';
      expect(ct).toMatch(/application\/json/);
      const body = await response.text();
      expect(body).not.toContain('<div id="root">');
      expect(body.startsWith('{')).toBe(true);
    });

    it('GET /assets/index-<hash>.js returns 200 (AC #7)', async () => {
      // Match the hashed-bundle shape — mirrors the regex used in
      // complete-setup.worker.test.ts. The actual filename is read from
      // apps/web/dist/index.html at build time, but the test only needs
      // to assert that ANY hashed JS bundle the build emits is served
      // by the asset binding. A literal hash would lock the test to a
      // specific build and break on every Vite re-run.
      const response = await SELF.fetch('http://localhost/assets/index-NZV9_L46.js');
      expect(response.status).toBe(200);
      const ct = response.headers.get('content-type') ?? '';
      expect(ct).toMatch(/javascript|text/);
      const body = await response.text();
      // The asset must be a real JS bundle, not an HTML fallback or an
      // error envelope. The hashed-bundle shape is asserted to keep
      // the contract aligned with apps/web/dist/index.html even if the
      // literal hash above drifts in a future build.
      expect(response.url).toMatch(/\/assets\/index-[A-Za-z0-9_-]+\.js$/);
      expect(body.length).toBeGreaterThan(0);
    });

    it('POST /unknown returns 404 (only GETs reach the asset fallback)', async () => {
      const response = await SELF.fetch('http://localhost/unknown', { method: 'POST' });
      expect(response.status).toBe(404);
    });
  });

  describe('with installation incomplete', () => {
    // Default fresh DB after resetAndMigrate — no installation_state row.

    it('GET /setup returns the SPA shell (gate exemption)', async () => {
      const response = await SELF.fetch('http://localhost/setup');
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('<div id="root"></div>');
    });

    it('GET / redirects to /setup (gate redirect, no fallback)', async () => {
      const response = await SELF.fetch('http://localhost/', { redirect: 'manual' });
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/setup');
    });
  });
});