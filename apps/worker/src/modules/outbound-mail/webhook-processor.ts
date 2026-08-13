// webhook-processor — verify HMAC-SHA256 signature, parse, update message
// status, persist a webhook_deliveries row. CAP-024. Owner: outbound-mail
// module. Private file — export through modules/outbound-mail/index.ts.
//
// R-INBOUND-SIGNATURE (.claude/rules/architecture.md §API conventions,
// .claude/rules/security.md §Secrets): signature verification runs BEFORE
// JSON.parse. The raw body is the canonical input to HMAC; parsing first
// would expose the parser to attacker-controlled bytes that have not been
// authenticated.

import type { Database } from '../../platform/database';
import { constantTimeCompare } from '../../platform/crypto';
import { DomainError } from '../../platform/errors';
import { systemIds } from '../../platform/ids';
import {
  createWebhookDelivery,
  findJobByProviderMessageId,
  getProviderConnection,
} from './webhook-repository';

export interface VerifyAndProcessEventInput {
  readonly db: Database;
  readonly connectionId: string;
  readonly rawBody: string;
  readonly signatureHeader: string | null;
}

/** Maps Brevo's event names onto our messages.status CHECK values. */
function mapEventToMessageStatus(event: string | undefined): string {
  switch (event) {
    case 'delivered':
      return 'delivered';
    case 'bounce':
    case 'hard_bounce':
    case 'soft_bounce':
      return 'bounced';
    case 'complaint':
    case 'spam':
      return 'complained';
    case 'delayed':
    case 'blocked':
      return 'delayed';
    default:
      // Unknown event → delivered is the safe default; we still persist the
      // raw payload so an operator can audit / correct later.
      return 'delivered';
  }
}

/**
 * Verifies the HMAC-SHA256 signature of `rawBody` against the connection's
 * stored `webhook_secret`, parses the JSON only after verification succeeds,
 * updates the matching message's status (if any), and stores a
 * webhook_deliveries row.
 *
 * Throws DomainError on any failure (unknown connection, missing or invalid
 * signature, unconfigured secret). The HTTP error middleware maps these to
 * status codes via the `httpStatus` field.
 */
export async function verifyAndProcessEvent(
  input: VerifyAndProcessEventInput,
): Promise<void> {
  const { db, connectionId, rawBody, signatureHeader } = input;

  // 1. Look up connection — 404 if unknown.
  const conn = await getProviderConnection(db, connectionId);
  if (!conn) {
    throw new DomainError({
      code: 'WEBHOOK_CONNECTION_NOT_FOUND',
      message: 'Connection not found',
      httpStatus: 404,
    });
  }

  // 2. Verify signature (R-INBOUND-SIGNATURE). Order matters: a missing or
  //    unconfigured secret is reported BEFORE we attempt to compare, so we
  //    never authenticate against an empty key.
  if (!conn.webhook_secret) {
    throw new DomainError({
      code: 'WEBHOOK_NOT_CONFIGURED',
      message: 'Webhook secret not configured',
      httpStatus: 409,
    });
  }
  if (!signatureHeader) {
    throw new DomainError({
      code: 'WEBHOOK_SIGNATURE_MISSING',
      message: 'X-Webhook-Signature header required',
      httpStatus: 401,
    });
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(conn.webhook_secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(rawBody),
  );
  const computedHex = Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // constant-time compare: never use === for token/signature comparison.
  if (!constantTimeCompare(computedHex, signatureHeader)) {
    throw new DomainError({
      code: 'WEBHOOK_SIGNATURE_INVALID',
      message: 'Invalid webhook signature',
      httpStatus: 401,
    });
  }

  // 3. Signature verified — safe to parse attacker-controllable bytes.
  const event = JSON.parse(rawBody) as BrevoWebhookEvent;

  // 4. Update message status when the event references a known message.
  let messageId: string | null = null;
  if (event.messageId) {
    const job = await findJobByProviderMessageId(db, event.messageId);
    if (job) {
      messageId = job.message_id;
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const status = mapEventToMessageStatus(event.event);
      await db
        .prepare('UPDATE messages SET status = ?, updated_at = ? WHERE id = ?')
        .bind(status, now, messageId)
        .run();
    }
  }

  // 5. Persist the delivery row. The raw payload is the exact bytes Brevo
  //    sent — preserved verbatim for audit / replay.
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  await createWebhookDelivery(db, {
    id: systemIds.uuid(),
    connectionId,
    eventType: event.event ?? 'unknown',
    rawPayload: rawBody,
    messageId,
    createdAt: now,
  });
}

/**
 * Brevo webhook event payload. Only the fields we read are typed; the rest
 * are preserved in raw_payload verbatim. `[key: string]: unknown` keeps the
 * parsed object permissive without resorting to `any`.
 */
interface BrevoWebhookEvent {
  readonly event?: string; // 'delivered', 'bounce', 'complaint', etc.
  readonly messageId?: string; // Brevo's id; matches outbound_jobs.provider_message_id
  readonly [key: string]: unknown;
}
