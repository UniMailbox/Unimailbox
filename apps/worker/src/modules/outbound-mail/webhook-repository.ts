// webhook-repository — webhook_deliveries + provider_connections.webhook_secret.
// CAP-024 + CAP-029. Owner: outbound-mail module. Private file — export
// through modules/outbound-mail/index.ts.
//
// R-INBOUND-SIGNATURE: signature verification runs before JSON parse. This
// repository owns the connection lookup that supplies the HMAC key.
//
// CAP-029: the delivery row now records the canonical event_time (provider
// first, server fallback) so the audit trail can answer "what time did
// Brevo observe this event" and "was this status update applied or
// rejected by the rank predicate".

import type { Database } from '../../platform/database';
import { DomainError } from '../../platform/errors';

export interface WebhookDeliveryInput {
  readonly id: string;
  readonly connectionId: string;
  readonly eventType: string;
  readonly rawPayload: string;
  readonly messageId: string | null;
  /**
   * Epoch-ms timestamp of the event per the provider (or server fallback).
   * Recorded for the audit trail; the actual ordering decision is made
   * inside updateMessageStatus when a matching message exists.
   */
  readonly eventTimeMs: number;
  /**
   * Where the eventTimeMs value came from. 'provider' = `ts`/`time` in the
   * payload; 'server' = we fell back to Date.now() because the provider
   * did not include one.
   */
  readonly eventTimeSource: 'provider' | 'server';
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
      'INSERT INTO webhook_deliveries (id, connection_id, event_type, raw_payload, message_id, status, event_time, event_time_source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      input.id,
      input.connectionId,
      input.eventType,
      input.rawPayload,
      input.messageId,
      'processed',
      input.eventTimeMs,
      input.eventTimeSource,
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
 * webhook events, scoped to the receiving connection. Returns the
 * associated message_id so the processor can update message status.
 * Returns null when no job matches (e.g. event for a message sent outside
 * this system, or — critically — a job owned by a DIFFERENT connection).
 *
 * The connection_id scope is mandatory: without it, a webhook arriving at
 * connection A whose `messageId` collides with (or was guessed from) a
 * job belonging to connection B would update the wrong message row
 * (R-AUTHZ-004 — IDOR via cross-tenant lookup). Provider message ids
 * are provider-assigned and not guaranteed globally unique across all
 * Brevo accounts; scoping to the receiving connection closes the
 * cross-tenant lookup hole.
 */
export async function findJobByProviderMessageId(
  db: Database,
  connectionId: string,
  providerMessageId: string,
): Promise<{ message_id: string } | null> {
  return db
    .prepare(
      'SELECT message_id FROM outbound_jobs WHERE provider_message_id = ? AND provider_connection_id = ? LIMIT 1',
    )
    .bind(providerMessageId, connectionId)
    .first<{ message_id: string }>();
}

/**
 * Admin-facing row shape for listing webhook deliveries. Excludes the
 * raw_payload column — the admin view needs event metadata, not the full
 * provider payload (which may carry recipient addresses etc.).
 */
export interface WebhookDeliveryRow {
  readonly id: string;
  readonly connection_id: string;
  readonly event_type: string;
  readonly message_id: string | null;
  readonly status: string;
  readonly created_at: string;
}

/**
 * Lists recent webhook deliveries, newest first. Used by the admin webhook
 * events view (CAP-025). The raw_payload column is deliberately omitted —
 * the admin list view shows event metadata only.
 */
export async function listWebhookDeliveries(
  db: Database,
  limit = 50,
): Promise<WebhookDeliveryRow[]> {
  const result = await db
    .prepare(
      'SELECT id, connection_id, event_type, message_id, status, created_at FROM webhook_deliveries ORDER BY created_at DESC LIMIT ?',
    )
    .bind(limit)
    .all<WebhookDeliveryRow>();
  return result.results ?? [];
}

/**
 * Admin-facing row shape for listing provider connections with their
 * webhook configuration. credential_id is intentionally excluded — the
 * admin webhook view does not need the encrypted-credential reference.
 */
export interface ProviderConnectionRow {
  readonly id: string;
  readonly provider_key: string;
  readonly label: string;
  readonly status: string;
  readonly webhook_secret: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * Lists all provider connections with their webhook secrets, newest first.
 * Used by the admin connections view (CAP-025) so the operator can see
 * which connections have webhook verification configured and copy the
 * webhook URL + secret into the provider dashboard.
 */
export async function listProviderConnections(
  db: Database,
): Promise<ProviderConnectionRow[]> {
  const result = await db
    .prepare(
      'SELECT id, provider_key, label, status, webhook_secret, created_at, updated_at FROM provider_connections ORDER BY created_at DESC',
    )
    .all<ProviderConnectionRow>();
  return result.results ?? [];
}
