// platform/env — the Cloudflare Worker `Env` type and the Hono `AppEnv` shape.
// Owns the worker's environment shape so neither `platform/*` nor any
// module needs to reach upward into the entrypoint layer for it.
//
// Per docs/rebuild/05-target-architecture/module-boundaries.md:41, this
// type is consumed by `buildAppContext(env: Env, ...)` and is the only
// thing the entrypoint hands the composition root.
//
// `ASSETS` is the binding the wrangler `assets` block produces (CAP-039);
// the platform's `not_found_handling: "single-page-application"` returns
// `index.html` for any non-API GET, so the Worker-side `http/router.ts`
// only mounts a catch-all for `/` itself.
//
// CAP-042 (AC 11):
//   - `BETTER_AUTH_SECRET` is a Secrets Store binding in production and a
//     plain string in the worker-pool test (the test config provides it as
//     a var). `readSecret()` from `platform/secrets.ts` handles both forms,
//     so the Worker code does not need a type-narrowing branch.
//   - `BETTER_AUTH_URL` and `AUTH_PROVIDER` are non-secret vars typed as
//     strings here; their closed-enum/origin validation lives in
//     `platform/config.ts:parseAuthProvider` and
//     `platform/config.ts:parseBetterAuthUrl`. The union literal type for
//     `AUTH_PROVIDER` is duplicated as a string at the runtime layer so a
//     bad var still fails closed in `parseAuthProvider` before any module
//     reads it.
//
// CAP-042 (AC 12): the `Variables.config` slot is set by the config
// middleware before any Better-Auth-aware route runs. It carries the
// strict-parsed `PlatformConfig` so the factory and the route read the
// same canonical values without re-parsing env. The type lives in
// `platform/config.ts`; we use a forward reference to avoid a runtime
// cycle (env ↔ config import each other at the type level only).

export type AuthProviderName = 'legacy' | 'dual' | 'better-auth';

import type { PlatformConfig } from './config';

export type Env = {
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  SETUP_SESSION: KVNamespace;
  CACHE: KVNamespace;
  OUTBOUND: Queue;
  ASSETS: Fetcher;
  INSTALLATION_TOKEN: SecretsStoreSecret;
  CREDENTIAL_ENCRYPTION_KEY: SecretsStoreSecret;
  BETTER_AUTH_SECRET: SecretsStoreSecret | string;
  // CAP-043 Slice 1 / D-CAP-043-D: CURSOR_SIGNING_KEY is the third
  // independent Secrets Store binding. It is read via readSecret() the
  // same way BETTER_AUTH_SECRET is (plain string in tests, SecretsStoreSecret
  // in production). The cursor HMAC key is neither the credential
  // AES-GCM key nor the Better Auth cookie HMAC key.
  CURSOR_SIGNING_KEY: SecretsStoreSecret | string;
  ENVIRONMENT?: string;
  BETTER_AUTH_URL?: string;
  AUTH_PROVIDER?: string;
  // D-CAP-042-auth-origin: comma-separated origins (besides
  // `BETTER_AUTH_URL`) that Better Auth will accept cross-origin requests
  // from. Used in local dev where the Vite SPA (port 5173) and the Worker
  // (port 8787) live on different origins; the browser document origin
  // is the Vite port, so BA's CSRF/origin middleware must allow it
  // explicitly. Production has same-origin SPA + API so this stays empty.
  BETTER_AUTH_ADDITIONAL_TRUSTED_ORIGINS?: string;
};

// Hono's `Bindings` slot on the app env. Lives here so middleware files
// can import a single, low-layer type rather than reaching upward.
export type AppEnv = {
  Bindings: Env;
  Variables: {
    /** UUIDv4 request correlation id (CAP-032 / R-API-001). Set by
     *  http/middleware/request-id.ts before any other middleware. */
    requestId?: string;
    userId?: string;
    /** Idempotency-Key header (CAP-027 / ADR-004). Set by
     *  http/middleware/idempotency.ts after format validation. */
    idempotencyKey?: string;
    // CAP-042 (AC 12): strict-parsed PlatformConfig (authProvider,
    // betterAuthUrl, environment). Built once per request by the
    // config middleware so the Better Auth factory and any future
    // auth-aware route can read the same canonical values without
    // re-parsing raw env. The actual type is `PlatformConfig` from
    // `./config`; we name it via the string-keyed `config` field
    // shape Hono exposes on `Variables` and let TypeScript narrow
    // it at use sites.
    config?: PlatformConfig;
  };
};
