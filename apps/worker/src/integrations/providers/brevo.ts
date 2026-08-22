// apps/worker/src/integrations/providers/brevo.ts — CAP-014.
// Brevo provider adapter implementing OutboundProviderAdapter.
//
// ADR-002: Modules call adapters through the OutboundProviderAdapter
// interface — never the SDK directly. Adapters live in integrations/providers/*
// and own the SDK calls.
//
// This adapter validates the connection by fetching the Brevo account info
// and sends messages via the Brevo SMTP API.

import type {
  OutboundProviderAdapter,
  ProviderRuntimeContext,
  SendProviderMessage,
  ProviderSendResult,
} from '@unimailbox/contracts';
import {
  parseProviderKey,
  RetryableProviderError,
  TerminalProviderError,
} from '@unimailbox/contracts';
import { DomainError } from '../../platform/errors';

const BREVO_API_BASE = 'https://api.brevo.com/v3';

/**
 * Brevo adapter — validates and sends via the Brevo API.
 *
 * validateConnection: GET /v3/account — verifies the API key is valid.
 * send: POST /v3/smtp/email — sends a transactional email.
 *
 * The adapter expects BREVO_API_KEY in the runtime context env. During
 * setupBrevo, we pass the plaintext key from the request body; at send time,
 * we'll pass the decrypted key from the credential store.
 *
 * CAP-029 D-CAP-028-A: HTTP failures are translated into typed provider
 * errors at the SDK boundary so the queue consumer (process-outbound-job)
 * can branch on `kind` instead of parsing status codes. Translation rules:
 *   - 2xx                        → success
 *   - 4xx (incl. 408, 429)       → TerminalProviderError (request will never succeed as-is;
 *                                   retrying identical payload wastes attempts — D-CAP-028-A)
 *   - 5xx / network / malformed  → RetryableProviderError (transient; the queue retry +
 *                                   provider-idempotency key make this safe)
 * validateConnection keeps its DomainError path — it runs once at setup, not
 * inside the queue loop, and surfaces a 502 to the operator's setup UI.
 */
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
    const apiKey = ctx.env.BREVO_API_KEY;
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

  /**
   * Send a message via the Brevo SMTP API.
   *
   * CAP-029 D-CAP-028-A: HTTP failures throw typed provider errors.
   *   - 4xx → TerminalProviderError (B2 — a malformed request will not
   *     succeed on retry; the queue consumer marks the job failed on the
   *     first attempt instead of burning `max_attempts` retries)
   *   - 5xx → RetryableProviderError (transient; existing attempts-budget
   *     path applies)
   *   - Network error / non-JSON 2xx → RetryableProviderError (treated as
   *     transient — the provider idempotency key keeps us safe from
   *     double-send on retry, R-OUTBOUND-004)
   *
   * @param ctx — Runtime context with env.BREVO_API_KEY set to the API key
   * @param msg — Provider-neutral send payload
   * @returns ProviderSendResult with the Brevo message ID and accepted timestamp
   * @throws {TerminalProviderError} on 4xx (incl. malformed request)
   * @throws {RetryableProviderError} on 5xx, network failure, or malformed response
   */
  async send(ctx: ProviderRuntimeContext, msg: SendProviderMessage): Promise<ProviderSendResult> {
    const apiKey = ctx.env.BREVO_API_KEY;
    if (typeof apiKey !== 'string') {
      // Missing config is terminal — operator error, not a transient failure.
      // Provider errors carry httpStatus=undefined; the queue consumer's
      // `isProviderError` guard still applies.
      throw new TerminalProviderError({
        message: 'Brevo adapter: BREVO_API_KEY missing from runtime context',
      });
    }

    // Map provider-neutral MailAddress to Brevo format
    const formatAddress = (addr: { address: string; displayName?: string }) => ({
      email: addr.address,
      name: addr.displayName ?? undefined,
    });

    const payload = {
      sender: formatAddress(msg.from),
      to: msg.to.map(formatAddress),
      cc: msg.cc.length > 0 ? msg.cc.map(formatAddress) : undefined,
      bcc: msg.bcc.length > 0 ? msg.bcc.map(formatAddress) : undefined,
      subject: msg.subject,
      htmlContent: msg.html,
      textContent: msg.text,
      attachment: msg.attachments.map((a) => ({
        name: a.filename ?? 'attachment',
        content: Buffer.from(a.content).toString('base64'),
        contentType: a.contentType,
      })),
      headers: msg.messageId
        ? {
            'Message-ID': msg.messageId,
            ...(msg.inReplyTo ? { 'In-Reply-To': msg.inReplyTo } : {}),
            ...(msg.references ? { References: msg.references } : {}),
          }
        : undefined,
    };

    let response: Response;
    try {
      response = await fetch(`${BREVO_API_BASE}/smtp/email`, {
        method: 'POST',
        headers: {
          'api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (cause) {
      // Network error (DNS, TLS, dropped connection, abort). The provider
      // idempotency key (R-OUTBOUND-004) keeps the retry safe from a
      // duplicate send if the first request actually reached Brevo.
      throw new RetryableProviderError({
        message: `Brevo send network error: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      });
    }

    if (!response.ok) {
      // R-SECRET-003 / R-LOG-001 (CAP-029 H2 review-triage): the raw
      // response body is NOT included in the error `message` — it may carry
      // PII (recipient addresses), secret prefixes (e.g. "xkeysib-abc..."),
      // or other details that must not land in the log stream. The body
      // is attached as `cause` on a structured Error so the audit trail
      // retains it for triage (operator can inspect the chain) without
      // spilling into the standard `error.message` surface that flows
      // through the queue consumer's logger calls.
      const body = await response.text().catch(() => '');
      const status = response.status;
      const errorMessage = `Brevo send failed: status ${status}`.trim();
      // 429 is retryable per CAP-029 M3 review-triage — Brevo's rate-limit
      // window is short and the queue's attempts budget + provider
      // idempotency key (R-OUTBOUND-004) make retries safe. All other 4xx
      // are terminal: a repeated identical payload will never succeed and
      // burning attempts wastes the budget.
      if (status === 429) {
        throw new RetryableProviderError({
          message: errorMessage,
          httpStatus: status,
          cause: body ? new Error(`provider body: ${body}`) : undefined,
        });
      }
      if (status >= 400 && status < 500) {
        throw new TerminalProviderError({
          message: errorMessage,
          httpStatus: status,
          cause: body ? new Error(`provider body: ${body}`) : undefined,
        });
      }
      // 5xx (and anything outside 4xx/5xx we haven't classified) → retryable.
      throw new RetryableProviderError({
        message: errorMessage,
        httpStatus: status,
        cause: body ? new Error(`provider body: ${body}`) : undefined,
      });
    }

    let data: { messageId?: string };
    try {
      data = (await response.json()) as { messageId?: string };
    } catch (cause) {
      // 2xx with malformed JSON — treat as retryable. The provider may have
      // accepted the message; the idempotency key handles the dedupe.
      throw new RetryableProviderError({
        message: 'Brevo response was not valid JSON',
        httpStatus: response.status,
        cause,
      });
    }

    if (!data.messageId) {
      throw new RetryableProviderError({
        message: 'Brevo response missing messageId',
        httpStatus: response.status,
      });
    }

    return {
      providerMessageId: data.messageId,
      acceptedAt: new Date().toISOString(),
    };
  },
};
