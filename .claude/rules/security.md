# Security Rules

Business-rule IDs (`R-SECRET-*`, `R-AUTHZ-*`, `R-AUTH-*`) are defined in
`docs/rebuild/02-business-discovery/business-rules.md`. Parameters below come from the ADRs in
`docs/rebuild/09-decisions/`. Cite the ID when you implement or review one.

Rebuilding this system is partly *motivated* by legacy security defects. A security regression here
is a blocking finding, never a follow-up ticket.

## Passwords — ADR-006

- `PBKDF2` with `hash: 'SHA-256'`, **100,000 iterations** for new application passwords, 256 derived bits. The operator approved this hosted Workers compatibility adjustment on 2026-10-06; existing hashes retain their stored iteration count. The quarantined Better Auth envelope remains at 600,000.
- Per-user random salt of **≥16 bytes** from `crypto.getRandomValues`.
- Store algorithm, iterations, salt and hash. Verify using the stored work factor;
  do not claim automatic rehashing until a migration/rehash path is implemented.
- Verify with the platform constant-time comparison helper. Do not compare
  password hashes or tokens with ordinary string equality.
- Argon2 / scrypt / bcrypt are rejected — not native to Web Crypto (would require WASM).
- Use native Web Crypto for new passwords; preserve standard derivation for existing higher-work-factor hashes, subject to the deployed Worker CPU limit.

## Secrets — ADR-007

- Two layers: encryption keys live in **Cloudflare Secrets Store** (`CREDENTIAL_ENCRYPTION_KEY`);
  encrypted payloads live in the `encrypted_credentials` D1 table as **AES-GCM** ciphertext with a
  version field.
- Real deployed key values never appear in Wrangler configuration, source or a
  settings table. Public local-only fixture constants are explicitly synthetic. Settings store
  only a `credential_id` reference.
- Decrypted credentials are cached **for the lifetime of one request only**. Never module-scope.
- Stored provider/encryption credentials are never logged or returned by read APIs
  (`R-SECRET-003`). Explicit creation/reset/rotation may return a new initial
  password or webhook secret once to the authorized actor. Protect these write
  responses and never include their values in logs, documentation or reports.
  R-SECRET-003 also permits the explicit `provider.sync`-authorized, audited
  webhook-secret reveal POST for provider dashboard setup; list APIs never reveal it.
- Recipient editor-asset capability URLs grant access to that file; treat complete
  live URLs as sensitive. Private incoming attachments remain authenticated.
- A seven-day overlapping webhook rotation window is an original design goal,
  not an implemented guarantee. The current adapter verifies the configured
  secret; add a tested rotation/overlap path before claiming dual-key acceptance.
- Encryption-key rotation is disabled by release tooling until a tested
  key-version/re-encryption migration exists. The one-shot maintenance job is
  proposed work, not a current command. Follow the deployment runbook.

## Authorization

Two independent layers; **both** must pass, and there is no implicit bypass (`R-AUTHZ-003`).

1. **Global** — `requirePermission(key)` middleware against the closed `PermissionKey` enum:
   `message.{read,send,delete}` · `mailbox.{create,manage,share}` · `user.{read,manage}` ·
   `role.{read,manage}` · `domain.{read,manage}` · `signature.{read,manage}` ·
   `settings.{read,manage}` · `provider.sync` · `webhook_event.{read,delete}` ·
   `analytics.read` · `audit.read` (added by CAP-044 for the audit-event query API).
   The enum is closed — adding a key is a deliberate change, not an ad-hoc string.
2. **Mailbox-scoped** — `mailboxes.assertCan(userId, mailboxId, op)` at use-case entry.

The `admin` column below is the **mailbox membership role**, not the global
`administrator` role. Global administration permits user/domain/grant management
through its own audited APIs; it does not grant message, draft, send or attachment
access without ownership or an explicit mailbox membership.

| op | owner | viewer | sender | admin |
|---|:-:|:-:|:-:|:-:|
| read | ✓ | ✓ | ✓ | ✓ |
| send | ✓ | ✗ | ✓ | ✓ |
| rename | ✓ | ✗ | ✗ | ✓ |
| manage_members | ✗ | ✗ | ✗ | ✗ |
| delete_message | ✓ | ✗ | ✗ | ✗ |
| delete_mailbox | ✓ | ✗ | ✗ | ✗ |

Mailbox ownership and mailbox roles do not grant member administration. Since the
2026-10-12 user decision, all membership APIs require global `mailbox.share`;
the Admin Users assignment API additionally requires `user.manage` for writes
and `user.read` for reads. The mailbox `admin` role means full current mailbox
operations (read, send, rename and per-user message organization), not global
administration. Hard deletion remains owner-only and is not a shipped message
operation. New accounts receive this mailbox role for each explicitly selected
mailbox, atomically with account creation.

Hard rules:

- **IDOR:** authorize against the *target* mailbox/message ID, never a client-supplied owner ID
  (`R-AUTHZ-004`). Any handler that trusts `body.userId` or `body.ownerId` is a blocking finding.
- Admin identity comes from the `administrator` role, never a hardcoded email list (`R-AUTHZ-005`).
- Permission checks hit the database per request; no cache older than 5 minutes (`R-AUTHZ-002`).
- Revoke **all** sessions on password change or reset (`R-AUTH-005`).
- Seed roles: `administrator` = all permissions; `member` = `message.{read,send,delete}`,
  `mailbox.{create,manage}`.

## Idempotency — ADR-004

- Application mutation routes require `Idempotency-Key` (8–128 characters from
  `[A-Za-z0-9_-]`; UUID is a client convention, not the only valid format).
  Provider webhooks use authenticated provider delivery/event identity instead;
  disabled public registration returns its refusal without requiring a key.
- Hash the canonical operation input. JSON mutations hash their defined body;
  binary uploads hash the streamed bytes plus relevant metadata.
- The `idempotency_records` row `(actorUserId, operation, idempotencyKey, requestHash,
  responseStatus, responseJson)` is written **in the same D1 batch as the business write**. Not
  before, not after, for strict business mutations. Auth/setup retain documented
  best-effort response caching; do not describe those paths as atomic business replay.
- Same key + same hash → return the stored response. Same key + different hash →
  `409 IDEMPOTENCY_KEY_REUSED`.
- Retention defaults to 24 hours and follows the configured system setting; cleanup
  is part of the existing daily identity sweep, not a separate Cron trigger.
- Outbound provider calls use the canonical message ID as their idempotency key (`R-OUTBOUND-004`).

## Input and transport

- Validate every request body with a zod schema from `packages/contracts` at the route boundary.
  Use cases receive parsed, typed input — they do not re-parse raw JSON.
- Ordinary JSON API bodies are capped at **1 MiB**. Binary uploads and provider
  webhooks are sibling routes with their own transport rules. Editor file uploads
  follow `maxAttachmentBytes` (up to 100 MiB); images use the smaller of that
  setting and 5 MiB. Avatars are limited to 2 MiB; legacy attachment uploads have
  their own fixed cap. Do not pass raw binary through the JSON body limiter.
- Never build SQL by string concatenation. Drizzle query builder or parameterized statements only.
- `PRAGMA foreign_keys = ON` (`R-DATA-004`).
- Email addresses are compared and stored case-insensitively (`R-DATA-001`) — an authorization or
  routing check that is case-sensitive is a bug.
- Blocklist matching on inbound rejects on subject, content, and from (`R-INBOUND-005`).

## Logging

One JSON line per event with `event`, `requestId`, `actorUserId?`, `durationMs`.

**Never log:** passwords, password hashes, access or refresh tokens, message bodies, attachment
bytes, decrypted secrets, provider API keys, `Idempotency-Key` values tied to a body,
complete download capabilities or raw shell commands that may contain credentials.
See `docs/operations/repository-hygiene.md` for public-document and commit checks.

## Audit

Every state transition writes an `audit_events` row: action, actor, resource, request ID.
Immutable, retained ≥90 days. If a capability adds a state transition and no audit row, the QA
reviewer blocks it.
