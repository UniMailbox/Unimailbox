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
 * is_deleted / deleted_at columns), then to `'0017'` by the Slice 1 fix
 * pass after migrations/0017_message_user_state_composite_pk.sql
 * (message_user_state PK becomes (mailbox_message_id, user_id) —
 * D-CAP-043-F).
 */
export const CURRENT_SCHEMA_VERSION = '0017' as const;

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
 * (CAP-043 Slice 3 / AC 14). Unlike the list/detail schemas, which model the
 * envelope's inner `data` object, this schema covers the whole wire body —
 * a one-shot action response is parsed in one step by the star mutation.
 *
 * `id` is the message id from the path (echoed so a replayed caller can
 * correlate); `isStarred` is the post-toggle mailbox-level flag (D-CAP-043-A)
 * as the SQLite integer 0 or 1, consistent with `messageListItemSchema`.
 *
 * R-API-004: replays return the byte-identical stored response.
 */
export const toggleStarResponseSchema = z.object({
  data: z.object({
    id: uuidSchema,
    isStarred: z.number(),
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

// CAP-040: cross-module audit-event write seam (outbound-mail → admin via
// contracts). Same pattern as BlocklistReader / RolePolicyReader above.
export {
  auditActionSchema,
  type AuditAction,
  type AuditEventInput,
  type AuditEventWriter,
  type D1StatementLike,
} from './admin/audit';
