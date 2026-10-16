// Brevo adapter: bounded submission with explicit unknown outcomes and positive-evidence lookup.
import type {
  OutboundProviderAdapter,
  ProviderRuntimeContext,
  SendProviderMessage,
  ProviderSendResult,
} from '@unimailbox/contracts';
import {
  estimateEmailBytes,
  OUTBOUND_SAFE_MAX_BYTES,
  OUTBOUND_LARGE_ATTACHMENT_THRESHOLD_BYTES,
  parseProviderKey,
  RetryableProviderError,
  TerminalProviderError,
  UnknownProviderOutcomeError,
  outboundAttemptTag,
} from '@unimailbox/contracts';
import { DomainError } from '../../platform/errors';

const BREVO_API_BASE = 'https://api.brevo.com/v3';

/** HTTP adapter; unknown submission outcomes are reconciled, never blindly retried. */
export const brevoAdapter: OutboundProviderAdapter = {
  key: parseProviderKey('brevo'),

  /**
   * Validate the Brevo API key by fetching account information.
   *
   * @param ctx — Runtime context with env.BREVO_API_KEY set to the API key
   * @throws {DomainError} with code PROVIDER_CONNECTION_FAILED (502) if the key is invalid
   * @throws {DomainError} with code PROVIDER_CONFIG_ERROR (500) if the key is missing
   */
  async validateConnection(ctx: ProviderRuntimeContext): Promise<void> {
    const apiKey = ctx.env.PROVIDER_API_KEY ?? ctx.env.BREVO_API_KEY;
    if (typeof apiKey !== 'string') {
      throw new DomainError({
        code: 'PROVIDER_CONFIG_ERROR',
        message: 'Missing API key',
        httpStatus: 500,
      });
    }
    const response = await fetch(`${BREVO_API_BASE}/account`, {
      headers: { 'api-key': apiKey },
    });
    if (!response.ok) {
      throw new DomainError({
        code: 'PROVIDER_CONNECTION_FAILED',
        message: `Brevo validation failed: ${response.status}`,
        httpStatus: 502,
      });
    }
  },

  /** 429 is confirmed nonacceptance; network/408/5xx/malformed success remain unknown. */
  async send(ctx: ProviderRuntimeContext, msg: SendProviderMessage): Promise<ProviderSendResult> {
    const apiKey = ctx.env.PROVIDER_API_KEY ?? ctx.env.BREVO_API_KEY;
    if (typeof apiKey !== 'string') {
      // Missing config is terminal — operator error, not a transient failure.
      // Provider errors carry httpStatus=undefined; the queue consumer's
      // `isProviderError` guard still applies.
      throw new TerminalProviderError({
        message: 'Brevo adapter: BREVO_API_KEY missing from runtime context',
      });
    }

    const emailBytes = estimateEmailBytes(
      msg.html,
      msg.text,
      msg.subject,
      msg.attachments.map((file) => file.content.byteLength),
    );
    if (
      emailBytes > OUTBOUND_SAFE_MAX_BYTES ||
      (msg.attachments.length > 0 && emailBytes > OUTBOUND_LARGE_ATTACHMENT_THRESHOLD_BYTES)
    ) {
      throw new TerminalProviderError({
        message: 'Email exceeds the safe Brevo size limit; use hosted file links.',
      });
    }
    // Map provider-neutral MailAddress to Brevo format
    const formatAddress = (addr: { address: string; displayName?: string }) => ({
      email: addr.address,
      name: addr.displayName ?? undefined,
    });

    const payload = {
      ...(msg.attemptId ? { tags: [outboundAttemptTag(msg.attemptId)] } : {}),
      sender: formatAddress(msg.from),
      to: msg.to.map(formatAddress),
      cc: msg.cc.length > 0 ? msg.cc.map(formatAddress) : undefined,
      bcc: msg.bcc.length > 0 ? msg.bcc.map(formatAddress) : undefined,
      subject: msg.subject,
      htmlContent: msg.html,
      textContent: msg.text,
      ...(msg.attachments.length > 0
        ? {
            attachment: msg.attachments.map((a) => ({
              name: a.filename ?? 'attachment',
              content: Buffer.from(a.content).toString('base64'),
              contentType: a.contentType,
            })),
          }
        : {}),
      // Brevo documents headers.idempotencyKey; local safety does not depend on
      // its TTL or duplicate suppression. Attempt correlation supports reconciliation.
      headers: {
        idempotencyKey: msg.idempotencyKey,
        ...(msg.attemptId ? { 'X-Mailin-custom': outboundAttemptTag(msg.attemptId) } : {}),
        ...(msg.messageId ? { 'Message-ID': msg.messageId } : {}),
        ...(msg.inReplyTo ? { 'In-Reply-To': msg.inReplyTo } : {}),
        ...(msg.references ? { References: msg.references } : {}),
      },
    };

    let response: Response;
    const signal = AbortSignal.timeout(ctx.timeoutMs ?? 20_000);
    try {
      response = await fetch(`${BREVO_API_BASE}/smtp/email`, {
        method: 'POST',
        headers: {
          'api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
        signal,
      });
    } catch {
      throw new UnknownProviderOutcomeError({ message: 'Brevo submission response unavailable' });
    }
    if (!response.ok) {
      const status = response.status;
      if (status === 429) {
        const retryAfterSeconds = parseRetryAfter(response.headers.get('Retry-After'));
        await response.body?.cancel().catch(() => {});
        throw new RetryableProviderError({
          message: 'Brevo throttled submission',
          httpStatus: status,
          ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
        });
      }
      if (status === 408 || status >= 500) {
        await response.body?.cancel().catch(() => {});
        throw new UnknownProviderOutcomeError({
          message: 'Brevo submission outcome unknown',
          httpStatus: status,
        });
      }
      let duplicate = false;
      try {
        const data = await readBoundedJson(response);
        duplicate =
          isRecord(data) &&
          (data.code === 'duplicate_parameter' || data.code === 'duplicate_request');
      } catch {
        /* Error body is not required to classify other definite 4xx rejection. */
      }
      if (duplicate)
        throw new UnknownProviderOutcomeError({
          message: 'Brevo reported duplicate submission',
          httpStatus: status,
        });
      throw new TerminalProviderError({
        message: `Brevo rejected submission: status ${status}`,
        httpStatus: status,
      });
    }
    let data: unknown;
    try {
      data = await readBoundedJson(response);
    } catch {
      throw new UnknownProviderOutcomeError({
        message: 'Brevo acceptance response unreadable',
        httpStatus: response.status,
      });
    }
    if (
      !isRecord(data) ||
      typeof data.messageId !== 'string' ||
      !data.messageId.trim() ||
      data.messageId.length > 1024
    )
      throw new UnknownProviderOutcomeError({
        message: 'Brevo acceptance response missing messageId',
        httpStatus: response.status,
      });
    return { providerMessageId: data.messageId, acceptedAt: new Date().toISOString() };
  },

  async findSubmission(ctx, attemptId) {
    const apiKey = ctx.env.PROVIDER_API_KEY ?? ctx.env.BREVO_API_KEY;
    if (typeof apiKey !== 'string') throw new Error('Provider lookup credentials unavailable');
    const tag = outboundAttemptTag(attemptId);
    const params = new URLSearchParams({
      tags: JSON.stringify([tag]),
      limit: '100',
      days: '30',
      sort: 'desc',
    });
    const response = await fetch(`${BREVO_API_BASE}/smtp/statistics/events?${params}`, {
      headers: { 'api-key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(ctx.timeoutMs ?? 5_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error('Provider lookup unavailable');
    }
    const body = await readBoundedJson(response, 262_144);
    if (!isRecord(body) || !Array.isArray(body.events)) return null;
    const found = new Map<string, string>();
    for (const event of body.events) {
      if (
        !isRecord(event) ||
        event.tag !== tag ||
        typeof event.messageId !== 'string' ||
        !event.messageId.trim() ||
        event.messageId.length > 1024 ||
        typeof event.date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(event.date) ||
        !Number.isFinite(Date.parse(event.date))
      )
        continue;
      const previous = found.get(event.messageId);
      if (!previous || Date.parse(event.date) < Date.parse(previous))
        found.set(event.messageId, event.date);
    }
    // Empty/incomplete/conflicting evidence is never permission to resubmit.
    if (found.size !== 1) return null;
    const result = found.entries().next().value;
    return result ? { providerMessageId: result[0], acceptedAt: result[1] } : null;
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function parseRetryAfter(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const value = /^\d+$/.test(raw.trim())
    ? Number(raw)
    : Math.ceil((Date.parse(raw) - Date.now()) / 1000);
  return Number.isFinite(value) && value >= 0 && Date.now() + value * 1000 <= 253402300799000
    ? Math.ceil(value)
    : undefined;
}
async function readBoundedJson(response: Response, maxBytes = 65_536): Promise<unknown> {
  if (!response.body) throw new Error('Provider response missing');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('Provider response too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
}
