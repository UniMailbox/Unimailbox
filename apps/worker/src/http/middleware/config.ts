// http/middleware/config — CAP-042 (AC 12).
//
// Resolves the strict-parsed `PlatformConfig` from the worker's raw env
// once per request and stows it on `c.var.config`. Anything that needs
// the auth provider mode, Better Auth URL, or environment name then
// reads from `c.var.config` instead of re-parsing the env, which keeps
// the closed-enum / origin validation in `platform/config.ts` as the
// single source of truth.
//
// Why a middleware (and not an inline `loadConfig(c.env)` in each
// route):
//
//   1. The Better Auth factory (`integrations/better-auth/factory.ts`)
//      builds its instance from the same config the route mount reads.
//      Doing it once per request keeps both layers consistent.
//   2. A bad `AUTH_PROVIDER` or `BETTER_AUTH_URL` value fails closed
//      here with a typed `ConfigError` that the error middleware
//      surfaces as a 500 with a stable code. Routing the failure
//      through the same middleware as the rest of the 5xx envelope
//      means the API contract for failed config is uniform.
//   3. `loadConfig` is intentionally not memoised at module scope:
//      Cloudflare Workers can recycle isolates between requests, and
//      a per-request build is cheap.
import type { MiddlewareHandler } from 'hono';

import { loadConfig } from '../../platform/config';
import type { AppEnv } from '../../platform/env';

/**
 * Resolve the platform config and attach it to the Hono context.
 *
 * `loadConfig` throws `ConfigError` on any malformed env. The error
 * middleware in `http/middleware/error.ts` is the only place that
 * translates that into a status code, so this middleware deliberately
 * does NOT wrap the call in a try/catch — letting it throw preserves
 * the typed-error contract for review and for the centralised handler.
 */
export const config: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('config', loadConfig(c.env));
  await next();
};
