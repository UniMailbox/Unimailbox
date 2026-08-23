# CAP-043 Slice 1 — 5-way review round (2026-08-23)

Slice under review: cursor HMAC + per-user soft-delete + filtered inbox list (uncommitted working tree on `claude/cap-042-better-auth-integration-c47133`, after `9c6cc99`). All five reviewers ran in parallel against the same dirty tree. Consolidated verdict: **fix pass required** (contracted in `work/active/CAP-043-inbox-message-thread/task.md` §"Slice 1 review outcome → fix pass", criteria F1–F10).

| Reviewer | Verdict |
|---|---|
| architecture | ACCEPT-WITH-FOLLOWUPS |
| code | ACCEPT-WITH-FOLLOWUPS |
| security | ACCEPT-WITH-FOLLOWUPS |
| frontend | REJECT |
| QA | ACCEPT (all 11 ACs verified with test evidence) |

## Findings rolled into the fix pass

### Code H1 ≡ Security M2 ≡ Architecture HIGH-adjacent — `message_user_state` single-column PK (root cause, orchestrator-confirmed)

- `apps/worker/src/database/schema/messages.ts:113-129` + `migrations/0006_messages.sql:76-83`: PK on `mailbox_message_id` alone.
- `apps/worker/src/modules/messages/message-read-repository.ts:369-394`: `markMessageAsRead` UPSERTs `ON CONFLICT(mailbox_message_id)` and never rewrites `user_id` → the second reader of a shared message never gets their own row; their per-user `isRead` resolves to 0 forever (pre-existing CAP-022 defect).
- D-CAP-043-B (per-user `is_deleted`) is unimplementable on this PK — Slice 3's DELETE would clobber the other member's row. The security reviewer's writer-side patch (re-assert `user_id = excluded.user_id`) was **rejected** — it only changes whose state is destroyed.
- **Fix**: migration 0017 rebuilds the table with `PRIMARY KEY (mailbox_message_id, user_id)`; lossless (old PK precludes duplicates). → D-CAP-043-F, F1–F4.

### Architecture HIGH — Drizzle drift

`apps/worker/src/database/schema/messages.ts` never mirrored 0016's `is_deleted`/`deleted_at` columns + index. → F2.

### Frontend HIGH ×3

1. `MailboxListPage.tsx:30-79` — missing D-CAP-041-9 `<Unauthorized variant="expired" />` fallback; null descriptor renders the misleading empty state. → F5.
2. `InboxListPage.tsx:44-48,53-55` — null descriptor double-handled (renders Unauthorized AND `useEffect`-navigates to `/login`). → F6.
3. `MailboxListPage.test.tsx:165-191` — unauthorized test asserts only `expect(router).toBeDefined()` (tautology); this is why finding 1 went undetected. → F5.

### Security MEDIUM ×2

1. `platform/config.ts:44,152-168` — `PlatformConfig.cursorSigningKey` empty-string stub invites HMAC over `""` by a future caller. Only valid path is `parseCursorSigningKey(env)`. → F8.
2. Slice 3 UPSERT hazard — subsumed by the 0017 composite PK; recorded as a binding Slice 3 gate.

### Code MEDIUM ×3

1. `mailbox-queries.ts:117` comment references non-existent `INBOX_INVALID_CURSOR_REFETCH`. → F8.
2. Dead `encodeCursor` alias (`message-read-repository.ts:136-138`, re-exported at `modules/messages/index.ts:36`); task.md AC #3 also drifted (`decodeCursor` never existed — since corrected). → F8.
3. Rule of Three: `platform/cursor.ts` has one concrete caller. Accepted under the contract's CAP-034 pre-allocation → recorded as D-CAP-043-G.

### Frontend MEDIUM ×2

1. `InboxListPage.test.tsx:124-137` — loading-skeleton test passes via the error branch (`skeleton !== null || errorView !== null`). → F7.
2. `InboxError.tsx:26` — copy says "The mailbox list is unavailable" on the inbox surface. → F8.

### Architecture MEDIUM ×2

1. `mailbox-queries.ts:38-50` — `mailboxListResponseSchema` should live in `packages/contracts`. Deferred: before Slice 3.
2. `0016_*.verify.sql:42-61` — CHECK probe never executes its failing INSERT. → F10 (also Security LOW).

### LOWs (fix-pass F8 or deferred — see task.md registry)

- `verifyCursor` redundant `as BufferSource` casts (→ F8); `useInfiniteQuery` five positional generics (→ F8); Card title raw mailbox UUID (Slice 2); `MailboxListRow` button-vs-`<Link>` (follow-up); cursor payload not bound to mailboxId/actor/TTL (Slice 2+); `verifyCursor` payload format validation (follow-up); `CursorInvalidError` module-local (accepted, no action); verify comment citing nonexistent `.changes` semantics (fix in passing).

## QA verification highlights (all PASS)

- AC 1–8, 18–20 verified with file:line evidence; `pnpm scaffold doctor` 13/13; typecheck/lint clean; worker tests 661/665 (4 known pre-existing D1-parallelism); `pnpm build` + wrangler dry-run shows `CURSOR_SIGNING_KEY` as an independent Secrets Store binding (D-CAP-043-D confirmed).
- Note: QA's AC-4 PASS rested on a test that seeds only ONE user's row — valid under the old PK but not proof of per-user coexistence. F4 strengthens the seed to both users post-0017.

## Process notes

- The architecture reviewer stalled twice (API error, then stream watchdog) but delivered a complete final verdict before termination; its findings are incorporated above.
- The code reviewer's first two result messages were truncated to counts; a resume produced the full H1/M1–M3/L1–L3 text.
- The frontend REJECT and QA ACCEPT tension resolved on inspection: QA anchored on `InboxListPage.test.tsx` (real coverage); the frontend HIGHs are in `MailboxListPage` + its test, which QA spot-checked only for AC 7.
