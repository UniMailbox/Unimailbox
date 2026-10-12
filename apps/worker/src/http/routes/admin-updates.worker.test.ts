import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { APPLICATION_VERSION, updateCheckResponseSchema } from '@unimailbox/contracts';
import { checkForUpdates, UPDATE_CACHE_KEY } from '../../platform/updates';
import type { Env } from '../../platform/env';
import { hashPassword } from '../../platform/crypto';

const now = Date.parse('2026-10-12T00:00:00Z');
const runtime = env as unknown as Env;
const release = {
  tag_name: `v${BigInt(APPLICATION_VERSION.split('.')[0] ?? '0') + 1n}.0.0`,
  published_at: new Date(now).toISOString(),
  draft: false,
  prerelease: false,
};
const BASE = 'http://localhost/api/v1/admin/updates';

beforeEach(async () => {
  await resetAndMigrate();
});
afterEach(() => vi.restoreAllMocks());

async function session(canRead: boolean): Promise<string> {
  const id = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const token = crypto.randomUUID();
  const password = await hashPassword('fixture-password');
  // Authentication only reads account status and the D1 session here; no login/password is exercised.
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, email, display_name, status, password_algorithm, password_iterations, password_salt, password_hash, created_at, updated_at) VALUES (?, ?, 'Fixture', 'active', ?, ?, ?, ?, datetime('now'), datetime('now'))",
    ).bind(
      id,
      `${id}@example.com`,
      password.algorithm,
      password.iterations,
      password.salt,
      password.hash,
    ),
    env.DB.prepare(
      "INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, created_at) VALUES (?, ?, ?, 2000000000, datetime('now'))",
    ).bind(sessionId, id, crypto.randomUUID()),
    env.DB.prepare(
      "INSERT OR IGNORE INTO permissions (id, key, description, created_at) VALUES ('settings.read', 'settings.read', 'Read', datetime('now'))",
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at) VALUES ('update-reader', 'update-reader', 'Fixture', 0, datetime('now'))",
    ),
    ...(canRead
      ? [
          env.DB.prepare(
            "INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES ('update-reader', 'settings.read', datetime('now'))",
          ),
          env.DB.prepare(
            "INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, 'update-reader', datetime('now'))",
          ).bind(id),
        ]
      : []),
  ]);
  await env.CACHE.put(`auth:${token}`, JSON.stringify({ userId: id, sessionId }), {
    expirationTtl: 900,
  });
  return token;
}

describe('update checks with real local KV and authentication', () => {
  it('R-AUTHZ-003 denies anonymous and users without settings.read before upstream access', async () => {
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });
    expect((await SELF.fetch(BASE)).status).toBe(401);
    const response = await SELF.fetch(BASE, {
      headers: { Authorization: `Bearer ${await session(false)}` },
    });
    expect(response.status).toBe(403);
    expect(await env.CACHE.get(UPDATE_CACHE_KEY)).toBeNull();
  });
  it('R-AUTHZ-003 allows settings.read and returns a private safe version projection', async () => {
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });
    await env.CACHE.put(
      UPDATE_CACHE_KEY,
      JSON.stringify({
        checkedAt: new Date(now).toISOString(),
        expiresAt: 4_000_000_000_000,
        unavailable: false,
        latest: { tag: release.tag_name, publishedAt: release.published_at },
      }),
    );
    const response = await SELF.fetch(BASE, {
      headers: { Authorization: `Bearer ${await session(true)}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json();
    expect(updateCheckResponseSchema.parse(body.data)).toMatchObject({
      current: { version: APPLICATION_VERSION },
      status: 'available',
    });
  });
  it('caches successful upstream checks for six hours and refreshes after expiry', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(release));
    expect((await checkForUpdates(runtime, fetchImpl, now)).status).toBe('available');
    await checkForUpdates(runtime, fetchImpl, now + 5 * 60 * 60_000);
    expect(fetchImpl).toHaveBeenCalledOnce();
    await checkForUpdates(runtime, fetchImpl, now + 6 * 60 * 60_000 + 1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('backs off failed checks and never reports a rate limit as current', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(null, { status: 429 }));
    expect((await checkForUpdates(runtime, fetchImpl, now)).status).toBe('unavailable');
    await checkForUpdates(runtime, fetchImpl, now + 14 * 60_000);
    expect(fetchImpl).toHaveBeenCalledOnce();
    await checkForUpdates(runtime, fetchImpl, now + 15 * 60_000 + 1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('reports no published release and equal base versions separately', async () => {
    const absent = await checkForUpdates(
      runtime,
      async () => new Response(null, { status: 404 }),
      now,
    );
    expect(absent.status).toBe('no_release');
    await env.CACHE.delete(UPDATE_CACHE_KEY);
    const same = await checkForUpdates(
      runtime,
      async () => Response.json({ ...release, tag_name: `v${APPLICATION_VERSION}` }),
      now,
    );
    expect(same.status).toBe('current');
  });
  it('disabling checks avoids all upstream access and ignores cached notices', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await env.CACHE.put(UPDATE_CACHE_KEY, 'invalid cache');
    expect(
      await checkForUpdates({ ...runtime, UPDATE_CHECK_ENABLED: 'false' }, fetchImpl, now),
    ).toMatchObject({ status: 'disabled', latest: null, checkedAt: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('recovers from malformed cache data', async () => {
    await env.CACHE.put(UPDATE_CACHE_KEY, JSON.stringify({ status: 'current' }));
    expect((await checkForUpdates(runtime, async () => Response.json(release), now)).status).toBe(
      'available',
    );
  });
});
