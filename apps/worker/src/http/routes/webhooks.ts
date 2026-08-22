// http/routes/webhooks — CAP-024 Brevo webhook receiver + CAP-040 atomic
// audit batch + correlation-id propagation.
//
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
//   3. After verification: parse, resolve messageId, build prepared
//      statements (messages UPDATE + webhook_deliveries INSERT) and
//      APPEND the audit_events INSERT — all three run in one D1 batch
//      (D-CAP-029-A: a webhook status advance and its audit row cannot
//      land in separate writes).
//
// CAP-040 / R-AUDIT-001: the route synthesises the request correlation
// UUID per request (already done by request-id middleware — read it from
// `c.get('requestId')`) and passes it through to the audit row so a
// status transition and its audit row are correlated.
//
// The setup gate still applies (the webhook path is not exempt). In practice
// Brevo only delivers events after the operator has completed setup, so the
// gate is 'complete' before any real event arrives.

import { Hono } from 'hono';
import { verifyAndProcessEvent } from '../../modules/outbound-mail';
import { systemIds } from '../../platform/ids';
import type { AppEnv } from '../../platform/env';
import { sqliteTimestamp } from '../../platform/idempotency';
import { buildAppContext } from '../../app-context';

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

    // CAP-040 / R-AUDIT-001: pull the request correlation UUID the
    // request-id middleware stamped on this request so the audit row
    // carries it through.
    const requestId = c.get('requestId') ?? null;

    const result = await verifyAndProcessEvent({
      db: c.env.DB,
      connectionId,
      rawBody,
      signatureHeader,
    });

    // R-AUDIT-001 + D-CAP-029-A: the messages UPDATE + webhook_deliveries
    // INSERT (returned by the processor) plus the audit_events INSERT run
    // in ONE D1 batch. The outbound-mail module cannot depend on admin
    // (.claude/rules/architecture.md) — the audit writer is the
    // cross-module seam wired through AppContext (composition root).
    const ctx = buildAppContext(c.env);
    const now = sqliteTimestamp(new Date());
    const auditStatement = ctx.auditEventWriter.prepare({
      id: systemIds.uuid(),
      actorUserId: null,
      action: 'webhook.delivered',
      resourceType: 'message',
      resourceId: result.messageId,
      requestId,
      metadata: JSON.stringify({
        connectionId,
        providerMessageId: result.providerMessageId,
      }),
      createdAt: now,
    }).statement;

    await c.env.DB.batch([
      ...result.preparedStatements.statements,
      auditStatement as unknown as D1PreparedStatement,
    ]);

    return c.json({ data: { ok: true } });
  });

  return routes;
}
