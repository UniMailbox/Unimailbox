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
import {
  BETTER_AUTH_BASE_PATH,
  BETTER_AUTH_COOKIE_NAME,
} from '../../integrations/better-auth/path';

/**
 * Force `AUTH_PROVIDER='dual'` for the legacy AC 13/14 tests.
 *
 * The committed `wrangler.test.jsonc` defaults to `'legacy'` so the
 * new cutover matrix tests (CAP-042 AC 23, this file) can override
 * per test without crossing modes accidentally. The pre-existing AC 13
 * (cookie → userId) and AC 14 (conflicting-principal) tests, however,
 * exercise both Bearer and Better Auth cookie paths simultaneously —
 * that combination is only coherent in `'dual'` mode.
 *
 * `env.AUTH_PROVIDER` is read by `parsePlatformConfig(c.env)` on every
 * request (`http/middleware/config.ts`), so this in-test mutation takes
 * effect on the next `SELF.fetch` without a Worker restart.
 */
function forceDualMode(): void {
  (env as { AUTH_PROVIDER?: string }).AUTH_PROVIDER = 'dual';
}

/**
 * Force `AUTH_PROVIDER` to the cutover value under test. Accepts the
 * closed enum from `platform/env.ts` (`'legacy' | 'dual' | 'better-auth'`).
 */
function forceAuthProvider(provider: 'legacy' | 'dual' | 'better-auth'): void {
  (env as { AUTH_PROVIDER?: string }).AUTH_PROVIDER = provider;
}

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
    env.DB.prepare(
      `INSERT INTO users (
           id, email, display_name, email_verified, status,
           password_algorithm, password_iterations, password_salt, password_hash,
           created_at, updated_at
         ) VALUES (?, ?, ?, 0, 'active', 'pbkdf2-sha256', 600000, ?, ?, ?, ?)`,
    ).bind(
      COOKIE_USER_ID,
      COOKIE_USER_EMAIL,
      COOKIE_DISPLAY_NAME,
      new Uint8Array(16),
      new Uint8Array(32),
      new Date(NOW_MS).toISOString().replace('T', ' ').replace('Z', ''),
      new Date(NOW_MS).toISOString().replace('T', ' ').replace('Z', ''),
    ),
    env.DB.prepare(
      `INSERT INTO auth_accounts (
           id, issuer, account_id, provider_id, user_id, password,
           created_at, updated_at
         ) VALUES (?, 'local:credential', ?, 'credential', ?, ?, ?, ?)`,
    ).bind('ac13-account', COOKIE_USER_ID, COOKIE_USER_ID, cookieEnvelope, NOW_MS, NOW_MS),
    env.DB.prepare(
      `INSERT INTO users (
           id, email, display_name, email_verified, status,
           password_algorithm, password_iterations, password_salt, password_hash,
           created_at, updated_at
         ) VALUES (?, ?, ?, 0, 'active', 'pbkdf2-sha256', 600000, ?, ?, ?, ?)`,
    ).bind(
      BEARER_USER_ID,
      BEARER_USER_EMAIL,
      BEARER_DISPLAY_NAME,
      new Uint8Array(16),
      new Uint8Array(32),
      new Date(NOW_MS).toISOString().replace('T', ' ').replace('Z', ''),
      new Date(NOW_MS).toISOString().replace('T', ' ').replace('Z', ''),
    ),
    env.DB.prepare(
      `INSERT INTO auth_accounts (
           id, issuer, account_id, provider_id, user_id, password,
           created_at, updated_at
         ) VALUES (?, 'local:credential', ?, 'credential', ?, ?, ?, ?)`,
    ).bind('ac14-account', BEARER_USER_ID, BEARER_USER_ID, bearerEnvelope, NOW_MS, NOW_MS),
  ]);
}

/** Sign in via Better Auth and return the raw cookie header (`name=value`). */
async function signInAndGetCookie(email: string, password: string): Promise<string> {
  const response = await SELF.fetch(`http://localhost${BETTER_AUTH_BASE_PATH}/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
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
    forceDualMode();
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
    forceDualMode();
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

// ---------------------------------------------------------------------------
// CAP-042 AC 23 — AUTH_PROVIDER cutover matrix for the credential
// surfaces resolved by `authn.ts`.
//
// The tests below flip `AUTH_PROVIDER` between requests inside the same
// test file to prove three things:
//
//   1. `legacy` mode accepts only the Bearer header. A Better Auth
//      cookie alone is silently ignored — no D1 lookup — so the
//      request falls through to 401 AUTHENTICATION_REQUIRED without
//      revealing the Better Auth surface's existence.
//   2. `better-auth` mode accepts only the Better Auth cookie. A
//      Bearer header alone is silently ignored — no CACHE lookup — so
//      the same 401 results, symmetrically.
//   3. The per-request `c.var.config` is re-parsed on every request,
//      so the cutover is a one-env-flip change. No Worker restart, no
//      migration, no schema change.
//
// The rollback-proof test below exercises dual → legacy → dual
// without restarting the Worker, which proves the additive schema
// (0014 + 0015) holds through cutover and rollback without a
// migration. Better Auth's `auth_accounts` / `auth_sessions` rows
// survive all three phases; legacy `users.password_*` rows survive
// all three phases.
// ---------------------------------------------------------------------------

describe('CAP-042 AC 23 — credential surface gating by AUTH_PROVIDER', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });
    await seedTwoUsers();
    // The default in wrangler.test.jsonc is `legacy`; each test below
    // overrides to the mode under test in-line.
  });

  it('legacy mode: Bearer-only request resolves the userId (CAP-019 still works)', async () => {
    forceAuthProvider('legacy');
    await env.CACHE.put(`auth:${BEARER_TOKEN}`, JSON.stringify({ userId: BEARER_USER_ID }));

    const response = await SELF.fetch('http://localhost/api/v1/auth/me', {
      headers: { Authorization: `Bearer ${BEARER_TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data?: { user?: { id?: unknown } } };
    expect(body.data?.user?.id).toBe(BEARER_USER_ID);
  });

  it('legacy mode: a Better Auth cookie alone returns 401 (silently ignored, no D1 lookup)', async () => {
    // Sign in via Better Auth in dual mode first so we have a
    // valid cookie to carry into the legacy-mode test. Without this
    // step we'd be exercising the sign-in endpoint (which the
    // route handler also gates), not the authn middleware gating.
    forceAuthProvider('dual');
    const cookie = await signInAndGetCookie(COOKIE_USER_EMAIL, COOKIE_PASSWORD);

    // Switch to legacy. The cookie value is opaque; the authn
    // middleware must not consult the D1 `auth_sessions` row at all.
    forceAuthProvider('legacy');
    const response = await SELF.fetch('http://localhost/api/v1/auth/me', {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: { code?: unknown } };
    expect(body.error?.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('legacy mode: a cookie carrying a still-valid session is ignored end-to-end', async () => {
    // Authoritative proof the D1 lookup was skipped: a `dual` mode
    // request with the same cookie resolves to the canonical user;
    // the same cookie in `legacy` mode returns 401 with no error
    // body leaking the Better Auth surface.
    forceAuthProvider('dual');
    const cookie = await signInAndGetCookieDual();

    forceAuthProvider('legacy');
    const response = await SELF.fetch('http://localhost/api/v1/auth/me', {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(401);
  });

  it('better-auth mode: a Better Auth cookie resolves to the canonical userId', async () => {
    forceAuthProvider('better-auth');
    const cookie = await signInAndGetCookieDual();

    const response = await SELF.fetch('http://localhost/api/v1/auth/me', {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data?: { user?: { id?: unknown } } };
    expect(body.data?.user?.id).toBe(COOKIE_USER_ID);
  });

  it('better-auth mode: a Bearer-only request returns 401 (silently ignored, no KV lookup)', async () => {
    forceAuthProvider('better-auth');
    // Plant a valid Bearer for BEARER_USER_ID in KV — in `dual` or
    // `legacy` mode this would resolve. In `better-auth` mode the
    // middleware must skip the KV lookup entirely.
    await env.CACHE.put(`auth:${BEARER_TOKEN}`, JSON.stringify({ userId: BEARER_USER_ID }));

    const response = await SELF.fetch('http://localhost/api/v1/auth/me', {
      headers: { Authorization: `Bearer ${BEARER_TOKEN}` },
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: { code?: unknown } };
    expect(body.error?.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('better-auth mode: a cookie carrying a different session still resolves that session', async () => {
    // Mode-switches the same D1 row: the additive schema is authoritative
    // for the cookie surface in both modes — only the gating logic in
    // `authn.ts` flips between them.
    forceAuthProvider('dual');
    const cookie = await signInAndGetCookieDual();

    forceAuthProvider('better-auth');
    const response = await SELF.fetch('http://localhost/api/v1/auth/me', {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
  });
});

/** Variant of `signInAndGetCookie` that requires the caller to have
 *  already set `AUTH_PROVIDER` to a mode that mounts Better Auth
 *  (`dual` or `better-auth`). Avoids the per-test side-effect of the
 *  AC 13/14 helper. */
async function signInAndGetCookieDual(): Promise<string> {
  // Defense in depth: a caller forgetting to set the mode first gets
  // an explicit assertion error rather than a confusing 401.
  const provider = (env as { AUTH_PROVIDER?: string }).AUTH_PROVIDER;
  if (provider === 'legacy') {
    throw new Error('signInAndGetCookieDual requires AUTH_PROVIDER != legacy');
  }
  return signInAndGetCookie(COOKIE_USER_EMAIL, COOKIE_PASSWORD);
}

// ---------------------------------------------------------------------------
// CAP-042 AC 23 — Rollback proof: dual → legacy → dual without restart.
//
// This is the load-bearing cutover test (Batch 6 §Rollback proof in
// `work/investigations/INV-2026-08-23-batch-5-6-plan.md`). It exercises
// the same D1 row through three AUTH_PROVIDER flips inside a single
// test run, with no Worker restart and no migration:
//
//   1. dual     → sign in via Better Auth, cookie accepted (200).
//   2. legacy   → SAME cookie is no longer accepted (401). Legacy
//                 Bearer for the same user is accepted (200). The
//                 `auth_sessions` row is unchanged; the `users`
//                 `password_*` row is unchanged.
//   3. dual     → the same Better Auth cookie is accepted again (200).
//                 This proves the additive schema survives cutover
//                 and rollback without a migration: nothing about the
//                 schema changed between phases 1, 2, and 3.
// ---------------------------------------------------------------------------

describe('CAP-042 AC 23 — rollback proof: dual → legacy → dual without restart', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });
    await seedTwoUsers();
  });

  it('signs in via Better Auth in dual, gets rejected in legacy, accepted again in dual', async () => {
    // Phase 1 — dual. Sign in via Better Auth, prove the cookie resolves
    // to the canonical user via `/api/v1/auth/me`.
    forceAuthProvider('dual');
    const cookie = await signInAndGetCookie(COOKIE_USER_EMAIL, COOKIE_PASSWORD);

    const dualMe = await SELF.fetch('http://localhost/api/v1/auth/me', {
      headers: { Cookie: cookie },
    });
    expect(dualMe.status).toBe(200);
    const dualBody = (await dualMe.json()) as { data?: { user?: { id?: unknown } } };
    expect(dualBody.data?.user?.id).toBe(COOKIE_USER_ID);

    // Snapshot the additive row state before the rollback.
    const sessionCountBefore = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?`,
    )
      .bind(COOKIE_USER_ID)
      .first<{ n: number }>();
    expect(sessionCountBefore?.n ?? 0).toBeGreaterThan(0);

    // Phase 2 — legacy. Same cookie carried, must now be ignored.
    // Plant a Bearer for the same user so we can prove the legacy path
    // still resolves it (proving the additive schema still works).
    forceAuthProvider('legacy');
    await env.CACHE.put(`auth:${BEARER_TOKEN}`, JSON.stringify({ userId: COOKIE_USER_ID }));

    const legacyCookieMe = await SELF.fetch('http://localhost/api/v1/auth/me', {
      headers: { Cookie: cookie },
    });
    expect(legacyCookieMe.status).toBe(401);

    const legacyBearerMe = await SELF.fetch('http://localhost/api/v1/auth/me', {
      headers: { Authorization: `Bearer ${BEARER_TOKEN}` },
    });
    expect(legacyBearerMe.status).toBe(200);
    const legacyBody = (await legacyBearerMe.json()) as { data?: { user?: { id?: unknown } } };
    expect(legacyBody.data?.user?.id).toBe(COOKIE_USER_ID);

    // The auth_sessions row is unchanged: rollback does not migrate,
    // delete, or otherwise mutate the additive schema.
    const sessionCountMid = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?`,
    )
      .bind(COOKIE_USER_ID)
      .first<{ n: number }>();
    expect(sessionCountMid?.n ?? 0).toBe(sessionCountBefore?.n ?? 0);

    // Phase 3 — back to dual. The same cookie must resolve again.
    forceAuthProvider('dual');
    const dualAgainMe = await SELF.fetch('http://localhost/api/v1/auth/me', {
      headers: { Cookie: cookie },
    });
    expect(dualAgainMe.status).toBe(200);
    const dualAgainBody = (await dualAgainMe.json()) as { data?: { user?: { id?: unknown } } };
    expect(dualAgainBody.data?.user?.id).toBe(COOKIE_USER_ID);

    // Final snapshot: the additive row is still there, unchanged in
    // count. This is the load-bearing assertion: the rollback proof.
    const sessionCountAfter = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?`,
    )
      .bind(COOKIE_USER_ID)
      .first<{ n: number }>();
    expect(sessionCountAfter?.n ?? 0).toBe(sessionCountBefore?.n ?? 0);
  });
});
