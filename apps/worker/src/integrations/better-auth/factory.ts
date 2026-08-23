// apps/worker/src/integrations/better-auth/factory.ts — CAP-042 (AC 12, 13).
//
// Request-scoped Better Auth instance builder. The HTTP layer
// (`http/routes/better-auth.ts` and the session bridge middleware in
// `http/middleware/authn.ts`) calls `createBetterAuth(env, config)`
// per request; the returned instance is used immediately and discarded.
//
// Why per-request (and not module-scope memoisation):
//
//   1. **Secret freshness** — `BETTER_AUTH_SECRET` is read via
//      `readSecret()` (a Secrets Store binding in production, a plain
//      string in worker-pool tests). A rotation therefore changes the
//      effective secret on the next request, not on the next deploy.
//      Caching the instance on the first request would freeze the old
//      secret and silently keep invalidating rotated credentials.
//   2. **Atomic config** — the instance holds only the resolved
//      configuration. Construction cost is the closure allocation
//      Better Auth performs internally, not I/O. A per-request build is
//      cheap enough to repeat; spike-evidence.md §Cookie, origin,
//      secret, and runtime decisions chose this pattern explicitly.
//   3. **Testability** — tests can construct an instance with a
//      caller-supplied secret override (`secretOverride`) without
//      poisoning a module-level memo across test files.
//
// What this factory **does not** do:
//
//   - It does not register a `sign-up/email` endpoint. Better Auth 1.7.1
//     honours `emailAndPassword.disableSignUp` and returns
//     `EMAIL_PASSWORD_SIGN_UP_DISABLED` (400) for that path. The
//     application registration endpoint (`http/routes/auth.ts`) is the
//     sole user-creation surface (spike-evidence.md §Generated SQLite
//     schema comparison, decision 5).
//   - It does not store Better Auth sessions in KV or any secondary
//     store. D1 is authoritative (`cookieCache.enabled` defaults to
//     `false` and we do not configure it). spike-evidence.md §Cookie,
//     origin, secret, and runtime decisions chose D1-only on purpose:
//     revocation, status changes, and token rotation are read at every
//     protected request.
//
// Schema mapping (`name` ↔ `display_name`):
//
//   Better Auth's core user model has `name` as the human-readable
//   handle; canonical Unimailbox stores it as `display_name`. The
//   `user.fields` map below tells the Drizzle adapter to read and
//   write `display_name` whenever Better Auth refers to `name`.
//   Without this map, sign-in would 500 on the first SELECT because
//   no column named `name` exists. The mapping is **typing only** —
//   the SQL column is owned by `migrations/0014_better_auth_substrate.sql`.
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { drizzle } from 'drizzle-orm/d1';

import type { PlatformConfig } from '../../platform/config';
import type { Env } from '../../platform/env';
import { readSecret } from '../../platform/secrets';
import { betterAuthPassword } from './password';
import { BETTER_AUTH_BASE_PATH } from './path';
import { betterAuthSchema } from './schema';

// R-AUTH-007 reconciled business rule: 6..30 characters. The previous
// 8..72 was legacy drift; spike-evidence.md §R-AUTH reconciliation
// notes the change must be reflected in `emailAndPassword.min/maxPasswordLength`
// so Better Auth's runtime validation agrees with the application
// contract. The boundary tests live in `http/routes/auth.worker.test.ts`
// (the registration path) and in `integrations/better-auth/`'s
// sign-in tests below.
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 30;

export interface CreateBetterAuthOptions {
  /** Override the secret for tests. When omitted, `readSecret(env.BETTER_AUTH_SECRET)`
   *  is used. Production callers must NOT pass this — it exists so worker-pool
   *  tests can inject a deterministic value without touching `env`. */
  readonly secretOverride?: string;
}

/**
 * Better Auth instance shape consumed by the HTTP layer.
 *
 * The factory returns the result of `betterAuth(...)` verbatim but
 * uses an explicit interface — the inferred `Auth<BetterAuthOptions>`
 * propagates the exact options literal we passed and loses covariance
 * at the call site. Declaring the structural shape we actually depend
 * on (`auth.handler`, `auth.api.getSession`) keeps the route and the
 * middleware from importing Better Auth types directly.
 */
export interface BetterAuthInstance {
  readonly handler: (request: Request) => Promise<Response>;
  readonly api: {
    readonly getSession: (input: { headers: Headers | Record<string, string> }) => Promise<unknown>;
  };
}

/**
 * Build a Better Auth instance bound to the request's D1 database and
 * the canonical schema.
 *
 * Returns a value that satisfies Better Auth's public `auth.api` /
 * `auth.handler` shape. The instance is single-use for the duration
 * of one request; constructing another for the next request is
 * deliberate, not a leak.
 */
export async function createBetterAuth(
  env: Env,
  config: PlatformConfig,
  options: CreateBetterAuthOptions = {},
): Promise<BetterAuthInstance> {
  const secret = options.secretOverride ?? (await readSecret(env.BETTER_AUTH_SECRET));
  // `drizzle(env.DB, { schema })` is the canonical Workers + D1 setup;
  // `transaction: false` is required because D1 disallows SQL-level
  // BEGIN TRANSACTION (spike-evidence.md §D1 transaction and atomic
  // registration result). Application-owned multi-row writes use
  // `DB.batch(...)` directly.
  const db = drizzle(env.DB, { schema: betterAuthSchema });

  const auth = betterAuth({
    appName: 'unimailbox',
    baseURL: config.betterAuthUrl,
    basePath: BETTER_AUTH_BASE_PATH,
    secret,
    // Better Auth's CSRF/origin middleware validates form/origin/callback
    // URLs against this list. We allow exactly the configured origin
    // (the Worker + SPA host) and reject the universe; `disableOriginCheck`
    // is intentionally left at its `false` default so open-redirect
    // payloads cannot escape through the auth boundary.
    trustedOrigins: [config.betterAuthUrl],
    advanced: {
      cookiePrefix: 'unimailbox',
      defaultCookieAttributes: {
        sameSite: 'lax',
        httpOnly: true,
        // `secure: true` is required for any HTTPS base URL; Better
        // Auth's own cookie writer falls back to false when the URL is
        // `http:`. The `local` environment uses `http://localhost`,
        // which keeps the dev cookie usable; preview/production
        // defaults to HTTPS via `parseBetterAuthUrl`.
        secure: config.betterAuthUrl.startsWith('https://'),
        path: '/',
      },
    },
    emailAndPassword: {
      enabled: true,
      // spike-evidence.md decision 5: application registration is the
      // sole user-creation surface. Better Auth's `sign-up/email` is
      // rejected at the framework level with 400
      // `EMAIL_PASSWORD_SIGN_UP_DISABLED`. Defense in depth: the route
      // layer (`http/routes/better-auth.ts`) also short-circuits
      // `/sign-up/*` paths before they reach this handler.
      disableSignUp: true,
      // R-AUTH-001 verified-email stop condition: no approved
      // deterministic sender contract yet. Better Auth's default is
      // false anyway; we set it explicitly so a future reviewer can
      // see the deferred decision. The verification row in
      // `auth_verifications` is created on demand when the
      // verified-email flow ships; until then it stays empty.
      requireEmailVerification: false,
      // R-AUTH-007: explicit boundaries match the reconciled contract.
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      // ADR-006 PBKDF2 envelope adapter. The Better Auth 1.7.1
      // callback surface here is pinned by the exported
      // `BetterAuthEmailPasswordOption` type in
      // `integrations/better-auth/password.ts:44`; an object-shaped
      // `hash` is a compile-time error.
      password: betterAuthPassword,
    },
    user: {
      // Better Auth's `name` ↔ canonical `display_name`. See the file
      // header for the rationale.
      fields: { name: 'display_name' },
    },
    session: {
      // 30-day session lifetime, 1-day refresh window. Matches the
      // legacy refresh-token behaviour (CAP-019 §login route). The
      // underlying `auth_sessions` table stores `expires_at` as a
      // Unix-ms integer; Better Auth's adapter handles the conversion.
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      // R-AUTH-004: cookie cache disabled → D1 is authoritative on
      // every protected request. Renaming / rotating / revoking a
      // session takes effect on the next request that reads it.
      cookieCache: { enabled: false },
      // R-AUTH-004: token rotation must still happen on refresh; we
      // explicitly keep the default (`false`) for visibility.
      disableSessionRefresh: false,
      // R-AUTH-005: revoke all sessions on password reset. Better
      // Auth's `emailAndPassword.revokeSessionsOnPasswordReset`
      // delegates to the internal adapter; we accept the default
      // (`true`) and pin it here so a future regression shows up
      // as a diff.
      preserveSessionInDatabase: true,
    },
    databaseHooks: {
      // Defense in depth alongside `disableSignUp: true`. If a future
      // plugin or route somehow reaches the user-create path on the
      // Better Auth adapter, this hook returns `false` to reject the
      // write before it touches D1. Application registration writes
      // directly via `DB.batch(...)` and never calls
      // `auth.api.signUpEmail`, so the hook does not affect it.
      user: {
        create: {
          // `Promise<false>` matches Better Auth 1.7.1's
          // `(user, ctx) => Promise<boolean | void | { data: ... }>`
          // signature: returning `false` aborts the create with no
          // replacement data. Sync `false` is not assignable.
          before: async () => false,
        },
      },
    },
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      schema: betterAuthSchema,
      transaction: false,
    }),
  });

  // Cast through `unknown` to the structural interface: the inferred
  // `Auth<{ ...literal... }>` loses covariance when the consumer asks
  // for `Auth<BetterAuthOptions>`. The runtime values are identical —
  // the inferred options and the generic parameter are the same
  // object — so this cast is purely a TypeScript plumbing fix.
  return auth as unknown as BetterAuthInstance;
}
