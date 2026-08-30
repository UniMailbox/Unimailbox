# CAP-058 — Per-user message star state

## Scope completed

- Added migration `0023_message_user_state_star.sql` and verification companion. The new
  `message_user_state.is_starred` is a constrained `INTEGER NOT NULL DEFAULT 0` with the existing
  composite key and foreign keys preserved.
- Backfilled legacy `mailbox_messages.is_starred = 1` to the current mailbox owner and explicit
  members. Existing read/delete fields are preserved on conflicts; the legacy column remains only
  for compatibility and is no longer read or written by the star path.
- Updated Messages list/detail/thread projections and the star toggle to use caller-scoped state.
  Star state, idempotency, and audit are committed in one D1 batch; star request hashes bind the
  mailbox/message resource; caller-soft-deleted messages remain 404 with no write.
- Scoped the complete web mailbox query-key family and mutation invalidations by authenticated
  user ID. Added a shared QueryClient account-switch isolation assertion.
- Tightened contract and repository presentation flags to exact `0 | 1` values.

## Verification

- `pnpm scaffold doctor`: 14/14
- `pnpm test:unit`: 999/999
- `pnpm test:worker`: 886/886, zero skipped/failed
- Contracts focused: 377/377
- Messages focused Worker: 68/68
- Web mailbox focused: 64/64
- `pnpm lint`, `pnpm typecheck`, `pnpm format:check`, `pnpm build`, `git diff --check`: pass
- Independent architecture review: ACCEPT, no findings

All checks were local. No `.dev.vars` contents or secret values were inspected, and no push,
deployment, or preview verification was performed. CAP-054 provider-side idempotency observation
remains pending; the separate MessageDetailPage loading-gate portion of D-CAP-044-O remains open.
