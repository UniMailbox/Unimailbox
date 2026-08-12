// request-id middleware — CAP-001 stub.
// Real implementation lands with CAP-007 (binds a UUIDv4 onto every request
// for log correlation and audit-event tracing).
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../../platform/env';

export const requestId: MiddlewareHandler<AppEnv> = async (_c, next) => {
  await next();
};