import { beforeEach, expect, it, vi } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import { Hono } from 'hono';
import {
  resetAndMigrate,
  seedInstallationState,
  seedQueryPerformanceFixture,
} from '@unimailbox/test-kit';
import { app } from '../../entrypoints/http';
import { authn } from './authn';
import type { AppEnv } from '../../platform/env';
import { findAuthenticatedPrincipal } from '../../modules/identity';

let f: Awaited<ReturnType<typeof seedQueryPerformanceFixture>>;
beforeEach(async () => {
  await resetAndMigrate();
  await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  f = await seedQueryPerformanceFixture(1);
  await env.CACHE.put(
    'auth:synthetic-query-token',
    JSON.stringify({ userId: f.ownerId, sessionId: f.sessionId }),
  );
});
const request = () =>
  new Request('http://localhost/api/v1/auth/me', {
    headers: { Authorization: 'Bearer synthetic-query-token' },
  });
it('R-AUTH-005: /me reuses one joined D1 identity read and never projects credential columns', async () => {
  const prepare = vi.spyOn(env.DB, 'prepare');
  try {
    const response = await app.fetch(request(), env, createExecutionContext());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { user: { id: f.ownerId, email: 'owner@example.test' } },
    });
    const reads = prepare.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => sql.includes('FROM sessions') || sql.includes('FROM users'));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toContain('JOIN users');
    expect(reads[0]).not.toMatch(/refresh_token_hash|password_hash|password_salt/);
  } finally {
    prepare.mockRestore();
  }
});
it.each(['revoked', 'expired', 'banned', 'deleted', 'wrong-owner'] as const)(
  'R-AUTH-005: a subsequent request rejects %s state despite the same KV token',
  async (kind) => {
    expect((await app.fetch(request(), env, createExecutionContext())).status).toBe(200);
    if (kind === 'revoked')
      await env.DB.prepare("UPDATE sessions SET revoked_at='2026-01-01' WHERE id=?")
        .bind(f.sessionId)
        .run();
    if (kind === 'expired')
      await env.DB.prepare('UPDATE sessions SET expires_at=0 WHERE id=?').bind(f.sessionId).run();
    if (kind === 'banned' || kind === 'deleted')
      await env.DB.prepare('UPDATE users SET status=? WHERE id=?').bind(kind, f.ownerId).run();
    if (kind === 'wrong-owner')
      await env.CACHE.put(
        'auth:synthetic-query-token',
        JSON.stringify({ userId: 'foreign-owner', sessionId: f.sessionId }),
      );
    expect((await app.fetch(request(), env, createExecutionContext())).status).toBe(401);
  },
);
it('R-AUTH-005: exact expiry denies and the forced-password-change flag survives the projection', async () => {
  expect(await findAuthenticatedPrincipal(env.DB, f.sessionId, f.ownerId, 2000000000)).toBeNull();
  await env.DB.prepare('UPDATE users SET must_change_password=1 WHERE id=?').bind(f.ownerId).run();
  const router = new Hono<AppEnv>();
  router.use('*', authn);
  router.get('/', (c) => c.json(c.get('principal')));
  const response = await router.fetch(
    new Request('http://localhost/', {
      headers: { Authorization: 'Bearer synthetic-query-token' },
    }),
    env,
    createExecutionContext(),
  );
  expect(await response.json()).toEqual({
    userId: f.ownerId,
    sessionId: f.sessionId,
    email: 'owner@example.test',
    displayName: 'owner',
    mustChangePassword: true,
  });
});
