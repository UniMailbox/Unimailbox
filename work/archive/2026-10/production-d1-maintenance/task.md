# Production D1 maintenance rollout

Started 2026-10-15. User authorized synchronizing production after staging's D1
maintenance acceptance. Main agent owns this release; self-review only.

Target: existing `unimailbox-production` at `https://mail.leanda.tech`, account
`6f215b03c5ff77ef28410254e9701d67`, D1 `unimailbox-production-db`.
Preserve all resource identities, encryption/cursor/setup keys, catch-all mailbox,
private forwarding secret, routing, provider configuration and Cron cadence.
Do not bootstrap, repeat setup, change DNS or send test mail.

Review current release ancestry and pending additive migrations 0034–0037;
AI/MCP remain disabled by default. Prepare the staging-tested current source
through the full production gate. Before migration, restore-test a protected D1
export and require the publication Time Travel bookmark. Verify all 37 remote
SQL companions, exact Worker identity, readiness/static/auth smoke, adopted D1
cadence snapshots and a real subsequent five-minute scheduled D1 update.
Record source/runtime/full-day evidence separately; no full mail-delivery
retest is claimed. Commit owned documentation and update existing PR #48.

Completed 2026-10-15. Production source `cc9c9d4` passed the canonical
2,411-test gate and published as Worker `8ccd55d9-dd83-4d73-8be6-97bbfbe36d3f`.
Backup restore/integrity/FK checks and backup migration simulation passed;
actual publication captured a recovery bookmark, applied 0034–0037 and verified
all 37 SQL companions. Existing bindings and AI/MCP disabled defaults matched
before/after. Exact-version smoke, readiness, three-cadence D1 inspection and
real 17:20:43 Asia/Shanghai Cron advancement with repeated health checks passed.
Old readiness expects schema 0033, so blind rollback is not a healthy recovery.
Full-day quota usage, hourly/daily execution and fresh mail retest remain separate.
See `docs/qa/d1-maintenance-production-2026-10-15.md`.
