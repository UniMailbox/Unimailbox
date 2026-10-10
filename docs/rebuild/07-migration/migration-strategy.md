# Migration Strategy

## Premise

The rebuild is in a **new repository**. This document describes how data flows from the existing legacy deployment into the new system at cutover. There is no code migration — the new repo is built from scratch. There is no "strangler" pattern — both systems run side by side for a window, but the new system is not derived from the old.

## Two-system window

```text
Time ─────────────────────────────────────────────────────▶

New repo Phase 0  Phase 1  Phase 2  Phase 3  Phase 4  Phase 5  Phase 6
   scaffold       basic    reliable sharing data   multi  scale
                 loop     loop    +share  import   provider
                                            │
                                            ▼
                                     ┌─────────────┐
                                     │   CUTOVER   │
                                     └─────────────┘
                                            │
                                            ▼
Legacy system:   running ────────────────────────► archived ──► removed
```

During the window, both systems run:

- **Legacy**: continues serving its users; reads/writes legacy D1 + R2.
- **New**: serves new installs; runs setup wizard; onboards its first admin; reads/writes new D1 + R2.

There is no code shared between the two. There is no shared database. There is no shared queue. The only thing they share is the **Cloudflare account** (during a transition period) or the **user** (who has two URLs).

## Data import (built in Phase 4)

The new repo contains `scripts/migrate-from-legacy/`, a one-time batch tool that:

1. **Reads** from the legacy D1 and R2.
2. **Transforms** data into the new schema.
3. **Writes** to the new D1 and R2.
4. **Verifies** row counts and invariants.

### What gets imported

| Legacy entity | New entity | Notes |
|---|---|---|
| `user` rows | `users` rows | Password rehash skipped — users must reset on first login |
| `account` rows | `mailboxes` rows | New ID assigned |
| `email` rows (inbound) | `messages` + `mailbox_messages` + `message_recipients` + `message_attachments` | Raw `.eml` synthesized for POP3 (Phase 5+) |
| `email` rows (outbound, sent/delivered) | `messages` + `mailbox_messages` + `message_recipients` + `message_attachments` | Provider state imported |
| `account_member` rows | `mailbox_members` rows | Role enum mapped |
| `signature` rows | `domain_signatures` rows | HTML sanitized |
| `role` + `role_perm` rows | `roles` + `role_permissions` rows | Perm-key set trimmed to canonical |
| `attachments` rows | `message_attachments` rows | R2 objects copied to new key prefix |
| R2 attachment bytes | R2 attachment bytes | Copied under `attachments/{new-uuid}.{ext}` |
| `setting` rows | `system_settings` + `encrypted_credentials` + `installation_state` | One-time copy |

### What does NOT get imported

- `email.status='SAVING'` rows (incomplete)
- `email.status='FAILED'` rows (terminal, optional)
- `webhook_event` rows (audit log only)
- `verify_record` rows (rate-limit counters)
- `oauth` rows (drop in new system; users re-bind)
- `reg_key` rows (regenerate with new code-hash format)
- `setting.resendTokens`, `setting.s3_*`, `setting.tg_bot_token`, `setting.secret_key`, `setting.brevo_webhook_secret` (these get re-entered through the new setup wizard as encrypted credentials)

### Import mechanics

```text
legacy-DB ──┐
            ├──▶ migration script ──▶ new-DB
legacy-R2 ──┘   (idempotent, cursor-based)
```

The script is **idempotent** (re-running produces the same result) and **cursor-based** (resumable after a crash). It runs as a CLI tool:

```bash
pnpm migrate:from-legacy --legacy-d1 <id> --new-d1 <id> --legacy-r2 <bucket> --new-r2 <bucket>
```

It emits a structured progress report:

```json
{
  "users_imported": 42,
  "users_skipped": 1,
  "users_failed": 0,
  "mailboxes_imported": 87,
  "messages_imported": 12453,
  "attachments_copied": 892,
  "elapsed_seconds": 247
}
```

The script is part of the new repo's `scripts/` directory and is tested against a fixture dump of legacy data.

## Per-deployment cutover

Each existing deployment cuts over independently:

1. Operator announces cutover window.
2. Operator disables public registration on legacy.
3. Operator runs the migration script (dry-run first).
4. Operator verifies the report.
5. Operator runs the migration script (real).
6. Operator switches DNS / Worker route to the new system.
7. Operator marks legacy as read-only for 30 days.
8. Operator deletes legacy bindings after 30 days.

## What if we cannot cut over (e.g., test deployment)?

Some deployments may continue running the legacy system indefinitely. The new repo does not block them. Each deployment chooses when to switch.

## What we **do not** do

- **No big-bang cutover**: every deployment cuts over independently.
- **No silent data import**: every migration is explicit and audited.
- **No backward compatibility in the new D1**: the new schema is clean.
- **No dual-write from new to legacy D1**: never.
- **No maintenance of legacy code in the new repo**: the new repo contains only the new system.

## Compatibility window summary

| Window | What runs |
|---|---|
| Phase 0–3 | Both systems in parallel; new is preview-only |
| Phase 4 cutover (per deployment) | Migration script + DNS switch; legacy becomes read-only |
| Phase 4+30 days | Legacy Worker deleted |
| Phase 4+90 days | Legacy D1 + R2 deleted (with operator approval) |