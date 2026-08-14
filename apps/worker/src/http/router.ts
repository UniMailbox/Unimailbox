// HTTP router — composes middleware and route handlers.
// Real /api/v1/* routes land with CAP-007+.
//
// CAP-031 / R-API-005: every `/api/v1/*` request body is capped at 1 MB by
// `enforceBodySize`, except `/api/v1/webhooks/*` (D-CAP-031-A — provider
// payloads can legitimately exceed 1 MB and require HMAC verification over
// the raw bytes before parsing).
//
// The router composition follows that exception literally:
//   - `apiV1` sub-app chains `enforceBodySize(1024*1024)` and mounts every
//     non-webhook `/api/v1/*` route.
//   - `webhookV1` sub-app is a sibling that does NOT chain the body limit;
//     it mounts `/api/v1/webhooks/*` only.
// `requestId`, `setupGate`, and `authn` are still applied globally to
// both sub-apps because those policies are not body-size related.

import { Hono } from 'hono';
import { requestId } from './middleware/request-id';
import { setupGate } from './middleware/setup-gate';
import { authn } from './middleware/authn';
import { enforceBodySize } from './middleware/body-size';
import { setupRoutes } from './routes/setup';
import { authRoutes } from './routes/auth';
import { adminRoutes } from './routes/admin';
import { adminBlocklistRoutes } from './routes/admin-blocklist';
import { adminRolePolicyRoutes } from './routes/admin-role-policies';
import { adminWebhookRoutes } from './routes/admin-webhooks';
import { mailboxRoutes } from './routes/mailboxes';
import { messageRoutes } from './routes/messages';
import { composeRoutes } from './routes/compose';
import { webhookRoutes } from './routes/webhooks';
import type { AppEnv } from '../platform/env';

const BODY_SIZE_LIMIT_BYTES = 1024 * 1024;

export function buildRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // Infrastructure middleware first, then gates, then authn, then routes.
  // Body-size enforcement is per-sub-app (see apiV1 / webhookV1 below).
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

  // CAP-031 / R-API-005: `/api/v1/*` body-size enforcement. Mounted on the
  // `/api/v1` path so every sub-app route chained below it inherits the
  // 1 MB cap. Webhooks are intentionally NOT in this sub-app — see
  // `webhookV1` below for the exempt sibling (D-CAP-031-A).
  const apiV1 = new Hono<AppEnv>();
  apiV1.use('*', enforceBodySize(BODY_SIZE_LIMIT_BYTES));

  // Setup API routes — mounted under the body-size-limited sub-app so setup
  // POST endpoints respect the 1 MB cap.
  apiV1.route('/setup', setupRoutes());

  // CAP-019: Auth and admin API routes.
  apiV1.route('/auth', authRoutes());
  apiV1.route('/admin', adminRoutes());

  // D-CAP-021 / CAP-035: blocklist + per-role policies.
  // Mounted under /api/v1/admin so the route paths inside the sub-apps
  // resolve to /api/v1/admin/blocklist* and /api/v1/admin/roles/:id/policy.
  apiV1.route('/admin', adminBlocklistRoutes());
  apiV1.route('/admin', adminRolePolicyRoutes());

  // CAP-025: Admin webhook events + connections view.
  apiV1.route('/', adminWebhookRoutes());

  // CAP-020: Mailbox routes.
  apiV1.route('/', mailboxRoutes());

  // CAP-022: Message routes (inbox list, detail, mark-as-read).
  apiV1.route('/', messageRoutes());

  // CAP-023: Compose (send) routes.
  apiV1.route('/', composeRoutes());

  // D-CAP-031-A: Webhooks. Sibling sub-app that does NOT chain the body
  // limit. Provider HMAC signatures are computed over the raw bytes and
  // some providers ship payloads > 1 MB.
  const webhookV1 = new Hono<AppEnv>();
  webhookV1.route('/', webhookRoutes());

  router.route('/api/v1', apiV1);
  router.route('/api/v1', webhookV1);

  return router;
}
