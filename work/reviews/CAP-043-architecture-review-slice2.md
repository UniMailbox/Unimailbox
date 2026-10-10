# CAP-043 — Architecture Review (Slice 2: message detail + thread, AC 9–12)

**Reviewer:** `.claude/agents/architecture-reviewer.md` · **Date:** 2026-08-23 · **Base:** working tree vs `422b4ab` (`feat(CAP-043): Slice 1 + fix pass`)

**Status:** ACCEPT WITH FOLLOWUPS

## Summary

Architecturally clean slice. All ten hard checks pass: dependency direction (repository imports only `platform/*`), module privacy (route imports via `modules/messages/index.ts` only), route shape and authz mirroring of the detail route, contracts reuse of `messageListItemSchema` (no forked shape), D-CAP-043-C priority order in a single `THREAD_ROOT_SQL` constant with `CURRENT_SCHEMA_VERSION` still `'0017'` and no new migration, plain-array thread (no offset pagination), identical 404 envelopes for non-existent vs cross-mailbox, `beforeLoad` routing per D-CAP-041-1, TanStack-Query-only web state with a targeted `setQueryData` write, and messages-only table ownership. The one finding that matters: Slice 2 introduces a soft-delete read-semantics divergence between `getMessageDetail` (200 for a soft-deleted-for-caller anchor) and `getMessageThread` (404), on the same page — resolve before CAP-043 closes.

## BLOCKER

None. Dependency direction, module boundaries, layer discipline, persistence ownership, and the forbidden-import list were traced file by file; no violations.

## HIGH

None. No unauthorized module edge, no Hono/Env/provider SDK import in a module, no Drizzle row type crossing a boundary (the exported `MessageThread` is a hand-written DTO, same pattern as the pre-existing `MessageListItem`/`MessageDetail`), no JSON-in-text column, no second source of authorization truth (route does `requirePermission` + `assertCan` on the path `mailboxId`).

## MEDIUM

### M1 — Soft-delete read semantics diverge across the messages read surface: detail 200 vs thread 404 for the same anchor and user

- **Where:** `apps/worker/src/modules/messages/message-read-repository.ts:344-356` (`getMessageDetail` WHERE clause lacks the filter) vs the new `getMessageThread` anchor/items filters (`~lines 415-470`, which apply `COALESCE(mus.is_deleted, 0) = 0`)
- **Violates:** `R-MESSAGE-005` consistency — D-CAP-043-B states a soft-deleted message is "gone for that user"; the inbox list (Slice 1) and the thread (Slice 2) implement that, the detail surface does not.
- **Failure scenario:** After Slice 3 ships delete, user A soft-deletes message M. A later open of `/mailbox/:mailboxId/messages/:M` (stale inbox tab, history, bookmark) renders the detail body with HTTP 200 while the thread panel on the same page errors `404 MESSAGE_NOT_FOUND` — a half-broken page, and the detail endpoint hands back a message that is supposed to be gone for that user.
- **Fix:** Add the same `LEFT JOIN message_user_state … COALESCE(mus.is_deleted, 0) = 0` predicate to `getMessageDetail`. Same file Slice 3 already owns (`message-read-repository.ts`), so bind the fix to Slice 3's envelope — or, if detail is deliberately meant to survive soft-delete, record that as a D-CAP-043 decision instead of leaving it implicit.

## LOW

### L1 — Ratified out-of-envelope file `packages/contracts/src/index.test.ts` missing from the persisted ownership amendment

- **Where:** `work/active/CAP-043-inbox-message-thread/task.md:146` — the amendment lists `router.tsx`, `mailbox-queries.ts`, `InboxListPage.tsx` only.
- **Violates:** `.claude/rules/agent-collaboration.md` §No hidden decisions / §File ownership — a ratification that exists only in the dispatch conversation does not exist.
- **Failure scenario:** A future auditor reconciling diff vs task.md finds a changed file with no declared owner — exactly the state drift the ownership table prevents.
- **Fix:** One-line amendment adding `packages/contracts/src/index.test.ts` to Slice 2's ownership.

### L2 — Thread response is unbounded (no LIMIT on the candidate query)

- **Where:** `apps/worker/src/modules/messages/message-read-repository.ts:449-468`
- **Violates:** Nothing — AC 10 ratifies a plain array. Design-margin note.
- **Failure scenario:** A pathological thread returns every same-root message in one response; the sibling list endpoint caps at 50.
- **Fix:** Follow-up: cap thread items (or record the accepted bound) once a real thread corpus exists.

### L3 — `THREAD_ROOT_SQL` in the WHERE clause is a per-row CASE scan; no index can serve it

- **Where:** `apps/worker/src/modules/messages/message-read-repository.ts:124-155`, `458-462`
- **Violates:** Nothing — D-CAP-043-C explicitly ratifies read-time resolution with a planned `thread_id` backfill as the eventual fix.
- **Failure scenario:** A mailbox with tens of thousands of messages evaluates the CASE for every row on each thread fetch.
- **Fix:** None now. Keep the D-CAP-043-C `thread_id` backfill follow-up tracked in the ledger at CAP-043 closure.

### L4 — Fourth copy of the ~15-line route authz preamble added; Slice 3 makes six

- **Where:** `apps/worker/src/http/routes/messages.ts:170-198` (userId 401 check + `checkPermission('role.manage')` + `assertCan`)
- **Violates:** Nothing yet — mirroring the detail route was the explicit instruction. `.claude/rules/coding.md` §Abstraction discipline (Rule of Three) becomes applicable when Slice 3 adds star/delete.
- **Failure scenario:** A future route copies the block and drops the `assertCan` line; the duplication is where an authz omission breeds.
- **Fix:** Consider a shared mailbox-read middleware/helper during Slice 3's edit of the same file.

## Not verified

- Test execution not rerun by this reviewer (read-only review; the orchestrator runs the gates). The 8 new worker tests and 8 web tests were read and map to AC 9–12, including the no-leak 404 shape assertion and per-user isRead/soft-delete cases.
- Runtime performance of the CASE-based thread scan under load (L3) — stated from query shape, not measured.

## Required fixes

1. M1 — align `getMessageDetail` with the soft-delete filter (bind to Slice 3's envelope) or record the divergence as a D-CAP-043 decision.
2. L1 — add `packages/contracts/src/index.test.ts` to the persisted Slice 2 ownership amendment.
