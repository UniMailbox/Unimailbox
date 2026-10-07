/**
 * @unimailbox/contracts
 *
 * Shared types and zod schemas. The only types that cross module boundaries.
 *
 * CAP-001 lays rails — this file holds a single sample schema so the build
 * pipeline has something to type-check. Real contracts land with CAP-004+.
 */
import { z } from 'zod';
import { attachmentContentTypeSchema, attachmentFilenameSchema } from './attachments';
import { domainNameSchema } from './domain-name';
import { uuidSchema } from './ids';

export * from './attachments';
export * from './admin/permissions';
export * from './admin/roles';
export { domainNameSchema } from './domain-name';
export type { DomainName } from './domain-name';
export { uuidSchema } from './ids';
export type { Uuid } from './ids';

// R-DATA-001 — email addresses are compared and stored case-insensitively.
export const emailAddressSchema = z.string().trim().toLowerCase().email().max(254);

/**
 * R-AUTH-008 — minimum email-prefix length gate.
 *
 * `R-AUTH-008` requires the registration path to reject email prefixes
 * shorter than `minEmailPrefix`. The application does not expose a
 * runtime setting for this value (the value is owned by the contracts
 * layer so the wire contract is one place to audit). Three characters
 * is the chosen defensible default:
 *
 *   - At least two characters: a single-letter prefix is too easy to
 *     collide with display preferences and to enumerate.
 *   - At most common: 3-character prefixes (`"abc@example.com"`) are
 *     the smallest realistic handle; anything below that is operator
 *     error or probing traffic.
 *
 * A future product change that wants a different default updates the
 * constant here; `registerRequestSchema` and any future
 * `signUpRequestSchema` re-use the same constant so a single edit
 * changes the wire contract end-to-end.
 */
export const MIN_EMAIL_PREFIX_LENGTH = 3;

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
  send(ctx: ProviderRuntimeContext, msg: SendProviderMessage): Promise<ProviderSendResult>;
}

// ---------------------------------------------------------------------------
// Message status — CAP-029 webhook ordering.
// ---------------------------------------------------------------------------

/**
 * Closed enum of message status values. Mirrors the CHECK constraint on
 * `messages.status` (migration 0006_messages.sql).
 *
 * Used as the input to `statusRank()` so R-MESSAGE-007 ordering is defined
 * in one place — the contract layer, not magic numbers in a repository.
 *
 * R-MESSAGE-007: webhook status updates are applied only if the new
 * provider_event_time is strictly newer than the stored value, or equal with
 * a strictly higher status rank. The rank is the single tie-breaker.
 */
export const messageStatusSchema = z.enum([
  'draft',
  'queued',
  'sending',
  'sent',
  'delivered',
  'delayed',
  'bounced',
  'complained',
  'failed',
]);

export type MessageStatus = z.infer<typeof messageStatusSchema>;

/**
 * R-MESSAGE-007 status rank. Terminal states (`failed`, `bounced`,
 * `complained`) tie for the highest rank; non-terminal states rank by
 * progression through the lifecycle (`delivered` > `delayed` > `queued` >
 * `sending` > `sent`). The relative ordering of `delivered` and `sent`
 * reflects that a confirmed delivery is "more resolved" than a queued send
 * — a stored `sent` row can be later upgraded to `delivered` on tie.
 *
 * Higher number = higher rank. Equality is allowed; strict-greater decides.
 */
// CAP-029 Arch M1 / Security M3 review-triage: STATUS_RANK_TABLE is now
// exported as a readonly array of [status, rank] pairs so the guard test
// in packages/contracts/src/index.test.ts can pin it against the SQL CASE
// in apps/worker/src/modules/messages/message-repository.ts. The shape
// (array of pairs) makes drift detectable: an `expect(STATUS_RANK_TABLE).toEqual(EXPECTED_PAIRS)`
// fails loudly when either side moves.
export const STATUS_RANK_TABLE: ReadonlyArray<readonly [MessageStatus, number]> = [
  ['failed', 100],
  ['bounced', 100],
  ['complained', 100],
  ['delivered', 80],
  ['delayed', 60],
  ['queued', 40],
  ['sending', 30],
  ['sent', 20],
  ['draft', 10],
];

export function statusRank(status: MessageStatus): number {
  // Look up by status — the array form above is the source of truth, this
  // O(n) lookup is fine for the (small) closed enum.
  const entry = STATUS_RANK_TABLE.find(([s]) => s === status);
  if (!entry) {
    throw new Error(`statusRank: unknown status ${String(status)}`);
  }
  return entry[1];
}

// ---------------------------------------------------------------------------
// Outbound job status — CAP-030 D-CAP-030-E (parity with messageStatusSchema).
// ---------------------------------------------------------------------------

/**
 * Closed enum of outbound job status values. Mirrors the CHECK constraint on
 * `outbound_jobs.status` (migration 0007_outbound_jobs.sql). Defined here
 * rather than consumed via the Drizzle row type so cross-boundary types come
 * from `contracts` (`.claude/rules/architecture.md` §Drizzle row types
 * crossing a module boundary).
 *
 * Note: `messages.status` and `outbound_jobs.status` are *not* identical sets
 * — `messages` has `draft`, `outbound_jobs` does not (a job is created at
 * `queued` by compose; draft is for a future drafts module). The direction
 * tables below encode the per-state lifecycles.
 */
export const outboundJobStatusSchema = z.enum([
  'queued',
  'sending',
  'sent',
  'delayed',
  'bounced',
  'complained',
  'failed',
]);

export type OutboundJobStatus = z.infer<typeof outboundJobStatusSchema>;

// ---------------------------------------------------------------------------
// Lifecycle direction tables — CAP-030.
// ---------------------------------------------------------------------------

/**
 * Allowed lifecycle transitions for `messages.status`. The forward path is
 * `draft → queued → sending → sent → delivered`, with terminal outcomes
 * (`failed`, `bounced`, `complained`) reachable from any non-terminal state.
 *
 * Per-state rationale:
 * - `draft` — initial state; no inbound transition. `R-MESSAGE-010` allows
 *   `draft → queued` (compose path bypasses the direction guard on INSERT)
 *   and `draft → sent` (a future drafts module's send).
 * - `queued` — produced by compose; can be claimed (`→ sending`), direct-sent
 *   (skip-claim path), or fail terminally.
 * - `sending` — held under a lease; outcomes are success (`sent`), retry
 *   reset (`queued`, R-OUTBOUND-008 semantics applied at the message level
 *   for the same event ordering), delay (`delayed`), or terminal.
 * - `sent` — webhook-driven outcomes. `D-CAP-030-F`: `sent → delayed` is a
 *   legitimate forward path (provider-side deferral after acceptance).
 * - `delivered` — confirmed; subsequent events are retroactive terminal
 *   corrections (`bounced`, `complained`, `failed`).
 * - `delayed` — recoverable; can resolve to `sent`, `delivered`, or terminal.
 * - `bounced`, `complained`, `failed` — terminal (`R-MESSAGE-012`-style);
 *   empty allowed-from set in the direction table AND the rank guard (rank
 *   100 ties, no equal-time promotion out) makes resurrection impossible
 *   from any non-newer-event path. Newer events still apply (the strict-
 *   less-time branch) — see CAP-029 A4.
 */
export const ALLOWED_MESSAGE_TRANSITIONS: ReadonlyMap<
  MessageStatus,
  ReadonlySet<MessageStatus>
> = new Map<MessageStatus, ReadonlySet<MessageStatus>>([
  // R-MESSAGE-010: draft → queued (compose path) and draft → sent (a future
  // drafts module's send).
  ['draft', new Set<MessageStatus>(['queued', 'sent'])],
  // Compose inserts at 'queued'; outcomes from 'queued' cover the claim
  // path plus direct-send and direct-failure edge cases.
  [
    'queued',
    new Set<MessageStatus>(['sending', 'sent', 'delayed', 'failed', 'bounced', 'complained']),
  ],
  // The post-claim attempt outcomes. 'sent' (success), 'delayed' (provider
  // deferral mid-flight), terminal outcomes. 'queued' is intentionally NOT
  // listed — R-OUTBOUND-008 retry reset applies to outbound_jobs, not messages.
  ['sending', new Set<MessageStatus>(['sent', 'delayed', 'failed', 'bounced', 'complained'])],
  // D-CAP-030-F: 'sent → delayed' is a legitimate forward path (provider
  // temporarily defers after acceptance). Terminal outcomes remain reachable.
  ['sent', new Set<MessageStatus>(['delivered', 'delayed', 'failed', 'bounced', 'complained'])],
  // Confirmed delivery; subsequent events are retroactive terminal
  // corrections only.
  ['delivered', new Set<MessageStatus>(['failed', 'bounced', 'complained'])],
  // Recoverable delay; can resolve to 'sent', 'delivered', or terminal.
  ['delayed', new Set<MessageStatus>(['sent', 'delivered', 'failed', 'bounced', 'complained'])],
  // R-MESSAGE-012: terminal. Empty set — resurrection is blocked.
  ['bounced', new Set<MessageStatus>([])],
  ['complained', new Set<MessageStatus>([])],
  ['failed', new Set<MessageStatus>([])],
]);

/**
 * Allowed lifecycle transitions for `outbound_jobs.status`. Driven by the
 * lease-aware writers (`claimOutboundJob`, `markOutboundJobSent`,
 * `markOutboundJobRetryable`, `markOutboundJobTerminal`) and the scheduled
 * reclaim path. Each writer's hard-coded `status = '...'` predicate already
 * enforces the legal `from` — this table makes the policy explicit so a
 * SQL change cannot silently widen it.
 *
 * Per-state rationale:
 * - `queued` — produced by compose; only legal forward is the claim
 *   (`→ sending`).
 * - `sending` — held under a lease. Three documented outcomes: success
 *   (`sent`, R-OUTBOUND-009), retry reset (`queued`, R-OUTBOUND-008),
 *   terminal failure (`failed`, R-OUTBOUND-008/009). The reclaim path
 *   (R-OUTBOUND-007) also transitions `sending → queued` for uncrashed
 *   consumers and `sending → failed` for `RECLAIM_EXHAUSTED`.
 * - `sent` — terminal (R-OUTBOUND-009). Empty allowed-from set.
 * - `delayed` — schema permits it (migration 0007 CHECK); no writer today
 *   advances a row to or from `delayed`. Empty set to make the gap
 *   explicit (D-CAP-030-C).
 * - `bounced`, `complained`, `failed` — terminal (R-OUTBOUND-009).
 */
export const ALLOWED_JOB_TRANSITIONS: ReadonlyMap<
  OutboundJobStatus,
  ReadonlySet<OutboundJobStatus>
> = new Map<OutboundJobStatus, ReadonlySet<OutboundJobStatus>>([
  // Only the claim path advances a row out of 'queued'.
  ['queued', new Set<OutboundJobStatus>(['sending'])],
  // The three documented lease-aware writer outcomes, plus the reclaim
  // path's two 'sending → queued' / 'sending → failed' transitions which
  // are subsumed by the same FROM state.
  ['sending', new Set<OutboundJobStatus>(['sent', 'queued', 'failed'])],
  // Terminal.
  ['sent', new Set<OutboundJobStatus>([])],
  // No writer exists today to advance a row to or from 'delayed'. The
  // direction table makes the gap explicit so a future writer must
  // consciously widen the set.
  ['delayed', new Set<OutboundJobStatus>([])],
  ['bounced', new Set<OutboundJobStatus>([])],
  ['complained', new Set<OutboundJobStatus>([])],
  ['failed', new Set<OutboundJobStatus>([])],
]);

/**
 * Pure direction guard. Returns `true` iff `from → to` is an allowed
 * lifecycle transition in the named domain. The first argument picks which
 * direction table is consulted — the two domains share values like
 * `queued`/`sending`/`sent` but not their transition policy, so the
 * discriminator is load-bearing (CAP-030 D-CAP-030-B: `sending → queued`
 * is allowed for jobs but forbidden for messages).
 *
 * The public API is split into two overloads (D-CAP-030-A) so a caller
 * passing `domain: 'job'` with a messages-only `from` value (e.g. `'draft'`)
 * is rejected at compile time instead of silently returning `false` via the
 * `?? false` fallback. The internal `canTransitionImpl` keeps the broad
 * union so `assertCanTransition` (which already takes the union) can
 * dispatch without a cast; callers outside this module see only the
 * strict overloads.
 */
export function canTransition(domain: 'message', from: MessageStatus, to: MessageStatus): boolean;
export function canTransition(
  domain: 'job',
  from: OutboundJobStatus,
  to: OutboundJobStatus,
): boolean;
export function canTransition(
  domain: 'message' | 'job',
  from: MessageStatus | OutboundJobStatus,
  to: MessageStatus | OutboundJobStatus,
): boolean;
export function canTransition(
  domain: 'message' | 'job',
  from: MessageStatus | OutboundJobStatus,
  to: MessageStatus | OutboundJobStatus,
): boolean {
  return canTransitionImpl(domain, from, to);
}

/**
 * Internal implementation — keeps the broad union so the inner `switch`
 can resolve `from`/`to` without a cast at every callsite. Not exported;
 `assertCanTransition` is the only consumer.
 */
function canTransitionImpl(
  domain: 'message' | 'job',
  from: MessageStatus | OutboundJobStatus,
  to: MessageStatus | OutboundJobStatus,
): boolean {
  switch (domain) {
    case 'message':
      return (
        ALLOWED_MESSAGE_TRANSITIONS.get(from as MessageStatus)?.has(to as MessageStatus) ?? false
      );
    case 'job':
      return (
        ALLOWED_JOB_TRANSITIONS.get(from as OutboundJobStatus)?.has(to as OutboundJobStatus) ??
        false
      );
  }
}

/**
 * Programmer-error guard. Throws when the transition is not allowed in the
 * named domain. Same plain-`Error` pattern as `statusRank` above — this is
 * NOT a user-facing 409, it is a developer invariant. SQL writers must use
 * `canTransition` (returning boolean) for in-flight rejection; this helper
 * is for code paths that *should* have already validated.
 *
 * D-CAP-030-G: a typed `DomainError` is intentionally NOT thrown here —
 * the closed error catalog (CAP-032) is for user-facing conditions, and
 * a direction violation is never one of those.
 *
 * Domain overloads mirror `canTransition` (D-CAP-030-A): passing a
 * messages-only `from` with `domain: 'job'` is a compile-time error.
 */
export function assertCanTransition(
  domain: 'message',
  from: MessageStatus,
  to: MessageStatus,
): void;
export function assertCanTransition(
  domain: 'job',
  from: OutboundJobStatus,
  to: OutboundJobStatus,
): void;
export function assertCanTransition(
  domain: 'message' | 'job',
  from: MessageStatus | OutboundJobStatus,
  to: MessageStatus | OutboundJobStatus,
): void;
export function assertCanTransition(
  domain: 'message' | 'job',
  from: MessageStatus | OutboundJobStatus,
  to: MessageStatus | OutboundJobStatus,
): void {
  if (!canTransitionImpl(domain, from, to)) {
    throw new Error(
      `assertCanTransition(${domain}): ${String(from)} → ${String(to)} is not an allowed lifecycle transition`,
    );
  }
}

/**
 * Returns the FROM-statuses that can transition to `to` in the messages
 * lifecycle. The result feeds the `AND status IN (SELECT value FROM
 * json_each(?))` clause in `updateMessageStatus` so the rank-aware
 * predicate is layered behind a direction gate (CAP-030 D-CAP-030-D-2).
 *
 * Empty array when no FROM-state is allowed (e.g. `to = 'draft'` — never
 * a valid target). SQL `IN` over an empty `json_each` returns no rows,
 * so the predicate evaluates to false; correct behaviour.
 */
export function allowedFromForMessageStatus(to: MessageStatus): ReadonlyArray<MessageStatus> {
  const froms: MessageStatus[] = [];
  for (const [from, tos] of ALLOWED_MESSAGE_TRANSITIONS) {
    if (tos.has(to)) froms.push(from);
  }
  return froms;
}

// ---------------------------------------------------------------------------
// Provider adapter error taxonomy — CAP-029 D-CAP-028-A.
// ---------------------------------------------------------------------------

/**
 * Discriminated error kinds thrown by an OutboundProviderAdapter. The
 * interface declares the shape so the queue-consumer use case
 * (process-outbound-job.ts) can branch on `kind` instead of guessing from
 * the HTTP status. Adapters translate HTTP responses into these kinds at
 * the SDK boundary; the queue consumer never sees an SDK error.
 *
 * R-OUTBOUND-008: a `terminal` error marks the job failed immediately —
 * not after max_attempts retries. A `retryable` error keeps the existing
 * attempts-budget logic.
 */
export type ProviderErrorKind = 'retryable' | 'terminal';

/**
 * Common shape for the two provider error types. Carries the HTTP status
 * (when applicable) and chains the underlying SDK error via `cause` per the
 * ES2022 Error chain (Q4 decision in CAP-029 task.md). R-LOG-001 is preserved:
 * the chain carries the message and stack, never bodies or API keys.
 */
interface ProviderErrorOptions {
  readonly message: string;
  readonly httpStatus?: number;
  readonly cause?: unknown;
}

function chainCause(options: ProviderErrorOptions): { cause: unknown } | undefined {
  return options.cause !== undefined ? { cause: options.cause } : undefined;
}

export class RetryableProviderError extends Error {
  readonly kind: ProviderErrorKind = 'retryable';
  readonly httpStatus: number | undefined;
  // `cause` is inherited from Error.prototype; do NOT redeclare it as a class
  // field — with `useDefineForClassFields: true` (TS default for ES2022 +
  // module ESNext) the field declaration would shadow Error's instance
  // assignment and reset `cause` to `undefined`.

  constructor(options: ProviderErrorOptions) {
    super(options.message, chainCause(options));
    this.name = 'RetryableProviderError';
    this.httpStatus = options.httpStatus;
  }
}

export class TerminalProviderError extends Error {
  readonly kind: ProviderErrorKind = 'terminal';
  readonly httpStatus: number | undefined;
  // `cause` is inherited from Error.prototype; see RetryableProviderError.

  constructor(options: ProviderErrorOptions) {
    super(options.message, chainCause(options));
    this.name = 'TerminalProviderError';
    this.httpStatus = options.httpStatus;
  }
}

/**
 * Type-guard helper: returns true when `error` is a recognised provider
 * error (`RetryableProviderError` or `TerminalProviderError`). The
 * queue-consumer use case uses this to decide whether to take the typed
 * fast-path or fall back to the existing SEND_FAILED path (B6 acceptance).
 */
export function isProviderError(
  error: unknown,
): error is RetryableProviderError | TerminalProviderError {
  return error instanceof RetryableProviderError || error instanceof TerminalProviderError;
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

/**
 * `CURRENT_SCHEMA_VERSION` — the canonical migration identifier the doctor
 * `schema-version` check compares the highest migration filename against.
 *
 * Lives in `apps/worker/src/database/schema-version.ts`; exported here so
 * the web client can gate its Continue button on the same constant
 * without crossing module boundaries (CAP-041 AC #6). Bumped when a new
 * migration lands. Hand-written; intentionally not auto-generated.
 *
 * CAP-043 Slice 1: bumped from `'0015'` to `'0016'` after
 * migrations/0016_message_user_state_soft_delete.sql (per-user
 * is_deleted / deleted_at columns), to `'0017'` for the composite primary
 * key, to `'0018'` for the audit.read upgrade backfill, to `'0019'` for
 * the role_policies JSON normalization (CAP-036), and to `'0020'` for
 * the idempotency_records.response_json CHECK raise (CAP-047 PATCH
 * slice), to `'0021'` for attachment_uploads (CAP-049), and to
 * `'0022'` for message_attachments (CAP-050 — one-consume-per-upload
 * via UNIQUE index + BEFORE INSERT trigger), to `'0023'` for per-user message
 * star state (CAP-058), to `'0024'` for one sanitized signature per managed
 * domain (CAP-068), and to `'0025'` for the CAP-069 settings revision seed.
 */
export const CURRENT_SCHEMA_VERSION = '0025' as const;

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
  // R-AUTH-007 reconciled business rule: 6..30 characters.
  // Same range as `registerRequestSchema` so setup and registration
  // agree on the password policy.
  password: z.string().min(6).max(30),
  displayName: z.string().max(100).optional(),
});

export type SetupAdministratorRequest = z.infer<typeof setupAdministratorRequestSchema>;

// ---------------------------------------------------------------------------
// Setup domain request — CAP-011
// ---------------------------------------------------------------------------

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
 *         The local-part (before `@`) must be at least `MIN_EMAIL_PREFIX_LENGTH`
 *         characters per R-AUTH-008 — too-short prefixes are rejected with 400
 *         VALIDATION_ERROR at the route boundary.
 * - password: 6-30 characters (enforced by API, hashed with PBKDF2-SHA256)
 * - displayName: optional display name (max 100 chars)
 */
export const registerRequestSchema = z.object({
  code: z.string().length(64),
  email: emailAddressSchema.refine(
    (value) => {
      const atIdx = value.indexOf('@');
      const prefix = atIdx >= 0 ? value.slice(0, atIdx) : value;
      return prefix.length >= MIN_EMAIL_PREFIX_LENGTH;
    },
    {
      message: `email prefix must be at least ${MIN_EMAIL_PREFIX_LENGTH} characters (R-AUTH-008)`,
    },
  ),
  // R-AUTH-007 reconciled business rule: 6..30 characters.
  // The legacy 8..72 was drift; Better Auth's
  // `emailAndPassword.min/maxPasswordLength` (factory.ts) pins the
  // runtime to the same range so the two surfaces agree.
  password: z.string().min(6).max(30),
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

/**
 * One row in the mailbox list response (GET /api/v1/mailboxes, CAP-020).
 *
 * CAP-043 Slice 3 (Slice 1 review, arch MEDIUM): promoted verbatim from the
 * local zod schema in `apps/web/src/features/mailbox/mailbox-queries.ts` —
 * cross-boundary wire shapes belong in contracts, not in a client feature
 * folder. The field types are carried over unchanged so
 * `fetchMailboxList`'s parsing behavior is identical before and after the
 * move (ids are UUIDs per ADR-005, but the schema keeps `z.string()` to
 * preserve the promoted shape).
 */
export const mailboxListItemSchema = z.object({
  id: z.string(),
  address: z.string(),
  displayName: z.string(),
  status: z.string(),
  domainId: z.string(),
  localPart: z.string(),
  ownerUserId: z.string(),
});

export type MailboxListItem = z.infer<typeof mailboxListItemSchema>;

/**
 * Inner shape of the GET /api/v1/mailboxes response body (the envelope's
 * `data` object): `{ data: { items: MailboxListItem[] } }` on the wire.
 */
export const mailboxListResponseSchema = z.object({
  items: z.array(mailboxListItemSchema),
});

export type MailboxListResponse = z.infer<typeof mailboxListResponseSchema>;

// ---------------------------------------------------------------------------
// Mailbox sharing — CAP-057
// ---------------------------------------------------------------------------

/** Explicit roles for mailbox members. The owner remains implicit. */
export const mailboxMemberRoleSchema = z.enum(['viewer', 'sender', 'admin']);
export type MailboxMemberRole = z.infer<typeof mailboxMemberRoleSchema>;

/** Strict request body for adding one explicit mailbox member. */
export const addMailboxMemberRequestSchema = z
  .object({
    email: emailAddressSchema,
    role: mailboxMemberRoleSchema,
  })
  .strict();

export type AddMailboxMemberRequest = z.infer<typeof addMailboxMemberRequestSchema>;

/** Safe member projection. Credentials, upload identifiers, and storage keys are absent. */
export const mailboxMemberItemSchema = z
  .object({
    userId: uuidSchema,
    email: emailAddressSchema,
    displayName: z.string().nullable(),
    role: mailboxMemberRoleSchema,
    createdAt: z.string().min(1),
  })
  .strict();

export type MailboxMemberItem = z.infer<typeof mailboxMemberItemSchema>;

/** Inner list response shape for GET /mailboxes/:mailboxId/members. */
export const mailboxMemberListResponseSchema = z
  .object({
    items: z.array(mailboxMemberItemSchema),
  })
  .strict();

export type MailboxMemberListResponse = z.infer<typeof mailboxMemberListResponseSchema>;

/** Canonical add response envelope. */
export const addMailboxMemberResponseSchema = z
  .object({
    data: mailboxMemberItemSchema,
  })
  .strict();

export type AddMailboxMemberResponse = z.infer<typeof addMailboxMemberResponseSchema>;

/** Canonical remove response envelope. */
export const deleteMailboxMemberResponseSchema = z
  .object({
    data: z
      .object({
        removed: z.literal(true),
        userId: uuidSchema,
      })
      .strict(),
  })
  .strict();

export type DeleteMailboxMemberResponse = z.infer<typeof deleteMailboxMemberResponseSchema>;

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

// D1 stores these presentation flags as constrained INTEGER 0/1 values.
// Keep the wire contract equally narrow so an invalid state cannot cross the
// module boundary as an arbitrary number.
const messageStateFlagSchema = z.union([z.literal(0), z.literal(1)]);

/**
 * Closed mailbox folder vocabulary used by message-list filters and
 * projections. The database column predates this contract and remains a
 * TEXT compatibility column, but new API inputs and outputs must stay within
 * the five user-visible views.
 */
export const messageFolderSchema = z.enum(['inbox', 'sent', 'drafts', 'archive', 'trash']);
export type MessageFolder = z.infer<typeof messageFolderSchema>;

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
  isRead: messageStateFlagSchema,
  isStarred: messageStateFlagSchema,
  folder: messageFolderSchema,
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
 * Metadata-only attachment relation in a message detail response.
 *
 * R-ATTACHMENT-001 / R-SECRET-003: the client receives the relation ID and
 * display metadata needed to render a download control, never the consumed
 * upload ID, storage object key, or bytes.
 */
export const messageAttachmentMetadataSchema = z
  .object({
    id: uuidSchema,
    filename: attachmentFilenameSchema,
    contentType: attachmentContentTypeSchema,
    sizeBytes: z.number().int().positive(),
    disposition: z.enum(['attachment', 'inline']),
    contentId: z.string().nullable(),
  })
  .strict();

export type MessageAttachmentMetadata = z.infer<typeof messageAttachmentMetadataSchema>;

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
  isRead: messageStateFlagSchema,
  isStarred: messageStateFlagSchema,
  folder: messageFolderSchema,
  createdAt: z.string(),
  recipients: z.object({
    to: z.array(messageRecipientSchema),
    cc: z.array(messageRecipientSchema),
  }),
  // Optional during client rollout; the Worker always emits an array.
  attachments: z.array(messageAttachmentMetadataSchema).optional(),
});

export type MessageDetail = z.infer<typeof messageDetailSchema>;

/**
 * Response envelope for GET /api/v1/mailboxes/:mailboxId/messages/:messageId/thread
 * (CAP-043 AC 10).
 *
 * `rootId` is the thread's resolved root per D-CAP-043-C — the first
 * non-empty of `messages.thread_id`, the first `<…>` msg-id token of
 * `references_header` (brackets kept: every threading header is stored
 * verbatim from RFC 5322, so a stripped token would never match a root
 * message's `message_id_header`), `in_reply_to_header`, or the anchor's
 * own `message_id_header` for a singleton. Nullable when the anchor
 * carries no threading headers at all — the thread is then the singleton
 * anchor itself.
 *
 * `items` are the same-mailbox messages resolving to the same root,
 * oldest-first, with per-user isRead (R-MESSAGE-005) and the calling
 * user's soft-deleted rows excluded.
 */
export const messageThreadResponseSchema = z.object({
  rootId: z.string().nullable(),
  items: z.array(messageListItemSchema),
});

export type MessageThreadResponse = z.infer<typeof messageThreadResponseSchema>;

/**
 * Full response body of PATCH /api/v1/mailboxes/:mailboxId/messages/:messageId/star
 * (CAP-058). Unlike the list/detail schemas, which model the
 * envelope's inner `data` object, this schema covers the whole wire body —
 * a one-shot action response is parsed in one step by the star mutation.
 *
 * `id` is the message id from the path (echoed so a replayed caller can
 * correlate); `isStarred` is the post-toggle caller-scoped flag (R-MESSAGE-005)
 * as the SQLite integer 0 or 1, consistent with `messageListItemSchema`.
 *
 * R-API-004: replays return the byte-identical stored response.
 */
export const toggleStarResponseSchema = z.object({
  data: z.object({
    id: uuidSchema,
    isStarred: messageStateFlagSchema,
  }),
});

export type ToggleStarResponse = z.infer<typeof toggleStarResponseSchema>;

// CAP-043 D-CAP-043-E: there is deliberately NO `deleteMessageResponseSchema`
// — DELETE .../messages/:messageId returns 204 No Content, and a body-less
// response has nothing to contract.

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
export const composeRequestSchema = z
  .object({
    to: z.array(composeRecipientSchema).min(1),
    cc: z.array(composeRecipientSchema).default([]),
    subject: z.string().max(998).default(''),
    htmlBody: z.string().max(1_000_000).default(''),
    textBody: z.string().max(1_000_000).default(''),
    inReplyTo: z.string().optional(),
    references: z.string().optional(),
    // CAP-050: optional list of CAP-049 staged upload IDs whose bytes
    // (already in CACHE KV under `attachment:<uploadId>`) should be
    // attached to this message. Defaults to empty so existing clients
    // are byte-identical. The route layer enforces the actor/mailbox
    // authorization and collapses every unavailable upload (missing,
    // foreign, expired, already-consumed, KV-missing) into one stable
    // safe error so ownership/lifecycle details never leak.
    attachmentUploadIds: z.array(uuidSchema).max(10).default([]),
  })
  .superRefine((value, ctx) => {
    // R-ATTACHMENT-001 / R-API-005: duplicate upload IDs in a single
    // request collapse to the existing 400 validation envelope. We
    // check both the existence-of-dup and the human-readable position
    // so the client gets the standard `path: ['attachmentUploadIds', N]`
    // shape used elsewhere in this contract.
    const seen = new Set<string>();
    value.attachmentUploadIds.forEach((id, index) => {
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['attachmentUploadIds', index],
          message: 'duplicate attachmentUploadId',
        });
      }
      seen.add(id);
    });
  });

export type ComposeRequest = z.infer<typeof composeRequestSchema>;

/**
 * Full response body of POST /api/v1/mailboxes/:mailboxId/messages/send
 * (CAP-023; promoted into contracts by CAP-044 Slice 1 / AC 3).
 *
 * The route answers 202 — the message is persisted `queued` (message +
 * recipients + mailbox_messages + outbound_jobs + idempotency record in
 * one D1 batch, R-OUTBOUND-006) and handed to the OUTBOUND queue, but it
 * has not yet reached the provider. Like `toggleStarResponseSchema`, this
 * schema models the WHOLE wire body (envelope included) so the compose
 * mutation parses the 202 in one step.
 *
 * R-API-004: replays with the same Idempotency-Key return the
 * byte-identical stored response, so the schema also describes every
 * replay.
 */
export const composeResponseSchema = z.object({
  data: z.object({
    messageId: uuidSchema,
    status: z.literal('queued'),
  }),
});

export type ComposeResponse = z.infer<typeof composeResponseSchema>;

// ---------------------------------------------------------------------------
// Drafts — CAP-047 wire contracts (slice 1.1: drafts core).
//
// These are the shared *wire* input contracts the CAP-047 draft routes will
// validate against. They are intentionally written with the CAP-047 wire
// names (`body_text` / `body_html`) — NOT the database Drizzle column names.
// The wire shape is locked at this boundary so the storage layer can evolve
// without breaking the public API (D-CAP-047-contracts: do not leak Drizzle
// names across the contracts boundary).
//
// CAP-047 also needs `If-Match: <updated_at>` on PATCH and an
// `Idempotency-Key` header on every mutating route. Those contracts are
// enforced by HTTP middleware in `apps/worker/src/http/middleware/`, not by
// the body schemas here.
// ---------------------------------------------------------------------------

/**
 * Request body for `POST /api/v1/mailboxes/:mailboxId/drafts`.
 *
 * - `subject`: required, ≤998 chars (matches the compose contract ceiling).
 * - `body_text`: required, ≤65,536 chars (64 KiB; the wire ceiling for the
 *   text body — drafts are server-authoritative, so the wire body is the
 *   source of truth for content).
 * - `body_html`: optional, ≤131,072 chars (128 KiB; the wire ceiling for
 *   the HTML body).
 * - `to`: required array of validated `EmailAddress` values, max 50.
 *   `to` is required (no default) — callers must always supply it, even
 *   as `[]`.
 * - `cc` / `bcc`: optional arrays of validated `EmailAddress` values, max
 *   50; default to `[]` to match the compose contract convention
 *   (`composeRequestSchema.cc.default([])`) so the minimum payload
 *   `{subject, body_text, to: []}` is valid without specifying `cc` or
 *   `bcc`.
 *
 * Recipient arrays are *arrays of strings* (the `EmailAddress` inferred
 * type), not objects — the wire shape does not carry per-recipient
 * `displayName` on drafts. A future drafts slice can widen this if the UI
 * needs a display name; the contracts layer is the boundary.
 *
 * The schema is `.strict()` so unknown fields (e.g. an `htmlBody` /
 * `textBody` typo, an `id` slipped into the body, etc.) are rejected at
 * the boundary instead of silently stripped: this is the same posture as
 * `updateDraftSchema` and `sendDraftSchema`, and it makes a typo a 400-
 * class error rather than a silent no-op against the wire contract.
 */
export const createDraftSchema = z
  .object({
    subject: z.string().max(998),
    body_text: z.string().max(65_536),
    body_html: z.string().max(131_072).optional(),
    to: z.array(emailAddressSchema).max(50),
    cc: z.array(emailAddressSchema).max(50).default([]),
    bcc: z.array(emailAddressSchema).max(50).default([]),
  })
  .strict();

export type CreateDraftRequest = z.infer<typeof createDraftSchema>;

const draftTimestampSchema = z.string().datetime({ precision: 3, offset: false });

/**
 * Server-authoritative draft returned by `GET /api/v1/drafts/:id`.
 * The strict shape prevents storage-only fields from crossing into the Web
 * draft view.
 */
export const draftResponseSchema = z
  .object({
    id: uuidSchema,
    mailboxId: uuidSchema,
    subject: z.string().max(998),
    body_text: z.string().max(65_536),
    body_html: z.string().max(131_072),
    to: z.array(emailAddressSchema).max(50),
    cc: z.array(emailAddressSchema).max(50),
    bcc: z.array(emailAddressSchema).max(50),
    status: z.literal('draft'),
    created_at: draftTimestampSchema,
    updated_at: draftTimestampSchema,
  })
  .strict();

export type DraftResponse = z.infer<typeof draftResponseSchema>;

/** Full `{ data: ... }` envelope for the draft read route. */
export const draftDetailResponseSchema = z.object({ data: draftResponseSchema }).strict();

export type DraftDetailResponse = z.infer<typeof draftDetailResponseSchema>;

/**
 * Request body for `PATCH /api/v1/drafts/:id`. All fields are optional —
 * the client patches only the field(s) that changed. The schema is
 * `.strict()` so unknown fields (e.g. a `draftId` typo) are rejected at
 * the boundary instead of silently stripped: the route relies on
 * `updated_at` for optimistic concurrency and on `Idempotency-Key` for
 * replay safety, so a body that does not match the wire contract is a
 * 400-class error, not a no-op.
 *
 * `If-Match: <updated_at>` is required by the route; it is a header, not a
 * body field, so it is not modelled here.
 */
export const updateDraftSchema = z
  .object({
    subject: z.string().max(998).optional(),
    body_text: z.string().max(65_536).optional(),
    body_html: z.string().max(131_072).optional(),
    to: z.array(emailAddressSchema).max(50).optional(),
    cc: z.array(emailAddressSchema).max(50).optional(),
    bcc: z.array(emailAddressSchema).max(50).optional(),
  })
  .strict();

export type UpdateDraftRequest = z.infer<typeof updateDraftSchema>;

/**
 * Request body for `POST /api/v1/drafts/:id/send`. The send route requires
 * an `Idempotency-Key` header (R-IDEMPOTENCY-*; ADR-004), but the *body*
 * is empty — every piece of information the route needs (the draft's
 * `updated_at` for optimistic concurrency, the recipient arrays from the
 * stored draft, the mailbox it lives in) is already on the server.
 *
 * The schema is `.strict()` so an accidental payload (e.g. a client that
 * POSTs `{ draftId }` or `{ to }`) is rejected at the boundary instead of
 * silently accepted.
 */
export const sendDraftSchema = z.object({}).strict();

export type SendDraftRequest = z.infer<typeof sendDraftSchema>;

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
  type RolePolicyReader,
} from './admin/role-policy';

// CAP-040: cross-module audit-event write seam (outbound-mail → admin via
// contracts). Same pattern as BlocklistReader / RolePolicyReader above.
// CAP-044 Slice 2 adds the read-side schemas (audit-event query API,
// D-CAP-044-E / AC 12).
export {
  auditActionSchema,
  auditEventSchema,
  auditEventListResponseSchema,
  auditEventQueryParamsSchema,
  type AuditAction,
  type AuditEventInput,
  type AuditEventItem,
  type AuditEventListResponse,
  type AuditEventQueryParams,
  type AuditEventWriter,
  type D1StatementLike,
} from './admin/audit';

// CAP-044 Slice 3 (AC 18): the admin users-list read contract. The
// users table stays identity-owned (D-CAP-044-H); these schemas are the
// only shape crossing the admin route → identity listUsers boundary.
export {
  userStatusSchema,
  userListItemSchema,
  userListResponseSchema,
  userListQueryParamsSchema,
  type UserStatus,
  type UserListItem,
  type UserListResponse,
  type UserListQueryParams,
} from './admin/users';

// CAP-066: managed-domain administration wire contracts. The domain
// response is a strict safe projection; outbound connection details never
// cross this boundary.
export {
  managedDomainStatusSchema,
  createManagedDomainRequestSchema,
  updateManagedDomainOutboundConnectionRequestSchema,
  managedDomainSchema,
  managedDomainListResponseSchema,
  verifyManagedDomainRequestSchema,
  verifyManagedDomainResponseSchema,
  updateManagedDomainOutboundConnectionResponseSchema,
  deleteManagedDomainResponseSchema,
  type ManagedDomainStatus,
  type CreateManagedDomainRequest,
  type UpdateManagedDomainOutboundConnectionRequest,
  type ManagedDomain,
  type ManagedDomainListResponse,
  type VerifyManagedDomainRequest,
  type VerifyManagedDomainResponse,
  type UpdateManagedDomainOutboundConnectionResponse,
  type DeleteManagedDomainResponse,
} from './admin/domains';

// CAP-068: one sanitized signature per managed domain.
export {
  SIGNATURE_CONTENT_MAX_LENGTH,
  createSignatureRequestSchema,
  updateSignatureRequestSchema,
  signatureSchema,
  signatureListResponseSchema,
  deleteSignatureResponseSchema,
  type CreateSignatureRequest,
  type UpdateSignatureRequest,
  type Signature,
  type SignatureListResponse,
  type DeleteSignatureResponse,
} from './admin/signatures';

// CAP-069: typed, allowlisted system-settings administration. Secrets and
// blocklists deliberately have separate ownership and never cross this shape.
export {
  SYSTEM_SETTINGS_MAX_ATTACHMENT_BYTES,
  DEFAULT_SYSTEM_SETTINGS,
  systemSettingsSchema,
  updateSystemSettingsRequestSchema,
  systemSettingsResponseSchema,
  type SystemSettings,
  type UpdateSystemSettingsRequest,
  type SystemSettingsResponse,
} from './admin/settings';

export {
  adminOverviewQuerySchema,
  adminOverviewResponseSchema,
  adminOverviewStatsSchema,
  type AdminOverviewQuery,
  type AdminOverviewResponse,
  type AdminOverviewStats,
} from './admin/overview';

// CAP-044 Slice 3 amendment (cursor-payload promotion): the payload
// schema + closed surface union moved here from the worker's
// platform/cursor.ts (its third consumer — listUsers — fired the
// promotion trigger recorded in the Slice 2 review note). The crypto
// stays in the worker; contracts owns the wire shape.
export {
  cursorSurfaceSchema,
  cursorPayloadSchema,
  type CursorSurface,
  type CursorPayload,
} from './cursor';
