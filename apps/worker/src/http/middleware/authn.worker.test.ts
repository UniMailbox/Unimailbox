// apps/worker/src/http/middleware/authn.worker.test.ts — CAP-042 (AC 13, 14).
//
// Worker-pool tests for the authn middleware's two CAP-042 surfaces:
// the cookie → userId bridge (AC 13) and the conflicting-principal
// detector (AC 14).
//
// AC 13: a Better Auth session cookie alone (no Bearer) must satisfy
// `requirePermission`. We exercise it via the legacy `/api/v1/auth/me`
// route — that route reads `c.get('userId')` and rejects with
// AUTHENTICATION_REQUIRED if the value is missing. The test proves
// the cookie path sets the variable exactly the same way the legacy
// Bearer path does.
//
// AC 14: when both a Bearer token AND a Better Auth cookie resolve
// to *different* user IDs, the request must fail with 401 and the
// stable `CONFLICTING_PRINCIPALS` error code. Same principals → no
// conflict (idempotent). One principal only → no conflict. The
// error code is the same one Better Auth's audit pipeline
// recognises so future audit-log aggregation does not need to
// special-case it.
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';

import { betterAuthPassword } from '../../integrations/better-auth/password';
import { BETTER_AUTH_BASE_PATH, BETTER_AUTH_COOKIE_NAME } from '../../integrations/better-auth/path';

const COOKIE_USER_ID = '00000000-0000-4000-8000-00000000ba13';
const COOKIE_USER_EMAIL = 'cap042-ac13-cookie@example.test';
const COOKIE_PASSWORD = 'cap042-ac13-cookie-password';
const COOKIE_DISPLAY_NAME = 'AC-13 Cookie User';

const BEARER_USER_ID = '00000000-0000-4000-8000-00000000ba14';
const BEARER_USER_EMAIL = 'cap042-ac14-bearer@example.test';
const BEARER_PASSWORD = 'cap042-ac14-bearer-password';
const BEARER_DISPLAY_NAME = 'AC-14 Bearer User';

const BEARER_TOKEN = 'test-bearer-token-for-ac14';

const NOW_MS = Date.UTC(2026, 7, 23, 0, 0, 0);

async function hashTestPassword(password: string): Promise<string> {
  const fn = betterAuthPassword.hash;
  if (typeof fn !== 'function') throw new Error('betterAuthPassword.hash missing');
  return fn(password);
}

/**
 * Seed two canonical users + matching Better Auth credential accounts.
 * Mirrors `better-auth.worker.test.ts` so the cookie path can resolve
 * either user without coupling the AC 13/14 tests to the AC 12 suite.
 */
async function seedTwoUsers(): Promise<void> {
  const cookieEnvelope = await hashTestPassword(COOKIE_PASSWORD);
  const bearerEnvelope = await hashTestPassword(BEARER_PASSWORD);

  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO users (
           id, email, display_name, email_verified, status,
           password_algorithm, password_iterations, password_salt, password_hash,
           created_at, updated_at
         ) VALUES (?, ?, ?, 0, 'active', 'pbkdf2-sha256', 600000, ?, ?, ?, ?)`,
      )
      .bind(
        COOKIE_USER_ID,
        COOKIE_USER_EMAIL,
        COOKIE_DISPLAY_NAME,
        new Uint8Array(16),
        new Uint8Array(32),
        new Date(NOW_MS).toISOString().replace('T', ' ').replace('Z', ''),
        new Date(NOW_MS).toISOString().replace('T', ' ').replace('Z', ''),
      ),
    env.DB
      .prepare(
        `INSERT INTO auth_accounts (
           id, issuer, account_id, provider_id, user_id, password,
           created_at, updated_at
         ) VALUES (?, 'local:credential', ?, 'credential', ?, ?, ?, ?)`,
      )
      .bind('ac13-account', COOKIE_USER_ID, COOKIE_USER_ID, cookieEnvelope, NOW_MS, NOW_MS),
    env.DB
      .prepare(
        `INSERT INTO users (
           id, email, display_name, email_verified, status,
           password_algorithm, password_iterations, password_salt, password_hash,
           created_at, updated_at
         ) VALUES (?, ?, ?, 0, 'active', 'pbkdf2-sha256', 600000, ?, ?, ?, ?)`,
      )
      .bind(
        BEARER_USER_ID,
        BEARER_USER_EMAIL,
        BEARER_DISPLAY_NAME,
        new Uint8Array(16),
        new Uint8Array(32),
        new Date(NOW_MS).toISOString().replace('T', ' ').replace('Z', ''),
        new Date(NOW_MS).toISOString().replace('T', ' ').replace('Z', ''),
      ),
    env.DB
      .prepare(
        `INSERT INTO auth_accounts (
           id, issuer, account_id, provider_id, user_id, password,
           created_at, updated_at
         ) VALUES (?, 'local:credential', ?, 'credential', ?, ?, ?, ?)`,
      )
      .bind('ac14-account', BEARER_USER_ID, BEARER_USER_ID, bearerEnvelope, NOW_MS, NOW_MS),
  ]);
}

/** Sign in via Better Auth and return the raw cookie header (`name=value`). */
async function signInAndGetCookie(email: string, password: string): Promise<string> {
  const response = await SELF.fetch(
    `http://localhost${BETTER_AUTH_BASE_PATH}/sign-in/email`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    },
  );
  expect(response.status).toBe(200);
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) throw new Error('sign-in missing set-cookie');
  const cookieHeader = setCookie.split(';')[0]?.trim();
  if (!cookieHeader) throw new Error('sign-in returned empty cookie');
  return cookieHeader;
}

describe('CAP-042 AC 13 — Better Auth cookie → userId bridge', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });
    await seedTwoUsers();
  });

  it('a Better Auth cookie alone lets the cookie-principal reach a requirePermission route', async () => {
    const cookie = await signInAndGetCookie(COOKIE_USER_EMAIL, COOKIE_PASSWORD);
    const response = await SELF.fetch('http://localhost/api/v1/auth/me', {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data?: { user?: { id?: unknown; email?: unknown; displayName?: unknown } };
    };
    expect(body.data?.user?.id).toBe(COOKIE_USER_ID);
    expect(body.data?.user?.email).toBe(COOKIE_USER_EMAIL);
    expect(body.data?.user?.displayName).toBe(COOKIE_DISPLAY_NAME);
  });

  it('an expired or unknown Better Auth cookie falls back to 401 (no silent principal)', async () => {
    const fakeCookie = `${BETTER_AUTH_COOKIE_NAME}=not-a-real-session-token`;
    const response = await SELF.fetch('http://localhost/api/v1/auth/me', {
      headers: { Cookie: fakeCookie },
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: { code?: unknown } };
    expect(body.error?.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('a Bearer-only request still resolves the userId (no regression on CAP-019)', async () => {
    await env.CACHE.put(`auth:${BEARER_TOKEN}`, JSON.stringify({ userId: BEARER_USER_ID }));
    const response = await SELF.fetch('http://localhost/api/v1/auth/me', {
      headers: { Authorization: `Bearer ${BEARER_TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data?: { user?: { id?: unknown; email?: unknown } };
    };
    expect(body.data?.user?.id).toBe(BEARER_USER_ID);
    expect(body.data?.user?.email).toBe(BEARER_USER_EMAIL);
  });
});

describe('CAP-042 AC 14 — conflicting principals', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });
    await seedTwoUsers();
  });

  it('a Bearer for user A and a Better Auth cookie for user B return 401 CONFLICTING_PRINCIPALS', async () => {
    await env.CACHE.put(`auth:${BEARER_TOKEN}`, JSON.stringify({ userId: BEARER_USER_ID }));
    const cookie = await signInAndGetCookie(COOKIE_USER_EMAIL, COOKIE_PASSWORD);

    const response = await SELF.fetch('http://localhost/api/v1/auth/me', {
      headers: {
        Authorization: `Bearer ${BEARER_TOKEN}`,
        Cookie: cookie,
      },
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
    expect(body.error?.code).toBe('CONFLICTING_PRINCIPALS');
    // R-SECRET-003: the error message must not leak which principal
    // resolved to which user. We assert only on the stable code; the
    // message is a human-readable hint and may vary.
    expect(typeof body.error?.message).toBe('string');
  });

  it('matching Bearer and Better Auth cookie (same user) does NOT trigger the conflict branch', async () => {
    // Plant the Bearer token for the same user that will sign in via
    // Better Auth — proves the conflict detector only fires on a real
    // disagreement.
    await env.CACHE.put(`auth:${BEARER_TOKEN}`, JSON.stringify({ userId: COOKIE_USER_ID }));
    const cookie = await signInAndGetCookie(COOKIE_USER_EMAIL, COOKIE_PASSWORD);

    const response = await SELF.fetch('http://localhost/api/v1/auth/me', {
      headers: {
        Authorization: `Bearer ${BEARER_TOKEN}`,
        Cookie: cookie,
      },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data?: { user?: { id?: unknown } };
    };
    expect(body.data?.user?.id).toBe(COOKIE_USER_ID);
  });

  it('Bearer only OR cookie only never raises CONFLICTING_PRINCIPALS', async () => {
    // Cookie only — covered by AC 13 above, but assert the error
    // code here too so a future regression that introduces a stray
    // conflict branch surfaces with a single failing test.
    const cookie = await signInAndGetCookie(COOKIE_USER_EMAIL, COOKIE_PASSWORD);
    const cookieOnly = await SELF.fetch('http://localhost/api/v1/auth/me', {
      headers: { Cookie: cookie },
    });
    expect(cookieOnly.status).toBe(200);

    // Bearer only — also covered above, repeated here so the test
    // name (`never raises CONFLICTING_PRINCIPALS`) reflects what
    // we actually prove.
    await env.CACHE.put(`auth:${BEARER_TOKEN}`, JSON.stringify({ userId: BEARER_USER_ID }));
    const bearerOnly = await SELF.fetch('http://localhost/api/v1/auth/me', {
      headers: { Authorization: `Bearer ${BEARER_TOKEN}` },
    });
    expect(bearerOnly.status).toBe(200);
  });
});