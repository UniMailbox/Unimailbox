import type { MessageStatus, WebhookProviderAdapter } from '@unimailbox/contracts';
import { parseProviderKey, parseOutboundAttemptTag } from '@unimailbox/contracts';
import { constantTimeCompare } from '../../platform/crypto';
import { DomainError } from '../../platform/errors';

interface BrevoWebhookBody {
  readonly 'X-Mailin-custom'?: unknown;
  readonly event?: unknown;
  readonly messageId?: unknown;
  readonly 'message-id'?: unknown;
  readonly ts?: unknown;
  readonly ts_event?: unknown;
  readonly ts_epoch?: unknown;
  readonly time?: unknown;
}

/** Brevo event names are not part of the message state machine. */
export function mapBrevoEventStatus(event: string): MessageStatus | null {
  switch (event) {
    case 'delivered':
      return 'delivered';
    case 'bounce':
    case 'hard_bounce':
    case 'hardBounce':
    case 'soft_bounce':
    case 'softBounce':
      return 'bounced';
    case 'complaint':
    case 'spam':
      return 'complained';
    case 'delayed':
    case 'deferred':
    case 'blocked':
      return 'delayed';
    default:
      return null;
  }
}

function eventTime(
  body: BrevoWebhookBody,
  receivedAtMs: number,
): {
  readonly value: number;
  readonly source: 'provider' | 'server';
} {
  const raw = body.ts_event ?? body.ts_epoch ?? body.ts ?? body.time;
  if (typeof raw === 'string') {
    // Require an explicit zone so an ambiguous local clock is never stored
    // as a provider UTC event time.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(raw)) {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed) && parsed > 0) {
        return { value: parsed, source: 'provider' };
      }
    }
  } else if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) {
    // Brevo normally emits seconds; some payloads use milliseconds.
    // Values through 10^10 are seconds (up to year 2286), larger values ms.
    const asMs = raw > 1e10 ? raw : raw * 1000;
    if (Number.isSafeInteger(asMs)) return { value: asMs, source: 'provider' };
  }
  return { value: receivedAtMs, source: 'server' };
}

export const brevoWebhookAdapter: WebhookProviderAdapter = {
  key: parseProviderKey('brevo'),

  async verifyAndParse({ rawBody, signatureHeader, secret, receivedAtMs }) {
    if (!signatureHeader) {
      throw new DomainError({
        code: 'WEBHOOK_SIGNATURE_MISSING',
        message: 'Webhook authentication header required',
        httpStatus: 401,
      });
    }

    // Brevo supports a configured Bearer token over HTTPS, rather than
    // dynamically signing each payload. Keep HMAC support for existing
    // integrations that supply a signature; both paths authenticate before
    // decoding any provider-controlled body.
    let authenticated: boolean;
    if (signatureHeader.startsWith('Bearer ')) {
      authenticated = constantTimeCompare(secret, signatureHeader.slice('Bearer '.length));
    } else {
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, rawBody));
      const computedHex = Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join(
        '',
      );
      authenticated = constantTimeCompare(computedHex, signatureHeader);
    }
    if (!authenticated) {
      throw new DomainError({
        code: 'WEBHOOK_SIGNATURE_INVALID',
        message: 'Invalid webhook signature',
        httpStatus: 401,
      });
    }

    let rawPayload: string;
    let body: BrevoWebhookBody;
    try {
      rawPayload = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(rawBody);
      const value: unknown = JSON.parse(rawPayload);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Webhook payload must be an object');
      }
      body = value as BrevoWebhookBody;
    } catch {
      throw new DomainError({
        code: 'INVALID_JSON',
        message: 'Invalid webhook JSON payload',
        httpStatus: 400,
      });
    }

    const eventType = typeof body.event === 'string' ? body.event : 'unknown';
    const time = eventTime(body, receivedAtMs);
    const providerMessageId = body['message-id'] ?? body.messageId;
    const attemptId = parseOutboundAttemptTag(body['X-Mailin-custom']);
    return {
      ...(attemptId ? { attemptId } : {}),
      eventType,
      providerMessageId:
        typeof providerMessageId === 'string' &&
        providerMessageId.trim() &&
        providerMessageId.length <= 1024
          ? providerMessageId
          : null,
      status: mapBrevoEventStatus(eventType),
      eventTimeMs: time.value,
      eventTimeSource: time.source,
      rawPayload,
    };
  },
};
