// platform/env — the Cloudflare Worker `Env` type and the Hono `AppEnv` shape.
// Owns the worker's environment shape so neither `platform/*` nor any
// module needs to reach upward into the entrypoint layer for it.
//
// Per docs/rebuild/05-target-architecture/module-boundaries.md:41, this
// type is consumed by `buildAppContext(env: Env, ...)` and is the only
// thing the entrypoint hands the composition root.
export type Env = {
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  SETUP_SESSION: KVNamespace;
  CACHE: KVNamespace;
  OUTBOUND: Queue;
  INSTALLATION_TOKEN: SecretsStoreSecret;
  CREDENTIAL_ENCRYPTION_KEY: SecretsStoreSecret;
  ENVIRONMENT?: string;
};

// Hono's `Bindings` slot on the app env. Lives here so middleware files
// can import a single, low-layer type rather than reaching upward.
export type AppEnv = {
  Bindings: Env;
  Variables: {
    userId?: string;
    /** Idempotency-Key header (CAP-027 / ADR-004). Set by
     *  http/middleware/idempotency.ts after format validation. */
    idempotencyKey?: string;
  };
};