// Demonstrative worker-pool test — apps/worker/src/platform/cache.test.ts.
// Proves the harness can talk to a real KV binding via the cloudflare pool.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getCache } from './cache';
import type { Env } from './env';

describe('KV binding (worker pool)', () => {
  it('round-trips a value through put/get', async () => {
    // `cloudflare:test` exposes a generic Cloudflare.Env; the worker's own
    // Env type (from wrangler.jsonc) is the right shape at runtime. The
    // pool binds env from wrangler.jsonc, so the cast is safe.
    const cache = getCache(env as unknown as Env);
    const key = `CAP-002:cache`;

    await cache.put(key, 'hello');
    const got = await cache.get(key);

    expect(got).toBe('hello');

    await cache.delete(key);
  });

  it('returns null for an absent key', async () => {
    const cache = getCache(env as unknown as Env);
    const got = await cache.get('CAP-002:cache:definitely-missing');
    expect(got).toBeNull();
  });

  it('returns the same handle for repeated calls', () => {
    const a = getCache(env as unknown as Env);
    const b = getCache(env as unknown as Env);
    expect(a).toBe(b);
  });
});