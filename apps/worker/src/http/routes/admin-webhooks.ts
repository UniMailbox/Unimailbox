// http/routes/admin-webhooks — CAP-025 admin webhook events view.
// Hono sub-app for /api/v1/admin/webhook-events and /api/v1/admin/connections.
//
// R-AUTHZ-001: Admin endpoints require 'webhook_event.read' permission.
// R-AUTHZ-002: Authorization checks hit the database per request.
//
// These are read-only list endpoints that surface webhook delivery history
// and provider-connection webhook configuration to the operator dashboard.

import { Hono } from 'hono';
import { requirePermission } from '../middleware/authz';
import {
  listWebhookDeliveries,
  listProviderConnections,
} from '../../modules/outbound-mail';
import type { AppEnv } from '../../platform/env';

export function adminWebhookRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /**
   * GET /api/v1/admin/webhook-events
   *
   * List recent webhook deliveries, newest first. Returns event metadata
   * (id, connection_id, event_type, message_id, status, created_at) without
   * the raw payload — the list view does not need provider body content.
   *
   * - Requires authn + requirePermission('webhook_event.read')
   */
  routes.get(
    '/admin/webhook-events',
    requirePermission('webhook_event.read'),
    async (c) => {
      const deliveries = await listWebhookDeliveries(c.env.DB);
      return c.json({ data: { items: deliveries } });
    },
  );

  /**
   * GET /api/v1/admin/connections
   *
   * List provider connections with their webhook configuration. Includes the
   * webhook URL and webhook secret so the operator can copy them into the
   * provider dashboard. The webhook_secret is a random signing key (not a
   * user password or provider API key) and is safe to display to admins who
   * already hold the webhook_event.read permission.
   *
   * - Requires authn + requirePermission('webhook_event.read')
   */
  routes.get(
    '/admin/connections',
    requirePermission('webhook_event.read'),
    async (c) => {
      const connections = await listProviderConnections(c.env.DB);
      const items = connections.map((conn) => ({
        id: conn.id,
        providerKey: conn.provider_key,
        label: conn.label,
        status: conn.status,
        webhookSecret: conn.webhook_secret,
        webhookUrl: conn.webhook_secret
          ? `/api/v1/webhooks/${conn.provider_key}/${conn.id}`
          : null,
        createdAt: conn.created_at,
        updatedAt: conn.updated_at,
      }));
      return c.json({ data: { items } });
    },
  );

  return routes;
}
