// authn middleware — CAP-001 stub.
// Real bearer-token verification lands with the identity module (Phase 1).
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../../platform/env';

export const authn: MiddlewareHandler<AppEnv> = async (_c, next) => {
  await next();
};