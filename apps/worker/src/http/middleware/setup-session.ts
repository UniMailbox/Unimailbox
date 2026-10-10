// setup-session middleware — R-AUTH-001.
//
// After the operator claims the setup wizard (POST /api/v1/setup/claim),
// they receive a short-lived KV session token. All subsequent setup endpoints
// require this token in the Authorization header: `Bearer <sessionToken>`.
//
// This middleware validates the session token against KV and rejects with
// 401 if the token is missing, invalid, or expired.

import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../../platform/env';
import { DomainError } from '../../platform/errors';

export const setupSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) {
    throw new DomainError({
      code: 'SETUP_SESSION_REQUIRED',
      message: 'Authorization header required',
      httpStatus: 401,
    });
  }

  const token = auth.slice('Bearer '.length);
  const session = await c.env.SETUP_SESSION.get(token);
  if (!session) {
    throw new DomainError({
      code: 'SETUP_SESSION_INVALID',
      message: 'Invalid or expired session',
      httpStatus: 401,
    });
  }

  await next();
};
