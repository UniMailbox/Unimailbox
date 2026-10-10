# Resource usage and Cron review — 2026-10-09

The Cloudflare account has **five** schedules across three Workers. The four schedules other than the current `unimailbox-staging` trigger are three legacy `unimailbox` schedules and one BBY schedule. Two legacy triggers duplicate work already performed by its every-minute trigger.

This is an audit. No application source, cloud schedule, deployment, business data, credentials or other project's files were changed. The only workspace addition is this report. Existing staged and unstaged work was preserved.

## Follow-up

The operator subsequently confirmed legacy retirement and authorized the repairs. All three legacy Cron schedules were removed; current implementation and acceptance evidence are recorded in [resource reduction QA](../qa/resource-reduction-2026-10-09.md). The original audit findings and recommendation table below remain a historical snapshot.

## Live Cron inventory

Times below use Asia/Shanghai where a clock time is shown. Cloudflare expressions use UTC.

| Worker | Expression | Invocations/day | Actual work | Recommendation |
| --- | --- | ---: | --- | --- |
| Legacy `unimailbox` | `* * * * *` | 1,440 | Recover expired outbound locks, dispatch pending/due outbound mail, process migration maintenance jobs; also run hourly and daily maintenance when their clock conditions match | Keep while the legacy service is active. Stop only as part of an explicit legacy-service retirement. |
| Legacy `unimailbox` | `0 * * * *` | 24 | Same handler; hourly upload expiry and operational metrics, plus normal outbound recovery/dispatch | Redundant: the minute trigger already runs the same hourly branch. Remove this additional trigger. |
| Legacy `unimailbox` | `17 3 * * *` | 1 | Same handler; at 11:17 daily purge expired sessions/idempotency records, old webhook records, old trash/unreferenced messages and orphan objects | Redundant: the minute trigger already runs the same daily branch. Remove this additional trigger. |
| `bby-api-staging` | `* * * * *` | 1,440 | Retry file/upload/document/signature deletion, signature-document work and email outbox | Separate project. Its deployed code also has a self-rescheduling Maintenance Durable Object alarm. Audit that alarm's live operation in BBY before removing its Cron fallback. |
| Current `unimailbox-staging` | `*/2 * * * *` | 720 | Recover outbound jobs, expire temporary attachments/editor assets; at 03:00 daily sweep avatars/editor/mail orphans | Keep a recovery trigger. Optional staging cadence reduction to five minutes would cut invocations and frequent heartbeat writes by 60%, while increasing the scheduled recovery wait. |

The legacy scheduled entrypoint passes `controller.scheduledTime` into its scheduler and never uses `controller.cron` to choose a task. The scheduler always runs outbound recovery/dispatch; it runs hourly work when UTC minute is zero and daily work at UTC 03:17. There is no scheduler-level deduplication between the three triggers. Therefore the extra hourly and daily triggers repeat work, rather than isolating different jobs.

An isolated reproduction executed the scheduler extracted from the **downloaded deployed script**, with all business/storage dependencies replaced by recording stubs. At 04:00 UTC, both the minute and hourly events produced the same task list. At 03:17 UTC, both the minute and daily events produced the same task list. It performed no external calls. Removing only these two duplicate triggers would leave hourly/daily coverage intact, avoid 25 scheduled invocations/day and release two Cron slots; this recommendation has not been applied.

The legacy service still owns **`mail.unimailbox.tech`**. Its D1 database contains three messages, zero outbound jobs and zero pending/running maintenance jobs. Low activity does not establish that it is retired. Disabling all legacy schedules also disables due-mail dispatch and retention maintenance for that service.

## Current staging findings

### 1. Expired D1 records are retained indefinitely

Read-only counts found:

| Table | Total | Obsolete/expired |
| --- | ---: | ---: |
| `idempotency_records` | 337 | 331 |
| `sessions` | 77 | 38 expired or revoked |
| `webhook_deliveries` | 152 | Retention policy not changed or assumed |
| `editor_assets` | 18 | Published assets must remain protected |
| `audit_events` | 283 | Retention policy not changed or assumed |

The current scheduler has attachment/editor cleanup and R2 sweeps, but no expired-session or expired-idempotency purge. Existing route-level idempotency deletions address specific retries/reservations, not general expiry. The security rules already require daily purging of 24-hour idempotency records (`.claude/rules/security.md:77`). D1 storage is currently only **1,228,800 bytes**, so this is a confirmed lifecycle gap and future growth issue, not a large present storage bill.

Recommended change: add bounded expired-idempotency and expired/revoked-session cleanup to the **existing daily maintenance group**, respecting foreign keys and failure isolation. Do not introduce another trigger. Do not delete mail, audit history or provider-event history without a defined retention policy.

### 2. Frequent cleanup and heartbeats impose an idle baseline

The current frequent handler executes four D1 queries even when there is no work: expired outbound leases, orphaned queued jobs, expired temporary uploads and expired editor assets. It also writes `ops:cron` once per invocation. At the configured cadence this is approximately **2,880 D1 queries and 720 KV heartbeat writes/day**, before real cleanup, daily work, requests or monitoring.

Sources: `apps/worker/src/entrypoints/scheduled.ts:21`, `modules/outbound-mail/job-repository.ts:454`, `modules/messages/attachment-consume-repository.ts:352`, `modules/editor-assets/index.ts:110`, and `platform/maintenance.ts:36`, under `apps/worker/src/`.

Recommended change: keep outbound recovery frequent, but perform expiry cleanup hourly. Expiry eligibility must continue to be enforced on request paths; delayed physical deletion must not extend upload validity. A five-minute recovery cadence is also reasonable for low-traffic staging if slower failure recovery is acceptable. Normal sending uses Queues and does not wait for Cron. Update the handler's accepted expression, all environment configs, tests and monitoring together if changing the trigger; changing Cloudflare alone currently produces `Unknown maintenance schedule`.

Deleting the staging Cron entirely would remove recovery for jobs stranded between a D1 commit and Queue enqueue, or after a consumer crash. Queue retries do not replace that durable-outbox backstop.

### 3. Empty maintenance produces avoidable success logs

Every idle frequent invocation emits three successful `cron.task` lines, one zero-count `outbound.reclaim` line and one `cron.complete` line: **five application log events**, or **3,600/day**, plus platform invocation logs. Observability currently retains 100% of invocations.

Sources: `apps/worker/src/platform/maintenance.ts:21`, `apps/worker/src/modules/outbound-mail/reclaim-stale-jobs.ts:131`, and `apps/worker/wrangler.staging.jsonc:17`.

Recommended change: preserve error logs and one aggregate maintenance result; emit recovery detail only for nonzero activity/failure. This removes four idle custom events per invocation without weakening the heartbeat or hiding failures. Avoid blanket sampling as the first fix: head sampling can also omit error-containing invocations. [Cloudflare documents sampling and invocation logs here](https://developers.cloudflare.com/workers/observability/logs/workers-logs/).

### 4. Setup smoke polling outlives the smoke address and writes D1

`InboundSmokeStep.tsx:74` polls every five seconds without an expiry/error stop condition. The address expires after five minutes, but `checkInboundSmokeTest` returns `pending` when its active token is absent, so the UI can keep polling. An open foreground page can issue up to 720 requests/hour. Each successful status check uses POST and persists a new idempotency record, although checking status is read-only. Once its setup session expires, repeated failed requests can continue until the user leaves the page.

Sources: `apps/web/src/features/setup/steps/InboundSmokeStep.tsx:65`, `apps/worker/src/modules/onboarding/inbound-smoke-test.ts:88`, and `apps/worker/src/http/routes/setup.ts:496`.

Recommended change: stop on expiry/terminal error, offer an explicit restart, and use a read-only status endpoint without mutation-idempotency writes. This is limited to setup, not a global mailbox polling loop.

### 5. Rejected/replayed editor uploads still perform an R2 upload

`upload-editor-asset.ts:55` streams the file into R2 before checking its idempotency record or aggregate pending quota. Quota rejection and replay then delete the just-uploaded object. The route already rejects files exceeding the per-file system limit before upload; the remaining waste is aggregate quota/replay handling.

Recommended change: reject known aggregate-quota failures before writing R2, retain the database trigger for concurrent-upload enforcement, and preserve replay semantics. A replay must still hash/validate the actual bytes; trusting a client-provided hash or returning the prior response without verifying the body would weaken idempotency. Avoid adding a second query to every successful upload without assessing the tradeoff.

### 6. Growth risks should be bounded before adding infrastructure

The outbound recovery and queued-orphan queries return all candidates, without a batch limit. During an outage, old queued rows may be enqueued again on successive scans, adding Queue operations even though downstream atomic claims protect mail from duplicate delivery. Current staging has **zero** queued/sending jobs; this is not an observed present usage spike.

Recommended change: bound recovery batches and review re-enqueue retry timing when implementing the next outbound robustness change. There is no current evidence justifying a new cache, Durable Object or additional indexes solely for this low-volume dataset. Indexes themselves add write/storage costs.

## Usage evidence and checks

- Account schedule inventory and custom-domain ownership were read through the Cloudflare REST API. Both legacy Unimailbox and BBY deployed scripts were downloaded for handler verification. No downloaded source or secret values are included in this report.
- Account Worker analytics for October 8 01:53:51–October 9 01:53:51 UTC returned 1,489 legacy Unimailbox invocations (two exceptions), 1,454 BBY invocations and 1,057 current staging invocations. These totals include all invocation types; they do not establish how many were user requests, sends or Cron fires. [Cloudflare Workers metric query reference](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/).
- October 8 UTC D1 analytics: current staging **6,117 read queries / 53,062 rows read / 196 rows written**; legacy Unimailbox **4,502 read queries / 9,280 rows read / zero writes**; BBY **14,290 read queries / 18,577 rows read / zero writes**. Query count and billed row count are different measures. [D1 metrics reference](https://developers.cloudflare.com/d1/observability/metrics-analytics/).
- R2 analytics across the preceding 24 hours returned 2,796 `ListObjects` operations for current staging. Most of this window predates the previous daily-sweep fix. The post-fix window, October 9 **01:25–01:57 UTC**, returned no R2 operation rows; analytics can lag, and the next natural daily scan is still pending. This does not prove the complete future daily cleanup cycle. [R2 metrics reference](https://developers.cloudflare.com/r2/platform/metrics-analytics/).
- Current `/healthz`, `/readyz` and `/healthz/maintenance` each returned HTTP 200. Version remains `ed2bff67-a2f0-4d8b-95c2-c2b0dcf631f5`, schema `0032`.
- The frontend has no global periodic mailbox polling; its default query settings disable focus refetch. Several feature queries intentionally override freshness, so the global 30-second default should not be assumed to cover every route.
- The five-minute GitHub Operations workflow is separate from Cloudflare Cron. This checkout still has no Git remote; its remote activation was not established. It is a future CI/request cost if enabled, not attributed current usage.
- Large editor-file uploads and downloads already stream R2 bytes, and hosted oversized attachments are excluded from provider binary attachments. These paths should remain. Authentication checks enforce session revocation and account status; removing them for cost would change security semantics.
- No new test suite or deployment was run: application behavior was unchanged. The isolated legacy-scheduler reproduction and read-only live checks provide the audit evidence. Aggregate usage is not a verified invoice or dollar-cost estimate.

Private scratch evidence is under `.tmp/resource-review-20261009/`: schedule/domain/settings snapshots, aggregate analytics, D1 counts and the isolated legacy Cron reproduction. The existing dirty worktree and Git index were checked against the turn-start baseline.

## Minimal change order

1. Remove only the two duplicate legacy hourly/daily triggers; retain its minute trigger until legacy retirement is decided.
2. Add the already-required bounded daily D1 expiry purge, using the existing daily group.
3. Remove empty success-log detail and stop unnecessary setup status polling/writes.
4. Move attachment/editor expiry to an hourly group; optionally use five-minute recovery in staging with the explicit latency tradeoff above.
5. Review upload rejection/replay I/O and bounded outbound recovery without weakening correctness or adding new services.

BBY trigger retirement and complete legacy-service shutdown are separate deployment decisions. No resource needs to be upgraded and no additional Cron trigger is required for the recommendations above.
