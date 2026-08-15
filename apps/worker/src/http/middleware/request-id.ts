// request-id middleware — CAP-032 / D-CAP-032-A.
//
// Generates a UUIDv4 for every request, sets it on `c.set('requestId', id)`
// so downstream middleware/handlers can read it via `c.get('requestId')`,
// and echoes it back on the response as the `X-Request-Id` header so the
// same value is observable from both the client and the log line.
//
// Mounted as the FIRST middleware in http/router.ts (before setupGate
// and authn) so rejected requests still carry an id (R-API-001).
//
// R-LOG-001: requestId is a UUID, never a body digest.
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../../platform/env';
import { systemIds } from '../../platform/ids';

export const requestId: MiddlewareHandler<AppEnv> = async (c, next) => {
  const id = systemIds.uuid();
  c.set('requestId', id);
  c.header('X-Request-Id', id);
  await next();
};