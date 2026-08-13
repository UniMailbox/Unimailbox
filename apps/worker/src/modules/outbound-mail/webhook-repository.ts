// webhook-repository — webhook_deliveries + provider_connections.webhook_secret.
// CAP-024. Owner: outbound-mail module. Private file — export through
// modules/outbound-mail/index.ts.
//
// R-INBOUND-SIGNATURE: signature verification runs before JSON parse. This
// repository owns the connection lookup that supplies the HMAC key.

import type { Database } from '../../platform/database';
import { DomainError } from '../../platform/errors';

export interface WebhookDeliveryInput {
  readonly id: string;
  readonly connectionId: string;
  readonly eventType: string;
  readonly rawPayload: string;
  readonly messageId: string | null;
  readonly createdAt: string;
}

/** Subset of provider_connections needed to verify a webhook signature. */
export interface ProviderConnectionForWebhook {
  readonly id: string;
  readonly provider_key: string;
  readonly webhook_secret: string | null;
  readonly status: string;
}

/**
 * Inserts a webhook_deliveries row. The caller (webhook-processor) has
 * already verified the signature and parsed the event.
 */
export async function createWebhookDelivery(
  db: Database,
  input: WebhookDeliveryInput,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO webhook_deliveries (id, connection_id, event_type, raw_payload, message_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      input.id,
      input.connectionId,
      input.eventType,
      input.rawPayload,
      input.messageId,
      'processed',
      input.createdAt,
    )
    .run();
}

/**
 * Reads the connection row's webhook-relevant fields. Returns null when no
 * connection matches the supplied id — the caller surfaces 404.
 */
export async function getProviderConnection(
  db: Database,
  connectionId: string,
): Promise<ProviderConnectionForWebhook | null> {
  return db
    .prepare(
      'SELECT id, provider_key, webhook_secret, status FROM provider_connections WHERE id = ?',
    )
    .bind(connectionId)
    .first<ProviderConnectionForWebhook>();
}

/**
 * Generates a random webhook secret for the connection if it does not yet
 * have one, and returns the secret. Used by the admin endpoint that hands
 * the operator the value to configure inside Brevo's dashboard.
 *
 * The secret is a 32-byte random value hex-encoded (256 bits) — adequate
 * entropy for an HMAC-SHA256 key. It is stored as plaintext because it is
 * a random signing key, not a user password or a provider API key.
 */
export async function ensureWebhookSecret(
  db: Database,
  connectionId: string,
): Promise<string> {
  const conn = await getProviderConnection(db, connectionId);
  if (!conn) {
    throw new DomainError({
      code: 'PROVIDER_CONNECTION_NOT_FOUND',
      message: 'Provider connection not found',
      httpStatus: 404,
    });
  }
  if (conn.webhook_secret) return conn.webhook_secret;

  // 32 random bytes → 64 hex chars. Web Crypto getRandomValues is the
  // CSPRNG on Cloudflare Workers.
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  await db
    .prepare('UPDATE provider_connections SET webhook_secret = ? WHERE id = ?')
    .bind(secret, connectionId)
    .run();
  return secret;
}

/**
 * Finds an outbound job by the provider message id Brevo echoes back in
 * webhook events. Returns the associated message_id so the processor can
 * update message status. Returns null when no job matches (e.g. event for
 * a message sent outside this system).
 */
export async function findJobByProviderMessageId(
  db: Database,
  providerMessageId: string,
): Promise<{ message_id: string } | null> {
  return db
    .prepare(
      'SELECT message_id FROM outbound_jobs WHERE provider_message_id = ? LIMIT 1',
    )
    .bind(providerMessageId)
    .first<{ message_id: string }>();
}
