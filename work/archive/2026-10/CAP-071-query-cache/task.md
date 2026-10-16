# CAP-071 — Measured D1 queries and mailbox cache freshness

Optimize authenticated identity lookup, thread reads and mailbox cache reuse
using synthetic local D1 query counts, rows read, plans and P95 samples. Preserve
D1 session revocation/account checks, exact thread-root precedence, mailbox/user
isolation, newest-thread limits, mutation cache coherence and draft concurrency.
No remote account/mail access, deployment, polling or Durable Objects.

Acceptance: local before/after metrics; direct binding authorization and migration/
thread regressions; frontend remount reuse and mutation/account-isolation tests;
canonical isolated pnpm verify with unrelated PersonalMcpSettings.tsx preserved.
Single writer; self-review. No new dependencies. R-AUTH-005, R-AUTHZ-002/004,
R-MESSAGE-005 and R-API-005 remain authoritative.

Outcome: implemented locally on 2026-10-16; isolated pnpm verify passed 2,543
tests. Self-review only. Evidence and publication boundaries:
`work/handoffs/query-cache-2026-10-16.md`.
