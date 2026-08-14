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

// ---------------------------------------------------------------------------
// Installation state — see docs/rebuild/05-target-architecture/api-design.md
// ---------------------------------------------------------------------------

/**
 * InstallationStep — each step in the setup wizard.
 * Ordered: claim → preflight → administrator → domain → cloudflare-verify
 * → inbound-smoke → brevo → outbound-smoke → complete.
 */
export const installationStepSchema = z.enum([
  'claim',
  'preflight',
  'administrator',
  'domain',
  'cloudflare-verify',
  'inbound-smoke',
  'brevo',
  'outbound-smoke',
  'complete',
]);

export type InstallationStep = z.infer<typeof installationStepSchema>;

/**
 * InstallationStateInfo — the single-row installation_state table shape.
 *
 * The `installation_state` table has CHECK (id = 1) — at most one row.
 * When the row is absent (fresh DB), the setup gate treats it as incomplete.
 */
export const installationStateInfoSchema = z.object({
  status: z.enum(['setup', 'complete']),
  currentStep: installationStepSchema,
});

export type InstallationStateInfo = z.infer<typeof installationStateInfoSchema>;

// ---------------------------------------------------------------------------
// Setup claim request — CAP-008
// ---------------------------------------------------------------------------

/**
 * Request body for POST /api/v1/setup/claim. The operator provides their
 * INSTALLATION_TOKEN to prove they hold the deploy-time secret.
 */
export const setupClaimRequestSchema = z.object({
  token: z.string().min(1),
});

export type SetupClaimRequest = z.infer<typeof setupClaimRequestSchema>;

// ---------------------------------------------------------------------------
// Setup preflight response — CAP-009
// ---------------------------------------------------------------------------

/**
 * Response body for POST /api/v1/setup/preflight. Reports each binding's
 * presence and the current database schema version.
 */
export const setupPreflightResponseSchema = z.object({
  bindings: z.record(z.boolean()),
  schemaVersion: z.string(),
});

export type SetupPreflightResponse = z.infer<typeof setupPreflightResponseSchema>;

// ---------------------------------------------------------------------------
// Setup administrator request — CAP-010
// ---------------------------------------------------------------------------

/**
 * Request body for POST /api/v1/setup/administrator. The operator creates
 * the first user (the initial administrator) with a PBKDF2-hashed password.
 *
 * R-AUTH-002: users.status is 'active' for the new administrator.
 * ADR-006: Password is hashed with PBKDF2-SHA256, 600k iterations.
 */
export const setupAdministratorRequestSchema = z.object({
  email: emailAddressSchema,
  password: z.string().min(8).max(72),
  displayName: z.string().max(100).optional(),
});

export type SetupAdministratorRequest = z.infer<typeof setupAdministratorRequestSchema>;

// ---------------------------------------------------------------------------
// Setup domain request — CAP-011
// ---------------------------------------------------------------------------

/**
 * Domain name schema — validated per R-DATA-001 (case-insensitive).
 *
 * Validates:
 * - Length: 4-253 chars (after trim/lowercase)
 * - Each label: 1-63 chars, starts/ends with alphanumeric, hyphens allowed internally
 * - At least one dot (subdomain.example or example.com)
 * - Only lowercase ASCII letters, digits, and hyphens
 *
 * Examples:
 * - ✓ example.com
 * - ✓ mail.example.com
 * - ✓ a-b.example.com
 * - ✗ example (no dot)
 * - ✗ -example.com (starts with hyphen)
 * - ✗ example-.com (ends with hyphen)
 * - ✗ Example.com (uppercase)
 * - ✗ a.b (too short — minimum 4 chars after normalization)
 */
export const domainNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(4)
  .max(253)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/,
    'Invalid domain name',
  );

export type DomainName = z.infer<typeof domainNameSchema>;

/**
 * Request body for POST /api/v1/setup/domain. The operator provides a domain
 * name to add to the managed domains list. The domain is created with status='active'.
 *
 * R-DATA-001: Domain names are case-insensitive (lowercased before insert).
 * ManagedDomain invariant: name is UNIQUE — duplicate returns 409.
 */
export const setupDomainRequestSchema = z.object({
  name: domainNameSchema,
});

export type SetupDomainRequest = z.infer<typeof setupDomainRequestSchema>;

// ---------------------------------------------------------------------------
// Setup Brevo request — CAP-014
// ---------------------------------------------------------------------------

/**
 * Request body for POST /api/v1/setup/brevo. The operator provides their
 * Brevo API key to validate and encrypt for storage.
 *
 * R-SECRET-002: Provider API keys live in encrypted_credentials.
 * R-SECRET-003: Secrets are never returned in API responses.
 */
export const setupBrevoRequestSchema = z.object({
  apiKey: z.string().trim().min(1),
});

export type SetupBrevoRequest = z.infer<typeof setupBrevoRequestSchema>;

// ---------------------------------------------------------------------------
// Authorization — CAP-017
// ---------------------------------------------------------------------------
/**
 * PermissionKey — closed enum of all permission keys.
 * R-AUTHZ-001: Permissions are a closed set; adding a key is a deliberate change.
 * R-AUTHZ-002: Authorization checks hit the database per request; no cache older than 5 minutes.
 *
 * From .claude/rules/security.md §Authorization:
 * - message.read, message.send, message.delete
 * - mailbox.create, mailbox.manage, mailbox.share
 * - user.read, user.manage
 * - role.read, role.manage
 * - domain.read, domain.manage
 * - signature.read, signature.manage
 * - settings.read, settings.manage
 * - provider.sync
 * - webhook_event.read, webhook_event.delete
 * - analytics.read
 */
export const permissionKeySchema = z.enum([
  'message.read',
  'message.send',
  'message.delete',
  'mailbox.create',
  'mailbox.manage',
  'mailbox.share',
  'user.read',
  'user.manage',
  'role.read',
  'role.manage',
  'domain.read',
  'domain.manage',
  'signature.read',
  'signature.manage',
  'settings.read',
  'settings.manage',
  'provider.sync',
  'webhook_event.read',
  'webhook_event.delete',
  'analytics.read',
]);

export type PermissionKey = z.infer<typeof permissionKeySchema>;

// ---------------------------------------------------------------------------
// Admin invite codes — CAP-018
// ---------------------------------------------------------------------------

/**
 * Request body for POST /api/v1/admin/invite-codes. Admin creates a registration key.
 *
 * - maxUses: maximum number of times the code can be used (default: 1)
 * - roleId: optional role ID to assign to users who register with this code
 * - expiresInHours: optional expiration in hours from now (null = no expiration)
 */
export const createInviteCodeRequestSchema = z.object({
  maxUses: z.number().int().min(1).default(1),
  roleId: z.string().optional(),
  expiresInHours: z.number().int().positive().optional(),
});

export type CreateInviteCodeRequest = z.infer<typeof createInviteCodeRequestSchema>;

// ---------------------------------------------------------------------------
// Authentication — CAP-019
// ---------------------------------------------------------------------------
/**
 * Request body for POST /api/v1/auth/register.
 *
 * - code: 64-character hex registration code (32 bytes, SHA-256 hashed for storage)
 * - email: user's email address (case-insensitive, validated per R-DATA-001)
 * - password: 8-72 characters (enforced by API, hashed with PBKDF2-SHA256)
 * - displayName: optional display name (max 100 chars)
 */
export const registerRequestSchema = z.object({
  code: z.string().length(64),
  email: emailAddressSchema,
  password: z.string().min(8).max(72),
  displayName: z.string().max(100).optional(),
});

export type RegisterRequest = z.infer<typeof registerRequestSchema>;

/**
 * Request body for POST /api/v1/auth/login.
 *
 * - email: user's email address (case-insensitive)
 * - password: user's password (1-72 chars to allow already-hashed edge cases)
 */
export const loginRequestSchema = z.object({
  email: emailAddressSchema,
  password: z.string().min(1).max(72),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * Request body for POST /api/v1/auth/refresh.
 *
 * - refreshToken: UUID refresh token (SHA-256 hashed for lookup in sessions table)
 */
export const refreshRequestSchema = z.object({
  refreshToken: uuidSchema,
});

export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

// ---------------------------------------------------------------------------
// Mailboxes — CAP-020
// ---------------------------------------------------------------------------
/**
 * Request body for POST /api/v1/mailboxes. Creates a new mailbox.
 *
 * - localPart: The part before @ (case-insensitive, validated per R-DATA-001)
 * - domainId: UUID of the managed domain (must exist and be active)
 * - displayName: Optional display name for the mailbox (max 100 chars)
 *
 * The mailbox address is constructed as {localPart}@{domain.name}.
 * R-MAILBOX-003: Owner (the authenticated user) is implicitly a member.
 */
export const createMailboxRequestSchema = z.object({
  localPart: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]$/, 'Invalid local part format'),
  domainId: uuidSchema,
  displayName: z.string().max(100).optional(),
});

export type CreateMailboxRequest = z.infer<typeof createMailboxRequestSchema>;

// ---------------------------------------------------------------------------
// Messages — CAP-022
// ---------------------------------------------------------------------------
/**
 * Recipient of a message — used in the to/cc arrays of list and detail responses.
 */
export const messageRecipientSchema = z.object({
  address: z.string(),
  displayName: z.string(),
});

export type MessageRecipientInfo = z.infer<typeof messageRecipientSchema>;

/**
 * One row in the inbox list response (GET /api/v1/mailboxes/:mailboxId/messages).
 *
 * R-MESSAGE-005: isRead is the per-user value (0 or 1).
 */
export const messageListItemSchema = z.object({
  id: uuidSchema,
  fromAddress: z.string(),
  fromName: z.string(),
  subject: z.string(),
  isRead: z.number(),
  isStarred: z.number(),
  folder: z.string(),
  createdAt: z.string(),
  recipients: z.object({
    to: z.array(messageRecipientSchema),
    cc: z.array(messageRecipientSchema),
  }),
});

export type MessageListItem = z.infer<typeof messageListItemSchema>;

/**
 * Response envelope for GET .../messages — cursor-paginated list of messages.
 */
export const messageListResponseSchema = z.object({
  items: z.array(messageListItemSchema),
  nextCursor: z.string().nullable(),
});

export type MessageListResponse = z.infer<typeof messageListResponseSchema>;

/**
 * Full message detail (GET /api/v1/mailboxes/:mailboxId/messages/:messageId).
 *
 * messageIdHeader/inReplyToHeader are nullable RFC 5322 headers; referencesHeader
 * is always present (defaults to empty string per the schema).
 */
export const messageDetailSchema = z.object({
  id: uuidSchema,
  fromAddress: z.string(),
  fromName: z.string(),
  subject: z.string(),
  htmlBody: z.string(),
  textBody: z.string(),
  messageIdHeader: z.string().nullable(),
  inReplyToHeader: z.string().nullable(),
  referencesHeader: z.string(),
  status: z.string(),
  isRead: z.number(),
  isStarred: z.number(),
  folder: z.string(),
  createdAt: z.string(),
  recipients: z.object({
    to: z.array(messageRecipientSchema),
    cc: z.array(messageRecipientSchema),
  }),
});

export type MessageDetail = z.infer<typeof messageDetailSchema>;

// ---------------------------------------------------------------------------
// Compose — CAP-023
// ---------------------------------------------------------------------------
/**
 * One recipient on a compose (send) request. Composed messages only carry
 * address + optional displayName — type ('to' / 'cc') is encoded by which
 * array the recipient lives in.
 */
export const composeRecipientSchema = z.object({
  address: emailAddressSchema,
  displayName: z.string().max(100).optional(),
});

/**
 * Request body for POST /api/v1/mailboxes/:mailboxId/messages/send.
 *
 * - to: at least one recipient (sending with no 'to' is a client bug)
 * - cc: optional, defaults to empty
 * - subject / htmlBody / textBody: default to empty strings so a reply can be
 *   sent with just bodies, or just a subject, etc.
 * - inReplyTo / references: optional RFC 5322 headers for threading
 *
 * The route is mutating, so per R-IDEMPOTENCY-* the handler requires an
 * Idempotency-Key header — that contract is enforced in middleware, not here.
 */
export const composeRequestSchema = z.object({
  to: z.array(composeRecipientSchema).min(1),
  cc: z.array(composeRecipientSchema).default([]),
  subject: z.string().max(998).default(''),
  htmlBody: z.string().max(1_000_000).default(''),
  textBody: z.string().max(1_000_000).default(''),
  inReplyTo: z.string().optional(),
  references: z.string().optional(),
});

export type ComposeRequest = z.infer<typeof composeRequestSchema>;

// ---------------------------------------------------------------------------
// Admin: Inbound blocklist + per-role policies — D-CAP-021 / CAP-035.
// ---------------------------------------------------------------------------
export {
  blocklistKindSchema,
  createBlocklistEntryRequestSchema,
  blocklistEntrySchema,
  type BlocklistKind,
  type CreateBlocklistEntryRequest,
  type BlocklistEntry,
  type BlocklistEntryRow,
  type BlocklistReader,
} from './admin/blocklist';

export {
  banEmailPatternSchema,
  availDomainPatternSchema,
  setRolePolicyRequestSchema,
  rolePolicySchema,
  type BanEmailPattern,
  type AvailDomainPattern,
  type SetRolePolicyRequest,
  type RolePolicy,
  type RolePolicyRow,
  type RolePolicyReader,
} from './admin/role-policy';
