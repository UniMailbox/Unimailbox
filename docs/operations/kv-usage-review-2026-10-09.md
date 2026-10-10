# KV usage investigation — 2026-10-09

The main source of staging KV read/delete usage is the two-minute maintenance schedule. Two sweepers delete an absent pagination cursor on every invocation; four cursor reads happen even when no cleanup is needed. The observed daily totals match this idle workload.

This investigation queried aggregate Cloudflare analytics and application D1 counts, inspected the current source, and reproduced idle calls with isolated fixtures. No application code, remote data, deployment, secret or schedule was changed. The existing dirty worktree was preserved.

## Follow-up

The user selected **daily** avatar/orphan scans instead of the hourly starting point below. Implementation and acceptance are recorded in [KV maintenance QA](../qa/kv-maintenance-2026-10-09.md); the investigation snapshot and original attribution below remain historical evidence.

## Live evidence

The active staging version is `c10f5148-8735-47e5-a6ec-5fa324779044`, at 100% traffic. Current application source matches its previously verified content tree `0ae602e7f7057bc4d1d573f9d2e448196e42a5e55f94e76b75b983105d021e96`.

The analytics snapshot was captured at 2026-10-09 00:28:11 UTC (08:28:11 Asia/Shanghai). Cloudflare `kvOperationsAdaptiveGroups` was queried separately for staging CACHE (`058a382c046940aa8c24f37a066db803`) and SETUP_SESSION (`cec9af62338c4eefb34c1e04edd5ffd3`), covering October 6–9. Dates below are **UTC**; October 8 spans October 8 08:00 to October 9 08:00 in Asia/Shanghai.

| UTC date | CACHE read | CACHE delete | CACHE write |
| --- | ---: | ---: | ---: |
| 2026-10-06 | 1,260 | 1 | 52 |
| 2026-10-07 | 4,637 | 1,173 | 168 |
| 2026-10-08 | 2,991 | 1,440 | 538 |
| 2026-10-09, partial snapshot | 56 | 28 | 14 |

SETUP_SESSION returned only 17 reads and one write on October 6; no operations were returned for October 7–9. CACHE is the namespace to optimize.

The October 9 partial snapshot has an exact 4:2:1 read/delete/write ratio, consistent with 14 idle Cron runs and one heartbeat write per run. October 8's 1,440 deletes equal 720 runs × two cursor deletions. The corresponding 2,880 cursor reads explain approximately 96.3% of that day's 2,991 reads. These are callsite attribution calculations, supported by the isolated reproduction; the aggregate analytics do not identify individual application keys or callsites.

## Confirmed callsites

1. **Unconditional cursor deletions.** `apps/worker/src/modules/identity/personal-avatar.ts:107` and `apps/worker/src/modules/editor-assets/index.ts:151` call KV `delete` whenever the R2 listing is not truncated, even when the preceding KV read returned null. Both tasks run every two minutes, creating 1,440 daily deletes for an empty/small namespace.
2. **Four cursor reads per maintenance invocation.** The avatar and editor sweepers each read one cursor; `apps/worker/src/modules/messages/sweep-inbound-objects.ts:54` loops over two inbound prefixes and reads one cursor for each. Thus idle maintenance creates 2,880 daily reads. Inbound cursor deletion already checks that a cursor was present.
3. **Normal authenticated requests.** `apps/worker/src/http/middleware/authn.ts:26` reads `auth:<token>` for each request carrying a nonempty Bearer token through the application router. D1 still checks session revocation and account status afterward. UI queries and their retries/refetches contribute reads; eliminating this lookup requires an authentication design change, rather than an unsafe revocation-bypassing cache.
4. **Maintenance health requests.** `apps/worker/src/platform/health.ts:38` reads the Cron heartbeat once per `/healthz/maintenance` request. `/healthz` and `/readyz` do not read KV. The five-minute Operations workflow would add 288 daily heartbeat reads if activated, but the repository still has no Git remote; its remote execution was not established and it is not assumed to explain these totals.

An isolated invocation of the actual three source sweepers, with empty R2/D1 fixtures and absent cursors, recorded exactly **four KV reads and two KV deletes**. No remote KV key was read or deleted for this reproduction. The heartbeat writer was not part of the fixture; its one write is established separately by `platform/maintenance.ts`.

## Additional growth risk, not the current cause

`modules/messages/attachment-consume-repository.ts:359` selects every `status='expired'` upload on every Cron, without a limit or cleanup-complete marker. `modules/attachments/expire-attachments.ts:119` probes KV again even after prior cleanup succeeded; with an R2 object store it also probes R2. Each permanently retained expired row would add approximately 720 KV reads per day. A live read-only query found six consumed uploads and **zero** expired/eligible uploads, so this issue is not currently contributing in staging.

Ordinary editor uploads and avatars use R2. KV's legacy attachment paths and R2-to-KV download fallback remain, but the mere presence of attachment code does not explain the observed fixed-rate idle usage. Setup smoke-test polling is confined to the setup flow.

## Recommended repair order

1. Delete the avatar/editor cursor only when the already-read cursor is non-null. This needs no extra KV read and removes the idle 1,440 deletes/day while preserving pagination reset.
2. Keep fast outbox recovery and short-lived upload expiry at the current cadence, but run the R2 orphan/avatar scans less often. Their grace periods are 24 hours or seven days; a separate hourly scan is a reasonable starting point for staging, subject to object volume. Four cursor reads per hour would be 96/day instead of 2,880/day, a 96.7% reduction in that scan component. Keep pagination progress durable; do not use isolate-local state as the only cursor store.
3. Add a durable cleanup-complete state/timestamp and bounded batches for expired uploads. Mark completion only after all relevant storage cleanup succeeds; failures must remain retryable. Distinguish R2-backed uploads from legacy KV bytes to avoid unnecessary fallback probes.
4. Leave authentication and monitoring semantics intact initially. Reassess request-driven KV usage after removing the maintenance baseline, then consider a separate reviewed token architecture if it becomes material.

Cloudflare treats deletion of a nonexistent key as successful, and KV operations still count when a key is absent. See [delete semantics](https://developers.cloudflare.com/kv/api/delete-key-value-pairs/) and [operation accounting](https://developers.cloudflare.com/kv/platform/pricing/). If the account uses the Free plan, 1,440 empty deletes alone exceed its documented 1,000-delete daily allowance; the account plan was not checked here.

Raw aggregate analytics, read-only D1 results, deployment metadata, current-source reproduction and calculations are saved in `.tmp/kv-investigation-20261009/`. [Cloudflare's analytics documentation](https://developers.cloudflare.com/kv/observability/metrics-analytics/) describes the queried dataset. No production-wide or account-wide usage attribution is claimed.
