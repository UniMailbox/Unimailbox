// Demonstrative worker-pool test — apps/worker/src/platform/database.test.ts.
// Proves the harness can talk to a real D1 binding via the cloudflare pool.
// Per .claude/rules/testing.md §Mocking: never mock D1 — this is the whole
// point of the worker project.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getDatabase } from './database';
import type { Env } from './env';

describe('D1 binding (worker pool)', () => {
  it('returns a handle that can execute a trivial SELECT', async () => {
    // `cloudflare:test` exposes a generic Cloudflare.Env; the worker's own
    // Env type (from wrangler.jsonc) is the right shape at runtime. The
    // pool binds env from wrangler.jsonc, so the cast is safe.
    const db = getDatabase(env as unknown as Env);
    const result = await db.prepare('SELECT 1 AS n').first<{ n: number }>();

    expect(result).not.toBeNull();
    expect(result?.n).toBe(1);
  });

  it('returns the same handle for repeated calls (binding identity is stable)', () => {
    const a = getDatabase(env as unknown as Env);
    const b = getDatabase(env as unknown as Env);
    expect(a).toBe(b);
  });

  it('exposes a prepare().all() result over multiple rows', async () => {
    const db = getDatabase(env as unknown as Env);
    const result = await db
      .prepare('SELECT 1 AS a UNION ALL SELECT 2 AS a UNION ALL SELECT 3 AS a')
      .all<{ a: number }>();

    expect(result.results.map((row) => row.a)).toEqual([1, 2, 3]);
  });
});