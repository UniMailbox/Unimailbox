// webhook-processor — verify HMAC-SHA256 signature, parse, update message
// status, persist a webhook_deliveries row. CAP-024 + CAP-029. Owner:
// outbound-mail module. Private file — export through
// modules/outbound-mail/index.ts.
//
// R-INBOUND-SIGNATURE (.claude/rules/architecture.md §API conventions,
// .claude/rules/security.md §Secrets): signature verification runs BEFORE
// JSON.parse. The raw body is the canonical input to HMAC; parsing first
// would expose the parser to attacker-controlled bytes that have not been
// authenticated.
//
// CAP-029 / R-MESSAGE-007: the message status update uses the public
// messages-module surface (updateMessageStatus) so an out-of-order event
// cannot clobber a newer status. Event timestamps prefer the provider-
// supplied value (Q1 decision: provider first, server fallback). The
// audit row records which source drove the ordering.

import type { Database } from '../../platform/database';
import { constantTimeCompare } from '../../platform/crypto';
import { DomainError } from '../../platform/errors';
import { systemIds } from '../../platform/ids';
import { sqliteTimestamp } from '../../platform/idempotency';
import type { MessageStatus } from '@unimailbox/contracts';
import { updateMessageStatus } from '../messages';
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

/**
 * Maps Brevo's event names onto our messages.status CHECK values. Returns
 * `null` when the event name is unrecognised — the caller skips the
 * status update but still persists the `webhook_deliveries` row so an
 * operator can audit / correct later.
 *
 * CAP-029 M1 / L2 review-triage: the previous default of 'delivered'
 * silently applied a high-rank status to unrecognised events. The
 * "fail closed" polarity now is: unknown event → no message-row change.
 * The delivery row still records the raw payload and event_type so the
 * audit trail is complete.
 */
function mapEventToMessageStatus(event: string | undefined): MessageStatus | null {
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
      return null;
  }
}

export interface VerifyAndProcessEventResult {
  readonly messageId: string | null;
}

/**
 * Verifies the HMAC-SHA256 signature of `rawBody` against the connection's
 * stored `webhook_secret`, parses the JSON only after verification succeeds,
 * updates the matching message's status (if any), and stores a
 * webhook_deliveries row.
 *
 * Returns `{ messageId }` so the caller (route handler) can emit an audit
 * event — the outbound-mail module cannot depend on admin per architecture rules.
 *
 * Throws DomainError on any failure (unknown connection, missing or invalid
 * signature, unconfigured secret). The HTTP error middleware maps these to
 * status codes via the `httpStatus` field.
 */
export async function verifyAndProcessEvent(
  input: VerifyAndProcessEventInput,
): Promise<VerifyAndProcessEventResult> {
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

  // 4. Compute the canonical event timestamp once. CAP-029 Q1: provider
  //    first (Brevo observed the event; that is the canonical ordering),
  //    server fallback when neither `ts` nor `time` is present.
  const eventTime = extractBrevoEventTimeMs(event);

  // 5. Update message status when the event references a known message.
  //    CAP-029 / R-MESSAGE-007: the write goes through the messages-module
  //    public surface (updateMessageStatus) which carries the rank-aware
  //    predicate. A late 'delivered' after 'bounced' is rejected by the
  //    predicate; a 'bounced' after a 'delivered' that arrived later is
  //    also rejected (the rank + event-time gate covers both orderings).
  //    R-AUTHZ-004: the lookup is scoped to the receiving connection so a
  //    webhook arriving at connection A whose messageId collides with a
  //    job owned by connection B cannot update the wrong message row.
  //    CAP-029 M1 / L2: when `mapEventToMessageStatus` returns null (an
  //    event name we don't recognise), we still set `messageId` so the
  //    delivery row links to the message, but we skip the status update
  //    — a diagnostic event like `opened` or `proxy_open` must not be
  //    promoted to a high-rank status by accident.
  let messageId: string | null = null;
  if (event.messageId) {
    const job = await findJobByProviderMessageId(db, connectionId, event.messageId);
    if (job) {
      messageId = job.message_id;
      const status = mapEventToMessageStatus(event.event);
      if (status !== null) {
        const now = sqliteTimestamp(new Date());
        await updateMessageStatus(db, {
          messageId,
          status,
          providerEventTimeMs: eventTime.value,
          now,
        });
      }
    }
  }

  // 6. Persist the delivery row. The raw payload is the exact bytes Brevo
  //    sent — preserved verbatim for audit / replay. event_time is the
  //    provider (or server) timestamp computed above so an operator can
  //    audit ordering decisions after the fact.
  const now = sqliteTimestamp(new Date());
  await createWebhookDelivery(db, {
    id: systemIds.uuid(),
    connectionId,
    eventType: event.event ?? 'unknown',
    rawPayload: rawBody,
    messageId,
    eventTimeMs: eventTime.value,
    eventTimeSource: eventTime.source,
    createdAt: now,
  });

  return { messageId };
}

/**
 * Returns the canonical epoch-ms timestamp for a Brevo event, plus which
 * source drove the value. CAP-029 Q1: provider first (Brevo supplies
 * `ts` / `time` as the observed event time), server fallback when neither
 * is present (unknown shapes still record an ordering decision).
 *
 * Format-based discrimination (CAP-029 H1 review-triage): the previous
 * magnitude heuristic (`> 1e12 ? ms : s*1000`) silently misclassified
 * microsecond and nanosecond values, landing them years in the future and
 * permissively passing any plausible-seconds value as already-in-ms. The
 * fix: the unit (seconds vs milliseconds) is decided by *format*, not by
 * value magnitude.
 *   - numeric value, integer, and > 10^10 (post-2286 in seconds, or any
 *     realistic ms value) → treated as milliseconds (Brevo is documented
 *     to occasionally emit ms for some payloads).
 *   - numeric value, integer, ≤ 10^10 → treated as seconds-since-epoch
 *     (Brevo's documented default).
 *   - numeric value with a fractional part → invalid (Brevo never emits
 *     fractional epoch values); fall back to server time.
 *   - string value → must parse as a valid ISO 8601 / RFC 3339 timestamp
 *     via `Date.parse`; on NaN-Infinity, fall back to server time.
 *   - anything else (boolean, null, object, undefined) → invalid; fall
 *     back to server time.
 *
 * Server fallback is `Date.now()` and is recorded as `source: 'server'` so
 * the audit trail can answer why a particular ordering decision was made.
 */
function extractBrevoEventTimeMs(
  event: BrevoWebhookEvent,
): { readonly value: number; readonly source: 'provider' | 'server' } {
  const raw = event.ts ?? event.time;
  if (raw === undefined || raw === null) {
    return { value: Date.now(), source: 'server' };
  }

  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return { value: parsed, source: 'provider' };
    }
    return { value: Date.now(), source: 'server' };
  }

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0 || !Number.isInteger(raw)) {
      return { value: Date.now(), source: 'server' };
    }
    // Format-based unit discrimination:
    //   > SECONDS_MS_THRESHOLD (10^10 ≈ year 2286 in seconds, or any ms
    //   value in the realistic range) → already milliseconds.
    //   ≤ SECONDS_MS_THRESHOLD          → seconds-since-epoch, multiply by 1000.
    const SECONDS_MS_THRESHOLD = 1e10;
    const asMs = raw > SECONDS_MS_THRESHOLD ? raw : raw * 1000;
    return { value: Math.trunc(asMs), source: 'provider' };
  }

  // boolean, object, bigint, symbol — none are valid epoch timestamps.
  return { value: Date.now(), source: 'server' };
}

/**
 * Brevo webhook event payload. Only the fields we read are typed; the rest
 * are preserved in raw_payload verbatim. `[key: string]: unknown` keeps the
 * parsed object permissive without resorting to `any`.
 */
interface BrevoWebhookEvent {
  readonly event?: string; // 'delivered', 'bounce', 'complaint', etc.
  readonly messageId?: string; // Brevo's id; matches outbound_jobs.provider_message_id
  /**
   * Provider-supplied event time. Brevo emits seconds-since-epoch here for
   * most payloads; some templates send an ISO string. We accept either
   * number or string and resolve to ms in `extractBrevoEventTimeMs`.
   */
  readonly ts?: number | string;
  readonly time?: number | string;
  readonly [key: string]: unknown;
}
