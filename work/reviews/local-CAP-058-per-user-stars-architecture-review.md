# CAP-058 per-user message stars — architecture/acceptance review

**Reviewer:** independent architecture reviewer (read-only)
**Date:** 2026-08-30
**Verdict:** **ACCEPT** — no BLOCKER/HIGH/MEDIUM findings.

## Reviewed surfaces

- Migration `0023_message_user_state_star.sql` adds a constrained/defaulted `is_starred` field,
  backfills the owner plus explicit members, preserves the composite key/foreign keys, and only
  updates `is_starred` on existing state rows.
- Messages list/detail/thread queries join `message_user_state` by the authenticated user, apply
  the caller soft-delete filter, default absent state to zero, and normalize flags to `0 | 1`.
- The star route authorizes before replay, binds the request hash to mailbox/message, and commits
  per-user state, idempotency, and audit in one D1 batch. The legacy mailbox star column is not in
  the runtime star read/write path.
- Web mailbox list/detail/thread and mutation keys use the authenticated user namespace; a focused
  QueryClient test proves user A data is not returned for user B.

## Evidence

- Contracts: 377/377
- Focused messages Worker tests: 68/68
- Focused Web mailbox tests: 64/64
- Full unit tests: 999/999
- Full Worker tests: 886/886, zero skipped/failed
- Scaffold doctor: 14/14
- Lint, typecheck, format, build/Wrangler dry-run, and `git diff --check`: pass

No files were edited by the reviewer. No `.dev.vars` contents or secrets were inspected; no remote
operation, push, deployment, or preview verification was performed. Non-blocking residuals are the
safe conflict behavior for pre-CAP-058 idempotency rows and the documented last-write-wins behavior
for different-key concurrent toggles.
