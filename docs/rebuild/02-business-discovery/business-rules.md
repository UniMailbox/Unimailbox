# Business Rules

A business rule is a **constraint** that the system enforces, expressed without reference to a specific implementation. Each rule has a category (data, state, authorization, workflow) and a category label.

## R-AUTH — Authentication & identity

| ID | Rule |
|---|---|
| R-AUTH-001 | A user must authenticate with a verified email + password to access any non-public route |
| R-AUTH-002 | A user with status `banned` or `deleted` cannot log in |
| R-AUTH-003 | A user may have at most 10 active sessions; oldest is evicted |
| R-AUTH-004 | Refresh tokens are rotated on every successful refresh |
| R-AUTH-005 | All sessions are revoked when the password is changed or reset |
| R-AUTH-006 | OAuth login does not require a password; OAuth users must explicitly set a password to use password login |
| R-AUTH-007 | Passwords must be at least 6 and at most 30 characters |
| R-AUTH-008 | Email prefix must be at least `minEmailPrefix` characters |
| R-AUTH-009 | Email addresses are case-insensitive everywhere |

## R-MAILBOX — Mailbox

| ID | Rule |
|---|---|
| R-MAILBOX-001 | A mailbox belongs to exactly one managed domain |
| R-MAILBOX-002 | A mailbox has exactly one owner |
| R-MAILBOX-003 | The owner cannot be added as a member |
| R-MAILBOX-004 | The owner can always perform all operations on their mailbox |
| R-MAILBOX-005 | A viewer can read but not send or modify |
| R-MAILBOX-006 | A sender can read and send but not rename or manage members |
| R-MAILBOX-007 | An admin can read, send, rename, and manage members |
| R-MAILBOX-008 | Only the owner can delete a mailbox |
| R-MAILBOX-009 | Deleting a mailbox cascades to its messages and attachments |
| R-MAILBOX-010 | A mailbox display name is at most 30 characters |
| R-MAILBOX-011 | A mailbox address is unique case-insensitively |

## R-MESSAGE — Message lifecycle

| ID | Rule |
|---|---|
| R-MESSAGE-001 | A message has exactly one canonical content row |
| R-MESSAGE-002 | A message has zero or more recipients, each with a type (to/cc/bcc) |
| R-MESSAGE-003 | A message is visible to one or more mailboxes via `mailbox_messages` |
| R-MESSAGE-004 | A message's folder assignment is per-mailbox |
| R-MESSAGE-005 | Read/star/delete state is per-user, not per-message |
| R-MESSAGE-006 | A message's status follows the lifecycle: draft → queued → sending → sent → delivered (or terminal) |
| R-MESSAGE-007 | Webhook status updates are applied only if newer (event time) or higher-rank on tie |
| R-MESSAGE-008 | A draft is visible only to its creator |
| R-MESSAGE-009 | A draft's optimistic-concurrency token is its `updated_at`; stale writes return 409 |
| R-MESSAGE-010 | A successful send transitions a draft irreversibly to `sent` (or `queued`) |
| R-MESSAGE-011 | Sending requires `message.send` permission + `send` operation on the mailbox |
| R-MESSAGE-012 | `failed` is terminal; to resend, create a new draft |

## R-INBOUND — Inbound mail

| ID | Rule |
|---|---|
| R-INBOUND-001 | Inbound mail arrives via Cloudflare Email Routing |
| R-INBOUND-002 | The recipient is resolved by matching `mailboxes.address` (case-insensitive) |
| R-INBOUND-003 | When the recipient is unknown and `unknown_recipient_policy=reject`, the message is rejected upstream |
| R-INBOUND-004 | When the recipient is unknown and `unknown_recipient_policy=store`, the message is saved with no mailbox recipient |
| R-INBOUND-005 | Blocklist matches on subject, content, and from reject the message |
| R-INBOUND-006 | Per-role `availDomain` and `banEmail` policies are evaluated at receive time |
| R-INBOUND-007 | The raw MIME is stored once; parsed content derives from the same bytes |
| R-INBOUND-008 | The message + recipients + attachments + mailbox-message rows are inserted in a single D1 batch |
| R-INBOUND-009 | A message with `status=SAVING` is recovered by a scheduled job (status promoted to `received` or rejected) |

## R-OUTBOUND — Outbound mail

| ID | Rule |
|---|---|
| R-OUTBOUND-001 | Provider selection is deterministic: domain override → first registered provider → fail |
| R-OUTBOUND-002 | A message with all-internal recipients does not require a configured provider |
| R-OUTBOUND-003 | A message with any external recipient requires a configured provider |
| R-OUTBOUND-004 | Provider calls use the canonical message ID as idempotency key |
| R-OUTBOUND-005 | Send requests must include an `Idempotency-Key` header; replays return the stored response |
| R-OUTBOUND-006 | Send + queued job + idempotency record are written in one D1 batch |
| R-OUTBOUND-007 | Queue submission is at-least-once; the consumer claim prevents concurrent processing |
| R-OUTBOUND-008 | A retryable error re-queues with backoff; a terminal error marks the job `failed` |
| R-OUTBOUND-009 | A `succeeded` job is terminal; no further retries |
| R-OUTBOUND-010 | CC and BCC are real recipient types and must be passed through to the provider |
| R-OUTBOUND-011 | On-site delivery creates a `mailbox_messages` row per internal recipient |
| R-OUTBOUND-012 | A TO bounce marks the sender message `bounced`; CC/BCC bounces do not |

## R-ATTACHMENT — Attachments

| ID | Rule |
|---|---|
| R-ATTACHMENT-001 | An attachment belongs to one message |
| R-ATTACHMENT-002 | Maximum 10 attachments per message |
| R-ATTACHMENT-003 | Maximum 64 MiB per attachment |
| R-ATTACHMENT-004 | An attachment's bytes live in R2 under `attachments/{uuid}.{ext}` |
| R-ATTACHMENT-005 | A direct upload requires an `attachment_uploads` row in `uploaded` status |
| R-ATTACHMENT-006 | An upload is consumed (marked `consumed`) atomically when the message is created |
| R-ATTACHMENT-007 | Expired unused uploads are deleted by a scheduled job |
| R-ATTACHMENT-008 | Inline images (CID) are rewritten to R2 URLs for non-CF providers |
| R-ATTACHMENT-009 | Maximum 50 inline images per message |

## R-AUTHZ — Authorization

| ID | Rule |
|---|---|
| R-AUTHZ-001 | Every protected request must have an authenticated principal |
| R-AUTHZ-002 | Permission checks consult the database on every request (no stale cache beyond 5 minutes) |
| R-AUTHZ-003 | Global permissions are independent of mailbox permissions; both must pass |
| R-AUTHZ-004 | Mailbox authorization is evaluated against the target mailbox ID, not a client-supplied owner ID |
| R-AUTHZ-005 | Admin identity is determined by the `administrator` role, not a hardcoded email list |

## R-SECRET — Secrets

| ID | Rule |
|---|---|
| R-SECRET-001 | Provider API keys live in `encrypted_credentials`, encrypted with AES-GCM |
| R-SECRET-002 | Encryption keys are stored in Cloudflare Secrets Store, never in `wrangler.toml` |
| R-SECRET-003 | Secrets are never logged, never returned in API responses, never exposed to the client. Narrow exception (defined 2026-08-24, resolving D-CAP-040-B): a one-value, admin-initiated reveal of a provider **webhook signing secret** via `POST /api/v1/admin/connections/:id/webhook-secret/reveal` is permitted, because the operator must paste the secret into the provider's own dashboard to configure the webhook. Controls are mandatory: gated on `provider.sync` permission, response is one-time display semantics, a `webhook_secret.reveal` audit row records actor + connection (never the value), and the secret is never logged. Rotation-only disclosure remains the norm for every other secret; no list endpoint may include a secret value. |
| R-SECRET-004 | Webhook signing secrets may be rotated; old + new are accepted during a 7-day window |

## R-AUDIT — Audit

| ID | Rule |
|---|---|
| R-AUDIT-001 | Every state transition writes an `audit_events` row |
| R-AUDIT-002 | Every setup mutation writes an `audit_events` row |
| R-AUDIT-003 | Audit events are immutable and retained for at least 90 days |
| R-AUDIT-004 | Audit events include actor, action, resource, request ID, IP |

## R-WORKFLOW — Workflows

| ID | Rule |
|---|---|
| R-WORKFLOW-001 | Setup steps advance strictly in declared order |
| R-WORKFLOW-002 | Setup state changes are atomic (optimistic concurrency on `stateVersion`) |
| R-WORKFLOW-003 | Setup completes only after both inbound and outbound smoke tests succeed |
| R-WORKFLOW-004 | A setup repair session is granted only to authenticated administrators |
| R-WORKFLOW-005 | Maintenance jobs are idempotent and cursor-based |
| R-WORKFLOW-006 | Outbound jobs are dispatched by the request handler; recovered by a scheduled job; processed by the queue consumer |

## R-DATA — Data integrity

| ID | Rule |
|---|---|
| R-DATA-001 | Email addresses are case-insensitive in storage and comparison |
| R-DATA-002 | Timestamps are stored as `YYYY-MM-DD HH:MM:SS` UTC; epoch ms for lock fields |
| R-DATA-003 | Soft-delete uses `deleted_at TIMESTAMP NULL`; queries must explicitly include or exclude deleted rows |
| R-DATA-004 | Foreign keys are enforced via `PRAGMA foreign_keys = ON` |
| R-DATA-005 | JSON-in-text columns are forbidden in the new schema (relational columns only) |
| R-DATA-006 | Numeric column defaults must match the column type (no `0` for text, no `0.88` for int) |

## R-API — API contract

| ID | Rule |
|---|---|
| R-API-001 | All responses follow `{ data: T }` on success or `{ error: { code, message, requestId } }` on failure |
| R-API-002 | Domain error codes are stable across releases |
| R-API-003 | HTTP status codes are real (400, 401, 403, 404, 409, 413, 429, 502, 503) |
| R-API-004 | Mutating endpoints accept `Idempotency-Key`; replays return the stored response |
| R-API-005 | Pagination uses opaque cursors that encode `(created_at, id)` and are signed |
| R-API-006 | All request bodies are validated by zod schemas before use-case entry |
| R-API-007 | Provider webhooks verify signatures before parsing payload |