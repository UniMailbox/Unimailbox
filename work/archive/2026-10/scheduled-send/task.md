# Scheduled send

Operator request: add scheduled sending to the current mail client and staging.

Reuse D1 outbox + Queue delay (maximum 24h) + existing five-minute recovery.
No additional Cron, infrastructure, dependencies or legacy deployment changes.

Acceptance:
- Compose can choose a future local date/time; normal send is unchanged.
- Scheduled list has authenticated cursor pagination, time change and cancellation.
- Cancellation preserves the unsent message as a draft; stale/concurrent edits conflict.
- No provider call before the authoritative scheduled time, including old deliveries.
- Far-future tasks and failed enqueue remain recoverable without per-tick duplicate enqueue.
- Snapshot body, threading, recipients/Bcc, editor/R2 attachments persist until delivery.
- Permission, idempotency, safe error codes and English/Chinese UI remain consistent.
- Future jobs do not raise false stalled-delivery alarms; overdue jobs still do.
- Binding-backed concurrency/recovery tests, frontend checks, full release gate and staging proof.
- Preserve all unrelated dirty-worktree contents and index; no commit/push.

Ownership: shared contracts/errors/audit; 0033 migration/schema/test fixture;
outbound schedule/repository/consumer/recovery; messages prepared folder/draft writers;
compose/scheduled HTTP routes/router; compose/dialog/scheduled web UI/navigation/i18n;
focused tests and execution/QA records. Final preservation evidence enumerates exact paths.

Result: implemented and verified. Final staging version
`155d261d-c109-454b-91ab-440b59d3b07e`; release gate 2,214 passing tests,
all 33 migration companions, healthy publication/ready/maintenance,
natural five-minute Cron, real delayed self-mail, byte-identical R2 download,
change-time and editable cancellation recovery. Multi-day timing uses the
binding-backed controlled clock. See `docs/qa/scheduled-send-2026-10-09.md`.


## 2026-10-10 archive

Completed implementation and staging acceptance; archived during repository consolidation.
The dated QA records retain the original validation results and their limits.
