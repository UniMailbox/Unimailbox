/**
 * @unimailbox/contracts
 *
 * Shared types and zod schemas. The only types that cross module boundaries.
 *
 * CAP-001 lays rails — this file holds a single sample schema so the build
 * pipeline has something to type-check. Real contracts land with CAP-004+.
 */
import { z } from 'zod';

// R-DATA-001 — email addresses are compared and stored case-insensitively.
export const emailAddressSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(254);

/**
 * Sample contract — a UUIDv4 string. The shape every other ID contract will
 * follow once CAP-004 lands the schema.
 *
 * Per ADR-005: all externally visible IDs are UUID v4 strings.
 */
export const uuidSchema = z.string().uuid();

export type Uuid = z.infer<typeof uuidSchema>;
export type EmailAddress = z.infer<typeof emailAddressSchema>;

// ---------------------------------------------------------------------------
// Provider plugin interface — see docs/rebuild/05-target-architecture/integration-boundaries.md
// ---------------------------------------------------------------------------

/**
 * Branded provider key. Prevents `string` from being passed where a concrete
 * provider is required; e.g. `parseProviderKey('brevo')` is the only way to
 * materialise one.
 */
export type ProviderKey = string & { readonly __brand: 'ProviderKey' };

export function parseProviderKey(value: string): ProviderKey {
  return value as ProviderKey;
}

/** MailAddress — provider-neutral. */
export interface MailAddress {
  readonly address: EmailAddress;
  readonly displayName?: string;
}

/** Provider-neutral attachment payload. */
export interface ProviderAttachment {
  readonly filename: string | null;
  readonly contentType: string;
  readonly disposition: 'attachment' | 'inline';
  readonly contentId?: string;
  readonly content: ArrayBuffer;
}

/** Provider-neutral send payload. */
export interface SendProviderMessage {
  readonly idempotencyKey: string;
  readonly from: MailAddress;
  readonly to: ReadonlyArray<MailAddress>;
  readonly cc: ReadonlyArray<MailAddress>;
  readonly bcc: ReadonlyArray<MailAddress>;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly messageId?: string;
  readonly inReplyTo?: string;
  readonly references?: string;
  readonly attachments: ReadonlyArray<ProviderAttachment>;
}

export interface ProviderSendResult {
  readonly providerMessageId: string;
  readonly acceptedAt: string;
}

/**
 * Runtime context handed to every adapter call. The minimal shape is
 * `{ env: Env }` for now; the full context (request id, logger, secrets
 * accessor) lands with the outbound-mail module.
 */
export interface ProviderRuntimeContext {
  readonly env: {
    readonly ENVIRONMENT?: string;
    [key: string]: unknown;
  };
}

/**
 * OutboundProviderAdapter — the single seam between domain code and any
 * concrete email-sending provider (Brevo, Resend, CF-Sendmail, etc.).
 *
 * Modules depend on this interface — never on a provider SDK directly
 * (.claude/rules/architecture.md §Forbidden). Adapters live in
 * `apps/worker/src/integrations/providers/*` and own the SDK calls.
 */
export interface OutboundProviderAdapter {
  readonly key: ProviderKey;
  validateConnection(ctx: ProviderRuntimeContext): Promise<void>;
  send(
    ctx: ProviderRuntimeContext,
    msg: SendProviderMessage,
  ): Promise<ProviderSendResult>;
}
