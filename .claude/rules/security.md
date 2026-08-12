# Security Rules

Business-rule IDs (`R-SECRET-*`, `R-AUTHZ-*`, `R-AUTH-*`) are defined in
`docs/rebuild/02-business-discovery/business-rules.md`. Parameters below come from the ADRs in
`docs/rebuild/09-decisions/`. Cite the ID when you implement or review one.

Rebuilding this system is partly *motivated* by legacy security defects. A security regression here
is a blocking finding, never a follow-up ticket.

## Passwords — ADR-006

- `PBKDF2` with `hash: 'SHA-256'`, **600,000 iterations**, 256 derived bits.
- Per-user random salt of **≥16 bytes** from `crypto.getRandomValues`.
- Store `{ algorithm: 'pbkdf2-sha256', iterations, salt, hash }` — the iteration count is stored so
  it can be raised later. Rehash on next successful login when the count increases.
- Verify with a **constant-time** compare (`crypto.subtle.timingSafeEqual`). Never `===`.
- Argon2 / scrypt / bcrypt are rejected — not native to Web Crypto (would require WASM).
- ~600ms per hash is expected and acceptable. Do not "optimize" it away.

## Secrets — ADR-007

- Two layers: encryption keys live in **Cloudflare Secrets Store** (`CREDENTIAL_ENCRYPTION_KEY`);
  encrypted payloads live in the `encrypted_credentials` D1 table as **AES-GCM** ciphertext with a
  version field.
- Keys never appear in `wrangler.toml`/`wrangler.jsonc`, source, or a settings table. Settings store
  only a `credential_id` reference.
- Decrypted credentials are cached **for the lifetime of one request only**. Never module-scope.
- Secrets are never logged, never returned in an API response, never sent to the client (`R-SECRET-003`).
- Webhook signing secrets rotate with a **7-day** window where old and new are both accepted.
- Re-encryption on rotation is a one-shot `maintenance_job`, not inline work.

## Authorization

Two independent layers; **both** must pass, and there is no implicit bypass (`R-AUTHZ-003`).

1. **Global** — `requirePermission(key)` middleware against the closed `PermissionKey` enum:
   `message.{read,send,delete}` · `mailbox.{create,manage,share}` · `user.{read,manage}` ·
   `role.{read,manage}` · `domain.{read,manage}` · `signature.{read,manage}` ·
   `settings.{read,manage}` · `provider.sync` · `webhook_event.{read,delete}` · `analytics.read`.
   The enum is closed — adding a key is a deliberate change, not an ad-hoc string.
2. **Mailbox-scoped** — `mailboxes.assertCan(userId, mailboxId, op)` at use-case entry.

| op | owner | viewer | sender | admin |
|---|:-:|:-:|:-:|:-:|
| read | ✓ | ✓ | ✓ | ✓ |
| send | ✓ | ✗ | ✓ | ✓ |
| rename | ✓ | ✗ | ✗ | ✓ |
| manage_members | ✓ | ✗ | ✗ | ✓ |
| delete_message | ✓ | ✗ | ✗ | ✗ |
| delete_mailbox | ✓ | ✗ | ✗ | ✗ |

Hard rules:

- **IDOR:** authorize against the *target* mailbox/message ID, never a client-supplied owner ID
  (`R-AUTHZ-004`). Any handler that trusts `body.userId` or `body.ownerId` is a blocking finding.
- Admin identity comes from the `administrator` role, never a hardcoded email list (`R-AUTHZ-005`).
- Permission checks hit the database per request; no cache older than 5 minutes (`R-AUTHZ-002`).
- Revoke **all** sessions on password change or reset (`R-AUTH-005`).
- Seed roles: `administrator` = all permissions; `member` = `message.{read,send,delete}`,
  `mailbox.{create,manage}`.

## Idempotency — ADR-004

- `Idempotency-Key` is **required** on every mutating endpoint (`POST`, `PATCH`, `DELETE`).
- `requestHash = sha256(canonical JSON of body)`.
- The `idempotency_records` row `(actorUserId, operation, idempotencyKey, requestHash,
  responseStatus, responseJson)` is written **in the same D1 batch as the business write**. Not
  before, not after.
- Same key + same hash → return the stored response. Same key + different hash →
  `409 IDEMPOTENCY_KEY_REUSED`.
- TTL 24h, purged by a daily cron.
- Outbound provider calls use the canonical message ID as their idempotency key (`R-OUTBOUND-004`).

## Input and transport

- Validate every request body with a zod schema from `packages/contracts` at the route boundary.
  Use cases receive parsed, typed input — they do not re-parse raw JSON.
- Reject any `/api/v1/*` request body over **1 MB** with 413.
- Never build SQL by string concatenation. Drizzle query builder or parameterized statements only.
- `PRAGMA foreign_keys = ON` (`R-DATA-004`).
- Email addresses are compared and stored case-insensitively (`R-DATA-001`) — an authorization or
  routing check that is case-sensitive is a bug.
- Blocklist matching on inbound rejects on subject, content, and from (`R-INBOUND-005`).

## Logging

One JSON line per event with `event`, `requestId`, `actorUserId?`, `durationMs`.

**Never log:** passwords, password hashes, access or refresh tokens, message bodies, attachment
bytes, decrypted secrets, provider API keys, `Idempotency-Key` values tied to a body.

## Audit

Every state transition writes an `audit_events` row: action, actor, resource, request ID.
Immutable, retained ≥90 days. If a capability adds a state transition and no audit row, the QA
reviewer blocks it.
