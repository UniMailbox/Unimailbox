// authz middleware — requirePermission(key) for route-level authorization.
// CAP-017 implements the real permission check middleware.
//
// The middleware reads `userId` from the Hono context (set by the authn middleware
// in CAP-019) and checks if the user has the required permission.
//
// Without authn middleware (CAP-019), `c.get('userId')` will always be undefined,
// so requirePermission will always return 401. This is correct behavior — no route
// uses this middleware until CAP-019 wires authentication.

import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../../platform/env';
import type { PermissionKey } from '@unimailbox/contracts';
import { DomainError } from '../../platform/errors';
import { checkPermission } from '../../modules/admin';

/**
 * Creates a middleware that requires a specific permission.
 *
 * - If `userId` is missing from context → 401 AUTHENTICATION_REQUIRED
 * - If user lacks the permission → 403 PERMISSION_DENIED
 * - Otherwise → passes through to the next handler
 *
 * @param key — The PermissionKey required to access the route
 * @returns Hono middleware handler
 *
 * @example
 * ```ts
 * app.get('/api/v1/messages', requirePermission('message.read'), handler);
 * ```
 */
export function requirePermission(key: PermissionKey): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const userId = c.get('userId');
    if (!userId || typeof userId !== 'string') {
      throw new DomainError({
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication required',
        httpStatus: 401,
      });
    }

    if (c.get('mustChangePassword') === true) {
      throw new DomainError({
        code: 'PASSWORD_CHANGE_REQUIRED',
        message: 'Password change required',
        httpStatus: 403,
      });
    }

    const hasPermission = await checkPermission(c.env.DB, userId, key);
    if (!hasPermission) {
      throw new DomainError({
        code: 'PERMISSION_DENIED',
        message: `Permission denied: ${key}`,
        httpStatus: 403,
      });
    }

    await next();
  };
}
