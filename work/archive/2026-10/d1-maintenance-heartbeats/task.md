# Move maintenance status from KV to D1

Started 2026-10-15. Main agent owns platform heartbeat persistence/health, schema
0037, test fixtures and operational documentation. No delegation or independent
review is claimed. Existing branch/PR #48 is the authorized delivery path.

Reduce staging maintenance KV writes by its 313/day fixed heartbeat baseline
and remove the three per-probe heartbeat KV reads. Persist three relational
cadence snapshots and failed task names in D1, retaining independent failure,
freshness, DLQ and stalled-delivery checks. A one-time durable handover reads
each pending old KV key during initial inspection, including absence;
concurrent first probes may duplicate reads but cannot overwrite live D1 state;
malformed/unreadable legacy state stays unhealthy until cadence recovery.
Do not write/delete legacy KV keys or change recovery/cleanup schedules.

Acceptance: focused real-binding call counts and failure/staleness/concurrency
tests; raw fresh/partial/repeated 0037 migration; canonical gate; existing
staging account/domain/resources verified, recovery bookmark before migration,
37 remote SQL companions and actual D1 scheduled heartbeat/health acceptance.
Commit, update PR and stage only owned files. Production remains on its current
release; migrating that installation is outside this staging deployment.

Focused checks: 30 Worker maintenance/scheduled tests, 28 raw migration and
fixture tests, TypeScript and focused lint pass. A stale compiled test-kit first
omitted the new table; rebuilding the fixture package corrected the harness.
Schema 0037 raw fresh/partial/repeated behavior and actual D1 atomic rollback,
legacy handover, delayed-run/race protection, fail-closed behavior and freshness
boundaries passed. Source self-review only; no independent review claimed.

Before migration, a private 0600 staging D1 export (schema 0036) restored into
in-memory SQLite with integrity and foreign-key checks passing. The publication
flow also captured its D1 Time Travel bookmark. Keep raw SQL and auth helpers
in ignored scratch.

Completed 2026-10-15: application `a104103`, canonical gate 2,411 tests,
all 37 remote schema companions, staging Worker
`246d800c-b48d-46d5-9d36-9d610d9e0820`, schema 0037. Readiness, repeated
maintenance probes, adopted hourly/daily snapshots and a real 16:20:40
Asia/Shanghai frequent D1 scheduled write passed. The first publication stopped
after 0037 on a read-only provider network error; the same prepared release
resumed successfully. Production unchanged. Full-day KV usage and actual new
hourly/daily runs remain separate from this bounded acceptance. Detailed evidence:
`docs/qa/d1-maintenance-heartbeats-2026-10-15.md`.
