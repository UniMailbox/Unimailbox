# D1 maintenance status — staging

Application `a104103`, schema 0037; Worker
`246d800c-b48d-46d5-9d36-9d610d9e0820` at `https://staging.unimailbox.tech`.
Delivery continues on `codex/kv-request-reduction-20261014`, PR #48.

- Maintenance heartbeat/failure snapshots now use D1. Atomic writes preserve
  per-cadence failures; one-time KV adoption preserves old results and records
  absent/invalid keys durably. Steady health probes never fall back to KV.
- Expected staging reduction: 313 fixed KV writes/day and three KV reads/probe.
  Five-minute/hourly/daily schedules and regular auth/attachment caches remain.
- Canonical gate passed 2,411 tests, doctor 14/14, bindings, lint, TypeScript and
  builds. Raw migration fresh/partial/repeat and actual D1/KV integration tests
  cover failure, rollback, race, delayed-run and freshness boundaries.
- A private D1 export restored with integrity/FK checks passing; publication
  captured a recovery bookmark. First publication applied 0037 but stopped on a
  read-only provider network failure before changing the Worker. The same
  prepared release resumed successfully and verified all 37 SQL companions.
- Readiness, maintenance probes and direct D1 state inspection passed.
  Real five-minute Cron advanced the frequent D1 snapshot at 16:20:40 Asia/Shanghai;
  three subsequent maintenance probes passed.
- Production remains unchanged at schema 0033 with its own ~313/day KV heartbeat
  baseline. Full post-release daily usage and real hourly/daily execution after
  this publication remain unobserved; old hourly/daily snapshots were adopted.
  Cloudflare quota notifications remain provider-managed. Source self-review
  only; no private mail read or sent, no credential/configuration/key replacement.

Design/runbook: `docs/operations/deploy.md`; detailed dated evidence:
`docs/qa/d1-maintenance-heartbeats-2026-10-15.md`.
