# Scheduled send — 2026-10-09

Scope: current mail client and staging only. Existing dirty source and index are
preserved; no commit/push, production change, new binding or new Cron.

## Behavior and storage

- Compose provides Schedule send, local presets and a custom date/time, up to
  365 days ahead. Times are stored in UTC, rounded up to a whole second.
- Scheduled mailbox view supports signed-cursor pagination, manual refresh,
  changing time and cancellation. Cancellation restores the persisted snapshot
  to Drafts, including recipients/Bcc, threading, signature and attachments.
- The D1 outbox is authoritative. Queue delays handle dates within 24 hours;
  farther dates enter that window through the existing five-minute recovery.
  Confirmed delayed deliveries are excluded from orphan recovery until due.
- Claims recheck the current time atomically. Old delayed messages cannot send
  early after rescheduling; cancellations are terminal for that job. Concurrent
  edits use a revision token and return SCHEDULE_STATE_CONFLICT on conflict.
- No browser polling, extra KV operation, daily object scan or new Cron is added.
  R2 message references protect scheduled editor assets after upload expiry.
- Migration 0033 is additive: nullable schedule/mailbox columns and a revision
  default, preserving existing immediate jobs and recovery behavior.

## Validation

Focused D1/R2/Queue-backed tests cover long dates, failed enqueue recovery,
early delivery, old queue messages, due delivery, cancellation/claim races,
identical replay races, ownership/read-only permissions, cursor pagination,
invalid time rejection and R2 reference retention. Provider calls are mocked
in these deterministic tests; live acceptance is recorded separately below.
Frontend integration tests cover compose scheduling, time editing, cancellation,
conflict errors and the message detail link. Contract tests enforce timestamps
and revision tokens. Migration tests preserve a pre-0033 immediate job.

The prepared release gate passed: doctor 14/14, generated binding checks,
lint, TypeScript, contracts/Web/Worker builds and 2,214 tests (1,260 unit/Web/
contract/script tests, 932 Worker tests and 22 migration fixture tests).
The prepared source tree is
`5174dbd67d70bbaac8e541f5941701bf0e071a8ae55968e89390b2f813f7128d`.
Final staging publication: `155d261d-c109-454b-91ab-440b59d3b07e`.
All 33 migration companions, mandatory publication smoke, `/healthz`, `/readyz`
(schema 0033), and `/healthz/maintenance` passed. The initial scheduled release
`ff4b144f-bee3-434a-af1b-15577667651e` also produced a natural successful
`*/5 * * * *` Cron at 14:45 Asia/Shanghai; the cloud schedules endpoint
confirmed the single five-minute trigger.

Browser acceptance confirmed Chinese navigation, both full and docked compose
modals, far-future persistence, cancellation and editable draft restoration.
Native date input exposed a stale-value issue; handling input as well as change
fixed it, verified by the selected value, controlled DOM value and persisted
schedule all matching. Compact dialog utilities now have static class tokens
and produce a 448px desktop dialog while preserving the existing editor width.
The 65-byte synthetic attachment uploaded successfully to R2.
Real delivery acceptance used only `staging-admin@unimailbox.tech` as sender
and recipient. The job `dd6186f6-b667-4f67-b5fc-64d27dd1cf9b` had scheduled UTC
`2026-10-09 06:58:00`; immediately before due it was queued, attempts 0 and
provider ID NULL. It reached sent at `06:58:08`, with a Brevo message ID and
outbound message status delivered. Exactly one corresponding inbox record
`ea5dbf5a-502e-4fcc-93e4-9ca038d57d22` was observed. Browser refresh removed the
task from Scheduled, and the inbox displayed the received body and attachment
list. Downloading through the received link returned 65 bytes identical to the
uploaded file. The cancelled far-future job retained attempts 0, NULL provider
ID and a recoverable, editable draft.

Receipts and screenshots live under `.tmp/scheduled-send-20261009/`:
`live-before-due.json`, `live-after-due.json`, `attachment-download.json`,
`received-mail.jpg`, `schedule-dialog-final.jpg`, `live-health-final.json`,
`cron-receipts.json` and `release-gate-final.log`. These are synthetic mail
fixtures; receipts intentionally exclude credentials and raw bearer links.
The prepared publication manifest is
`.tmp/releases/6f215b03c5ff77ef28410254e9701d67/staging/1791528756248-5174dbd67d70/release.json`.
A multi-day real-time recovery wait was not run; that path uses the controlled
clock with binding-backed tests.

## Operational limits

Scheduling specifies the earliest allowed provider submission, not an exact
inbox-arrival guarantee. Queue/provider outages can delay delivery; existing
bounded recovery, retries, idempotency and overdue monitoring remain in force.
Cancel/change is available only while the job is queued; a claimed send returns
a conflict. The current draft recovery flow preserves the rendered snapshot.

Cloudflare delay API:
[Queue delays](https://developers.cloudflare.com/queues/configuration/batching-retries/).

Worktree preservation checked 895 turn-start files: 34 existing paths and
12 new paths belong to the declared scope; no outside-scope content changed
and the Git index is byte-identical. The current source tree matches the
verified published manifest. Final diff whitespace check passed.
