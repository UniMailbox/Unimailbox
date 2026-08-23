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

- [ ] 9. `apps/worker/src/modules/messages/message-read-repository.ts` exports `getMessageThread(db, mailboxId, messageId)` returning the same-thread messages for the mailbox, ordered oldest-first. The thread root is computed as the first non-empty of: `messages.thread_id`, the first `<…>` from `messages.references_header`, `messages.in_reply_to_header`, the message's own `message_id_header` (singleton).
- [ ] 10. `GET /api/v1/mailboxes/:mailboxId/messages/:messageId/thread` returns `{ data: { rootId, items: MessageListItem[] } }` with the items ordered oldest-first; non-existent message → `404 MESSAGE_NOT_FOUND`; cross-mailbox message → `404` (no leak).
- [ ] 11. Web: `/mailbox/:mailboxId/messages/:messageId` renders the message detail (text body, from, to, cc, subject, date, headers collapsed by default), and a thread panel listing all messages in the thread with the active one highlighted and clickable navigation.
- [ ] 12. Opening a message detail fires `PATCH .../read` once (idempotent, no second fetch on re-render); unread → read transition updates the inbox list cache for that entry.

### Slice 3 — Star + delete

- [ ] 13. `apps/worker/src/modules/messages/message-read-repository.ts` exports `toggleMessageStar(db, mailboxId, messageId)` and `deleteMessageForUser(db, mailboxId, messageId, userId)`. Star toggles `mailbox_messages.is_starred` (mailbox-level — see `D-CAP-043-A`); delete is per-user via `message_user_state.is_deleted` + `deleted_at`.
- [ ] 14. `PATCH /api/v1/mailboxes/:mailboxId/messages/:messageId/star` requires `Idempotency-Key`; replays return the same response. Returns `{ data: { id, isStarred } }`.
- [ ] 15. `DELETE /api/v1/mailboxes/:mailboxId/messages/:messageId` requires `Idempotency-Key`; returns `204` on success; replays return the same `204`. The per-user row write is a single UPSERT on `message_user_state` so the operation is atomic.
- [ ] 16. Web: star button toggles optimistic state; delete button opens an `AlertDialog` confirmation, then removes the message from the inbox list cache (`setQueryData` slice, not full invalidation).
- [ ] 17. Star / delete state survive a route refresh; star is mailbox-level (any member sees the same star), delete is per-user (user A's delete does not hide the message from user B).

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

- [ ] repository — `apps/worker/src/modules/messages/message-read-repository.ts` (getMessageThread)
- [ ] contract schema — `packages/contracts/src/index.ts` (messageThreadResponseSchema)
- [ ] route — `apps/worker/src/http/routes/messages.ts` (GET .../thread)
- [ ] client — `apps/web/src/features/mailbox/{MessageDetailPage,MessageThreadPanel,MessageDetailSkeleton}.tsx` (NEW)
- [ ] tests — `apps/worker/src/http/routes/messages.worker.test.ts` (thread tests), `apps/web/src/features/mailbox/MessageDetailPage.test.tsx` (NEW)

### Slice 3

- [ ] repository — `apps/worker/src/modules/messages/message-read-repository.ts` (toggleMessageStar + deleteMessageForUser)
- [ ] contract schema — `packages/contracts/src/index.ts` (toggleStarResponseSchema, deleteMessageResponseSchema)
- [ ] route — `apps/worker/src/http/routes/messages.ts` (PATCH .../star, DELETE .../messages/:id)
- [ ] client — `apps/web/src/features/mailbox/{StarButton,DeleteMessageButton,ConfirmDeleteDialog}.tsx` (NEW), `apps/web/src/components/ui/AlertDialog.tsx` (NEW if not present)
- [ ] tests — `apps/worker/src/http/routes/messages.worker.test.ts` (star/delete tests), `apps/web/src/features/mailbox/{StarButton,DeleteMessageButton}.test.tsx` (NEW)

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
| `implementer-slice-2` | Slice 2 | `apps/worker/src/modules/messages/message-read-repository.ts`, `apps/worker/src/http/routes/messages.ts`, `packages/contracts/src/index.ts`, `apps/web/src/features/mailbox/{MessageDetailPage,MessageThreadPanel,MessageDetailSkeleton}.tsx`, `apps/web/src/features/mailbox/MessageDetailPage.test.tsx` |
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

## Open questions

None at contract time. The orchestrator will record new open questions here as the slices land.

## Slice dispatch plan

The orchestrator dispatches one slice at a time:

1. **Slice 1** (worker foundation + web inbox list) → 4-way parallel review → fix slice if needed → gate.
2. **Slice 2** (message detail + thread) → 4-way parallel review → fix slice if needed → gate.
3. **Slice 3** (star + delete) → 4-way parallel review → fix slice if needed → gate.
4. **Final closure** — orchestrator updates ledger + implementation log + archives `work/active/CAP-043-inbox-message-thread/` to `work/archive/2026-08/CAP-043/`. No commit without explicit user approval.

CAP-043 is **Implemented** at code-level when all three slices pass the six gates and reviewers return ACCEPT or ACCEPT-WITH-FIXES. **Verified** requires a preview-deployment end-to-end run (CAP-045).
