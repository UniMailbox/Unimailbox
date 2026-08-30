# CAP-058 — Per-user message star state

> Bounded Phase 3 backend slice. This capability replaces the remaining
> mailbox-level star behavior with the per-user state already used for read and
> soft-delete. It does not include folders, bulk actions, search, deployment,
> or a new storage binding.

**Phase:** 3 · **Status:** Implemented locally · **Started:** 2026-08-30 · **Completed:** 2026-08-30

## Goal

Make message stars independent for every authenticated user while preserving the
existing star endpoint, response envelope, authorization, idempotency, and audit
guarantees. If two members star the same message, one member's toggle must never
change the other member's view.

## Scope

- Add `message_user_state.is_starred` as a typed 0/1 column with a safe default and
  constraint, including the authoritative SQL migration and verify companion.
- Backfill an existing mailbox-level `mailbox_messages.is_starred = 1` into one
  per-user state row for the mailbox owner and every explicit mailbox member. Keep
  the legacy column for compatibility, but make it non-authoritative and stop
  reading or writing it from the star path.
- Update the Drizzle typing, migration fixture, schema sentinel, and messages read
  queries so list, detail, and thread surfaces resolve `isStarred` from the calling
  user's state row (`COALESCE(..., 0)`).
- Update the existing star toggle route/repository seam to read and atomically
  upsert the calling user's `(mailbox_message_id, user_id)` state row. Keep the
  route path, `Idempotency-Key` requirement, response `{ data: { id, isStarred } }`,
  audit action, and one-batch mutation/replay semantics unchanged.
- Bind the star idempotency identity to the target mailbox/message rather than
  using one route-template operation for every message. A legacy record may only
  replay when its stored response identifies the same message; otherwise it must
  not be applied to this resource.
- Scope the existing web mailbox query-key family by authenticated user ID so a
  per-user star (and its optimistic rollback) cannot survive an account switch in
  a shared `QueryClient`.
- Add focused real-D1 Worker and contract/schema tests for migration shape,
  per-user independence, list/detail/thread projections, authorization, replay,
  same-key concurrency, audit correlation, and no legacy-column dependency.

## Out of scope

- Folders or folder filters, bulk star actions, UI changes, provider/storage/R2/KV
  changes, new routes, deployment/preview verification, or remote operations.
- Removing `mailbox_messages.is_starred`; it remains a compatibility column until
  a separately planned cleanup migration.
- Changing read, delete, mailbox-sharing, attachment, or Better Auth behavior.

## Business rules

| Rule ID | What it means for this slice |
|---|---|
| `R-MESSAGE-005` | Read/star/delete state is per user on `message_user_state`; a missing row means an unstarred message. |
| `R-AUTHZ-003` / `R-AUTHZ-004` | Require global `message.read` and authorize the path mailbox; no cross-mailbox message mutation or existence leak. |
| `R-API-002` / `R-API-004` | Keep stable envelopes and require replay-safe mutation; same key/body is byte-identical and side-effect-free, a different body conflicts. |
| `R-AUDIT-001` | One correlated `message.star_toggled` event is committed with the state mutation and idempotency record; replay adds none. |
| `R-DATA-004` / `R-DATA-005` | Use parameterized SQL, enforced FKs, and a typed boolean column rather than JSON/text state. |

## Acceptance criteria

- [x] 1. Migration `0023_message_user_state_star.sql` adds `is_starred INTEGER
  NOT NULL DEFAULT 0 CHECK (is_starred IN (0,1))`, records itself in
  `d1_migrations`, and its verify companion checks the column/default/check,
  migration row, and backfill statement shape. Drizzle, `CURRENT_SCHEMA_VERSION`,
  and the worker-pool migration fixture agree on `0023`.
- [x] 2. Existing legacy starred rows are backfilled once for the mailbox owner
  and explicit members without duplicating composite state rows. The legacy
  `mailbox_messages.is_starred` value is not consulted by post-migration reads or
  writes.
- [x] 3. `PATCH /api/v1/mailboxes/:mailboxId/messages/:messageId/star` toggles
  only the caller's state row and returns the unchanged existing response
  envelope/status. Owner and viewer/sender/admin members can toggle through the
  existing read authorization; foreign/non-member, missing, and cross-mailbox
  messages remain denied/not-found as before.
- [x] 4. Two users sharing a mailbox can hold opposite star values for the same
  message. Their list, detail, and thread responses each reflect only the
  requesting user's state, and a user with no state row sees `isStarred: 0`.
- [x] 5. A caller's soft-deleted message is treated as the same
  `MESSAGE_NOT_FOUND`/no-write surface as any other hidden message. The legacy
  `mailbox_messages.is_starred` value is unchanged and cannot make a hidden or
  newly-created message appear starred.
- [x] 6. A successful toggle writes one per-user state change, one
  `message.star_toggled` audit row with actor/message/request correlation and
  only the approved mailbox + target metadata, plus one idempotency record in one
  D1 batch. The legacy mailbox star column is unchanged.
- [x] 7. Same-key/same-body replay and true concurrent same-key requests return
  identical stored responses and leave exactly one per-user state, audit, and
  idempotency row. Same-key/different-body remains the stable idempotency
  conflict; different users/keys and different messages do not share state or
  records. The web query keys include user identity and preserve optimistic
  rollback behavior.
- [x] 8. Focused Worker/contract tests carry every implemented R-* ID and prove
  no credential, storage, or unrelated user's state is exposed. No new raw SQL is
  placed in the route handler outside the existing messages repository seam.
- [x] 9. `pnpm scaffold doctor`, `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`,
  `pnpm test:worker`, `pnpm format:check`, `pnpm build`, and `git diff --check`
  pass locally. No preview/deployment evidence is required.

## Vertical slice

`migration/schema` → Messages read/state repository → existing star route → real-D1
Worker/contract tests. No new module dependency edge is allowed. The messages
module remains the sole owner of `message_user_state`; audit and idempotency use
the existing platform/composition seams.

## Implementation evidence

- Migration/schema: `0023` applies and verifies cleanly; the upgrade test covers owner/member
  backfill, composite-key preservation, and legacy-column retention.
- Backend: list/detail/thread and toggle use caller-scoped `message_user_state.is_starred`,
  preserve read/delete fields, hide caller-soft-deleted messages, and bind star idempotency to
  mailbox/message resources while keeping the atomic state + idempotency + audit batch.
- Web: mailbox list/detail/thread and mutation cache keys include the authenticated user ID;
  shared-QueryClient account-switch isolation is covered by a focused test.
- Local gates: contracts 377/377, focused messages Worker 68/68, focused Web 64/64, unit 999/999,
  Worker 886/886, doctor 14/14, lint/typecheck/format/build, and `git diff --check` pass.
- Independent architecture review: ACCEPT with no findings. No preview/deployment evidence was
  collected; CAP-054 provider verification remains a separate Phase 2 prerequisite.

## File ownership

| Agent | Owns |
|---|---|
| Claude Code | `migrations/0023_message_user_state_star.sql`, `migrations/0023_message_user_state_star.verify.sql`, `apps/worker/src/database/schema/messages.ts`, `apps/worker/src/database/schema-version.ts`, `packages/contracts/src/index.ts` comments/types if needed, `packages/test-kit/src/migrationsDb.ts`, `packages/test-kit/src/migrationsDb.worker.test.ts`, `apps/worker/src/modules/messages/message-read-repository.ts`, `apps/worker/src/modules/messages/index.ts`, `apps/worker/src/http/routes/messages.ts`, `apps/worker/src/http/routes/messages.worker.test.ts`, focused contract tests, and the existing web mailbox query-key consumers/tests under `apps/web/src/features/mailbox/`. |
| Codex | This contract, ledger/log, review coordination, quality gates, archive, and final commit. |
| Grok/architecture reviewer | Independent read-only architecture/acceptance review; no source edits. |

## Dependencies

- Requires: CAP-043 per-user read/delete state and composite PK — implemented;
  CAP-040 audit seam and CAP-042 idempotency/auth boundary — implemented.
- Blocks: folder views and the final Phase 3 star/folder acceptance evidence.

## Decisions

- 2026-08-30: Use the existing `message_user_state` composite key and add only
  `is_starred`; keep the legacy mailbox column for compatibility but make it
  non-authoritative. Backfill legacy starred rows to all currently effective
  mailbox users (implicit owner plus explicit members) so the migration does not
  silently clear existing stars.
- 2026-08-30: Keep the existing route and wire response unchanged; per-user
  semantics are a persistence/read-model correction, not a new HTTP surface.

## Reading list

- `CLAUDE.md`
- `.claude/rules/architecture.md`
- `.claude/rules/testing.md`
- `.claude/rules/security.md`
- `docs/rebuild/02-business-discovery/business-rules.md`
- `docs/rebuild/08-roadmap/phase-3-business-completeness.md`
- `apps/worker/src/http/routes/messages.ts`
- `apps/worker/src/modules/messages/message-read-repository.ts`
- `migrations/0017_message_user_state_composite_pk.sql`
- `packages/test-kit/src/migrationsDb.ts`
