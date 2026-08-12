// authz middleware — CAP-001 stub.
// requirePermission(key) lands with the admin module (Phase 1).
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../../platform/env';

export const authz: MiddlewareHandler<AppEnv> = async (_c, next) => {
  await next();
};