// http/routes/webhooks — CAP-024 Brevo webhook receiver + CAP-040 atomic
// audit batch + correlation-id propagation.
//
// Hono sub-app for POST /api/v1/webhooks/:providerKey/:connectionId.
//
// Public endpoint — no authn/authz middleware. Identity is proven by the
// provider-authenticated header (Brevo Bearer token or legacy HMAC-SHA256) per
// .claude/rules/architecture.md §API conventions and
// .claude/rules/security.md §Secrets).
//
// Order of operations is load-bearing:
//   1. Read raw bytes BEFORE any UTF-8 decode or JSON parse.
//   2. Hand rawBody + the provider authentication header to the adapter,
//      which constant-time verifies authentication before parsing JSON.
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
import { DomainError } from '../../platform/errors';
import { parseProviderKey } from '@unimailbox/contracts';
import { providerRegistry } from '../../integrations/providers/provider-registry';

const MAX_WEBHOOK_BODY_BYTES = 65_536;

function assertWebhookBodySize(size: number): void {
  if (size > MAX_WEBHOOK_BODY_BYTES) {
    throw new DomainError({
      code: 'BODY_TOO_LARGE',
      message: 'Webhook body exceeds 64 KiB',
      httpStatus: 413,
    });
  }
}

export function webhookRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /**
   * POST /api/v1/webhooks/:providerKey/:connectionId
   *
   * Body: raw bytes Brevo sent (JSON-shaped, but we verify before parsing).
   * Brevo Authorization: Bearer webhook_secret; legacy X-Webhook-Signature supported.
   */
  routes.post('/webhooks/:providerKey/:connectionId', async (c) => {
    const connectionId = c.req.param('connectionId');
    const providerKey = c.req.param('providerKey');

    // R-INBOUND-SIGNATURE: read raw body BEFORE JSON parse.
    const declaredSize = Number(c.req.header('Content-Length'));
    if (Number.isFinite(declaredSize)) assertWebhookBodySize(declaredSize);
    const rawBody = new Uint8Array(await c.req.arrayBuffer());
    assertWebhookBodySize(rawBody.byteLength);
    const signatureHeader =
      (providerKey === 'brevo' ? c.req.header('Authorization') : undefined) ??
      c.req.header('X-Webhook-Signature') ??
      null;

    // CAP-040 / R-AUDIT-001: pull the request correlation UUID the
    // request-id middleware stamped on this request so the audit row
    // carries it through.
    const requestId = c.get('requestId') ?? null;

    const result = await verifyAndProcessEvent({
      db: c.env.DB,
      connectionId,
      providerKey,
      rawBody,
      signatureHeader,
      adapter: providerRegistry.getWebhook(parseProviderKey(providerKey)),
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
