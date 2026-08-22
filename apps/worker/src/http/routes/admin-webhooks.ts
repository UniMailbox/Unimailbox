// http/routes/admin-webhooks — CAP-025 admin webhook events view + CAP-040
// R-SECRET-003 closure (no `webhook_secret` in the list response) +
// CAP-040 webhook secret reveal endpoint.
//
// Hono sub-app for /api/v1/admin/webhook-events, /api/v1/admin/connections,
// and POST /api/v1/admin/connections/:id/webhook-secret/reveal.
//
// R-AUTHZ-001: Admin endpoints require 'webhook_event.read' permission for
// the list endpoints and 'provider.sync' for the reveal endpoint.
// R-AUTHZ-002: Authorization checks hit the database per request.
// R-AUTHZ-004: the reveal endpoint scopes its lookup to a single
// connectionId supplied in the URL; it does NOT widen to "all secrets".
// R-SECRET-003: secret material is NEVER returned in the list response. It
// is only returned by the explicit reveal endpoint, which writes an audit
// row (R-AUDIT-001) on every call.

import { Hono } from 'hono';
import { requirePermission } from '../middleware/authz';
import {
  listWebhookDeliveries,
  listProviderConnections,
  getWebhookSecretForConnection,
} from '../../modules/outbound-mail';
import { createAuditEvent } from '../../modules/admin';
import { systemIds } from '../../platform/ids';
import { sqliteTimestamp } from '../../platform/idempotency';
import { DomainError } from '../../platform/errors';
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
  routes.get('/admin/webhook-events', requirePermission('webhook_event.read'), async (c) => {
    const deliveries = await listWebhookDeliveries(c.env.DB);
    return c.json({ data: { items: deliveries } });
  });

  /**
   * GET /api/v1/admin/connections
   *
   * List provider connections with their webhook configuration.
   *
   * CAP-040 / R-SECRET-003: this endpoint no longer returns `webhookSecret`.
   * The previous behaviour mapped the raw `webhook_secret` column onto the
   * response, leaking signing-key material on every list call. The list
   * now surfaces `webhookConfigured` (boolean) and `webhookUrl`; the secret
   * itself is reachable through the explicit reveal endpoint.
   *
   * - Requires authn + requirePermission('webhook_event.read')
   */
  routes.get('/admin/connections', requirePermission('webhook_event.read'), async (c) => {
    const connections = await listProviderConnections(c.env.DB);
    const items = connections.map((conn) => ({
      id: conn.id,
      providerKey: conn.provider_key,
      label: conn.label,
      status: conn.status,
      webhookConfigured: conn.webhook_configured === 1,
      webhookUrl: conn.webhook_configured
        ? `/api/v1/webhooks/${conn.provider_key}/${conn.id}`
        : null,
      createdAt: conn.created_at,
      updatedAt: conn.updated_at,
    }));
    return c.json({ data: { items } });
  });

  /**
   * POST /api/v1/admin/connections/:id/webhook-secret/reveal
   *
   * Reveal the webhook signing key for one provider connection. The list
   * endpoint intentionally does NOT return secrets; an operator who needs
   * to copy the value into the provider dashboard (Brevo, Resend, ...)
   * calls this endpoint explicitly. Every call writes an audit row
   * (`webhook_secret.reveal`, R-AUDIT-001 / R-SECRET-003) so a leaked
   * operator token cannot silently exfiltrate the secret without an audit
   * trail.
   *
   * - Requires authn + requirePermission('provider.sync') — the same
   *   permission that authorises connection-level write operations.
   * - Scoped to one connectionId from the URL (R-AUTHZ-004).
   */
  routes.post(
    '/admin/connections/:id/webhook-secret/reveal',
    requirePermission('provider.sync'),
    async (c) => {
      const userId = c.get('userId');
      if (!userId) {
        throw new DomainError({
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication required',
          httpStatus: 401,
        });
      }
      const connectionId = c.req.param('id');
      if (!connectionId) {
        throw new DomainError({
          code: 'VALIDATION_ERROR',
          message: 'connection id path param required',
          httpStatus: 400,
        });
      }
      const requestId = c.get('requestId') ?? null;
      const row = await getWebhookSecretForConnection(c.env.DB, connectionId);
      // R-AUDIT-001: every reveal writes an audit row. The actor is the
      // authenticated user; the resource is the connection; the metadata
      // carries the connectionId only (NOT the secret — R-LOG-001).
      await createAuditEvent(c.env.DB, {
        id: systemIds.uuid(),
        actorUserId: userId,
        action: 'webhook_secret.reveal',
        resourceType: 'provider_connection',
        resourceId: connectionId,
        requestId,
        metadata: JSON.stringify({
          connectionId,
          providerKey: row.provider_key,
        }),
        createdAt: sqliteTimestamp(new Date()),
      });
      return c.json({
        data: {
          id: row.id,
          providerKey: row.provider_key,
          label: row.label,
          webhookSecret: row.webhook_secret,
        },
      });
    },
  );

  return routes;
}
