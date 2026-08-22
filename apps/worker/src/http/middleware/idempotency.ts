// http/middleware/idempotency — CAP-027 / ADR-004.
//
// Enforces the `Idempotency-Key` header on every mutating endpoint.
//
// Layered after authn/setupSession/requirePermission so a 401/403 is
// returned before the client even learns we wanted a key. R-SETUP-001
// bootstrap is exempt — /setup/claim runs *before* the client has a
// session token, so the claim endpoint uses this middleware too but
// its operation string is what makes the row recordable.
//
// What the middleware does:
//   1. Reads `Idempotency-Key`.
//   2. Missing → 400 IDEMPOTENCY_KEY_REQUIRED.
//   3. Malformed → 400 IDEMPOTENCY_KEY_INVALID (8-128 chars of [A-Za-z0-9_-]).
//   4. Sets `c.set('idempotencyKey', key)` for downstream handlers
//      (the route handler reads the key + hashes the raw body + calls
//      tryReplayIdempotency).
//
// Why the middleware does NOT do the replay itself:
//   - The replay path needs the raw request body (for sha256_hex(body)).
//     Middleware can read raw bodies but that complicates the body
//     re-injection for downstream handlers.
//   - Strict-mode routes (compose, mailboxes.create, messages.read) want
//     to *append* the record insert to their existing D1 batch; that
//     needs the route handler's control over the batch.
//   - Best-effort routes (setup, auth) want the lookup to happen *before*
//     the use case so they can short-circuit. The middleware can't do
//     that without a DB handle.
//
// The shape below is the minimum the middleware can guarantee: the
// header is present and well-formed. The handler does the rest.

import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../../platform/env';
import { IDEMPOTENCY_HEADER, IDEMPOTENCY_KEY_PATTERN } from '../../platform/idempotency';
import { DomainError } from '../../platform/errors';

export const requireIdempotencyKey: MiddlewareHandler<AppEnv> = async (c, next) => {
  const key = c.req.header(IDEMPOTENCY_HEADER);

  if (!key) {
    throw new DomainError({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: `${IDEMPOTENCY_HEADER} header required`,
      httpStatus: 400,
    });
  }

  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new DomainError({
      code: 'IDEMPOTENCY_KEY_INVALID',
      message: `${IDEMPOTENCY_HEADER} must be 8-128 chars of [A-Za-z0-9_-]`,
      httpStatus: 400,
    });
  }

  c.set('idempotencyKey', key);
  await next();
};
