// http/middleware/body-size — CAP-031 / R-API-005.
//
// Enforces a hard upper bound on `/api/v1/*` request body size.
//
// Why this exists (.claude/rules/security.md §Input and transport):
//   "Reject any `/api/v1/*` request body over 1 MB with 413."
//
// Two layers:
//
//   1. `Content-Length` header. If the client advertises a length above
//      the limit, reject without reading the body — saves bandwidth and
//      avoids holding oversized bytes in memory.
//
//   2. `Content-Length` is advisory. Some clients omit it (chunked
//      transfer, custom proxies), so we also fall back to reading the
//      raw body once and measuring its byte length. Hono's
//      `c.req.text()` caches the read in `bodyCache`, so downstream
//      handlers calling `c.req.text()` again receive the cached value
//      without re-reading the wire — verified against hono@4.6.20
//      `dist/request.js` `#cachedBody`.
//
// Logging:
//   Per the contract and .claude/rules/security.md §Logging, the
//   middleware emits NO log line on rejection. The over-limit body is
//   never logged. Operators discover over-limit requests through the
//   `413 BODY_TOO_LARGE` response in their access logs.
//
// Webhook exemption (D-CAP-031-A):
//   `/api/v1/webhooks/*` is mounted separately and does not chain this
//   middleware. Provider payloads (inbound email in particular) can
//   legitimately exceed 1 MB and require HMAC signature verification
//   before parsing — see http/routes/webhooks.ts.

import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../../platform/env';
import { DomainError } from '../../platform/errors';

export function enforceBodySize(maxBytes: number): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const contentLength = c.req.header('Content-Length');
    if (contentLength !== undefined && contentLength !== null && contentLength !== '') {
      const declared = Number.parseInt(contentLength, 10);
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new DomainError({
          code: 'BODY_TOO_LARGE',
          message: `Request body exceeds ${maxBytes} bytes`,
          httpStatus: 413,
        });
      }
    }

    // Defense in depth: read the body and measure its byte length.
    // Hono caches the read in bodyCache, so downstream `c.req.text()`
    // calls in route handlers reuse the same value. We do not log the
    // body bytes (R-LOG-001).
    const rawBody = await c.req.text();
    const byteLength = new TextEncoder().encode(rawBody).length;
    if (byteLength > maxBytes) {
      throw new DomainError({
        code: 'BODY_TOO_LARGE',
        message: `Request body exceeds ${maxBytes} bytes`,
        httpStatus: 413,
      });
    }

    await next();
  };
}
