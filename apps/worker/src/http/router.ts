// HTTP router — composes middleware and route handlers.
// Real /api/v1/* routes land with CAP-007+.

import { Hono } from 'hono';
import { requestId } from './middleware/request-id';
import { setupGate } from './middleware/setup-gate';
import { authn } from './middleware/authn';
import { setupRoutes } from './routes/setup';
import { authRoutes } from './routes/auth';
import { adminRoutes } from './routes/admin';
import { mailboxRoutes } from './routes/mailboxes';
import { messageRoutes } from './routes/messages';
import { composeRoutes } from './routes/compose';
import type { AppEnv } from '../platform/env';

export function buildRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // Infrastructure middleware first, then gates, then authn, then routes.
  router.use('*', requestId);
  router.use('*', setupGate);
  router.use('*', authn); // CAP-019: sets userId if valid token present

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

  // CAP-019: Auth and admin API routes.
  router.route('/api/v1/auth', authRoutes());
  router.route('/api/v1/admin', adminRoutes());

  // CAP-020: Mailbox routes.
  router.route('/api/v1', mailboxRoutes());

  // CAP-022: Message routes (inbox list, detail, mark-as-read).
  router.route('/api/v1', messageRoutes());

  // CAP-023: Compose (send) routes.
  router.route('/api/v1', composeRoutes());

  return router;
}
