# Production D1 maintenance synchronization

Target `https://mail.leanda.tech`, existing `unimailbox-production` resources.
Published source `cc9c9d4` as Worker `8ccd55d9-dd83-4d73-8be6-97bbfbe36d3f`,
schema 0037. Application/asset digests match the prior staging release.

- Maintenance heartbeat/failure state now uses D1. Expected production reduction:
  313 fixed KV writes/day and three KV reads per steady health probe. Staging has
  the same change; schedules and ordinary auth/attachment/cursor KV remain.
- The full production preparation gate passed 2,411 tests plus doctor 14/14,
  generated bindings, lint, TypeScript, builds and the environment bundle check.
- A private D1 export restored with integrity/FK checks passing. Simulated
  0034–0037 preserved all 37 existing non-migration tables; 15 pending-migration
  assertions passed. The actual release captured a recovery bookmark, applied
  those four migrations and verified all 37 remote companions before publication.
- Exact-version smoke, readiness, repeated maintenance probes and direct D1
  inspection passed. Existing resource/key/catch-all/forwarding binding metadata
  matched the pre-release snapshot. AI/MCP remain disabled.
- Real Cron advanced D1 at 17:20:43 Asia/Shanghai; three subsequent probes
  passed, with unchanged bindings and disabled AI/MCP confirmed again.
- Current business fields remain additive, but old Worker readiness requires
  schema 0033. A blind rollback is not a healthy recovery; use a reviewed
  schema-aware build or coordinated data recovery. Do not alter migration
  history or rotate encryption keys to bypass checks.
- No mail API reads/test sends, DNS/routing edits or provider/config changes.
  Post-publication hourly/daily runs, full-day quota metrics and fresh mail
  delivery/attachment retests remain separate. Main-agent self-review only.

Full evidence and recovery boundaries:
`docs/qa/d1-maintenance-production-2026-10-15.md`.
