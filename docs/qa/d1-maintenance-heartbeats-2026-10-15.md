# D1 maintenance status — staging, 2026-10-15

## Purpose and design

The prior read/delete optimizations left a fixed KV write baseline. On October
14 UTC, account aggregates showed 30 reads, 635 writes and one delete: staging
CACHE contributed 318 writes and production CACHE 317. Each environment's
288 frequent, 24 hourly and one daily heartbeat accounts for 313 writes/day.
The account crossed 500 writes in the 19:00 UTC hour (03:00–04:00 Asia/Shanghai
on October 15). This matches a possible Free-KV write notification; the exact
notification metric/account has not been confirmed from the email itself.

Migration 0037 adds three D1 cadence snapshots plus relational failed-task
names. The state remains bounded. Heartbeat results and task names change in
one D1 batch, and older started runs cannot erase newer results. Health reads
one small D1 result after handover, retaining frequent/hourly/daily freshness,
failure isolation, DLQ and overdue-delivery checks.

First inspection imports pending legacy KV snapshots or durably records their
absence. A malformed/unreadable value becomes a failed snapshot until its own
cadence recovers. Conditional writes prevent a late import from replacing live
D1 results; concurrent first probes may duplicate a bounded legacy read. Later
probes never poll KV. Existing keys expire under their old TTL without deletes.
Initialization grace uses persisted migration time and cannot reset on redeploy.

Frequent recovery remains five-minute, expiry hourly and orphan scanning daily.
Daily cursor KV access and normal auth/attachment caches remain separate.
Only staging is selected for this release; production retains its existing
release and approximately 313/day heartbeat KV write baseline.

## Local evidence and recovery

- 30 focused Worker tests passed for actual D1/KV bindings, monitoring, scheduling,
  atomic rollback, race protection, late runs, failed import and freshness bounds.
- 28 migration fixture tests passed, including raw fresh/partial/repeated 0037
  application at the 0036 boundary, preserved existing state, checks and registration.
- Binding spies show zero KV get/put/delete/list for steady frequent and empty
  hourly maintenance/health. Daily scans retain five cursor reads without empty
  deletes; initial legacy adoption has its separate one-time reads.
- TypeScript and focused lint passed. The first test attempt used stale compiled
  fixture exports; rebuilding test-kit loaded 0037 and the focused rerun passed.
- Main-agent source/security self-review only; no independent reviewer claimed.
- Before migration a private 0600 D1 export at schema 0036 was restored to an
  in-memory SQLite database with integrity and foreign-key checks passing.
  Normal publication also requires a fresh D1 Time Travel recovery bookmark.

## Release and live acceptance

Application commit: `a104103`. The canonical gate passed **2,411 tests**:
1,372 non-Worker, 1,011 Worker and 28 migration fixtures, plus doctor 14/14,
generated binding checks, lint, TypeScript and builds.

Staging Worker `246d800c-b48d-46d5-9d36-9d610d9e0820` serves this source at
`https://staging.unimailbox.tech`, schema 0037. Source digest:
`fe8c7d4a695362dd3522690a3224bee043998a789c43e012a9fb8ddbf243dcf0`;
frontend digest:
`bd37271f04adfcbff902fa035e6fabdc0883b76f6c5ba1b4d248fbffbc098c01`.
The release captured a pre-migration D1 Time Travel bookmark. The first attempt
applied 0037 then stopped on a transient network error during the read-only 0004
verification, before changing the Worker. Resuming the same prepared release
applied no further migration, passed all **37** verification companions and
verified the exact published Worker identity after propagation.

At 16:16:58 Asia/Shanghai, three consecutive maintenance probes passed. A direct
D1 query returned all three snapshots, `legacy_imported=1`, no failed tasks and
completed timestamps. The hourly/daily snapshots retained their previous results;
the frequent snapshot had already advanced to 16:15:41. Readiness and the standard
operations check also passed.

At 16:21:08 a second direct D1 inspection confirmed a different frequent request
ID with `started_at=2026-10-15T08:20:40.320Z` and
`completed_at=2026-10-15T08:20:40.842Z`, newer than the initial observation.
This demonstrates a real post-publication scheduled D1 write; no fake Cron or
synthetic success was injected. Three further maintenance probes passed.
Actual hourly/daily execution after publication remains unobserved; their old
snapshots were adopted, with failure/freshness semantics covered locally.

Expected reduction is 313 fixed KV writes per environment/day and three reads
per steady-state health probe. This is source/call-count evidence, not a full
post-release billing day or a promise about other account traffic. Cloudflare's
quota warning is provider-managed; the migration stores application health and
failure state in D1, rather than modifying notification settings.
