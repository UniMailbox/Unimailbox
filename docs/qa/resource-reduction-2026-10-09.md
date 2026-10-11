# Resource reduction acceptance — 2026-10-09

The operator confirmed the legacy service is retired and authorized the resource-review repairs. Existing data is retained for gradual replacement by the current implementation.

## Implemented scope

- Removed all three legacy `unimailbox` Cron schedules. Cloudflare PUT succeeded and a subsequent GET returned an empty list. No Worker, domain, database, bucket, namespace, credential or historical message was deleted. BBY configuration is unchanged.
- Configured one five-minute trigger in current environment templates and local/test configurations. Outbound recovery runs every five minutes, upload expiry hourly, identity/idempotency expiry and avatar/orphan scanning daily at **03:00 Asia/Shanghai**. The former two-minute expression is accepted during Cloudflare propagation.
- Isolated frequent/hourly/daily results and heartbeats. Monitoring allows 15 minutes for frequent, two hours for hourly and 26 hours for daily heartbeats, with initial-cycle grace for missing hourly/daily records. A retry timestamp cannot hide a stalled delivery: the monitor measures unsent-job age from creation.
- Daily D1 cleanup removes at most 1,000 expired idempotency rows and 1,000 expired/revoked application sessions, preserving active sessions and unexpired records. No schema migration or new service is required.
- Retained one success summary per cadence and all error reports. Empty outbound recovery does not emit a detail log. Queue warnings expose a stable safe reason rather than raw error messages.
- Bounded expired-lease and orphaned-queued recovery to 100 candidates each. Atomic queued retry reservations suppress concurrent/repeated enqueue; enqueue failure or a crash remains eligible for later recovery without consuming a send attempt.
- Editor upload idempotency/quota checks precede R2 writes. Replays stream/hash the actual body without R2 writes or deletes, and remain available at full quota. Fresh requests retain the atomic D1 quota trigger; losing concurrent idempotency uploads remove their orphan object before returning a conflict.
- Setup polls a session-protected, no-store GET endpoint without D1 idempotency writes. GET does not advance setup; a single authenticated idempotent POST confirms receipt and advances. Explicit expiry and error stop polling; restart generates a new address. The server supplies an expiry timestamp, and the frontend deadline handles a stalled request. Chinese copy is included.
- Optional GitHub Operations checks reduced from five-minute to 15-minute cadence. Remote workflow activation remains unestablished; this is future CI savings, separate from Worker Cron.

## Expected idle baseline

These are source-based estimates for continuous configured operation, excluding request traffic, actual cleanup/recovery, monitoring and variable object-reference checks. They are not observed full-day analytics or a bill.

| Component | Before | After |
| --- | ---: | ---: |
| Current frequent scheduled invocations/day | 720 | 288 |
| Current maintenance KV heartbeat writes/day | 721 (720 + daily) | 313 (288 + 24 hourly + daily) |
| Current base D1 maintenance statements/day | 2,880 + daily scans | 626 + daily scans (576 recovery + 48 expiry + two TTL purges) |
| Current idle maintenance application success logs/day | 3,604 | 313 |
| Legacy scheduled invocations/day | 1,465 | 0 |
| Optional Operations workflow runs/day | 288 | 96 |

Normal sends remain Queue-driven. Scheduled recovery waits up to five minutes for its next scan; queued-orphan retry reservations become eligible after the five-minute grace period. Daily R2 pagination remains bounded at 100 objects per prefix and preserves published/live references.

## Validation

Focused binding-backed Worker tests initially passed **81/81**, and focused frontend tests passed **7/7**. After the stalled-delivery monitor fix, the scheduled suite passed **12/12**. These checks cover bounded TTL eviction with active-record preservation, hourly failure persistence, concurrent/failed queued retry reservations and batch bounds, full-quota replay/body conflicts without R2 I/O, GET polling without writes or setup mutation, and expiry/error/restart/receipt frontend behavior.

The full prepared-release gate passed **2,191 tests** (1,252 unit/frontend/package, 918 Worker and 21 migration/test-kit Worker tests), doctor **14/14**, generated-type freshness, lint, TypeScript and builds. All 32 staging migration companions passed before and after publication, with no new migration. The Worker runner printed transient network diagnostics but all test projects completed successfully with exit code zero.

## Live publication and cleanup

- Staging version **`be27f319-59aa-4947-b4ae-faaaceb1e303`** was published through the prepared-release path and passed mandatory publication smoke. Source tree: `4996f0a989913098aad2e32e273c90d06e7b4a8bac2ba9e2e7ba5aa9c7c379bf`; schema remains `0032`. The release manifest records `phase: verified`, the previous version and a pre-migration recovery bookmark.
- Subsequent Cloudflare schedule reads confirmed legacy `unimailbox: []`, current `unimailbox-staging: ["*/5 * * * *"]` and unchanged `bby-api-staging: ["* * * * *"]`. These are two account triggers across two active scheduled Workers. Other BBY maintenance decisions remain separate.
- `/healthz`, `/readyz` and `/healthz/maintenance` returned HTTP **200** with `ok: true`; health/readiness returned the expected new version and source tree.
- A fresh D1 Time Travel bookmark was saved before a one-time cleanup using the same bounded predicates as daily maintenance. Deleted **331 expired idempotency records** and **38 expired/revoked sessions**. Afterward, expired counts were zero; **39 active sessions**, **six unexpired idempotency records** and **25 messages** remained. Queued/sending outbound jobs remained zero. Only aggregate counts and operation metadata were collected.
- The release manifest is `.tmp/releases/<account>/staging/<release>/release.json`. Sanitized schedule/health/purge evidence and the additional recovery bookmark are in the private evidence folder below.

Three natural frequent Cron runs on the new version completed successfully at **10:46, 10:48 and 10:50 Asia/Shanghai**, each with one aggregate application log, `failedTasks: []`, `ok: true`, platform outcome `ok` and no exceptions. Their event expression was still the former `*/2 * * * *` during propagation, which the handler deliberately accepts. The control-plane GET already returned only `*/5 * * * *`; a natural event carrying the new expression has not yet been observed. [Cloudflare documents up to 15 minutes of Cron propagation](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

The next hourly cloud run is due **2026-10-09 11:00 Asia/Shanghai** and the first daily run after this release is due **2026-10-10 03:00 Asia/Shanghai**; neither has yet been observed. Binding-backed tests cover both cadence branches and failure isolation. Real incoming/outgoing mail, browser setup acceptance and full-day usage reductions remain separate evidence; none is inferred from local tests or successful HTTP checks. The temporary tail session was stopped after collecting evidence. No new infrastructure, paid upgrade, production-domain cutover or secret rotation was needed.

Preservation checks compared all **892** turn-start files: only the 32 expected existing paths changed and three expected files were added. Unrelated file contents and the Git index are unchanged. The final source identity matches the verified published manifest. Documentation-only acceptance updates do not change that source digest.

Private evidence: `.tmp/resource-fixes-20261009/`. The turn-start worktree/index snapshot is retained for preservation checks. No commit or push was requested.
