// HTTP router — CAP-001 stub.
// Composes middleware and the four middleware handlers (authn, authz,
// request-id, error). Real /api/v1/* routes land with CAP-007+.

import { Hono } from 'hono';
import { requestId } from './middleware/request-id';
import type { AppEnv } from '../platform/env';

export function buildRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.use('*', requestId);
  router.get('/healthz', (c) => c.json({ ok: true, surface: 'router' }));
  return router;
}