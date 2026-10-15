# Production D1 maintenance rollout — 2026-10-15

## Selected installation and recovery

The operator explicitly authorized production synchronization after the staging
D1 maintenance rollout. Target: `https://mail.leanda.tech`, Worker
`unimailbox-production`, account `6f215b03c5ff77ef28410254e9701d67`, D1
`unimailbox-production-db` (`95823dc9-bf9b-4366-8cad-de9310c09fdb`).

Before publication, liveness, readiness and maintenance passed. Active Worker
`e765cc40-f059-453d-8654-8dffc620e0bb` served source `7599e03`, schema 0033.
The new source descends from that release and retains its production mail changes.
Compared with the previous config, the existing target/resource/key/catch-all
identities are retained; the current source additionally includes the AI binding.
The private forwarding secret is present as secret metadata. No bootstrap,
setup, routing/DNS, provider configuration or credential rotation is requested.

A protected 0600 production D1 export was restored into in-memory SQLite before
migration: integrity and foreign-key checks passed. Export size: 517,303 bytes;
SHA-256 `dee11c97fac5a02521a3e5b23e8e381900311a9b037ec96e051dc64a233d779b`.
Applying pending migrations 0034–0037 to that private backup left all 37 existing
non-migration tables row-equivalent under per-table fingerprints;
post-migration integrity/FK checks and all 15 pending-migration assertions passed.
AI/MCP defaults remained disabled.
Raw SQL, bindings and provider logs stay in ignored private scratch.

## Change and validation boundaries

This publishes the staging-tested current application rather than editing a
running Worker manually. Pending additive migrations add disabled AI settings,
scoped MCP tables/shared prompt and bounded D1 maintenance snapshots. Existing
mail data and keys are preserved; none of these migrations remove or reinterpret
old business fields. The old Worker's readiness check requires exact schema 0033,
so a blind code-only rollback would report unhealthy on schema 0037. Recovery
must use a reviewed schema-aware build or the coordinated backup/Time Travel
procedure; do not delete migration records to force readiness.
No new AI/MCP service is enabled by this rollout.

Maintenance results and relational failed-task names now commit atomically in
D1. One-time KV handover preserves old failure/freshness state; steady monitoring
never falls back to KV. Five-minute recovery, hourly expiry and daily cleanup
schedules remain unchanged. Expected production reduction: 313 fixed heartbeat
KV writes/day and three KV reads per steady health probe. Other auth/attachment/
orphan cursor usage remains. See [runbook](../operations/deploy.md) and
[staging evidence](d1-maintenance-heartbeats-2026-10-15.md).

Local source tests already passed the 2,411-test gate and GitHub Verify/CodeQL/
secret checks on `cc9c9d4`; production preparation repeated and passed the
canonical gate: 1,372 non-Worker, 1,011 Worker and 28 migration tests, doctor
14/14, generated bindings, lint, TypeScript, builds and production bundle check.
Main-agent self-review only. This platform rollout makes no mail API reads or
test sends; historical delivery evidence remains dated, and the full
mail/attachment catalog is not rerun. A full post-release quota day is separate
from source call counts and bounded scheduled-write acceptance.

## Publication and runtime

Published source `cc9c9d4` as Worker `8ccd55d9-dd83-4d73-8be6-97bbfbe36d3f`,
schema 0037. The application content matches the verified staging artifact:
source digest `fe8c7d4a695362dd3522690a3224bee043998a789c43e012a9fb8ddbf243dcf0`;
frontend digest `bd37271f04adfcbff902fa035e6fabdc0883b76f6c5ba1b4d248fbffbc098c01`.
The release recorded the old Worker and a pre-migration D1 Time Travel bookmark,
applied exactly 0034–0037 and passed all **37** remote verification companions.
Exact-version publication smoke passed: liveness/readiness/schema, completed
setup/login, anonymous admin denial, static assets and security headers.

At 17:16:00 Asia/Shanghai, three maintenance probes and the standard operations
check passed. Direct D1 inspection returned all three completed snapshots,
`failed_count=0` and `legacy_imported=1`. Hourly/daily states retained the old
results; frequent state was already at 17:15:43. The existing database, KV, R2,
queues, key bindings, catch-all value and forwarding-secret metadata matched
the pre-publication snapshot exactly. AI/MCP configurations were confirmed
still disabled via a bounded read-only query.

At 17:21:05 a subsequent read confirmed the frequent request ID changed and
`started_at=2026-10-15T09:20:43.698Z`,
`completed_at=2026-10-15T09:20:44.194Z` were newer than the initial observation.
This proves a new real scheduled D1 write rather than only a legacy import.
Three further maintenance probes and repeated binding/default checks passed.
No simulated Cron or synthetic heartbeat was written.

No mail API reads or test sends were performed. New hourly/daily execution,
full post-release daily quota usage and a fresh end-to-end mail delivery retest
remain outside this bounded platform acceptance.
