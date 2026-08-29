// HTTP router — composes middleware and route handlers.
// Real /api/v1/* routes land with CAP-007+.
//
// CAP-031 / R-API-005: every `/api/v1/*` request body is capped at 1 MB by
// `enforceBodySize`, except `/api/v1/webhooks/*` (D-CAP-031-A — provider
// payloads can legitimately exceed 1 MB and require HMAC verification over
// the raw bytes before parsing), and `/api/v1/auth/better/*` (D-CAP-042-A
// — Better Auth owns its own body validation, and the sign-in / get-session
// / sign-out payloads are well under 1 MB; mounting the cap on a parent
// sub-app would consume the raw body and break Better Auth's `c.req.raw.json()`
// reader, surfaced as a 500 with an empty body).
//
// The router composition follows those exceptions literally:
//   - `apiV1` sub-app chains `enforceBodySize(1024*1024)` for ordinary API
//     routes.
//   - `attachmentV1` is mounted before `apiV1`; its raw-binary route performs
//     a binary-safe 5 MiB declared/actual byte check (CAP-049).
//   - `betterAuthRoutes()` is mounted inside `apiV1` but its handler
//     rebuilds a Request from the cached body that `enforceBodySize`
//     has already materialised (see `http/routes/better-auth.ts`).
//   - `webhookV1` is a sibling sub-app that does NOT chain the body limit;
//     it mounts `/api/v1/webhooks/*` only.
// `requestId`, `setupGate`, `authn`, and `config` are still applied
// globally to every sub-app because those policies are not body-size
// related.
//
// CAP-039 — Deployment substrate: the hand-written HTML shell that
// referenced `/assets/index.js` (a path that no longer exists after Vite
// hashed the bundle) is gone. SPA fallback is provided by the wrangler
// `assets` block + `not_found_handling: "single-page-application"`; the
// router mounts the catch-all AFTER `/api/v1` sub-apps so non-API GETs
// fall through to `env.ASSETS` and `/api/v1/*` always reaches the API.

import { Hono } from 'hono';
import { requestId } from './middleware/request-id';
import { setupGate } from './middleware/setup-gate';
import { authn } from './middleware/authn';
import { enforceBodySize } from './middleware/body-size';
import { config as configMiddleware } from './middleware/config';
import { setupRoutes } from './routes/setup';
import { authRoutes } from './routes/auth';
import { adminRoutes } from './routes/admin';
import { adminBlocklistRoutes } from './routes/admin-blocklist';
import { adminRolePolicyRoutes } from './routes/admin-role-policies';
import { adminWebhookRoutes } from './routes/admin-webhooks';
import { adminAuditEventRoutes } from './routes/admin-audit-events';
import { adminUserRoutes } from './routes/admin-users';
import { mailboxRoutes } from './routes/mailboxes';
import { messageRoutes } from './routes/messages';
import { composeRoutes } from './routes/compose';
import { draftRoutes } from './routes/drafts';
import { attachmentRoutes } from './routes/attachments';
import { webhookRoutes } from './routes/webhooks';
import { betterAuthRoutes } from './routes/better-auth';
import type { AppEnv } from '../platform/env';

const BODY_SIZE_LIMIT_BYTES = 1024 * 1024;

export function buildRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // Infrastructure middleware first, then gates, then authn, then routes.
  // Body-size enforcement is per-sub-app (see apiV1 / webhookV1 / betterAuthV1).
  // Order matters: `config` must run before `authn` so the conflict
  // check in `authn` has access to `c.var.config` (CAP-042 AC 14).
  router.use('*', requestId);
  router.use('*', setupGate);
  router.use('*', configMiddleware);
  router.use('*', authn); // CAP-019 + CAP-042: sets userId from Bearer and/or Better Auth cookie

  // R-SETUP-003: /healthz is exempt from the setup gate and always reachable.
  router.get('/healthz', (c) => c.json({ ok: true, surface: 'router' }));

  // CAP-031 / R-API-005: `/api/v1/*` body-size enforcement. Mounted on the
  // `/api/v1` path so every sub-app route chained below it inherits the
  // 1 MB cap. Webhooks and the Better Auth shadow handler are
  // intentionally NOT in this sub-app — see `webhookV1` and
  // `betterAuthV1` below for the exempt siblings.
  const apiV1 = new Hono<AppEnv>();
  apiV1.use('*', enforceBodySize(BODY_SIZE_LIMIT_BYTES));

  // CAP-049: attachments accept binary bodies up to 5 MiB. Mount this
  // sibling before the general apiV1 app so its terminal handler runs without
  // the text-reading 1 MiB middleware. The route performs a binary-safe
  // Content-Length precheck and actual ArrayBuffer byte-length check.
  const attachmentV1 = new Hono<AppEnv>();
  attachmentV1.route('/', attachmentRoutes());

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

  // CAP-044 Slice 2 (D-CAP-044-E, CAP-033 absorbed): audit-event query API.
  // Same mount style as adminWebhookRoutes — paths are fully qualified
  // inside the sub-app (/admin/audit-events).
  apiV1.route('/', adminAuditEventRoutes());

  // CAP-044 Slice 3 (AC 17): admin users-list API, served by the identity
  // module's public listUsers (D-CAP-044-H). Same mount style as the
  // audit-event routes (/admin/users).
  apiV1.route('/', adminUserRoutes());

  // CAP-020: Mailbox routes.
  apiV1.route('/', mailboxRoutes());

  // CAP-022: Message routes (inbox list, detail, mark-as-read).
  apiV1.route('/', messageRoutes());

  // CAP-023: Compose (send) routes.
  apiV1.route('/', composeRoutes());

  // CAP-047 server draft-create slice: POST /api/v1/mailboxes/:mailboxId/drafts.
  // Mounted next to compose so the create-draft route shares the same
  // body-size cap and middleware chain.
  apiV1.route('/', draftRoutes());

  // D-CAP-031-A: Webhooks. Sibling sub-app that does NOT chain the body
  // limit. Provider HMAC signatures are computed over the raw bytes and
  // some providers ship payloads > 1 MB.
  const webhookV1 = new Hono<AppEnv>();
  webhookV1.route('/', webhookRoutes());

  // CAP-042 (AC 12): Better Auth shadow handler at `/api/v1/auth/better/*`.
  // Mounted inside `apiV1` so the 1 MB body cap still applies, but the
  // route handler rebuilds the request from the cached body that
  // `enforceBodySize` has already materialised — see
  // `http/routes/better-auth.ts` for why this is necessary (D-CAP-042-A).
  //
  // Path: `/auth/better/*` (NOT a bare `*`). A bare `*` would shadow the
  // sibling `webhookV1` routes mounted at `/api/v1/webhooks/*` because
  // Hono dispatches `apiV1` first and a wildcard inside apiV1 catches
  // every other `/api/v1/*` path before the sibling sub-app has a
  // chance. Pinning the mount at `/auth/better/*` keeps the wildcard
  // inside the route handler (Better Auth's path dispatch) while
  // leaving other sub-app routes untouched.
  apiV1.route('/auth/better', betterAuthRoutes());

  router.route('/api/v1', attachmentV1);
  router.route('/api/v1', apiV1);
  router.route('/api/v1', webhookV1);

  // CAP-039: SPA fallback. Mounted AFTER the /api/v1 sub-apps so /api/v1/*
  // never reaches the asset binding. The wrangler `assets` block +
  // `not_found_handling: "single-page-application"` serves `index.html`
  // for any non-API GET the binding can't resolve; the catch-all below
  // forwards to env.ASSETS so the platform can apply the SPA fallback.
  // Non-GET methods and /api/v1/* paths return c.notFound() — defense
  // in depth; `run_worker_first: ["/api/*"]` at the wrangler level is
  // the real enforcement.
  router.get('*', async (c) => {
    // Only forward GETs; HEAD/POST/etc. fall through to a 404 (the
    // non-API contract for non-GET client requests doesn't exist today,
    // and exposing env.ASSETS to them would leak a write surface).
    if (c.req.method !== 'GET') {
      return c.notFound();
    }
    // `/api/v1/*` is owned by the apiV1/webhookV1/betterAuthV1 sub-apps.
    // A path under it that has no matching route (e.g. `/api/v1/setup/`)
    // is a real 404, not a client route — never forward to the asset
    // binding.
    if (c.req.path.startsWith('/api/v1')) {
      return c.notFound();
    }
    return c.env.ASSETS.fetch(c.req.raw);
  });

  return router;
}
