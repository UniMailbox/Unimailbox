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
import { parseProviderKey } from '@unimailbox/contracts';
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
   * @param ctx — Runtime context with env.BREVO_API_KEY set to the API key
   * @param msg — Provider-neutral send payload
   * @returns ProviderSendResult with the Brevo message ID and accepted timestamp
   * @throws {DomainError} with code PROVIDER_SEND_FAILED (502) if the send fails
   */
  async send(
    ctx: ProviderRuntimeContext,
    msg: SendProviderMessage,
  ): Promise<ProviderSendResult> {
    const apiKey = ctx.env.BREVO_API_KEY;
    if (typeof apiKey !== 'string') {
      throw new DomainError({
        code: 'PROVIDER_CONFIG_ERROR',
        message: 'Missing API key',
        httpStatus: 500,
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

    const response = await fetch(`${BREVO_API_BASE}/smtp/email`, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new DomainError({
        code: 'PROVIDER_SEND_FAILED',
        message: `Brevo send failed: ${response.status} ${body}`.trim(),
        httpStatus: 502,
      });
    }

    const data = (await response.json()) as { messageId?: string };
    if (!data.messageId) {
      throw new DomainError({
        code: 'PROVIDER_SEND_FAILED',
        message: 'Brevo response missing messageId',
        httpStatus: 502,
      });
    }

    return {
      providerMessageId: data.messageId,
      acceptedAt: new Date().toISOString(),
    };
  },
};
