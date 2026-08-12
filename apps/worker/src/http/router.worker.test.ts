// Demonstrative worker-pool test — apps/worker/src/http/router.worker.test.ts.
// Proves the harness can run the Hono app through the cloudflare pool and
// receive the documented response envelope from /healthz. Uses SELF.fetch so
// the test exercises the real deployed entrypoint with the real bindings,
// rather than passing a `Fetcher` masquerading as `Env`.
import { describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';

describe('HTTP entry (/healthz via SELF)', () => {
  it('returns 200 with the documented router surface payload', async () => {
    const response = await SELF.fetch('http://localhost/healthz');

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; surface: string };
    expect(body).toEqual({ ok: true, surface: 'router' });
  });

  it('returns 404 for an unknown route', async () => {
    const response = await SELF.fetch('http://localhost/this-does-not-exist');
    expect(response.status).toBe(404);
  });
});
