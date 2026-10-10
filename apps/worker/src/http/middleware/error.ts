// error middleware — CAP-032 / R-API-001.
//
// Maps every thrown error to the canonical envelope
// `{ error: { code, message, requestId } }` (R-API-001). The four branches
// are:
//   1. ZodError    → 400 VALIDATION_ERROR (zod schema validation failures)
//   2. DomainError → err.httpStatus (typed application errors)
//   3. SyntaxError → 400 VALIDATION_ERROR (defence in depth; the canonical
//                   malformed-body surface is `INVALID_JSON` via
//                   http/middleware/parse-json-body.ts)
//   4. unknown     → 500 INTERNAL
//
// `requestId` is sourced from `c.get('requestId')` (set by the request-id
// middleware). If the middleware somehow fails to set one, the envelope
// emits `requestId: '<unknown>'` rather than `undefined` (AC5 — defence
// in depth).
//
// The Response is built via `Response.json(...)`. The `X-Request-Id`
// header set by the request-id middleware is copied onto the response
// explicitly so the error path keeps the same correlation surface as the
// success path.
import type { Context, ErrorHandler } from 'hono';
import { ZodError } from 'zod';
import type { AppEnv } from '../../platform/env';
import { DomainError } from '../../platform/errors';
import type { ErrorCode, HttpStatusCode } from '../../platform/errors';

/**
 * Resolve the request correlation id for the envelope. Falls back to a
 * sentinel string when the middleware did not run (defence in depth — AC5).
 */
function resolveRequestId(c: Context<AppEnv>): string {
  return c.get('requestId') ?? '<unknown>';
}

/**
 * Map a code + httpStatus + message + requestId to the canonical envelope
 * Response. Centralised so every branch emits exactly the same shape.
 *
 * `requestId` is the single source of truth — the envelope body and the
 * `X-Request-Id` header are both derived from this parameter, so they
 * cannot drift (Arch L3 / QA L1).
 */
function envelope(
  code: ErrorCode,
  message: string,
  httpStatus: HttpStatusCode,
  requestId: string,
): Response {
  const response = Response.json({ error: { code, message, requestId } }, { status: httpStatus });
  // Don't propagate the AC5 sentinel as a real header.
  if (requestId !== '<unknown>') {
    response.headers.set('X-Request-Id', requestId);
  }
  return response;
}

export const errorMiddleware: ErrorHandler<AppEnv> = (err, c) => {
  // Handle ZodError (validation failures from schema.parse at the route boundary)
  if (err instanceof ZodError) {
    return envelope(
      'VALIDATION_ERROR',
      err.errors[0]?.message ?? 'Validation failed',
      400,
      resolveRequestId(c),
    );
  }

  // Handle DomainError (application errors with known HTTP status)
  if (err instanceof DomainError) {
    const status = err.httpStatus ?? 500;
    return envelope(err.code, err.message, status, resolveRequestId(c));
  }

  // Handle SyntaxError (JSON parsing failures).
  //
  // D-CAP-031-D (defence in depth, post-CAP-031): every `/api/v1/*` route
  // that calls `JSON.parse(rawBody)` now goes through `parseJsonBody`
  // (or a local try/catch in /api/v1/auth/*) which converts SyntaxError
  // into a typed `INVALID_JSON` DomainError before it reaches this branch.
  // We keep this fallback so a future route that forgets to use the
  // helper still returns `400` rather than `500`. R-INPUT-002 keeps the
  // stable code (`VALIDATION_ERROR`) here only as a last-resort shape —
  // the canonical surface for malformed bodies is `INVALID_JSON`.
  if (err instanceof SyntaxError) {
    return envelope('VALIDATION_ERROR', 'Invalid JSON', 400, resolveRequestId(c));
  }

  // Unknown errors → 500. Log so production 500s are visible.
  // R-LOG-001: `err` must not carry body bytes, tokens, or secrets.
  // Future redaction (D-CAP-006-B) must scrub `err.message` and `err.stack`
  // before persisting.
  console.error('[error-middleware] unhandled error:', err);

  return envelope('INTERNAL', 'Internal server error', 500, resolveRequestId(c));
};
