// Runtime resource types come from Wrangler; application and migration-only extensions live here.
export type AuthProviderName = 'legacy' | 'dual' | 'better-auth';

import type { PlatformConfig } from './config';

// Resource bindings are generated from the deployable staging configuration.
// Test/local secret values and migration compatibility vars remain explicit.
export type Env = Omit<
  RuntimeBindings,
  | 'AI'
  | 'INSTALLATION_TOKEN'
  | 'CREDENTIAL_ENCRYPTION_KEY'
  | 'CURSOR_SIGNING_KEY'
  | 'ENVIRONMENT'
  | 'RELEASE_SHA'
  | 'RELEASE_TREE'
  | 'APP_ORIGIN'
  | 'VERSION'
> & {
  AI?: Ai;
  INSTALLATION_TOKEN: SecretsStoreSecret;
  CREDENTIAL_ENCRYPTION_KEY: SecretsStoreSecret;
  VERSION?: WorkerVersionMetadata;
  RELEASE_SHA?: string;
  RELEASE_TREE?: string;
  /** Set to "false" to disable anonymous GitHub release checks. */
  UPDATE_CHECK_ENABLED?: string;
  APP_ORIGIN?: string;
  /** Domain-scoped fallback for unknown inbound envelope recipients. */
  INBOUND_CATCH_ALL_MAILBOX?: string;
  /** Optional private Worker secret containing a verified external destination. */
  INBOUND_FORWARD_TO?: string;
  /** Migration-only Better Auth compatibility binding; never required by the
   * deployed self-managed authentication path. */
  BETTER_AUTH_SECRET?: SecretsStoreSecret | string;
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
    sessionId?: string;
    mustChangePassword?: boolean;
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
