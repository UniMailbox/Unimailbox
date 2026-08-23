// apps/worker/src/http/routes/better-auth.ts — CAP-042 (AC 12).
//
// Mounts the Better Auth HTTP surface at `/api/v1/auth/better/*`.
//
// The Hono sub-app below is the **only** place that calls
// `auth.handler(request)` and copies the resulting `Response` back
// into the Hono envelope. Per spike-evidence.md §Cookie, origin,
// secret, and runtime decisions, this is the Hono reference pattern:
// pass a Request with the body intact to Better Auth, then mirror the
// response.
//
// Why we rebuild the request (D-CAP-042-A):
//   The parent `apiV1` sub-app chains `enforceBodySize(1024*1024)`,
//   which calls `c.req.text()` to measure the body. That call consumes
//   the underlying `c.req.raw` body stream, so Better Auth's
//   `auth.handler(c.req.raw).json()` would throw a non-APIError which
//   `better-call` surfaces as 500 INTERNAL with an empty body.
//   Hono's `c.req.text()` cache holds the already-read body; we read
//   it back here and construct a fresh `Request` with that body so
//   Better Auth can parse it. The 1 MB cap still applies because
//   `enforceBodySize` runs first.
//
// We do not parse the request body, do not run zod validation, and do
// not apply `enforceBodySize` here (the parent already does).
//
// Mounting order (see `http/router.ts`): this sub-app is mounted at
// `/api/v1/auth/better/*` INSIDE `apiV1`, so the body-size cap is
// inherited. Webhooks are still a sibling sub-app because their body
// limit exemption is different (D-CAP-031-A).
import { Hono } from 'hono';

import { createBetterAuth } from '../../integrations/better-auth/factory';
import type { AppEnv } from '../../platform/env';
import { logger } from '../../platform/logger';

/**
 * Mount the Better Auth shadow handler.
 *
 * Wildcard `*` so every path under `/api/v1/auth/better` is forwarded
 * — `sign-in/email`, `sign-out`, `get-session`, and the application-
 * disabled `sign-up/email`. The factory's `disableSignUp: true` is the
 * authoritative "off" switch; we do not filter paths here so a future
 * Better Auth release that renames a route keeps working without an
 * Hono edit.
 */
export function betterAuthRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.all('*', async (c) => {
    const config = c.var.config;
    if (!config) {
      // The `config` middleware is mounted upstream of this sub-app
      // (see `http/router.ts`), so this branch should be unreachable
      // in practice. Defensive throw keeps a misconfigured router
      // from silently falling through to a Better Auth instance
      // bound to an undefined base URL.
      throw new Error('PlatformConfig missing from request context');
    }
    const auth = await createBetterAuth(c.env, config);

    // Rebuild a Request with the cached body that `enforceBodySize`
    // already materialised. D-CAP-042-A: passing `c.req.raw` directly
    // to Better Auth fails because the body stream has been consumed.
    //
    // `c.req.text()` is idempotent thanks to Hono's bodyCache, so a
    // second call returns the same string without re-reading the wire.
    // For GET requests (no body, e.g. `get-session`), the body is the
    // empty string and the rebuilt Request matches the original.
    const cachedBody = await c.req.text();
    const rebuilt = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers: c.req.raw.headers,
      body: cachedBody.length > 0 ? cachedBody : null,
    });

    let response: Response;
    try {
      response = await auth.handler(rebuilt);
    } catch (err) {
      // Better Auth 1.7.1's `drizzleAdapter` sometimes surfaces a
      // structured APIError as both a returned Response AND an
      // unhandled rejection on a side-channel promise (see
      // `apps/worker/test/setup.ts` for the matching
      // `unhandledRejection` swallow). If Better Auth's
      // `auth.handler(rebuilt)` itself throws an APIError — rare,
      // but possible if the request fails validation before the
      // adapter is reached — we convert the APIError into a
      // structured `Response` so the route still emits a 4xx
      // envelope instead of falling through to the global error
      // middleware's 500.
      //
      // Anything that is NOT a Better Auth APIError is a genuine
      // bug; let it bubble so it surfaces as a 500.
      if (err && typeof err === 'object' && 'statusCode' in err) {
        const apiErr = err as { statusCode?: number; body?: unknown };
        const status = apiErr.statusCode ?? 500;
        const body = apiErr.body ?? { message: 'better_auth error' };
        response = new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      } else {
        throw err;
      }
    }

    // The Hono reference copies headers + status, then returns a new
    // Response with the original body. We do the same: the Better Auth
    // body is a `ReadableStream` that must be passed straight through
    // so streaming responses (rare, but possible) survive.
    //
    // R-SECRET-003: never log the response body. We log only the
    // status and request id; a 5xx still surfaces, but the headers and
    // payload — which can carry session cookies — stay out of the log.
    if (response.status >= 500) {
      const requestId = c.get('requestId');
      logger.warn(
        requestId ? { event: 'better_auth.upstream_error', requestId } : { event: 'better_auth.upstream_error' },
        { status: response.status },
      );
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  });

  return routes;
}
