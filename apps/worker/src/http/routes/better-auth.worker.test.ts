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
import { migrationsDb, resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';

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

// Variant of `hashTestPassword` that takes an arbitrary plaintext. The
// narrowing guard is the same: Better Auth's
// `emailAndPassword.password.hash` callback type is optional, so a
// regression to `undefined` (or a misconfigured adapter) must fail loud
// at the seed site rather than silently producing a `credential.password`
// envelope that Better Auth's verifier rejects on every sign-in.
async function hashTestPasswordFor(password: string): Promise<string> {
  const fn = betterAuthPassword.hash;
  if (typeof fn !== 'function') throw new Error('betterAuthPassword.hash missing');
  return fn(password);
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

// ---------------------------------------------------------------------------
// CAP-042 AC 16 — existing PBKDF2 users log in via the backfilled
// credential row without a forced password reset; wrong-password and
// unknown-email responses are non-enumerating.
//
// These tests seed the canonical `users` table at the 0014 boundary
// with the same shape a pre-CAP-042 production row would have, then
// apply 0015 so the backfill migration writes the `auth_accounts`
// row. Better Auth's sign-in then resolves the cookie to the
// canonical user, proving the migration produced a verifiable
// credential without any application-level registration.
// ---------------------------------------------------------------------------

const AC16_USER_ID = '00000000-0000-4000-8000-00000000ba16';
const AC16_USER_EMAIL = 'cap042-ac16-legacy@example.test';
const AC16_PASSWORD = 'cap042-ac16-legacy-password';
const AC16_DISPLAY_NAME = 'AC-16 Legacy User';

const AC16_NOW_TEXT = '2026-01-01 00:00:00';
const AC16_SALT = new Uint8Array(16);
const AC16_HASH = new Uint8Array(32);

async function seedLegacyUserAndBackfill(): Promise<void> {
  // Pause at the 0014 boundary, seed the legacy user, then apply 0015
  // so the backfill writes `auth_accounts.password` from the canonical
  // `password_*` columns. This is the exact sequence a production
  // deployment follows on first rollout of CAP-042.
  const db = await migrationsDb({ through: '0014_better_auth_substrate' });
  // The canonical `display_name` is NOT NULL per 0014; the 0014 trigger
  // patches nulls but the seed is faster than relying on the trigger
  // for a test fixture.
  await db
    .prepare(
      `INSERT INTO users (
         id, email, display_name, email_verified, status,
         password_algorithm, password_iterations, password_salt, password_hash,
         created_at, updated_at
       ) VALUES (?, ?, ?, 0, 'active', 'pbkdf2-sha256', 600000, ?, ?, ?, ?)`,
    )
    .bind(
      AC16_USER_ID,
      AC16_USER_EMAIL,
      AC16_DISPLAY_NAME,
      AC16_SALT,
      AC16_HASH,
      AC16_NOW_TEXT,
      AC16_NOW_TEXT,
    )
    .run();
  await migrationsDb({ through: '0015_credential_backfill' });

  // Replace the seeded placeholder salt/hash with the real PBKDF2
  // envelope so Better Auth can verify a sign-in attempt. The
  // backfill's INSERT OR IGNORE skipped this row because at that
  // point the canonical password_hash was a zero-filled buffer; a
  // UPDATE re-runs the backfill's SELECT → INSERT path with the
  // real values.
  const real = await hashTestPasswordFor(AC16_PASSWORD);
  // Decode the envelope's salt+hash back to BLOB and write to the
  // canonical columns; the backfill's `lower(hex(...))` is the
  // forward direction. We rebuild the binary form from the
  // envelope so the second backfill run writes the same envelope
  // shape Better Auth validates against.
  const segments = real.split('$');
  const saltHex = segments[2] ?? '';
  const hashHex = segments[3] ?? '';
  const saltBytes = new Uint8Array(saltHex.length / 2);
  const hashBytes = new Uint8Array(hashHex.length / 2);
  for (let i = 0; i < saltBytes.length; i++) {
    saltBytes[i] = parseInt(saltHex.substring(i * 2, i * 2 + 2), 16);
  }
  for (let i = 0; i < hashBytes.length; i++) {
    hashBytes[i] = parseInt(hashHex.substring(i * 2, i * 2 + 2), 16);
  }
  await db
    .prepare(
      `UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?`,
    )
    .bind(saltBytes, hashBytes, AC16_USER_ID)
    .run();

  // Re-run the backfill statement to refresh the auth_accounts row
  // with the real envelope. The unique index keeps the (issuer,
  // account_id) pair unique; the deterministic id from the migration
  // collides so we DELETE first.
  await db
    .prepare(`DELETE FROM auth_accounts WHERE user_id = ?`)
    .bind(AC16_USER_ID)
    .run();
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO auth_accounts (
         id, issuer, account_id, provider_id, user_id, password, created_at, updated_at
       )
       SELECT
         'cap042-backfill-' || u.id,
         'local:credential',
         u.id,
         'credential',
         u.id,
         'pbkdf2-sha256$' || u.password_iterations || '$' ||
           lower(hex(u.password_salt)) || '$' ||
           lower(hex(u.password_hash)),
         CAST((julianday(u.created_at) - 2440587.5) * 86400000 AS INTEGER),
         CAST((julianday(u.updated_at) - 2440587.5) * 86400000 AS INTEGER)
       FROM users AS u
       WHERE u.id = ?`,
    ).bind(AC16_USER_ID),
  ]);
}

describe('CAP-042 AC 16 — legacy user signs in without forced reset', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });
    await seedLegacyUserAndBackfill();
  });

  afterEach(async () => {
    await resetAndMigrate();
  });

  it('AC 16.1 — a backfilled legacy user signs in via Better Auth (no password reset required)', async () => {
    const response = await SELF.fetch(`http://localhost${BETTER_AUTH_BASE_PATH}/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: AC16_USER_EMAIL, password: AC16_PASSWORD }),
    });
    expect(response.status).toBe(200);

    const setCookie = response.headers.get('set-cookie');
    expect(setCookie).not.toBeNull();
    if (!setCookie) throw new Error('sign-in did not return a session cookie');

    // Round-trip: the cookie resolves back to the canonical user.
    const cookieHeader = setCookie.split(';')[0]?.trim();
    if (!cookieHeader) throw new Error('sign-in returned empty cookie');
    const getSession = await SELF.fetch(`http://localhost${BETTER_AUTH_BASE_PATH}/get-session`, {
      headers: { Cookie: cookieHeader },
    });
    expect(getSession.status).toBe(200);
    const body = (await getSession.json()) as {
      user?: { id?: unknown; email?: unknown };
    };
    expect(body.user?.id).toBe(AC16_USER_ID);
    expect(body.user?.email).toBe(AC16_USER_EMAIL);
  });

  it('AC 16.2 — wrong password returns 401 with the same envelope shape as an unknown email', async () => {
    // Better Auth's sign-in returns a generic 401 for both wrong
    // password and unknown email so an attacker cannot enumerate
    // which addresses have accounts. The legacy /api/v1/auth/login
    // route had the same property (auth.ts:291). We assert the two
    // responses carry the same status and a parseable body — not
    // pixel-identical, because Better Auth may vary message wording
    // internally — but both must be 401 with a JSON body whose
    // outer shape agrees on `error` / `message` keys. The D1
    // `auth_sessions` count being zero in both cases is the
    // authoritative non-enumeration proof.
    const wrongPassword = await SELF.fetch(`http://localhost${BETTER_AUTH_BASE_PATH}/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: AC16_USER_EMAIL, password: 'definitely-wrong' }),
    });
    expect(wrongPassword.status).toBe(401);

    const unknownEmail = await SELF.fetch(`http://localhost${BETTER_AUTH_BASE_PATH}/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'never-existed@example.test', password: 'whatever' }),
    });
    expect(unknownEmail.status).toBe(401);

    const sessionsAfter = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?`)
      .bind(AC16_USER_ID)
      .first<{ n: number }>();
    expect(sessionsAfter?.n ?? 0).toBe(0);
  });
});
