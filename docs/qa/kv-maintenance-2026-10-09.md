# KV maintenance reduction — 2026-10-09

Implemented the [KV investigation recommendations](../operations/kv-usage-review-2026-10-09.md), with daily avatar/orphan scans as requested. Staging is verified; production, secret rotation, commit and push were outside this change. Existing unrelated work and the Git index were preserved.

## Behavior

- The existing two-minute Cron retains outbox recovery and temporary attachment/editor-upload expiry. Ordinary ticks perform no R2 prefix scans or sweep-cursor reads/deletes.
- Its 19:00 UTC tick additionally scans avatars, editor orphans and inbound/legacy attachment orphans once daily at **03:00 Asia/Shanghai**. Each prefix processes at most 100 objects, with durable pagination and age/reference protection. Larger buckets finish a pass over multiple days. Only present, completed cursors are deleted.
- Attachment expiry handles at most 100 pending rows and checkpoints successful KV/R2 cleanup in `cleanup_completed_at`. Storage/checkpoint failures remain retryable; consumed attachments are protected. Legacy storage compatibility probes remain once per pending upload because compose can copy KV uploads to R2 before its consume transaction commits.
- A daily `attachment:` prefix scan also catches aged R2 copies that land after expiry was checkpointed, without deleting live uploaded/consumed objects.
- Frequent and daily heartbeats are independent. Both groups run even if one fails; frequent success cannot hide daily failure. Maintenance health reads two heartbeat keys and allows one 26-hour startup window for the first daily run. Existing stale/failed daily records remain unhealthy.

Idle scan arithmetic falls from **2,880 cursor reads/day to 5/day**, and **1,440 empty cursor deletes/day to 0**. These are source/test-based expectations, not a full day of deployed analytics. Heartbeat writes and request-driven authentication/monitoring reads remain.

## Validation

The final release gate passed: doctor 14/14, generated bindings, lint, TypeScript, builds, and **1,250 unit/web/contracts/scripts + 911 Worker + 21 migration tests = 2,182**.

Binding-backed coverage includes absent-cursor deletion, pagination beyond 100 objects, recent-upload protection, no storage probes after cleanup completion, real D1 checkpoint failure/retry, bounded batches, consumed/racing upload protection, late R2 write cleanup, daily time boundaries, cadence failure isolation and the 0031→0032 upgrade preserving expired upload metadata. Spies observe real bindings rather than replacing their behavior. A pre-existing flaky assertion that rejected `255` anywhere in a response now requires metadata-only output; random UUID digits no longer cause false failures.

## Staging acceptance

- Origin: `https://staging.unimailbox.tech`; verified version `ed2bff67-a2f0-4d8b-95c2-c2b0dcf631f5`, content tree `50f60629aab780b2bdafb5df22ff6f88e92f71a7971d14662724b656ae392b3d`.
- Migration 0032 applied and all **32** remote schema companions passed. Read-only counts still show six consumed uploads, zero eligible expired uploads and no consumed-row completion marks.
- Mandatory publication smoke passed, including release identity, readiness, frontend entry/asset/security headers, missing asset/map/API responses and protected API authentication. `/healthz`, `/readyz` (schema 0032) and `/healthz/maintenance` returned 200 with the expected identity.
- Cloudflare schedules API confirms exactly one `*/2 * * * *` trigger. Real Cron at **2026-10-09 01:20 UTC** ran the final version successfully with only `outbound.reclaim`, `attachments.expire` and `editor-assets.expire`, followed by `cadence=frequent`, `failedTasks=[]`, `ok=true`.
- Daily dispatch and cleanup are verified against real local Worker bindings. Its first natural cloud execution is due **2026-10-10 03:00 Asia/Shanghai** and has not yet been observed. No live email or full-day analytics acceptance is claimed.

Cloudflare rejected the initial extra schedule because the account had reached its Workers Free limit of five Cron triggers. The final implementation therefore selects the daily tick using the existing event's original `scheduledTime`; it adds no trigger or per-tick KV lookup. Other Workers were untouched and no upgrade is required. Readiness briefly returned 503 between migration 0032 and the initial Worker publication; final checks passed. The intermediate failed release retains the pre-migration recovery bookmark.

Operational details live in the [deployment runbook](../operations/deploy.md#monitoring-dlq-and-safe-redrive). The final verified release manifest is `.tmp/releases/<account>/staging/<release>/release.json`; raw logs, Cloudflare schedule/health/Cron evidence and preservation checks are private scratch artifacts in `.tmp/kv-fixes-20261009/`.
