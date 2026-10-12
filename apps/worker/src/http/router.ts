// HTTP router — composes middleware and route handlers.
//
// CAP-031: ordinary JSON API bodies are capped at 1 MiB by enforceBodySize.
// Provider webhooks authenticate through their adapter before payload parsing.
// Raw attachment/editor/avatar uploads apply route-specific binary limits;
// editor file limits follow the system attachment policy.
//
// The router composition follows those exceptions literally:
//   - `apiV1` sub-app chains `enforceBodySize(1024*1024)` for ordinary API
//     routes.
//   - `attachmentV1` is mounted before `apiV1`; its raw-binary route performs
//     declared/actual byte checks with the route-specific upload policy.
//   - `webhookV1` is a sibling sub-app that does NOT chain the body limit;
//     it mounts `/api/v1/webhooks/*` only.
// `requestId`, `setupGate`, `authn`, and `config` are still applied
// globally to every sub-app because those policies are not body-size
// related.
//
// Asset-first routing serves existing static files. The Worker supplies the SPA
// shell only for browser routes; missing API paths/files remain real 404s.

import { Hono } from 'hono';
import { requestId } from './middleware/request-id';
import { setupGate } from './middleware/setup-gate';
import { authn } from './middleware/authn';
import { enforceBodySize } from './middleware/body-size';
import { config as configMiddleware } from './middleware/config';
import { setupRoutes } from './routes/setup';
import { personalSettingsRoutes, personalAvatarRoutes } from './routes/personal-settings';
import { authRoutes } from './routes/auth';
import { adminRoutes } from './routes/admin';
import { adminBlocklistRoutes } from './routes/admin-blocklist';
import { adminRolePolicyRoutes } from './routes/admin-role-policies';
import { adminWebhookRoutes } from './routes/admin-webhooks';
import { adminAuditEventRoutes } from './routes/admin-audit-events';
import { adminUserRoutes } from './routes/admin-users';
import { adminDomainRoutes } from './routes/admin-domains';
import { adminRoleRoutes } from './routes/admin-roles';
import { adminSignatureRoutes } from './routes/admin-signatures';
import { adminAiRoutes } from './routes/admin-ai';
import { aiReplyRoutes } from './routes/ai-reply';
import { adminSettingsRoutes } from './routes/admin-settings';
import { adminOverviewRoutes } from './routes/admin-overview';
import { adminUserMailboxRoutes } from './routes/admin-user-mailboxes';
import { mailboxRoutes } from './routes/mailboxes';
import { messageRoutes } from './routes/messages';
import { composeRoutes } from './routes/compose';
import { draftRoutes } from './routes/drafts';
import { scheduledSendRoutes } from './routes/scheduled-sends';
import { editorAssetRoutes } from './routes/editor-assets';
import { attachmentRoutes } from './routes/attachments';
import { webhookRoutes } from './routes/webhooks';
import type { AppEnv } from '../platform/env';

const BODY_SIZE_LIMIT_BYTES = 1024 * 1024;

export function buildRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // Infrastructure middleware first, then gates, then authn, then routes.
  // Body-size enforcement is per-sub-app (see apiV1 / webhookV1).
  // Keep configuration validation before application-owned authentication.
  router.use('*', requestId);
  router.use('*', setupGate);
  router.use('*', configMiddleware);
  router.use('*', authn); // Sets userId only from a Bearer token bound to an active D1 session.

  // CAP-031: `/api/v1/*` body-size enforcement. Mounted on the
  // `/api/v1` path so every sub-app route chained below it inherits the
  // 1 MB cap. Webhooks and binary attachments use sibling sub-apps.
  const apiV1 = new Hono<AppEnv>();
  apiV1.use('*', enforceBodySize(BODY_SIZE_LIMIT_BYTES));

  // Binary uploads use route-specific limits. Mount this
  // sibling before the general apiV1 app so its terminal handler runs without
  // the text-reading 1 MiB middleware. The route performs a binary-safe
  // length precheck and actual byte-length check (streaming for editor assets).
  const attachmentV1 = new Hono<AppEnv>();
  attachmentV1.route('/', personalAvatarRoutes());
  attachmentV1.route('/', attachmentRoutes());
  attachmentV1.route('/', editorAssetRoutes());

  // Setup API routes — mounted under the body-size-limited sub-app so setup
  // POST endpoints respect the 1 MB cap.
  apiV1.route('/setup', setupRoutes());

  // CAP-019: Auth and admin API routes.
  apiV1.route('/auth', authRoutes());
  apiV1.route('/', personalSettingsRoutes());
  apiV1.route('/admin', adminRoutes());

  // D-CAP-021 / CAP-035: blocklist + per-role policies.
  // Mounted under /api/v1/admin so the route paths inside the sub-apps
  // resolve to /api/v1/admin/blocklist* and /api/v1/admin/roles/:id/policy.
  apiV1.route('/admin', adminBlocklistRoutes());
  apiV1.route('/admin', adminRolePolicyRoutes());

  // CAP-025: Admin webhook events + connections view.
  apiV1.route('/', adminWebhookRoutes());

  // CAP-044 Slice 2 (D-CAP-044-E, CAP-033 absorbed): audit-event query API.
  // Same mount style as adminWebhookRoutes — paths are fully qualified
  // inside the sub-app (/admin/audit-events).
  apiV1.route('/', adminAuditEventRoutes());

  // CAP-044 Slice 3 (AC 17): admin users-list API, served by the identity
  // module's public listUsers (D-CAP-044-H). Same mount style as the
  // audit-event routes (/admin/users).
  apiV1.route('/', adminUserRoutes());
  apiV1.route('/', adminUserMailboxRoutes());

  // CAP-066: managed-domain administration. Paths are fully qualified
  // inside the sub-app (/admin/domains*) like the users/audit routes above.
  apiV1.route('/', adminDomainRoutes());

  // CAP-067: custom-role definitions and the closed permission catalog.
  apiV1.route('/', adminRoleRoutes());

  // CAP-068: one sanitized signature per managed domain.
  apiV1.route('/', adminSignatureRoutes());

  // CAP-069: typed, allowlisted global system settings.
  apiV1.route('/', adminSettingsRoutes());
  apiV1.route('/', adminAiRoutes());
  apiV1.route('/', adminOverviewRoutes());

  // CAP-020: Mailbox routes.
  apiV1.route('/', mailboxRoutes());

  // CAP-022: Message routes (inbox list, detail, mark-as-read).
  apiV1.route('/', messageRoutes());

  // CAP-023: Compose (send) routes.
  apiV1.route('/', composeRoutes());
  apiV1.route('/', aiReplyRoutes());

  // CAP-047 server draft-create slice: POST /api/v1/mailboxes/:mailboxId/drafts.
  // Mounted next to compose so the create-draft route shares the same
  // body-size cap and middleware chain.
  apiV1.route('/', draftRoutes());
  apiV1.route('/', scheduledSendRoutes());

  // D-CAP-031-A: Webhooks. Sibling sub-app that does NOT chain the body
  // limit. Provider HMAC signatures are computed over the raw bytes and
  // some providers ship payloads > 1 MB.
  const webhookV1 = new Hono<AppEnv>();
  webhookV1.route('/', webhookRoutes());

  router.route('/api/v1', attachmentV1);
  router.route('/api/v1', apiV1);
  router.route('/api/v1', webhookV1);

  // Static files are served by the asset layer first. Only actual browser routes
  // receive the SPA shell; unknown API paths and missing files keep their 404.
  router.get('*', async (c) => {
    if (c.req.path === '/api' || c.req.path.startsWith('/api/') || /\.[^/]+$/.test(c.req.path))
      return c.notFound();
    const url = new URL(c.req.url);
    url.pathname = '/';
    url.search = '';
    return c.env.ASSETS.fetch(new Request(url, c.req.raw));
  });

  return router;
}
