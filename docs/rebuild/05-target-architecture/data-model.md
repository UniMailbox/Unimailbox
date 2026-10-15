# Data Model

> Original target-design detail. Current module ownership and transport contracts
> are in [module boundaries](module-boundaries.md) and [API conventions](api-design.md).
> Concrete tables/bindings come from the source and numbered migrations; future
> provider examples and class sketches below are not claims of shipped behavior.


See `../E-proposed-domain-model.md` for full schemas. This document captures the rules.

## Identifier rules

- All externally visible IDs are **UUID v4 strings** (`TEXT PRIMARY KEY`).
- Database-generated integer IDs are **internal only**.
- Email addresses are **case-insensitive** in storage and comparison (`COLLATE NOCASE`).
- Timestamps are **`YYYY-MM-DD HH:MM:SS`** (D1 native format) for human-readable fields.
- Lock expiry fields use **Unix epoch milliseconds** (integer).

## Schema ownership

| Module | Tables owned |
|---|---|
| `identity` | `users`, `sessions`, `idempotency_records`, `oauth_accounts`, `user_preferences` |
| `onboarding` | `installation_state`, `registration_keys` |
| `tenancy` | `managed_domains`, `mailboxes`, `mailbox_members`, `domain_signatures` (Phase 3) |
| `messages` | `messages`, `message_recipients`, `mailbox_messages`, `message_user_state`, `message_attachments`, `attachment_uploads` |
| `outbound-mail` | `outbound_jobs`, `provider_connections`, `encrypted_credentials`, `webhook_deliveries`, `provider_message_state`, `webhook_events` |
| `admin` | `roles`, `permissions`, `role_permissions`, `user_roles`, `system_settings`, `audit_events`, `maintenance_jobs` |

## Operational heartbeat snapshots

Platform operations owns `maintenance_heartbeats` (one row each for frequent,
hourly and daily maintenance) and `maintenance_heartbeat_failures` (task names
for each current failed snapshot). Migration 0037 seeds uninitialized rows,
never a synthetic successful run. Snapshot/task changes are atomic; newer
started runs and live D1 results take precedence over delayed/legacy results.
These bounded operational rows retain normalized UTC ISO-8601 timestamps with
milliseconds, matching Cron logs and preserving run ordering. This is an
operational exception to the human-readable business timestamp format above.
There are no new JSON-in-text columns or unbounded alert history tables.

## Soft-delete rule

- Use `deleted_at TIMESTAMP NULL`.
- Default reads exclude soft-deleted rows.
- Cascade-delete is explicit: e.g., `mailbox delete` cascades to `mailbox_messages`, which triggers `message_user_state` and `message_attachments` cleanup.

## Foreign-key rule

```sql
PRAGMA foreign_keys = ON;
```

Every FK has `ON DELETE CASCADE` or `ON DELETE SET NULL` declared.

## Index strategy

| Pattern | Index |
|---|---|
| List latest by folder | `(mailbox_id, folder, created_at DESC, id DESC)` |
| Status filtering | `(status, created_at DESC)` |
| Recipient lookup | `(message_id, type)` |
| Outbound dispatch | `(status, available_at)` |
| Webhook idempotency | `(provider_connection_id, event_key)` |
| Audit resource lookup | `(resource_type, resource_id, created_at DESC)` |
| Maintenance runnable | `(status, updated_at)` |

## Migration authority

- Drizzle owns typed schema declarations and may generate SQL.
- Reviewed SQL files in `migrations/` are the deployable artifacts.
- Wrangler applies migrations and records them in `d1_migrations`.
- Each migration is immutable; the scaffold records repository checksums.

### Migration file shape

```text
migrations/
├── 0001_initial.sql
├── 0001_initial.verify.sql
├── 0001_initial.md
├── 0002_seed_permissions.sql
├── 0002_seed_permissions.verify.sql
├── 0002_seed_permissions.md
└── meta/
```

Each `.md` documents:

- Purpose
- Compatibility window (forward / backward / both)
- Expected duration
- Data-backfill strategy
- Verification queries
- Recovery procedure

## Migration policy

1. **Expand-and-contract**: additive columns/tables before code that writes them.
2. **Backfills are bounded**: use `maintenance_jobs` for resumable cursor-based work.
3. **No destructive changes in the same release as the new behavior**.
4. **D1 Time Travel bookmark before every production migration**.

## Storage rule

- Canonical data in D1.
- Binary data (raw MIME, attachments) in R2.
- Own-account avatars are private R2 objects under `user-avatars/<userId>/<version>`.
  `user_preferences` stores relational language/theme/density/reading-pane/default-mailbox
  fields and the avatar reference. No opaque profile JSON or public avatar URL is stored.
- Cached config / sessions / state in KV.
- Encryption keys in Cloudflare Secrets Store.
- Outbound jobs dispatched via Cloudflare Queue.

## What is **never** stored

- Plaintext passwords.
- Plaintext provider API keys.
- Plaintext webhook signing secrets.
- Plaintext session refresh tokens (only hashes).
- Message body in error messages / logs.

## Attachment cleanup checkpoint (0032)

`attachment_uploads.cleanup_completed_at` is nullable and independent of the
`uploaded`/`consumed`/`expired` lifecycle. Only successful storage cleanup of an
expired upload sets it; existing rows start null. A partial index covers pending
cleanup in expiry/ID order, and each sweep handles at most 100 rows. Consumed
uploads are excluded. See [maintenance operations](../../operations/deploy.md#monitoring-dlq-and-safe-redrive)
for cadence, retry and storage compatibility details.
