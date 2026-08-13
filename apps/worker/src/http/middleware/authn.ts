// authn middleware — CAP-019 authentication.
//
// Reads Authorization: Bearer <token> header, looks up the token in CACHE KV,
// and sets c.set('userId', userId) if valid.
//
// This middleware is applied globally (after setupGate) but does NOT block
// unauthenticated requests — requirePermission handles that. A request without
// a valid token proceeds with userId unset, and requirePermission returns 401.
//
// R-AUTH-007: Access tokens are UUIDs stored in KV with 15-minute TTL.
// R-SECRET-003: Tokens are never logged.

import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../../platform/env';

/**
 * Authentication middleware.
 *
 * - Reads `Authorization: Bearer <token>` from the request header
 * - Looks up `auth:{token}` in CACHE KV
 * - If found and valid, sets `c.set('userId', parsed.userId)`
 * - Always calls next() — does not block unauthenticated requests
 *
 * Applied globally in router.ts after setupGate. Protected routes use
 * requirePermission middleware to check both authentication and authorization.
 */
export const authn: MiddlewareHandler<AppEnv> = async (c, next) => {
  const authHeader = c.req.header('Authorization');

  // Check for Bearer token
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length);

    // Look up the token in CACHE KV
    const data = await c.env.CACHE.get(`auth:${token}`);

    if (data) {
      try {
        const parsed = JSON.parse(data) as { userId: string };
        // Set userId in context for requirePermission to read
        c.set('userId', parsed.userId);
      } catch {
        // Invalid JSON in KV — ignore and proceed without auth
        // This prevents a corrupted KV entry from breaking all requests
      }
    }
  }

  await next();
};
