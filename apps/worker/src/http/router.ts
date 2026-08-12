// HTTP router — composes middleware and route handlers.
// Real /api/v1/* routes land with CAP-007+.

import { Hono } from 'hono';
import { requestId } from './middleware/request-id';
import { setupGate } from './middleware/setup-gate';
import { setupRoutes } from './routes/setup';
import type { AppEnv } from '../platform/env';

export function buildRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // Infrastructure middleware first, then gates, then routes.
  router.use('*', requestId);
  router.use('*', setupGate);

  // R-SETUP-003: /healthz is exempt from the setup gate and always reachable.
  router.get('/healthz', (c) => c.json({ ok: true, surface: 'router' }));

  // Setup API routes.
  router.route('/api/v1/setup', setupRoutes());

  return router;
}
