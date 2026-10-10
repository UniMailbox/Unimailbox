# CAP-043 — Inbox, message detail/thread, read and Phase 1 delete behavior

> The shared contract for this capability. Every agent working on it reads this file first.
> Location: `work/active/CAP-043-inbox-message-thread/task.md`. Delete this quote block when filling in.

**Phase:** 2 · **Status:** In Progress · **Started:** 2026-08-23

## Goal

A signed-in member can open their inbox, see a paginated list of messages grouped by mailbox, open a message to read it in the context of its reply thread, star it, or soft-delete it from their own view — with no other member's state changed and no secret or signal leaked across mailbox boundaries.

## Scope

- HMAC-signed cursor pagination contract (CAP-034 pulled forward — the slice needs it now).
- Per-user soft-delete column on `message_user_state` and the inbox-list filter that uses it.
- `GET .../messages/:messageId/thread` returning the same-thread messages ordered by RFC 5322 chain, oldest-first.
- `PATCH .../messages/:messageId/star` toggling the mailbox-level star flag.
- `DELETE .../messages/:messageId` setting the per-user soft-delete row.
- Web: mailbox list, inbox list (cursor pagination), message detail with thread panel, star + delete buttons, loading / empty / error / unauthorized / retry states.
- Mark-read continues to fire automatically on detail open (R-MESSAGE-005).

## Out of scope

- **Compose / reply / forward** — CAP-044. The reply composer is the next capability; CAP-043 ships read-side only.
- **Folder management, label, search, filters** — Phase 3 / Phase 4 work; `folder` is read-only here (`'inbox'` default).
- **Bulk actions** (select-all, archive-many) — Phase 3.
- **Real-time push** (SSE / WebSocket inbox refresh) — Phase 6 / optimisation.
- **Mailbox create / rename / share / delete** — the mailbox listing endpoint exists from CAP-020; create and rename land separately.
- **HTML sanitization policy** — the existing `htmlBody` column stores raw HTML; the Phase 1 web renderer uses `textBody` for the message body. Inline HTML rendering is a Phase 3 capability (Tiptap read view), not in this slice.
- **Hard delete / GDPR erase** — R-MAILBOX-009 cascade is mailbox-level; per-message purge is a later capability.
- **Per-mailbox `message_user_state.is_starred` migration** — the existing `mailbox_messages.is_starred` is mailbox-level and intentionally unchanged (see `D-CAP-043-A`).
- **CAP-034 separate capability** — the HMAC cursor work that used to be its own allocated capability is folded into Slice 1 here per execution-plan.md §CAP-043 ("Pull CAP-034 forward only if the slice needs cursor contract now"). The cursor contract is needed now.

## Business rules

| Rule ID | What it means for this slice |
|---|---|
| `R-MESSAGE-004` | A message's folder assignment is per-mailbox; the inbox list is `mailbox_messages.folder = 'inbox'` for the requested mailbox. |
| `R-MESSAGE-005` | Read / star / **delete** state is per-user. **Soft delete lands here per-user via `message_user_state.is_deleted`** so user A's delete does not affect user B's view. |
| `R-MESSAGE-007` | Status updates via webhook apply only if newer (R-MESSAGE-007); the inbox read-side is unaffected by status writes. |
| `R-AUTHZ-003` | Global `requirePermission('message.read')` on every inbox route, then mailbox-scoped `assertCan(actor, mailboxId, 'read', isAdmin)` at handler entry. |
| `R-AUTHZ-004` | `assertCan` authorises against the path's `mailboxId`, never a body-supplied owner. |
| `R-API-004` | `PATCH .../star` and `DELETE .../messages/:id` require `Idempotency-Key`; replays return the stored response. |
| `R-API-005` | Cursor is HMAC-signed; tampering returns `400 INVALID_CURSOR`. The cursor encodes `(created_at, id)` per cursor pagination contract (architecture.md §Pagination). |
| `R-INBOUND-008` | Inbox reads do not mutate; mark-read is the only mutation on detail open. |
| `R-DATA-001` | Email addresses are compared case-insensitively — the inbox `from_address` lookup and the recipient comparisons are NOCASE. |

Source: `docs/rebuild/02-business-discovery/business-rules.md`.

## Acceptance criteria

Objectively checkable. No "works correctly". Each maps to a test or a demonstrable behaviour.

### Slice 1 — Cursor HMAC + soft-delete + filtered inbox list

- [x] 1. `migrations/0016_message_user_state_soft_delete.sql` adds `is_deleted INTEGER NOT NULL DEFAULT 0` and `deleted_at TEXT` to `message_user_state`; the matching `.verify.sql` proves both columns exist with the right defaults and a UNIQUE constraint is NOT added.
- [x] 2. `apps/worker/src/platform/cursor.ts` exports `signCursor(payload)` and `verifyCursor(token)` using HMAC-SHA-256; `verifyCursor` returns `null` on tamper or signature mismatch. Sign key derived from `env.CURSOR_SIGNING_KEY` (new binding) via the same Secrets Store pattern as `BETTER_AUTH_SECRET` (CAP-042).
- [x] 3. `apps/worker/src/modules/messages/message-read-repository.ts` uses `signCursor`/`verifyCursor` from `platform/cursor.ts` (the pre-CAP-043 base64 cursor helpers are gone); a tampered cursor yields `null` and the route returns `400 INVALID_CURSOR` (not 200 with the wrong page).
- [x] 4. `listMessagesByMailbox` LEFT JOINs `message_user_state` and filters `COALESCE(mus.is_deleted, 0) = 0` so a soft-deleted message disappears from user A's list but is still in user B's list (asserted with two seeded users).
- [x] 5. `wrangler.jsonc` and `wrangler.test.jsonc` both declare the `CURSOR_SIGNING_KEY` binding (Secrets Store); `platform/config.ts` adds a strict parser; `scaffold doctor` parity check passes.
- [x] 6. `GET /api/v1/mailboxes/:mailboxId/messages` returns the new opaque HMAC cursor; tampered cursor returns `400 INVALID_CURSOR` (worker-pool test); empty mailbox returns `{ data: { items: [], nextCursor: null } }` with HTTP 200.
- [x] 7. Web: `/mailbox` lists owned mailboxes (uses existing `GET /api/v1/mailboxes` from CAP-020); click navigates to `/mailbox/:mailboxId`.
- [x] 8. Web: `/mailbox/:mailboxId` renders the inbox list with cursor pagination (`useInfiniteQuery` or equivalent), per-message subject / from / snippet / date / read badge / star icon, loading skeleton, empty state ("Nothing here yet"), error state with retry, unauthorized state (redirect to `/login` if descriptor is `null`).

### Slice 2 — Message detail + thread

- [x] 9. `apps/worker/src/modules/messages/message-read-repository.ts` exports `getMessageThread(db, mailboxId, messageId)` returning the same-thread messages for the mailbox, ordered oldest-first. The thread root is computed as the first non-empty of: `messages.thread_id`, the first `<…>` from `messages.references_header`, `messages.in_reply_to_header`, the message's own `message_id_header` (singleton).
- [x] 10. `GET /api/v1/mailboxes/:mailboxId/messages/:messageId/thread` returns `{ data: { rootId, items: MessageListItem[] } }` with the items ordered oldest-first; non-existent message → `404 MESSAGE_NOT_FOUND`; cross-mailbox message → `404` (no leak).
- [x] 11. Web: `/mailbox/:mailboxId/messages/:messageId` renders the message detail (text body, from, to, cc, subject, date, headers collapsed by default), and a thread panel listing all messages in the thread with the active one highlighted and clickable navigation.
- [x] 12. Opening a message detail fires `PATCH .../read` once (idempotent, no second fetch on re-render); unread → read transition updates the inbox list cache for that entry.

### Slice 3 — Star + delete

- [x] 13. `apps/worker/src/modules/messages/message-read-repository.ts` exports `toggleMessageStar(db, mailboxId, messageId)` and `deleteMessageForUser(db, mailboxId, messageId, userId)`. Star toggles `mailbox_messages.is_starred` (mailbox-level — see `D-CAP-043-A`); delete is per-user via `message_user_state.is_deleted` + `deleted_at`. (Post-review shape per H1/H2: the exports became the read + prepared-write pairs `getMessageStarState`/`prepareSetMessageStar` and `prepareSoftDeleteMessageForUser`, so the routes fold business write + idempotency record + audit row into one atomic D1 batch.)
- [x] 14. `PATCH /api/v1/mailboxes/:mailboxId/messages/:messageId/star` requires `Idempotency-Key`; replays return the same response. Returns `{ data: { id, isStarred } }`.
- [x] 15. `DELETE /api/v1/mailboxes/:mailboxId/messages/:messageId` requires `Idempotency-Key`; returns `204` on success; replays return the same `204`. The per-user row write is a single UPSERT on `message_user_state` so the operation is atomic.
- [x] 16. Web: star button toggles optimistic state; delete button opens an `AlertDialog` confirmation, then removes the message from the inbox list cache (`setQueryData` slice, not full invalidation).
- [x] 17. Star / delete state survive a route refresh; star is mailbox-level (any member sees the same star), delete is per-user (user A's delete does not hide the message from user B).

### Cross-slice gates

- [x] 18. `pnpm scaffold doctor` 13/13 + `pnpm typecheck` clean + `pnpm lint` clean + `pnpm test:unit` and `pnpm test:worker` show only pre-existing D1-parallelism failures (no new flakes).
- [x] 19. `pnpm build` passes with `wrangler --dry-run` clean (every new binding declared in both wrangler configs).
- [x] 20. `apps/web/src/features/auth/auth-session-storage.test.ts` source-tree walk still rejects `localStorage`/`sessionStorage`/`indexedDB`/Zustand `persist` after the new inbox files are added.

## Vertical slice

Layers each slice touches, in dependency order:

### Slice 1

- [x] domain — `apps/worker/src/platform/cursor.ts` (NEW: sign/verify)
- [x] migration — `migrations/0016_message_user_state_soft_delete.sql` (+ `.verify.sql`)
- [x] repository — `apps/worker/src/modules/messages/message-read-repository.ts` (cursor + delete filter)
- [x] use case — n/a (read-side; repository only)
- [x] contract schema — `packages/contracts/src/index.ts` (cursor opaque string; inbox list response stays the same)
- [x] route — `apps/worker/src/http/routes/messages.ts` (cursor 400 path)
- [x] client — `apps/web/src/features/mailbox/{MailboxListPage,InboxListPage,MailboxListSkeleton,InboxListSkeleton,InboxEmpty,InboxError}.tsx` (NEW)
- [x] tests — `apps/worker/src/http/routes/messages.worker.test.ts` (HMAC cursor tests), `apps/web/src/features/mailbox/InboxListPage.test.tsx` (NEW), `apps/web/src/features/mailbox/MailboxListPage.test.tsx` (NEW)

### Slice 2

- [x] repository — `apps/worker/src/modules/messages/message-read-repository.ts` (getMessageThread)
- [x] contract schema — `packages/contracts/src/index.ts` (messageThreadResponseSchema)
- [x] route — `apps/worker/src/http/routes/messages.ts` (GET .../thread)
- [x] client — `apps/web/src/features/mailbox/{MessageDetailPage,MessageThreadPanel,MessageDetailSkeleton}.tsx` (NEW)
- [x] tests — `apps/worker/src/http/routes/messages.worker.test.ts` (thread tests), `apps/web/src/features/mailbox/MessageDetailPage.test.tsx` (NEW)

### Slice 3

- [x] repository — `apps/worker/src/modules/messages/message-read-repository.ts` (toggleMessageStar + deleteMessageForUser)
- [x] contract schema — `packages/contracts/src/index.ts` (toggleStarResponseSchema, deleteMessageResponseSchema)
- [x] route — `apps/worker/src/http/routes/messages.ts` (PATCH .../star, DELETE .../messages/:id)
- [x] client — `apps/web/src/features/mailbox/{StarButton,DeleteMessageButton,ConfirmDeleteDialog}.tsx` (NEW), `apps/web/src/components/ui/AlertDialog.tsx` (NEW if not present)
- [x] tests — `apps/worker/src/http/routes/messages.worker.test.ts` (star/delete tests), `apps/web/src/features/mailbox/{StarButton,DeleteMessageButton}.test.tsx` (NEW)

New module dependency edges introduced: `modules/messages` → `platform/cursor` (allowed; messages already uses `platform/*`). `apps/web/src/features/mailbox` → `apps/web/src/components/ui` (allowed; existing pattern).

## Delivery path

Trace the real invocation, not only the module calls:

**Inbox list (Slice 1)**: `<Browser /mailbox>` → `<Hono router /mailbox>` → `queryClient.ensureQueryData(authQueryKeys.session())` → `MailboxListPage` (`GET /api/v1/mailboxes`) → click mailbox → `InboxListPage` (`GET /api/v1/mailboxes/:mailboxId/messages`) → cursor pagination → user A's soft-deleted messages hidden.

**Message detail (Slice 2)**: `<Browser /mailbox/:mailboxId/messages/:messageId>` → `MessageDetailPage` (`GET .../messages/:messageId` + `GET .../thread`) → on mount, `PATCH .../read` once → unread badge updates in inbox list cache.

**Star + delete (Slice 3)**: star button → `PATCH .../star` with Idempotency-Key → `mailbox_messages.is_starred` toggles → cache update. Delete button → `AlertDialog` confirm → `DELETE .../messages/:id` with Idempotency-Key → `message_user_state.is_deleted = 1` per-user row → cache slice removed.

- Build/runtime configuration touched: `apps/worker/wrangler.jsonc` and `apps/worker/wrangler.test.jsonc` (new `CURSOR_SIGNING_KEY` Secrets Store binding), `apps/worker/src/platform/config.ts` (strict parser), `scripts/deploy.ts` (provision the new secret).
- Fresh-deploy evidence required: yes — `migrations/0016_message_user_state_soft_delete.sql` runs on a fresh D1; verify migration test passes against a fresh temporary D1 binding.
- Repeat-deploy/idempotency evidence required: yes — second `pnpm test:worker` run against the seeded D1 shows no duplicate-column / no-failed-migration errors.

## Reference implementation

None — no external code is being copied. The cursor HMAC pattern follows the existing `apps/worker/src/platform/idempotency.ts` HMAC convention used for `Idempotency-Key` payload verification (CAP-014 / ADR-004); the message-thread pattern follows RFC 5322 §3.6.3 (`References` and `In-Reply-To` header semantics). The web patterns follow the existing `apps/web/src/features/setup/` and `apps/web/src/features/auth/` files (TanStack Query + React Router + D-CAP-041-1 closure for `beforeLoad`).

Per `.claude/rules/reference-implementations.md` §Required provenance, no agentic-inbox pattern is being adopted for the inbox UI; the closest reference is the legacy public-service inbox (out of scope) and the existing CAP-041 step pages (in scope, follows same patterns).

## File ownership

One writer per file. Reading anything is fine; writing outside your list is not. Each slice has exactly one implementer; reviewers run in parallel after the slice lands.

| Agent | Slice | Owns |
|---|---|---|
| `implementer-slice-1` | Slice 1 | `migrations/0016_*.sql`, `migrations/0016_*.verify.sql`, `apps/worker/src/platform/cursor.ts`, `apps/worker/src/platform/config.ts`, `apps/worker/src/platform/secrets.ts`, `apps/worker/src/modules/messages/message-read-repository.ts`, `apps/worker/src/http/routes/messages.ts`, `apps/worker/wrangler.jsonc`, `apps/worker/wrangler.test.jsonc`, `scripts/deploy.ts`, `apps/web/src/features/mailbox/{MailboxListPage,InboxListPage,MailboxListSkeleton,InboxListSkeleton,InboxEmpty,InboxError}.tsx`, `apps/web/src/features/mailbox/MailboxListPage.test.tsx`, `apps/web/src/features/mailbox/InboxListPage.test.tsx`, `apps/web/src/features/mailbox/index.ts` |
| `implementer-slice-2` | Slice 2 | `apps/worker/src/modules/messages/message-read-repository.ts`, `apps/worker/src/http/routes/messages.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/index.test.ts` (schema-coverage tests — required by doctor's tests-cover-contracts check; ratified post-review), `apps/web/src/features/mailbox/{MessageDetailPage,MessageThreadPanel,MessageDetailSkeleton}.tsx`, `apps/web/src/features/mailbox/MessageDetailPage.test.tsx`, **+ amendment after Slice 1 review**: `apps/web/src/app/router.tsx` (detail route), `apps/web/src/features/mailbox/mailbox-queries.ts` (detail/thread queries + mark-read mutation), `apps/web/src/features/mailbox/InboxListPage.tsx` (deferred fe-LOW: show mailbox address from the mailbox-list cache instead of the raw UUID) |
| `implementer-slice-3` | Slice 3 | `apps/worker/src/modules/messages/message-read-repository.ts`, `apps/worker/src/http/routes/messages.ts`, `packages/contracts/src/index.ts`, `apps/web/src/components/ui/AlertDialog.tsx`, `apps/web/src/features/mailbox/{StarButton,DeleteMessageButton,ConfirmDeleteDialog}.tsx`, `apps/web/src/features/mailbox/{StarButton,DeleteMessageButton}.test.tsx` |
| `architecture-reviewer` (parallel after slice) | per slice | reads only; produces findings |
| `code-reviewer` (parallel after slice) | per slice | reads only; produces findings |
| `qa-reviewer` (parallel after slice) | per slice | reads only; produces findings |
| `security-reviewer` (parallel after slice) | per slice | reads only; produces findings |
| `frontend-reviewer` (parallel after slice) | per slice | reads only; produces findings |

Note on overlapping ownership: `message-read-repository.ts`, `apps/worker/src/http/routes/messages.ts`, and `packages/contracts/src/index.ts` appear in three slices. The orchestrator sequences the slices so no two implementers touch the same file concurrently (Slice 1 → review → Slice 2 → review → Slice 3 → review).

## Reading list

Give each subagent exactly this — not the whole `docs/` tree.

- `CLAUDE.md` (the Claude Code entry point)
- this file (`work/active/CAP-043-inbox-message-thread/task.md`)
- `.claude/agents/implementer.md` (if you are an implementer) or `.claude/agents/<role>.md`
- `.claude/rules/architecture.md` (modules → integrations is forbidden; allowed table; bounded contexts)
- `.claude/rules/coding.md` (Rule of Three; naming; comments cite rule IDs)
- `.claude/rules/security.md` (PBKDF2 envelope, secrets, R-AUTHZ-004 IDOR)
- `.claude/rules/testing.md` (every business invariant gets a test named after its rule ID; never mock D1/R2/KV)
- `.claude/rules/git.md` (commit message format; agents do not commit)
- `docs/rebuild/02-business-discovery/business-rules.md` (R-MESSAGE-* and R-AUTHZ-*)
- `docs/rebuild/05-target-architecture/api-design.md` (cursor pagination contract)
- `apps/worker/src/platform/idempotency.ts` (existing HMAC pattern for `Idempotency-Key`)
- `apps/worker/src/modules/messages/message-read-repository.ts` (existing read queries — your extension point)
- `apps/worker/src/http/routes/messages.ts` (existing routes — your extension point)
- `apps/web/src/features/auth/auth-queries.ts` (TanStack Query pattern for fetchAuthSession)
- `apps/web/src/features/setup/setup-queries.ts` (TanStack Query pattern for setup-step mutations)

## Dependencies

- Requires: CAP-022 (inbox routes), CAP-042 (Better Auth shell + authorized mailbox navigation)
- Blocks: CAP-044 (compose / reply / admin surfaces depend on the inbox shell)
- Pulls forward: CAP-034 (cursor HMAC) — folded into Slice 1 per execution-plan.md §CAP-043

## Decisions made during this capability

### D-CAP-043-A — `is_starred` stays mailbox-level (defer per-user star to a follow-up)

`mailbox_messages.is_starred` is mailbox-level — when any member of a mailbox stars a message, all members see the star. `R-MESSAGE-005` says star state is per-user. Migrating this column to `message_user_state.is_starred` is a separate, schema-breaking change (every `mailbox_messages` SELECT that surfaces `is_starred` needs to join the per-user state), and existing CAP-022 tests assert the mailbox-level value. For CAP-043, the slice leaves `is_starred` as-is and documents the gap.

A future capability should migrate `is_starred` to `message_user_state` per R-MESSAGE-005 — at minimum a migration that adds `message_user_state.is_starred`, a backfill of `1` where `mailbox_messages.is_starred = 1`, a change to the inbox list query to LEFT JOIN the per-user value, and a deprecation of the mailbox-level column. Until then, CAP-043 star is mailbox-level.

### D-CAP-043-B — soft-delete uses `message_user_state.is_deleted`, not a `deleted_at` on `mailbox_messages`

R-MESSAGE-005 says delete is per-user; placing `deleted_at` on `mailbox_messages` would be mailbox-level and violate the rule. Migration 0016 adds `is_deleted` + `deleted_at` to `message_user_state`; the inbox list query LEFT JOINs and filters `COALESCE(mus.is_deleted, 0) = 0`. A user who has never opened the message has no `message_user_state` row — `COALESCE` returns 0, so the message shows as not-deleted. The DELETE handler UPSERTs the row with `is_deleted = 1`.

### D-CAP-043-C — thread root computed at read time, not denormalised into `messages.thread_id`

`messages.thread_id` is already a column (CAP-021 schema), but the existing inbound write path does not populate it. For CAP-043 the thread root is computed at read time from `references_header` / `in_reply_to_header` / `message_id_header` so the slice ships without a backfill migration. The computation is deterministic: take the first non-empty value in priority order `[thread_id, references_header[0], in_reply_to_header, message_id_header]`. A follow-up capability should backfill `thread_id` for existing rows and populate it at insert time (so the column becomes authoritative), at which point the read-time computation can be deleted. Until then, both the column and the read-time computation exist; if the column is set, it wins.

### D-CAP-043-D — `CURSOR_SIGNING_KEY` is a Secrets Store binding, separate from `CREDENTIAL_ENCRYPTION_KEY` and `BETTER_AUTH_SECRET`

The cursor is opaque to clients but tamperable by them (it's URL-passed). HMAC-SHA-256 over the `(created_at, id)` payload prevents a malicious client from jumping the cursor or guessing other users' positions. The signing key MUST be independent from `CREDENTIAL_ENCRYPTION_KEY` (different purpose, different rotation cadence) and `BETTER_AUTH_SECRET` (different purpose, different rotation cadence). `.claude/rules/security.md` §Secrets (ADR-007) is the precedent; the Secrets Store binding is the storage layer.

### D-CAP-043-E — `DELETE` returns `204 No Content`, not `200`

The HTTP convention for a successful DELETE is `204 No Content`. The slice returns the empty body and the `Idempotency-Key` replay returns the same `204` with empty body. The Idempotency-Key table stores `responseStatus = 204` and `responseJson = ''` (the existing `prepareCreateIdempotencyRecord` already accepts this shape).

### D-CAP-043-F — `message_user_state` PK becomes `(mailbox_message_id, user_id)` (Slice 1 review finding, H1)

The CAP-021/0006 schema made `mailbox_message_id` the sole PRIMARY KEY of `message_user_state` — one row per mailbox message, not one row per user. That is incompatible with `R-MESSAGE-005` per-user semantics in two ways:

1. **Pre-existing defect (CAP-022 `markMessageAsRead`)**: the UPSERT conflicts on `mailbox_message_id` alone and never rewrites `user_id`, so when a second member reads a shared message their INSERT conflicts, the DO UPDATE keeps the first reader's `user_id`, and the second reader's per-user row never exists. Every subsequent visit resolves `isRead = 0` for them (the list/detail queries join on `(mailbox_message_id, user_id)`), so the second reader's read state is silently dropped — the message shows unread forever for everyone except the first reader.
2. **Blocks D-CAP-043-B**: a per-user `is_deleted` column on a table that can hold only one user's row means Slice 3's DELETE would clobber the other member's state.

Migration **0017** rebuilds the table with `PRIMARY KEY (mailbox_message_id, user_id)` (SQLite cannot ALTER a PK; the migration creates `message_user_state_new`, copies rows, drops the old table, renames, recreates both indexes). The rebuild is lossless: the single-column PK guarantees no `(mailbox_message_id, user_id)` duplicates exist today. The writer-side alternative (re-assert `user_id = excluded.user_id` in the DO UPDATE, proposed during review) was **rejected** — it only changes whose state gets destroyed. `markMessageAsRead`'s conflict target becomes `(mailbox_message_id, user_id)`.

### D-CAP-043-G — Rule of Three: `platform/cursor.ts` is pre-allocated CAP-034, accepted under the contract exception

`signCursor`/`verifyCursor` currently have one concrete caller (`listMessagesByMailbox`). The abstraction is not justified by the Rule of Three; it is accepted because the CAP-043 contract explicitly pulls CAP-034 forward (§Out of scope, §Dependencies) and the execution plan allocates further cursor-paginated lists (drafts, sent, search) to the same helper. Recorded here so the acceptance is contractual, not tacit.

### D-CAP-043-H — star and per-user soft delete ride the `message.read` surface (Slice 3 dispatch decision)

Both Slice 3 mutations are presentation-state changes on the read surface, not destructive operations, so both use `requirePermission('message.read')` + `assertCan(actor, mailboxId, 'read', isAdmin)` — exactly the markRead route's surface:

- **star** toggles a mailbox-level presentation flag (D-CAP-043-A); the per-user-star deferral is the recorded gap.
- **soft delete** writes only the calling user's own `message_user_state` row (D-CAP-043-B); it cannot affect any other member's view, so it is the user tidying their own inbox, not exercising a destructive capability.

The `message.delete` permission and the mailbox matrix's owner-only `delete_message` op stay reserved for hard delete / per-message purge (explicitly out of scope for CAP-043). If a future capability moves star to per-user state or adds hard delete, it revisits this mapping.

## Slice 1 review outcome → fix pass

Reviews returned: frontend **REJECT** (3 HIGH, 2 MEDIUM, 2 LOW) · QA **ACCEPT** (all AC verified) · security **ACCEPT-WITH-FOLLOWUPS** (2 MEDIUM, 3 LOW) · code **ACCEPT-WITH-FOLLOWUPS** (1 HIGH, 3 MEDIUM, 3 LOW) · architecture pending. The orchestrator independently confirmed the code H1 / security M2 root cause (single-column PK) by inspecting `schema/messages.ts:113-129` and `message-read-repository.ts:369-394`.

### Fix-pass acceptance criteria

- [x] F1. **Migration 0017** (`migrations/0017_message_user_state_composite_pk.sql` + `.verify.sql`) rebuilds `message_user_state` with `PRIMARY KEY (mailbox_message_id, user_id)`, preserving every column and default from 0006 + 0016 (`is_read`, `read_at`, `updated_at DEFAULT (datetime('now'))`, `is_deleted DEFAULT 0 CHECK`, `deleted_at`), both FK CASCADEs, and recreates `message_user_state_user_idx` + `message_user_state_is_deleted_idx`. Copy step preserves all rows (lossless — no duplicates possible under the old PK). Verify asserts both PK columns (`pk=1` in `PRAGMA table_info`), row-count preservation, both indexes, and the `d1_migrations` row.
- [x] F2. **Drizzle schema** (`apps/worker/src/database/schema/messages.ts`) catches up with 0016 + 0017: adds `isDeleted` (`integer`, mode boolean, default false) and `deletedAt` (`text`, nullable) plus the `is_deleted` index (arch-review HIGH — 0016's columns were never mirrored), and declares the composite PK via `primaryKey({ columns: [mailboxMessageId, userId] })`. `CURRENT_SCHEMA_VERSION` is `'0017'` in both `apps/worker/src/database/schema-version.ts` and `packages/contracts/src/index.ts`; `packages/test-kit/src/migrationsDb.ts` imports and applies 0017 (and `migrationsDb.worker.test.ts` expectations updated).
- [x] F3. **`markMessageAsRead`** conflict target becomes `(mailbox_message_id, user_id)`; the misleading "keeps the existing user_id" comment is replaced with the per-user row semantics. New worker test `R-MESSAGE-005`: two members read the same message → both have `message_user_state` rows with `is_read = 1`; each member's list shows the message read for themselves.
- [x] F4. **AC-4 test strengthened**: the per-user soft-delete test seeds rows for BOTH users (owner `is_deleted = 1`, viewer row present `is_deleted = 0`), proving coexistence — only possible post-0017.
- [x] F5. **`MailboxListPage`** renders the D-CAP-041-9 fallback: `descriptor === null` after the router guard renders `<Unauthorized variant="expired" />` (mirrors `MailboxShell`), not the empty state. The unauthorized test asserts the `expired-session` surface AND that no mailbox rows render — replacing the current `expect(router).toBeDefined()` tautology.
- [x] F6. **`InboxListPage`** drops the `useEffect` navigate-to-`/login` double-handling; a null descriptor renders `<Unauthorized variant="expired" />` only (the Sign-in CTA inside it is the recovery path), matching `MailboxShell`.
- [x] F7. **Loading-skeleton test** proves the skeleton branch: the messages fetch must never resolve during the assertion (pending promise), and the assertion is `inbox-list-skeleton` only — not `skeleton OR error`.
- [x] F8. **Dead surface removed**: `encodeCursor` alias and its re-export in `modules/messages/index.ts` are gone (repository calls `signCursor` directly); `PlatformConfig.cursorSigningKey` stub field is deleted from `platform/config.ts` (the only key path is `parseCursorSigningKey(env)`); the `mailbox-queries.ts` comment referencing non-existent `INBOX_INVALID_CURSOR_REFETCH` describes the real `refetch()` recovery; `verifyCursor` drops the redundant `as BufferSource` casts; `mailboxMessagesInfiniteQuery` drops the inferable positional generics; `InboxError` copy says "inbox list", not "mailbox list".
- [x] F9. Gates: `pnpm scaffold doctor` 13/13 (schema-version reads 0017), `pnpm typecheck` clean, `pnpm lint` clean, `pnpm test:worker` at the 661+new baseline (4 pre-existing D1-parallelism failures only), `pnpm build` clean, web mailbox tests green.
- [x] F10. **0016 verify.sql CHECK probe fixed** (arch MEDIUM + sec LOW): the dead INSERT probe that never executes its failing insert is replaced with a `sqlite_master` DDL assertion (`SELECT … FROM sqlite_master WHERE name='message_user_state' AND sql LIKE '%is_deleted IN (0, 1)%'`-style, which survives the 0017 rebuild) or deleted outright. No verify file may carry statements that assert nothing.

### Fix-pass file ownership (one implementer, same envelope as Slice 1 plus)

`migrations/0017_*.sql` + `.verify.sql` (NEW) · `apps/worker/src/database/schema/messages.ts` · `apps/worker/src/database/schema-version.ts` · `packages/contracts/src/index.ts` (version bump only) · `packages/test-kit/src/migrationsDb.ts` · `apps/worker/src/modules/messages/message-read-repository.ts` · `apps/worker/src/modules/messages/index.ts` · `apps/worker/src/http/routes/messages.worker.test.ts` · `apps/worker/src/platform/config.ts` · `apps/worker/src/platform/cursor.ts` · `apps/web/src/features/mailbox/{MailboxListPage,InboxListPage,InboxError,mailbox-queries}.{tsx,ts}` · `apps/web/src/features/mailbox/{MailboxListPage,InboxListPage}.test.tsx`

### Deferred to later slices / follow-ups (recorded, not fixed now)

| Finding | Disposition |
|---|---|
| Cursor payload not bound to `mailboxId`/actor/TTL (sec LOW) | Slice 2 or follow-up — add `mailboxId` + `iat` to payload when a second cursor consumer exists |
| `verifyCursor` payload format validation (UUID + datetime regex) (sec LOW) | Follow-up hardening |
| 0016 verify.sql CHECK probe leaves dirty state on failure (sec LOW) | Follow-up — wrap probe rows in a transaction |
| `MailboxListRow` button vs `<Link>` (fe LOW) | Follow-up refactor; Batch 8 L-3 chose button deliberately |
| Card title shows raw mailbox UUID (fe LOW) | Slice 2 threads the mailbox address through the inbox route |
| Auth-storage guard doesn't scan `features/mailbox/**` (fe follow-up) | Extend guard root when Slice 3 adds cache mutations |
| Global installation-status → `/setup` redirect missing on web router (fe follow-up) | Pre-existing; separate capability (CAP-045 preview deployment surfaces it) |
| `MailboxShell` retirement once `MailboxListPage` carries the D-CAP-041-9 fallback | Slice 2 cleanup — verify no importers first |
| Slice 3 gate: star/delete UPSERTs MUST target `(mailbox_message_id, user_id)` post-0017 (sec M2) | Binding constraint on Slice 3's `deleteMessageForUser` |
| Promote `mailboxListResponseSchema` from `apps/web/src/features/mailbox/mailbox-queries.ts:38-50` to `packages/contracts` (arch MEDIUM) | Before Slice 3 lands — cross-boundary wire shapes belong in contracts |
| Verify comment cites nonexistent `.changes` semantics (arch LOW) | Fix in passing during the fix pass if trivially locatable; else follow-up |

## Slice 2 review outcome → fix pass

Reviews returned (all five in parallel on the uncommitted Slice 2 tree): architecture **ACCEPT-WITH-FOLLOWUPS** · code **ACCEPT-WITH-FOLLOWUPS** · security **ACCEPT-WITH-FOLLOWUPS** · frontend **ACCEPT-WITH-FOLLOWUPS** · QA **ACCEPT**. Full reports in `work/reviews/CAP-043-architecture-review-slice2.md` and the other four slice-2 review files; the consolidated record lands in `work/reviews/CAP-043-slice2-review.md` at fix-pass completion. The orchestrator independently confirmed the three worker findings below against `message-read-repository.ts:335-509`.

### Fix-pass acceptance criteria (G1–G12)

- [x] G1. **Thread query B is capped; recipients fetch bounded** (sec M1 — D1 rejects >100 bound parameters). The root-matching branch of query B changes from unbounded ASC to `ORDER BY m.created_at DESC, m.id DESC LIMIT 50` with the results reversed in JS to the ASC presentation order (newest-50 window: the root may fall outside a 50+ thread; `rootId` in the response stays correct and the anchor is rendered by the detail query, so the window is presentation-only). A named constant (`THREAD_MAX_ITEMS = 50`) cites the D1 parameter limit. The singleton branch is unchanged (structurally ≤1 row by the unique index). The recipients `IN` clause therefore binds ≤50 ids — always under the limit; no chunking. Boundary worker test: a thread with 120 same-root members returns 200 with exactly 50 items, includes the NEWEST member, excludes the oldest/root member, and every item carries parsed recipients (proving the bounded IN-clause executed). Before the fix this scenario fails the whole request.
- [x] G2. **`getMessageDetail` respects per-user soft delete** (arch M1 / code M4 / sec L2 — detail currently 404s nothing the list hides). The WHERE gains `AND COALESCE(mus.is_deleted, 0) = 0`. Worker test: seed `message_user_state` with `is_deleted = 1` for user A on a message → GET detail as A → 404 `MESSAGE_NOT_FOUND`; GET as B (no row) → 200.
- [x] G3. **`THREAD_ROOT_SQL` final tier uses `NULLIF(m.message_id_header, '')`** (code L1 — an empty-string `message_id_header` currently resolves root `''`, and every other header-less empty-string message also resolves `''`, fusing unrelated messages). With NULLIF, empty string resolves NULL → singleton. Worker test: two messages with `message_id_header = ''`, no references / in_reply_to / thread_id → two separate singleton threads (each thread response has exactly 1 item).
- [x] G4. **Malformed-References worker tests** (code M2): `references_header` values `'no brackets here'`, `'<'`, `'><'` must fall through the first-token tier (no garbage root like `''` or a partial) to the in_reply_to / message-id tiers — each case asserts the resolved root matches the next valid tier (or singleton when no tiers apply).
- [x] G5. **in_reply_to-only tier test** (QA L1): message M1 with `message_id_header = '<root@x>'`, message M2 with no references but `in_reply_to_header = '<root@x>'` → both resolve root `<root@x>` → M2's thread contains both, oldest-first.
- [x] G6. **Mark-read flips the detail cache too** (fe M1 / code M1 — today only the inbox infinite cache flips; the cached detail still says `isRead: 0`, so every reopen of an already-read message fires a redundant PATCH). `onSuccess` additionally `setQueryData` on `mailboxQueryKeys.message(mailboxId, messageId)` setting `isRead: 1` (additive copy). Regression test: open unread message → 1 PATCH; navigate back; reopen → still exactly 1 PATCH total.
- [x] G7. **Sibling-navigation mark-read test** (fe M2 / code L7 — the route reuses the component instance on param change, so `remountDeps` behavior must be proven, not assumed): render at unread A → exactly 1 PATCH for A; rerender with unread B → exactly 1 PATCH for B and no further PATCH for A.
- [x] G8. **Thread-error branch test** (code M3): thread fetch rejects → message body still renders, `message-thread-error` panel visible with the retry control, retry re-issues the thread fetch.
- [x] G9. **Mark-read failures are not silent** (fe L1 / code L3): the mutation gains an `onError` handler that `console.warn`s once with `mailboxId`, `messageId`, and the error code+message (genuinely ignorable failure — the page keeps rendering; warn with a reason). Test: PATCH rejects → warn called once with both ids, page does not crash.
- [x] G10. **From address renders once** (fe L2): the Card description no longer duplicates the `message-from` meta row. Test: the formatted from string appears exactly once in the rendered detail.
- [x] G11. **InboxListPage address-lookup test** (fe L3 — the lookup landed at `InboxListPage.tsx:80` without a test): cached mailbox list hit → the Card title shows the mailbox address; empty cache → falls back to the raw mailbox UUID without crashing.
- [x] G12. Gates: `pnpm scaffold doctor` 13/13 · `pnpm typecheck` · `pnpm lint` · `pnpm test:unit` ≥ 665 · `pnpm test:worker` at baseline + new passing (only the 4 documented pre-existing D1-parallelism failures) · web mailbox tests green · `pnpm build` EXIT=0.

### Fix-pass file ownership (one implementer, Slice 2 envelope only)

`apps/worker/src/modules/messages/message-read-repository.ts` · `apps/worker/src/http/routes/messages.worker.test.ts` · `apps/web/src/features/mailbox/mailbox-queries.ts` · `apps/web/src/features/mailbox/MessageDetailPage.tsx` · `apps/web/src/features/mailbox/MessageDetailPage.test.tsx` · `apps/web/src/features/mailbox/InboxListPage.test.tsx` (address-lookup test only — `InboxListPage.tsx` is NOT owned; if the test exposes a defect there, report it, do not fix it).

### Deferred to Slice 3 / closure (recorded, not fixed now)

| Finding | Disposition |
|---|---|
| Detail + thread routes duplicate the authz stanza; a shared helper needs a 6th site first | Slice 3 — extract when the star/delete routes add it |
| `THREAD_ROOT_SQL` CASE evaluation per row (no index) on the thread query | Follow-up with the `thread_id` backfill capability (D-CAP-043-C already records read-time resolution as deliberate) |
| `message-read-repository.ts` approaching 250+ lines | Split decision at Slice 3 completion |
| `assertCan` 404-vs-403 oracle (deny shape for cross-tenant IDs) | Closure-time recorded decision |
| Detail page Back link + title show raw mailbox UUID | Cosmetic; ride along with Slice 3 web work if touched |

## Slice 3 dispatch contract

### File ownership

| Agent | Slice | Files |
|---|---|---|
| `implementer-slice-3` | Slice 3 (star + delete, AC 13–17) | `apps/worker/src/modules/messages/message-read-repository.ts`, `apps/worker/src/modules/messages/index.ts` (exports), `apps/worker/src/http/routes/messages.ts` (star + delete routes + authz/idempotency helper extraction), `apps/worker/src/http/routes/messages.worker.test.ts`, `packages/contracts/src/index.ts` (+ `index.test.ts` — `toggleStarResponseSchema`, `mailboxListResponseSchema` promotion), `apps/web/src/features/mailbox/mailbox-queries.ts` (star/delete mutations + switch to the promoted contracts schema), `apps/web/src/features/mailbox/{StarButton,DeleteMessageButton,ConfirmDeleteDialog}.tsx` (NEW), `apps/web/src/components/ui/AlertDialog.tsx` (NEW primitive), `apps/web/src/features/mailbox/InboxListPage.tsx` (row actions), `apps/web/src/features/mailbox/{StarButton,DeleteMessageButton,InboxListPage}.test.tsx` |

### Binding gates (carried findings — a reviewer blocks on any of these)

1. **Composite-key UPSERT** (Slice 1 review, sec M2): `deleteMessageForUser`'s UPSERT targets `ON CONFLICT(mailbox_message_id, user_id)` post-0017, preserving `is_read`/`read_at` on conflict (DO UPDATE SET lists only `is_deleted`, `deleted_at`, `updated_at`).
2. **`mailboxListResponseSchema` promotion** (Slice 1 review, arch MEDIUM — "before Slice 3 lands"): the local zod schema moves from `mailbox-queries.ts:45-70` to `packages/contracts`, exported as `mailboxListResponseSchema` + `MailboxListItem`; contracts `index.test.ts` covers it; the web imports it and the local copy is deleted. `fetchMailboxList`'s parsing behavior is unchanged.
3. **Route authz + idempotency helper extraction** (Slice 2 review, arch L4): star and delete are the 6th and 7th copies of the markRead stanza. Extract within `messages.ts` (no new module): a context helper (userId 401 + `checkPermission('role.manage')` + `assertCan(..., 'read', ...)` on the path mailboxId) and the idempotency replay/record/race stanza, then apply to all message routes in the file. Behavior of the existing routes is unchanged — extraction is a refactor in the same commit, proven by the existing tests passing untouched.
4. **Permission surface** (D-CAP-043-H): both routes use `requirePermission('message.read')` + `assertCan('read')`.
5. **Star repository semantics** (D-CAP-043-A): single atomic `UPDATE mailbox_messages SET is_starred = NOT is_starred WHERE mailbox_id = ? AND message_id = ? RETURNING is_starred` (D1 supports RETURNING); no row → null → route 404s. Concurrent toggles are last-write-wins, accepted under D-CAP-043-A.
6. **Delete returns 204** (D-CAP-043-E): empty body; idempotent replay returns the same 204 — the worker test proves replay of a 204 works end-to-end (same key+body → identical 204; different body → 409).
7. **No `deleteMessageResponseSchema`** — the vertical-slice plan line is superseded by D-CAP-043-E (204 has no body). Only `toggleStarResponseSchema` (`{ data: { id, isStarred } }`) is added.
8. **Web actions live in the inbox rows** (AC 16): `StarButton` optimistic toggle with rollback on failure; `DeleteMessageButton` → `ConfirmDeleteDialog` (`AlertDialog` composed from the existing `Alert`/`Button` primitives); on 204 the item is removed from the inbox infinite cache via structural `setQueryData` (no full invalidation). Detail-page actions ride with CAP-044 — `MessageDetailPage.tsx` is NOT in this slice's envelope.

### Test obligations (beyond AC 13–17)

Worker: star round-trip both directions with returned value; star visible to the second member (mailbox-level, AC 17); delete hides from A but not B (AC 17, seeded rows per F4 convention); delete of absent/cross-mailbox message → 404 no-leak shape; idempotency replay matrix on both routes (same key+body → identical response incl. 204; different body → 409); the post-extraction suite passes unchanged. Web: optimistic star flip + rollback on API failure; dialog open → cancel (no request) → confirm (DELETE fires, row leaves the list cache); mailbox-list address lookup still green after the schema promotion.

## Slice 3 review outcome → fix pass

Reviews returned (all five in parallel on the uncommitted Slice 3 tree): security **ACCEPT-WITH-FOLLOWUPS** · architecture **ACCEPT-WITH-FOLLOWUPS** · QA **ACCEPT-WITH-FOLLOWUPS** · frontend **ACCEPT-WITH-FOLLOWUPS** · code **ACCEPT-WITH-FOLLOWUPS** — zero BLOCKER and zero HIGH across the round. Consolidated record: `work/reviews/CAP-043-slice3-review.md`. The orchestrator independently confirmed the H1 mechanics (toggle and record are separate statements in `messages.ts:438→452`), the H3 platform defect (`platform/idempotency.ts:235-240`), and the H8 dialog-closes-before-mutate behavior before writing this contract.

**New decision — D-CAP-043-I (audit boundary for message presentation state):** `message.star_toggled` and `message.soft_deleted` join the closed `AuditAction` enum, and both routes fold an `audit_events` INSERT into the same D1 batch as the business write + idempotency record (R-AUDIT-001, CAP-040 `AuditEventWriter` seam — the `webhooks.ts` fold). `markMessageAsRead` is exempt: a per-user read flag is presentation state, not a resource state transition, and per-open audit rows would grow `audit_events` without forensic value. D-CAP-043-H was challenged and upheld — star/delete stay on the read surface; `message.delete` remains reserved for hard delete.

### Fix-pass acceptance criteria (H1–H14)

- [x] H1. **Star toggle becomes batch-atomic** (sec M1 + code M1 — the toggle runs, then the record INSERTs separately; the ApiClient mints the Idempotency-Key once and reuses it across 5xx/429 retries, so a crash gap or same-key race re-executes a non-re-runnable `NOT is_starred`: one click, two state changes, exactly what R-API-004 forbids). `toggleMessageStar` is replaced by `getMessageStarState(db, mailboxId, messageId): Promise<boolean | null>` (read; null → route 404) and `prepareSetMessageStar(db, mailboxId, messageId, target): D1PreparedStatement` (`UPDATE mailbox_messages SET is_starred = ? WHERE mailbox_id = ? AND message_id = ?`). The route reads the current flag, computes `target = !current`, builds `successBody` from the KNOWN target — a batched `UPDATE … RETURNING` cannot feed the record's `responseJson` because statement values bind at prepare time, hence read-compute-write — then runs ONE `db.batch([setStar, record(200, successBody), audit])` (H4). On `isIdempotencyUniqueViolation` the whole batch has rolled back; the catch calls platform `replayAfterRace` (H3). The read→batch window for DIFFERENT-key concurrent toggles stays last-write-wins (gate 5 / D-CAP-043-A). Worker test (interleaving-independent): `Promise.all` of two same-key star toggles → both responses identical AND `mailbox_messages.is_starred` equals the response value (under the old non-batched code the DB could disagree with the response).
- [x] H2. **Soft delete becomes batch-atomic.** `deleteMessageForUser` is replaced by `prepareSoftDeleteMessageForUser(db, mailboxId, messageId, userId): Promise<D1PreparedStatement | null>` (internal existence SELECT → null, else the post-0017 composite-key UPSERT preserving `is_read`/`read_at`). Route: null → 404; else ONE `db.batch([upsert, record(204, ''), audit])`; UNIQUE race → `replayAfterRace`; success → `new Response(null, { status: 204 })`. The 204/`''` response is deterministic, so no read-compute-write is needed here.
- [x] H3. **Platform 204 replay fix + collapse of the parallel replay implementations** (sec M1 / code M3 / arch M-1 — one fact, one home). `platform/idempotency.ts` `replayResponse` passes `record.responseJson === '' ? null : record.responseJson` to the Response constructor (fetch spec: a non-null body on a null-body status throws — D-CAP-043-E); a unit test proves a stored 204 replays without throwing. `messages.ts` then deletes BOTH local helpers — `replayStoredResponse` and `settleIdempotentOperation` (including its mis-stated "every write here is naturally re-runnable" comment): the begin-path replays via platform `replayResponse`; the star/delete race catch calls platform `replayAfterRace` (which already owns the re-read + vanished-winner `IDEMPOTENCY_CONFLICT` 409); markRead settles via platform `writeIdempotencyRecord` (best-effort mode, documented as such — re-marking a read message is a no-op, the only remaining legitimate best-effort write in this file).
- [x] H4. **Audit rows for star and soft delete** (sec M2 + D-CAP-043-I). `AuditAction` gains `message.star_toggled` and `message.soft_deleted` (`contracts/src/admin/audit.ts`; enum coverage in `contracts/src/index.test.ts`). Both routes build the statement via `buildAppContext(c.env).auditEventWriter.prepare({ id: systemIds.uuid(), actorUserId: userId, action, resourceType: 'message', resourceId: messageId, requestId, metadata: { mailboxId, … }, createdAt: systemClock.now() })` — exactly the `webhooks.ts` fold — and include it in the H1/H2 batches. Worker test: each operation leaves exactly one `audit_events` row (actor, action, resource id); a replayed idempotent request adds none.
- [x] H5. **Timestamp normalization** (arch M-2 + code L2). `markMessageAsRead` and the soft-delete UPSERT write `sqliteTimestamp(systemClock.now())` ('YYYY-MM-DD HH:MM:SS') instead of `new Date().toISOString()` — the same-column format mixing that `platform/idempotency.ts` documents as a silent correctness bug the moment any SQL predicate compares these columns as TEXT.
- [x] H6. **Route-layer hygiene** (code L1). The list route uses `const userId = await requireMailboxReadAccess(c, mailboxId)` and passes it down — no `c.get('userId') as string` cast. The markRead handler's inline `SELECT id FROM mailbox_messages …` moves into the module (e.g. `markMessageAsRead` takes `(mailboxId, messageId, userId)` and resolves the row itself, returning a found signal — implementer's choice of shape, but no raw SQL remains in routes). Trailing newlines added where missing (`mailbox-queries.ts`, `InboxListPage.test.tsx`, `message-read-repository.ts`).
- [x] H7. **Row-scoped star rollback** (code M2 — whole-snapshot restore can resurrect state: star A then star B, both fail → B's snapshot restore re-applies A's failed flip; star X then delete X succeeds → the star's late failure restores the deleted row into the list). `onError` replaces the snapshot restore with a functional `setQueryData` that flips ONLY `input.messageId`'s `isStarred` back; the `previousInbox` snapshot and its context payload go away (the awaited `cancelQueries` stays). Web tests for both scenarios above: two-then-fail leaves both rows at pre-click values; a failed star after a successful delete leaves the row gone.
- [x] H8. **A failed delete is not user-silent after confirmation** (fe M3 + QA M2 — today `onConfirm` closes the dialog BEFORE mutating, so a 5xx leaves the row in place with only a `console.warn`). The dialog stays open on failure and shows the error inline (an `Alert` inside the dialog); it closes only on success. Implement via per-call callbacks on `mutate` (`onSuccess: close`, `onError: setError`) alongside the hook-level cache handlers; confirm disabled while pending. Web test: failing DELETE → dialog still open with the error visible, row still present, warn logged once; success → dialog closed, row gone.
- [x] H9. **Settle-race path proven** (QA M3 + code "not verified" — the UNIQUE-catch / re-read / replay branch has no test, and sequential `SELF.fetch` cannot hit it mid-flight). `Promise.all` of two same-key DELETEs against real bindings; assert interleaving-independent invariants: both responses 204, exactly ONE `idempotency_records` row, `message_user_state.is_deleted = 1`, exactly one audit row (after H2 the loser's batch rolls back, so the business write commits once under any interleaving).
- [x] H10. **Boundary + authz + seeding matrix** (QA M1 + QA L1/L2/L4). Worker: the cross-user delete test seeds state through the real route per the F4 convention (viewer marks read via `PATCH …/read` → owner deletes → viewer's row survives `is_read = 1, is_deleted = 0` and the message remains in the viewer's list); a second delete of the same message with a FRESH key returns 204 (idempotent no-op, not 404); a `member`-role viewer can star and soft-delete on the read surface (D-CAP-043-H) and an unauthenticated request 401s on both routes. Web: the row's StarButton `aria-pressed` reflects the server-confirmed value after the mutation settles (detail-page star display is out of scope — CAP-044).
- [x] H11. **Web cache hygiene** (code L3/L6 + QA L5). The delete mutation gains the awaited `cancelQueries` on the messages key (symmetry with star — an in-flight page fetch must not re-insert the deleted row). The `mailbox-queries.ts` header comment states the real key shape `['mailbox', 'messages', mailboxId]`. A web test proves `removeQueries` dropped the detail + thread entries after a successful delete.
- [x] H12. **Dialog semantics + markup validity** (fe M2 + fe L1/L5 + code L5). `AlertDialog` panel: `role="alertdialog"`, `aria-modal="true"`, an accessible name (string prop supplied by `ConfirmDeleteDialog`), Escape cancels, initial focus lands on the CANCEL button (the safe action). The delete trigger's accessible name includes the subject (`aria-label={'Delete message: ' + subject}`, falling back to `'Delete message'` when the subject is empty). No `<div>` inside `<span>`/`<p>` anywhere in the inbox row at any dialog state (row-actions container becomes a div if that is the minimal fix). Full focus-trap modal semantics stay deferred (arch L-4).
- [x] H13. **Storage guard extended** (fe M1 + the recorded Slice-1 follow-up "extend guard root when Slice 3 adds cache mutations" — Slice 3 added them). `auth-session-storage.test.ts` globs `../mailbox/**/*.{ts,tsx}` in addition to `./**/*.{ts,tsx}`; title and header comment describe both trees.
- [x] H14. Gates: `pnpm scaffold doctor` 13/13 · `pnpm typecheck` · `pnpm lint` · `pnpm test:unit` ≥ 692 + new (platform replay test, contracts enum coverage) · `pnpm test:worker` at the 690/694 baseline + new passing (only the 4 documented pre-existing D1-parallelism failures) · web mailbox tests green · `pnpm build` EXIT=0.

### Fix-pass file ownership (one implementer)

`apps/worker/src/http/routes/messages.ts` · `apps/worker/src/modules/messages/message-read-repository.ts` · `apps/worker/src/modules/messages/index.ts` (exports) · `apps/worker/src/platform/idempotency.ts` (+ its unit test file, extended per existing convention) · `apps/worker/src/http/routes/messages.worker.test.ts` · `packages/contracts/src/admin/audit.ts` · `packages/contracts/src/index.test.ts` · `apps/web/src/features/mailbox/mailbox-queries.ts` · `apps/web/src/features/mailbox/{DeleteMessageButton,ConfirmDeleteDialog}.tsx` · `apps/web/src/components/ui/AlertDialog.tsx` · `apps/web/src/features/mailbox/InboxListPage.tsx` (row-actions container only) · `apps/web/src/features/mailbox/{StarButton,DeleteMessageButton,InboxListPage}.test.tsx` · `apps/web/src/features/auth/auth-session-storage.test.ts` (glob extension only)

### Deferred to closure / follow-ups (recorded, not fixed now)

| Finding | Disposition |
|---|---|
| Per-user star (a viewer's star is every member's star) — inherent to D-CAP-043-A's mailbox-level flag | Ledger follow-up with the per-user-star migration |
| `THREAD_ROOT_SQL` per-row CASE scan (no serving index) | Ledger follow-up with the `thread_id` backfill (D-CAP-043-C) |
| `mailboxListItemSchema` `id`/`domainId`/`ownerUserId` stay `z.string()` (gate 2 mandated verbatim promotion) | Follow-up tightening to `uuidSchema` |
| No `.inbox-*` styles exist in tokens.css — the whole inbox is unstyled since Slice 1 | Styling pass follow-up (fe L2) |
| Sibling thread-cache stale flash on navigation | Self-corrects on navigation; accepted (fe L3) |
| AlertDialog full focus-trap / scroll-lock modal semantics | Beyond H12's minimal set (arch L-4) |
| `message-read-repository.ts` split decision | At closure (the file grows again with H1/H2) |
| `assertCan` 404-vs-403 deny-shape oracle | At closure |
| `MailboxListItem` re-export vs direct contracts import | At closure |
| Cursor payload binding to mailboxId/actor/TTL + `verifyCursor` format validation (carried from Slice 1) | Follow-up hardening |

## Open questions

None at contract time. The orchestrator will record new open questions here as the slices land.

## Slice dispatch plan

The orchestrator dispatches one slice at a time:

1. **Slice 1** (worker foundation + web inbox list) → 4-way parallel review → fix slice if needed → gate.
2. **Slice 2** (message detail + thread) → 4-way parallel review → fix slice if needed → gate.
3. **Slice 3** (star + delete) → 4-way parallel review → fix slice if needed → gate.
4. **Final closure** — orchestrator updates ledger + implementation log + archives `work/active/CAP-043-inbox-message-thread/` to `work/archive/2026-08/CAP-043/`. No commit without explicit user approval.

CAP-043 is **Implemented** at code-level when all three slices pass the six gates and reviewers return ACCEPT or ACCEPT-WITH-FIXES. **Verified** requires a preview-deployment end-to-end run (CAP-045).
