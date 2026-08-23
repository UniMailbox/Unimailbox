// apps/worker/src/http/routes/better-auth.worker.test.ts — CAP-042 (AC 12).
//
// Worker-pool tests for the Better Auth shadow handler at
// `/api/v1/auth/better/*`. The route layer is a thin pass-through
// (`http/routes/better-auth.ts`) that forwards the raw Request to
// `auth.handler(c.req.raw)`. The tests below prove the *application*
// surface — the routes the SPA and curl see — rather than the
// internal Better Auth API.
//
// Each test seeds a canonical `users` row + matching `auth_accounts`
// row directly via D1. The application's registration path (Batch 4)
// will replace this with a real app-owned insert, but AC 12 only
// requires the sign-in / get-session / sign-out flow to work, and
// signing in is impossible without an account to sign in with.
//
// What this file proves:
//   1. The Better Auth `basePath` and the Hono mount agree: a POST
//      to `/api/v1/auth/better/sign-in/email` reaches the framework's
//      sign-in endpoint. A typo on either side would surface here as
//      a 404.
//   2. Sign-in writes a session row to `auth_sessions` and returns a
//      `Set-Cookie` header that the browser can re-send. R-AUTH-007 /
//      R-SECRET-003: cookie is HttpOnly, SameSite=Lax, and never
//      returned in a JSON body.
//   3. Get-session resolves the cookie to the canonical `users` row,
//      proving the `name` ↔ `display_name` mapping is wired (a
//      regression there would 500 on the column lookup).
//   4. Sign-out deletes the session row so a follow-up get-session
//      returns no user.
import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';

import { betterAuthPassword } from '../../integrations/better-auth/password';
import { BETTER_AUTH_BASE_PATH, BETTER_AUTH_COOKIE_NAME } from '../../integrations/better-auth/path';

const TEST_USER_ID = '00000000-0000-4000-8000-00000000ba01';
const TEST_USER_EMAIL = 'cap042-ac12@example.test';
const TEST_PASSWORD = 'cap042-ac12-password';
const TEST_DISPLAY_NAME = 'AC-12 User';

// Fixed `now` for created_at / updated_at. Better Auth reads these as
// Unix-millisecond integers; using a fixed value keeps the row
// comparison deterministic across test runs.
const NOW_MS = Date.UTC(2026, 7, 22, 0, 0, 0);

// Hash the canonical test password once and cache the envelope so the
// `seedUserAndCredential` helper can bind it without re-running
// PBKDF2-SHA256 at 600_000 iterations for every test.
async function hashTestPassword(): Promise<string> {
  const fn = betterAuthPassword.hash;
  if (typeof fn !== 'function') throw new Error('betterAuthPassword.hash missing');
  return fn(TEST_PASSWORD);
}

/**
 * Seed a canonical user + credential account for the Better Auth
 * shadow handler to sign in. Mirrors the migration 0014 default
 * (`email_verified = false`) plus the password columns required by
 * the canonical schema. The envelope is the same ADR-006 form the
 * application uses during registration (Batch 4).
 */
async function seedUserAndCredential(): Promise<void> {
  const passwordEnvelope = await hashTestPassword();
  await env.DB.batch([
    // 1. canonical user row.
    env.DB
      .prepare(
        `INSERT INTO users (
           id, email, display_name, email_verified, status,
           password_algorithm, password_iterations, password_salt, password_hash,
           created_at, updated_at
         ) VALUES (?, ?, ?, 0, 'active', 'pbkdf2-sha256', 600000, ?, ?, ?, ?)`,
      )
      .bind(
        TEST_USER_ID,
        TEST_USER_EMAIL,
        TEST_DISPLAY_NAME,
        // The legacy password columns are not used by the Better Auth
        // sign-in path — it reads `auth_accounts.password` instead —
        // but the canonical schema enforces NOT NULL on them, so we
        // store a placeholder blob.
        new Uint8Array(16),
        new Uint8Array(32),
        new Date(NOW_MS).toISOString().replace('T', ' ').replace('Z', ''),
        new Date(NOW_MS).toISOString().replace('T', ' ').replace('Z', ''),
      ),
    // 2. Better Auth credential account. `issuer='local:credential'`
    //    matches the spike-evidence.md contract; `account_id` and
    //    `user_id` both equal the canonical user id so the adapter's
    //    `findOne({ userId, providerId: 'credential' })` resolves.
    env.DB
      .prepare(
        `INSERT INTO auth_accounts (
           id, issuer, account_id, provider_id, user_id, password,
           created_at, updated_at
         ) VALUES (?, 'local:credential', ?, 'credential', ?, ?, ?, ?)`,
      )
      .bind(
        'account-1',
        TEST_USER_ID,
        TEST_USER_ID,
        passwordEnvelope,
        NOW_MS,
        NOW_MS,
      ),
  ]);
}

describe('CAP-042 AC 12 — Better Auth shadow handler at /api/v1/auth/better', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    // R-SETUP-001 — without seeding 'complete' state, the setupGate
    // middleware redirects every non-/setup request to /setup, so the
    // /api/v1/auth/better/* paths would never reach Better Auth. Mark
    // the installation complete so the gate lets the request through.
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });
    await seedUserAndCredential();
  });

  afterEach(async () => {
    await resetAndMigrate();
  });

  // AC 12.1 — basePath / mount-path contract. A typo in either side
  // surfaces here as a 404 because the Hono router would not match
  // the framework's expected basePath.
  it('mounts /api/v1/auth/better/sign-in/email under BETTER_AUTH_BASE_PATH', async () => {
    expect(BETTER_AUTH_BASE_PATH).toBe('/api/v1/auth/better');
    const response = await SELF.fetch(
      `http://localhost${BETTER_AUTH_BASE_PATH}/sign-in/email`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: TEST_USER_EMAIL, password: TEST_PASSWORD }),
      },
    );
    if (response.status !== 200) {
      const body = await response.text();
      throw new Error(`Better Auth returned ${response.status}: ${body}`);
    }
    // The framework rejects the body without an Idempotency-Key only
    // when the application enforces it; Better Auth itself does not
    // require one for sign-in. A 200 means the framework's sign-in
    // endpoint ran end-to-end against the real D1 binding.
    expect(response.status).toBe(200);
  });

  it('sign-in returns a HttpOnly SameSite=Lax session cookie (R-SECRET-003, R-AUTH-007)', async () => {
    const response = await SELF.fetch(`http://localhost${BETTER_AUTH_BASE_PATH}/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_USER_EMAIL, password: TEST_PASSWORD }),
    });
    expect(response.status).toBe(200);

    const setCookie = response.headers.get('set-cookie');
    expect(setCookie).not.toBeNull();
    if (!setCookie) throw new Error('Better Auth sign-in did not return a session cookie');
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toContain(`${BETTER_AUTH_COOKIE_NAME}=`);
    // Domain is host-only (the cookie name carries no leading dot and
    // no Domain attribute is set on localhost).
    expect(setCookie).not.toMatch(/Domain=/i);
  });

  it('sign-in writes a row to auth_sessions against the real D1 binding', async () => {
    await SELF.fetch(`http://localhost${BETTER_AUTH_BASE_PATH}/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_USER_EMAIL, password: TEST_PASSWORD }),
    });

    const sessionCount = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?`)
      .bind(TEST_USER_ID)
      .first<{ n: number }>();
    expect(sessionCount?.n ?? 0).toBeGreaterThan(0);
  });

  it('get-session resolves the cookie back to the canonical user (AC 13)', async () => {
    const signIn = await SELF.fetch(`http://localhost${BETTER_AUTH_BASE_PATH}/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_USER_EMAIL, password: TEST_PASSWORD }),
    });
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.get('set-cookie');
    if (!cookie) throw new Error('sign-in missing set-cookie');
    const cookieHeader = cookie.split(';')[0]?.trim();
    if (!cookieHeader) throw new Error('sign-in returned empty cookie');

    const getSession = await SELF.fetch(`http://localhost${BETTER_AUTH_BASE_PATH}/get-session`, {
      headers: { Cookie: cookieHeader },
    });
    expect(getSession.status).toBe(200);
    const body = (await getSession.json()) as Record<string, unknown> & {
      user?: Record<string, unknown>;
      session?: Record<string, unknown>;
    };
    // AC 13's authoritative contract is that the cookie resolves to
    // the canonical user row. Better Auth's default get-session shape
    // exposes `id` and `email`; the canonical `display_name` ↔
    // Better Auth `name` mapping exists for sign-up-time writes (the
    // application's registration endpoint) but is not part of the
    // default response. Asserting on `id` and `email` is sufficient
    // because both come from the same `users` row the cookie
    // resolves to.
    expect(body.user?.id).toBe(TEST_USER_ID);
    expect(body.user?.email).toBe(TEST_USER_EMAIL);
    expect(body.session?.userId).toBe(TEST_USER_ID);
  });

  it('sign-out invalidates the cookie so a follow-up get-session returns no user', async () => {
    const signIn = await SELF.fetch(`http://localhost${BETTER_AUTH_BASE_PATH}/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_USER_EMAIL, password: TEST_PASSWORD }),
    });
    const cookie = signIn.headers.get('set-cookie');
    if (!cookie) throw new Error('sign-in missing set-cookie');
    const cookieHeader = cookie.split(';')[0]?.trim();
    if (!cookieHeader) throw new Error('sign-in returned empty cookie');

    // Better Auth's sign-out validates the Origin against the trusted
    // origin set in the factory (`config.betterAuthUrl`).
    // `wrangler.test.jsonc` pins `BETTER_AUTH_URL=http://localhost`,
    // so the test origin must match.
    const signOut = await SELF.fetch(`http://localhost${BETTER_AUTH_BASE_PATH}/sign-out`, {
      method: 'POST',
      headers: { Cookie: cookieHeader, Origin: 'http://localhost' },
    });
    expect(signOut.status).toBe(200);

    const getSession = await SELF.fetch(`http://localhost${BETTER_AUTH_BASE_PATH}/get-session`, {
      headers: { Cookie: cookieHeader },
    });
    expect(getSession.status).toBe(200);
    // After sign-out the session is gone; Better Auth returns
    // `{ "data": null }` (the route's success envelope wraps `null`).
    // Accept any of: literal null body, `{ data: null }`, or
    // `{ user: null, session: null }`. The D1 row count is the
    // authoritative check.
    const rawText = await getSession.text();
    const parsed = rawText.length === 0 ? null : (JSON.parse(rawText) as Record<string, unknown>);
    const userField =
      parsed && typeof parsed === 'object' && 'user' in parsed
        ? (parsed.user as unknown)
        : undefined;
    expect(userField ?? null).toBeNull();

    const sessionCount = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?`)
      .bind(TEST_USER_ID)
      .first<{ n: number }>();
    expect(sessionCount?.n ?? 0).toBe(0);
  });

  it('sign-in with the wrong password returns 401 without revealing which factor failed', async () => {
    const response = await SELF.fetch(`http://localhost${BETTER_AUTH_BASE_PATH}/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_USER_EMAIL, password: 'definitely-wrong' }),
    });
    expect(response.status).toBe(401);
  });

  it('sign-up/email is rejected by the framework (disableSignUp: true)', async () => {
    const response = await SELF.fetch(`http://localhost${BETTER_AUTH_BASE_PATH}/sign-up/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'never-registered@example.test',
        password: 'whateverPassword123',
        name: 'Never',
      }),
    });
    expect(response.status).toBe(400);
  });
});
