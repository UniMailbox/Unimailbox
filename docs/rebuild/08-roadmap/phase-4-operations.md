# Phase 4 — Operations + Data Import

## Business goal

Admins can operate the system: search, audit, manual intervention, exception handling. **And** the data import tool is ready for legacy cutover.

## User value

Administrators can diagnose and recover from incidents. Existing legacy deployments can cut over.

## Scope

- **Search**: cursor-paginated full-text search over `messages.subject`, `from_address`, `to_address`. FTS5 virtual table.
- **Bulk operations**: admin `messages/batch-delete` with idempotency + soft-delete.
- **Provider sync**: `BrevoSyncAdapter` lists known messages and back-fills status.
- **Audit UI**: filter by actor, action, resource, time range.
- **Maintenance jobs**: cursor-based backfills; `MaintenanceJob` table; handler registry.
- **Scheduled jobs**:
  - Outbound dispatcher recovery (every minute).
  - Session cleanup (daily).
  - Idempotency cleanup (daily).
  - Upload cleanup (hourly).
  - Webhook cleanup (daily).
  - Orphan R2 cleanup (daily).
- **Setup repair session**: authenticated admin can re-enter `/setup` for upgrade-only steps.
- **Rate limits**: per-IP on `/auth/login`, per-user on `/messages/send`, per-IP on `/setup/claim`.
- **ECharts dashboard**: simple counters (users, mailboxes, messages today, outbound queue depth).
- **Operator runbook**: `docs/operations/runbook.md` for incident response.
- **Data import tool**: `scripts/migrate-from-legacy/` reads from legacy D1 + R2, transforms, writes to new D1 + R2. Idempotent, cursor-based, tested against a legacy fixture.

## Out of scope

Full-text search across attachments; provider sync for Resend/CF (those are added in Phase 5).

## Acceptance criteria

```text
[x] Admin searches for "test" in subject across all mailboxes.
[x] Admin bulk-deletes 50 messages in one request with idempotency.
[x] Outbound dispatcher cron recovers 5 stuck jobs.
[x] Operator runbook executes successfully against a staging deployment.
[x] Setup repair session allows re-running only the upgraded step.
[x] Migration script dry-run produces a report with row counts.
[x] Migration script real-run transforms 100% of legacy users, mailboxes, and messages without data loss.
[x] Migration script is idempotent: re-running produces zero additional inserts.
[x] Migration script is cursor-based: a crash mid-run resumes from the last checkpoint.
[x] After migration, the new system can authenticate a legacy user (after password reset).
[x] After migration, a legacy inbox is viewable in the new client.
```

## Key technical decisions

- FTS5 with porter stemming.
- Maintenance job cursor format: JSON object, opaque to consumers.
- Audit log retention: 90 days (default).
- Idempotency retention: 24 hours.
- Migration script reads legacy via direct D1 HTTP API; does not depend on legacy code.
- Migration script writes to new via the same Drizzle client used by the Worker.

## Cutover

- Per-deployment cutover can begin once Phase 4 ships.
- See `07-migration/cutover-plan.md` for the day-by-day sequence.

## Risks

- FTS5 index size with large mailboxes.
- Maintenance job concurrency (multiple cron instances).
- Migration script correctness on legacy schema drift.