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

  // GET / — serves the minimal HTML app shell when installation is complete.
  // The setup gate (setup-gate middleware) ensures this is only reachable
  // when installation_state.status === 'complete'. Before that, it redirects
  // to /setup.
  router.get('/', (c) => {
    // Minimal HTML shell — the setup gate ensures this is only reachable
    // when installation_state.status === 'complete'.
    return c.html(
      '<!DOCTYPE html><html><head><title>Unimailbox</title></head><body><div id="root"></div><script type="module" src="/assets/index.js"></script></body></html>',
    );
  });

  // Setup API routes.
  router.route('/api/v1/setup', setupRoutes());

  return router;
}
