// authn middleware — CAP-019 legacy Bearer + CAP-042 Better Auth cookie.
//
// Reads `Authorization: Bearer <token>` from the request header and
// looks up `auth:{token}` in CACHE KV. If found and valid, sets
// `c.set('userId', parsed.userId)`.
//
// CAP-042 (AC 13, 14): also resolves the Better Auth session cookie
// (`unimailbox.session_token`) against the real D1 `auth_sessions`
// table. Both surfaces may produce a userId; the explicit precedence
// is:
//
//   - **Sole valid** (one credential resolves, the other is absent
//     or unparseable) — that userId wins.
//   - **Both absent / unparseable** — userId stays unset; downstream
//     `requirePermission` returns 401.
//   - **Both resolve to the same userId** — userId is set; no conflict.
//   - **Both resolve but disagree** — 401 `CONFLICTING_PRINCIPALS`
//     (AC 14). The response carries no credential material so an
//     attacker cannot use the error to enumerate.
//
// CAP-042 (AC 23) — AUTH_PROVIDER cutover matrix:
//
//   The `authProvider` value on `c.var.config` gates which credential
//   surfaces this middleware accepts on a per-request basis:
//
//     - `'legacy'`     — only Bearer. The Better Auth cookie is
//                        silently ignored (no D1 lookup); a request
//                        with only a cookie falls through to a 401.
//     - `'dual'`       — both surfaces (existing AC 13/14 behaviour).
//     - `'better-auth'`— only Better Auth cookie. The Bearer header is
//                        silently ignored (no CACHE lookup); a request
//                        with only a Bearer falls through to a 401.
//
//   Silently ignoring a credential is the safe choice over a 401: a
//   legacy-mode caller probing for Better Auth gets the same 401 they
//   would get with no credential at all, and no error body reveals
//   that the Better Auth surface exists.
//
// This middleware does NOT block unauthenticated requests — that
// responsibility belongs to `requirePermission` (R-AUTHZ-001 +
// R-AUTHZ-003). It only sets `c.var.userId` and surfaces the
// conflicting-principal case as a 401 before any handler runs.
//
// R-SECRET-003: tokens, cookies, and resolved user IDs are never
// logged. The conflict error includes no header material.
import type { MiddlewareHandler } from 'hono';

import { createBetterAuth } from '../../integrations/better-auth/factory';
import { BETTER_AUTH_COOKIE_NAME } from '../../integrations/better-auth/path';
import type { PlatformConfig } from '../../platform/config';
import { DomainError } from '../../platform/errors';
import type { AppEnv } from '../../platform/env';
import { logger } from '../../platform/logger';
import { systemClock } from '../../platform/clock';

/**
 * Stable machine-readable error code for AC 14. Surfaced through the
 * existing error middleware (`http/middleware/error.ts`) so the
 * response shape matches the rest of the API: `{ error: { code, message, requestId } }`
 * with HTTP status 401.
 */
const CONFLICTING_PRINCIPALS = 'CONFLICTING_PRINCIPALS';

/**
 * Extract the cookie value for `name` from a `Cookie` header string.
 *
 * Returns `null` for a missing / malformed cookie. The parser is
 * intentionally simple — Better Auth's cookie value is opaque and the
 * server-side session lookup will reject malformed values via the
 * D1 query — but a syntactically-broken header must not throw.
 */
function readCookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';');
  for (const raw of parts) {
    const segment = raw.trim();
    if (!segment) continue;
    const eqIdx = segment.indexOf('=');
    if (eqIdx < 1) continue;
    const key = segment.slice(0, eqIdx).trim();
    if (key !== name) continue;
    const value = segment.slice(eqIdx + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

/**
 * Resolve a Better Auth session's userId from the cookie value.
 *
 * Reads the `auth_sessions` row by `token`, validates that the row
 * exists and is not expired, and returns `user_id`. Returns `null`
 * for missing / expired / unknown tokens. The `auth_sessions`
 * `expires_at` column is stored as Unix-millisecond integer per the
 * 0014 migration; Better Auth computes it that way too.
 */
async function resolveBetterAuthUserId(
  env: AppEnv['Bindings'],
  config: PlatformConfig,
  token: string,
): Promise<string | null> {
  const auth = await createBetterAuth(env, config);
  // `auth.api.getSession` accepts either a Headers instance or a
  // plain record. We construct a minimal Headers with just the cookie
  // so the lookup does not depend on the full request being shaped
  // exactly like a Workers `Request`.
  const headers = new Headers();
  headers.set('cookie', `${BETTER_AUTH_COOKIE_NAME}=${token}`);
  const result = (await auth.api.getSession({ headers })) as
    | { user?: { id?: unknown }; session?: { userId?: unknown } }
    | null;
  if (!result || typeof result !== 'object') return null;
  const userId =
    (typeof result.user?.id === 'string' && result.user.id) ||
    (typeof result.session?.userId === 'string' && result.session.userId) ||
    null;
  return userId;
}

/**
 * Authentication middleware.
 *
 * Reads `Authorization: Bearer <token>` from the request header
 * (existing CAP-019 behaviour) and the Better Auth session cookie
 * (CAP-042 AC 13). The two sources are merged into a single
 * `c.var.userId`; conflicting principals yield 401 (AC 14).
 *
 * Applied globally in `http/router.ts` after `setupGate`. Protected
 * routes use `requirePermission` to enforce authentication and
 * authorization on top of this layer.
 */
export const authn: MiddlewareHandler<AppEnv> = async (c, next) => {
  // CAP-042 (AC 23): AUTH_PROVIDER cutover matrix. The `config`
  // middleware populates `c.var.config` per request from the runtime
  // env, so flipping `AUTH_PROVIDER` takes effect on the next request
  // without a Worker restart. `authProvider === 'dual'` is the default
  // behaviour the existing AC 13/14 tests cover; the two new branches
  // gate which credential surfaces are read.
  const authProvider = c.var.config?.authProvider ?? 'dual';
  const acceptBearer = authProvider !== 'better-auth';
  const acceptBetterAuth = authProvider !== 'legacy';

  // Resolve the legacy Bearer userId via CACHE KV. This is the
  // existing CAP-019 path; the lookup is local to a Worker and has
  // no D1 cost. `AUTH_PROVIDER === 'better-auth'` skips the lookup
  // entirely — a Bearer header is silently ignored so a legacy
  // bearer alone returns 401 from the downstream `requirePermission`,
  // not a mode-specific rejection (defence in depth against probing
  // for the Better Auth surface).
  const authHeader = c.req.header('Authorization');
  let bearerUserId: string | null = null;
  if (acceptBearer && authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length);
    const data = await c.env.CACHE.get(`auth:${token}`);
    if (data) {
      try {
        const parsed = JSON.parse(data) as { userId?: unknown };
        if (typeof parsed.userId === 'string' && parsed.userId.length > 0) {
          bearerUserId = parsed.userId;
        }
      } catch {
        // Invalid JSON in KV — ignore and proceed without auth.
        // This prevents a corrupted KV entry from breaking all
        // requests.
      }
    }
  }

  // Resolve the Better Auth session userId via D1. This costs one
  // `auth_sessions` lookup; it is the authoritative source for any
  // request that uses the Better Auth cookie surface (CAP-042 AC 13).
  // Apply the canonical `Cookie` header parser rather than relying
  // on `c.req.header('cookie')` returning the same case-sensitive
  // header — RFC 6265 says the header is case-insensitive but the
  // browser may send any capitalisation.
  //
  // `AUTH_PROVIDER === 'legacy'` skips the lookup so a Better Auth
  // cookie alone returns 401 (cookie silently ignored — see the file
  // header for the no-probing rationale).
  let betterAuthUserId: string | null = null;
  if (acceptBetterAuth) {
    const cookieHeader = c.req.header('Cookie') ?? c.req.header('cookie');
    const cookieToken = readCookieValue(cookieHeader, BETTER_AUTH_COOKIE_NAME);
    if (cookieToken) {
      const config = c.var.config;
      if (!config) {
        // The `config` middleware should have populated this; the
        // absence indicates a router misconfiguration. Falling
        // through with `betterAuthUserId = null` is the safe choice —
        // the legacy Bearer path still runs, and `requirePermission`
        // is the gate that decides whether unauthenticated requests
        // are acceptable for the route.
      } else {
        const lookupStart = systemClock.unixMs();
        try {
          betterAuthUserId = await resolveBetterAuthUserId(c.env, config, cookieToken);
        } catch (error) {
          // CAP-042 (H-3): the bare `catch {}` swallowed a Better Auth
          // lookup failure with zero observability. A Better Auth internal
          // error must not deny a request that has a valid Bearer token,
          // but the swallowed failure has to be visible in the log so
          // regressions surface. R-LOG-001: never log the cookie value;
          // `event` + `requestId` + `durationMs` give operators enough to
          // correlate without leaking credential material.
          const durationMs = systemClock.unixMs() - lookupStart;
          const requestId = c.get('requestId');
          logger.warn(
            requestId
              ? { event: 'authn.better_auth_lookup_failed', requestId, durationMs }
              : { event: 'authn.better_auth_lookup_failed', durationMs },
            { error: error instanceof Error ? error.message : String(error) },
          );
          // Fall through with `betterAuthUserId = null`; the conflict
          // check below still runs and the caller can decide what to do
          // if neither principal resolves.
        }
      }
    }
  }

  // Conflict detection (AC 14). When both principals resolve, they
  // must agree. The error is 401 with a stable, machine-readable
  // code so a future audit log can record the conflict without
  // logging either principal.
  if (bearerUserId && betterAuthUserId && bearerUserId !== betterAuthUserId) {
    throw new DomainError({
      code: CONFLICTING_PRINCIPALS,
      message: 'Cookie and bearer authentication do not agree',
      httpStatus: 401,
    });
  }

  // CAP-042 (H-4, R-AUTH-002): per-request `users.status` recheck. The
  // Better Auth factory's `databaseHooks.session.create.before` hook
  // gates *new* sign-ins on `users.status = 'active'`, but it does NOT
  // gate every protected request that uses an existing session. A
  // user banned or deleted between sign-in and the next protected
  // request would otherwise continue to pass authn with a stale token.
  // The second-layer status recheck is the canonical D1 column (not
  // Better Auth's `banned` field); spike-evidence.md R-AUTH-002 row
  // pins the canonical column as the source of truth.
  //
  // Returning `null` makes the middleware treat the request as
  // unauthenticated — `requirePermission` will then issue a 401 with
  // the standard envelope. We do NOT log the resolved userId (R-LOG-001).
  const candidateUserId = bearerUserId ?? betterAuthUserId;
  if (candidateUserId) {
    const statusRow = await c.env.DB
      .prepare(`SELECT status FROM users WHERE id = ? AND status = 'active' LIMIT 1`)
      .bind(candidateUserId)
      .first<{ status: string }>();
    if (statusRow) {
      c.set('userId', candidateUserId);
    }
  }

  await next();
};

// Re-export the constant so the auth-bridge middleware (if added
// later) and the error-handling tests share the same string source.
export const CONFLICTING_PRINCIPALS_CODE = CONFLICTING_PRINCIPALS;
