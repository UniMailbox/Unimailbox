// webhook-repository — webhook_deliveries + provider_connections.webhook_secret.
// CAP-024 + CAP-029 + CAP-040. Owner: outbound-mail module. Private file —
// export through modules/outbound-mail/index.ts.
//
// R-INBOUND-SIGNATURE: signature verification runs before JSON parse. This
// repository owns the connection lookup that supplies the HMAC key.
//
// CAP-029: the delivery row now records the canonical event_time (provider
// first, server fallback) so the audit trail can answer "what time did
// Brevo observe this event" and "was this status update applied or
// rejected by the rank predicate".
//
// CAP-040 / D-CAP-029-A: the delivery insert + audit insert are batched
// together by the route handler. This repository exposes
// `prepareCreateWebhookDelivery` so the caller can fold the row into the
// same `db.batch([...])` as the audit insert + (optional) messages UPDATE.
// The legacy `createWebhookDelivery` is retained for tests but the route
// handler no longer uses it.

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
 *
 * Prefer `prepareCreateWebhookDelivery` when the insert is being batched
 * with other writes (D-CAP-029-A / CAP-040). This function is retained
 * for tests and any future code path that needs to write a delivery row
 * outside a batch.
 */
export async function createWebhookDelivery(
  db: Database,
  input: WebhookDeliveryInput,
): Promise<void> {
  await prepareCreateWebhookDelivery(db, input).run();
}

/**
 * Build the prepared INSERT for a webhook_deliveries row so the route
 * handler can fold it into a `db.batch([...])` together with the messages
 * UPDATE and the audit_events INSERT (D-CAP-029-A / CAP-040).
 *
 * The prepared statement matches the original `createWebhookDelivery` SQL
 * exactly so callers can swap between the two without behavioural drift.
 */
export function prepareCreateWebhookDelivery(
  db: Database,
  input: WebhookDeliveryInput,
): D1PreparedStatement {
  return db
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
    );
}

/**
 * Row shape used to expose webhook secret material. The `webhook_secret`
 * column is the random HMAC signing key (CAP-024); it is the same value
 * `ensureWebhookSecret` returns on first call.
 *
 * CAP-040: the admin reveal endpoint returns this value to the operator
 * (the previous list endpoint returned it inline — a R-SECRET-003 leak —
 * so listing no longer exposes it).
 */
export interface WebhookSecretRow {
  readonly id: string;
  readonly provider_key: string;
  readonly label: string;
  readonly webhook_secret: string | null;
}

/**
 * Reads the connection row's webhook secret, scoping to the receiving
 * connection id. Throws DomainError(404) when the connection is absent.
 *
 * CAP-040 / R-AUTHZ-004: the lookup is scoped to a single connection id;
 * the caller must NOT broaden the scope to all connections.
 */
export async function getWebhookSecretForConnection(
  db: Database,
  connectionId: string,
): Promise<WebhookSecretRow> {
  const row = await db
    .prepare(
      'SELECT id, provider_key, label, webhook_secret FROM provider_connections WHERE id = ?',
    )
    .bind(connectionId)
    .first<WebhookSecretRow>();
  if (!row) {
    throw new DomainError({
      code: 'PROVIDER_CONNECTION_NOT_FOUND',
      message: 'Provider connection not found',
      httpStatus: 404,
    });
  }
  return row;
}

/**
 * Row shape for unmatched webhook deliveries — provider message id is
 * present (parsed from raw_payload via the STORED generated column) but
 * `message_id` is NULL. Used by `reconcileWebhookDeliveries` to find rows
 * that the early-event path wrote before the queue consumer had finished
 * marking `outbound_jobs.provider_message_id`.
 */
export interface UnmatchedWebhookDeliveryRow {
  readonly id: string;
  readonly connection_id: string;
  readonly provider_message_id: string;
}

/**
 * Finds webhook_deliveries rows whose `message_id` is NULL but whose
 * provider message id matches the supplied value. Used by
 * `reconcileWebhookDeliveries` to back-fill `message_id` once the canonical
 * provider id becomes known on `outbound_jobs`.
 *
 * Scoped to a single `provider_message_id` so the result set is bounded
 * (small in practice — at most a handful of unmatched rows per job). The
 * lookup uses the composite index
 * `webhook_deliveries_provider_message_id_idx` (migration 0013) so it does
 * not table-scan.
 */
export async function findUnmatchedDeliveriesByProviderMessageId(
  db: Database,
  providerMessageId: string,
): Promise<ReadonlyArray<UnmatchedWebhookDeliveryRow>> {
  const rows = await db
    .prepare(
      'SELECT id, connection_id, provider_message_id FROM webhook_deliveries WHERE provider_message_id = ? AND message_id IS NULL',
    )
    .bind(providerMessageId)
    .all<UnmatchedWebhookDeliveryRow>();
  return rows.results ?? [];
}

/**
 * Build the prepared UPDATE that sets `webhook_deliveries.message_id` to
 * the supplied value for a specific delivery row. Used by
 * `reconcileWebhookDeliveries` so the reconciliation runs in the same
 * `db.batch([...])` as the audit row.
 *
 * The `WHERE id = ? AND message_id IS NULL` predicate is a safety net:
 * a racing reconcile that already back-filled the row finds nothing to
 * update, so this UPDATE is a no-op rather than a duplicate-write.
 */
export function prepareBackfillDeliveryMessageId(
  db: Database,
  deliveryId: string,
  messageId: string,
): D1PreparedStatement {
  return db
    .prepare(
      'UPDATE webhook_deliveries SET message_id = ? WHERE id = ? AND message_id IS NULL',
    )
    .bind(messageId, deliveryId);
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
 *
 * CAP-040 / R-SECRET-003: `webhook_secret` is intentionally NOT selected
 * here — the list endpoint must not leak secret material. The
 * `webhook_configured` boolean is the only signal of secret presence.
 */
export interface ProviderConnectionRow {
  readonly id: string;
  readonly provider_key: string;
  readonly label: string;
  readonly status: string;
  readonly webhook_configured: number | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * Lists all provider connections with their webhook configuration
 * indicator, newest first. Used by the admin connections view (CAP-025)
 * so the operator can see which connections have webhook verification
 * configured and copy the webhook URL into the provider dashboard.
 *
 * CAP-040 / R-SECRET-003: this function does NOT select `webhook_secret`.
 * The reveal endpoint (`POST /api/v1/admin/connections/:id/webhook-secret/reveal`)
 * is the only API surface that returns secret material, and each reveal
 * writes an audit row (R-AUDIT-001).
 */
export async function listProviderConnections(
  db: Database,
): Promise<ProviderConnectionRow[]> {
  const result = await db
    .prepare(
      'SELECT id, provider_key, label, status, CASE WHEN webhook_secret IS NULL THEN 0 ELSE 1 END AS webhook_configured, created_at, updated_at FROM provider_connections ORDER BY created_at DESC',
    )
    .all<ProviderConnectionRow>();
  return result.results ?? [];
}