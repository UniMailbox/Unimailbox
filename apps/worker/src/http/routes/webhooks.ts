// http/routes/webhooks — CAP-024 Brevo webhook receiver.
// Hono sub-app for POST /api/v1/webhooks/:providerKey/:connectionId.
//
// Public endpoint — no authn/authz middleware. Identity is proven by the
// HMAC-SHA256 signature over the raw body (R-INBOUND-SIGNATURE per
// .claude/rules/architecture.md §API conventions and
// .claude/rules/security.md §Secrets).
//
// Order of operations is load-bearing:
//   1. Read the raw body as text (c.req.text()) BEFORE any JSON parse.
//   2. Hand rawBody + X-Webhook-Signature to verifyAndProcessEvent, which
//      recomputes HMAC over the same bytes and constant-time compares before
//      calling JSON.parse.
//   3. Only after verification: parse, update message status, store the
//      webhook_deliveries row.
//
// The setup gate still applies (the webhook path is not exempt). In practice
// Brevo only delivers events after the operator has completed setup, so the
// gate is 'complete' before any real event arrives.

import { Hono } from 'hono';
import { verifyAndProcessEvent } from '../../modules/outbound-mail';
import type { AppEnv } from '../../platform/env';

export function webhookRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /**
   * POST /api/v1/webhooks/:providerKey/:connectionId
   *
   * Body: raw bytes Brevo sent (JSON-shaped, but we verify before parsing).
   * Header X-Webhook-Signature: hex HMAC-SHA256(rawBody, webhook_secret).
   */
  routes.post('/webhooks/:providerKey/:connectionId', async (c) => {
    const connectionId = c.req.param('connectionId');
    // providerKey is parsed but unused in Phase 1: Brevo is the only
    // outbound provider, so connectionId uniquely identifies the secret.
    // A future provider dispatch will branch on it.

    // R-INBOUND-SIGNATURE: read raw body BEFORE JSON parse.
    const rawBody = await c.req.text();
    const signatureHeader = c.req.header('X-Webhook-Signature') ?? null;

    await verifyAndProcessEvent({
      db: c.env.DB,
      connectionId,
      rawBody,
      signatureHeader,
    });

    return c.json({ data: { ok: true } });
  });

  return routes;
}
