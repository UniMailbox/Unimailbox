# CAP-043 Slice 3 — 5-way review round (2026-08-24)

Slice under review: star + per-user soft delete (AC 13–17) — uncommitted working tree on `claude/cap-042-better-auth-integration-c47133` after `e81e233` (Slice 2). All five reviewers ran in parallel against the same dirty tree. Consolidated verdict: **fix pass required** — contracted in `work/active/CAP-043-inbox-message-thread/task.md` §"Slice 3 review outcome → fix pass" (criteria H1–H14). Zero BLOCKER and zero HIGH across the round; every verdict was ACCEPT-WITH-FOLLOWUPS.

| Reviewer | Verdict | Full report |
|---|---|---|
| security | ACCEPT-WITH-FOLLOWUPS | final message only; consolidated below |
| architecture | ACCEPT-WITH-FOLLOWUPS | final message only; consolidated below |
| QA | ACCEPT-WITH-FOLLOWUPS | final message only; consolidated below |
| frontend | ACCEPT-WITH-FOLLOWUPS | final message only; consolidated below |
| code | ACCEPT-WITH-FOLLOWUPS | final message only; consolidated below |

All five independently verified the eight binding gates from the dispatch contract (composite-key UPSERT preserving `is_read`/`read_at`, contracts schema promotion with the local copy deleted, helper extraction, read-surface permission per D-CAP-043-H — challenged and upheld, single-statement star semantics per gate 5, 204 + replay-of-204, no delete response schema, inbox-row actions with detail page untouched). QA verified AC 13–17 with evidence: both-direction toggle vs DB truth, mailbox-level visibility, 404 no-leak envelope identity, IDOR, missing-key 400, replay-of-204 with `deleted_at` unchanged and one record, 409 hash mismatch, optimistic flip + rollback, dialog cancel/confirm.

Reporting-accuracy note (orchestrator validation): the implementer's self-report inflated new-test counts — claimed 16 new contracts tests (13 actual) and 8 new web tests (7 actual); the 14-worker-test claim was exact. Suites pass; counts corrected at validation. Reinforces the validate-everything rule.

## Findings rolled into the fix pass (H1–H14)

### Security M1 ≡ Code M1 — star toggle is a non-re-runnable write under best-effort idempotency → H1 (+ H2 for delete, H3 for the platform collapse)

The toggle and the idempotency record are separate statements (`messages.ts:438` then `:452`). The code reviewer supplied the decisive evidence that same-key collision is realistic, not theoretical: the ApiClient builds its headers once outside the retry loop, so 5xx/429 retries reuse the SAME minted Idempotency-Key. Failure scenarios: crash gap → retry re-executes `NOT is_starred` (one click, two state changes); same-key race → both execute the toggle (net: back to start), the loser replays the winner's value, both clients render the winner's claim while the DB disagrees — and nothing refetches (structural `setQueryData` only). The code reviewer also caught the `settleIdempotentOperation` doc comment claiming "every write here is naturally re-runnable" — false for a toggle. **Orchestrator design decision (recorded in the H1 criterion):** a batched `UPDATE … RETURNING` cannot feed the record's `responseJson` (statement values bind at prepare time), so the fix is read-compute-write — read the flag, compute the target, then ONE `db.batch([UPDATE with the computed target, record, audit])`. The read→batch window for different-key concurrent toggles remains last-write-wins (gate 5 / D-CAP-043-A).

### Security M2 → H4 + D-CAP-043-I — no audit rows for star or soft delete

`audit_events` gains `message.star_toggled` and `message.soft_deleted`, folded into the same D1 batch as the business write via the CAP-040 `AuditEventWriter` seam (the `webhooks.ts` pattern). `markRead` is exempt — recorded as D-CAP-043-I: a per-user read flag is presentation state, not a resource state transition; per-open audit rows would grow the table without forensic value.

### Code M2 — whole-snapshot rollback can resurrect state → H7

The star mutation's `onError` restores the entire `onMutate` snapshot. Concrete failures: (A) star row A then row B, both requests fail → B's snapshot (which contains A's optimistic flip) restores over A's correct rollback; (B) star X then delete X succeeds → the star's late failure restores the soft-deleted row into the list. Both persist until navigation (`refetchOnWindowFocus: false`). This supersedes the orchestrator's initial "accept the tradeoff" adjudication — the reviewer's scenarios convinced otherwise. Fix: row-scoped inverse flip of `input.messageId` only.

### Code M3 ≡ Architecture M-1 — platform `replayResponse` throws on a stored 204; three parallel replay implementations → H3

`platform/idempotency.ts:235-240` builds `new Response(record.responseJson, …)` unconditionally; a stored 204 carries `responseJson = ''` and the fetch spec rejects a non-null body on a null-body status. The route-local `replayStoredResponse` workaround is correct and complete for today's callers (DELETE /messages is the only 204-storing route), but the platform defect stays live for the next 204-returning route, and the workaround existed only in the implementer's report — a hidden decision. Fix: guard in `replayResponse` + unit test, then collapse — delete both local helpers; begin-path replays via platform `replayResponse`, star/delete race catches call platform `replayAfterRace` (which already owns the vanished-winner `IDEMPOTENCY_CONFLICT` 409), markRead settles via platform `writeIdempotencyRecord`.

### QA M1 — cross-user delete test seeds state directly, not through the route → H10

The AC-17 delete-isolation test inserts `message_user_state` rows by hand; the F4 convention (established in the Slice 1 fix pass) seeds through the real route. Fix test: viewer marks read via `PATCH …/read` → owner deletes → viewer's row survives `is_read = 1, is_deleted = 0`, message present in the viewer's list.

### QA M2 ≡ Frontend M3 — a confirmed delete that fails is user-silent → H8

`onConfirm` closes the dialog BEFORE the mutation fires; a 5xx leaves the row in place with only a `console.warn`. The user's confirmed intent silently disappears. Fix: the dialog stays open on failure with the error shown inline; closes only on success.

### QA M3 + Code "not verified" — the settle-race branch is unproven → H9

The UNIQUE-violation catch (re-read winner / vanished-winner 409) has no direct test; the existing race test pre-inserts the winner, exercising the begin-path replay instead. Sequential `SELF.fetch` cannot hit the catch mid-flight. Fix: `Promise.all` of two same-key DELETEs asserting interleaving-independent invariants (both 204, one record, `is_deleted = 1`, one audit row).

### Architecture M-2 ≡ Code L2 — ISO-8601 timestamps into SQLite TEXT columns → H5

`new Date().toISOString()` at `message-read-repository.ts:587` and `:684` while the column default is `datetime('now')` format — the same-column format mixing `platform/idempotency.ts` documents as a silent correctness bug. Normalize via `sqliteTimestamp(systemClock.now())`.

### Code L1 — list route discards the authz helper's return and re-casts the context → H6

`c.get('userId') as string` at `messages.ts:257` defeats the helper's proof of the userId; a future middleware change compiles clean and silently binds `undefined` into the per-user LEFT JOIN. The markRead handler's inline `SELECT` also belongs in the module.

### Code L3 + L6 + QA L5 — web cache hygiene → H11

Delete mutation lacks the star mutation's awaited `cancelQueries`; the header comment mis-states the cache key shape (`['mailbox', mailboxId, 'messages']` vs the actual `['mailbox', 'messages', mailboxId]`); no test proves `removeQueries` dropped the detail + thread entries.

### Frontend M2 + Frontend L1/L5 + Code L5 — dialog semantics and markup validity → H12

The AlertDialog panel has no `role`, no accessible name, no Escape handling, and no initial focus; the delete trigger's accessible name is a bare "Delete"; the row's action container nests `<div>` inside `<span>`. Fix set is minimal (role/aria/Escape/focus-to-Cancel); full focus-trap modal semantics stay deferred.

### Frontend M1 — storage guard not extended → H13

The recorded Slice-1 follow-up said to extend the AC-21 storage guard "when Slice 3 adds cache mutations"; Slice 3 added them and the guard still scans only `features/auth/**`. Extend the glob to `../mailbox/**`.

### Remaining LOWs → H10 (QA L1 fresh-key re-delete 204, QA L2 viewer-role + 401 matrix, QA L4 settled star state on the row)

## Deferred (recorded in task.md §"Slice 3 … Deferred to closure / follow-ups")

Per-user star migration (D-CAP-043-A) · `THREAD_ROOT_SQL` CASE scan with the `thread_id` backfill (D-CAP-043-C) · `mailboxListItemSchema` uuid tightening (gate 2 mandated verbatim promotion) · tokens.css inbox styling pass (pre-existing since Slice 1) · sibling thread-cache stale flash (self-corrects) · AlertDialog focus-trap semantics · repository split decision (at closure) · `assertCan` 404-vs-403 oracle (at closure) · `MailboxListItem` re-export · cursor payload binding + `verifyCursor` format validation (carried from Slice 1).

## Fix pass outcome

**Complete — all fourteen criteria (H1–H14) implemented and validated.** Implementer
`implementer-slice3-fix` (2026-08-24); the orchestrator validated the diff file-by-file
against the criteria and ran the full six gates itself.

- **H1/H2 (worker)**: star is a read-compute-write batch — `getMessageStarState` → computed `target` → ONE `db.batch([prepareSetMessageStar, record(200, built-from-known-target), audit])`; delete is `prepareSoftDeleteMessageForUser` (null → 404 before any write) → ONE `db.batch([UPSERT, record(204, ''), audit])`. Both catches narrow on `isIdempotencyUniqueViolation` and replay via platform `replayAfterRace` (the loser's batch rolled back with the failed record INSERT). Bind orders verified against placeholder order; the UPSERT still conflicts on the post-0017 composite PK with `is_read`/`read_at` preserved.
- **H3**: platform `replayResponse` passes the stored empty body as `null` (unit test: stored 204 → `response.body` null, `.text()` `''`, no throw); both route-local helpers deleted; begin-path replays via `replayResponse`, markRead settles via `writeIdempotencyRecord` with the best-effort rationale documented in-code (D-CAP-043-I).
- **H4**: `message.star_toggled` + `message.soft_deleted` in the closed enum (+4 contracts tests); `prepareMessageAudit` folds the audit INSERT into both batches via the CAP-040 seam (webhooks.ts pattern); worker tests prove exactly one audit row per operation and none added on replay.
- **H5**: zero `new Date()`/`toISOString` left in `message-read-repository.ts` (grep-verified) — `sqliteTimestamp(systemClock.now())` throughout.
- **H6–H13 (web + hygiene)**: no `c.get('userId') as string` cast (helper's return used); markRead's row lookup lives in `markMessageAsRead(db, mailboxId, messageId, userId): Promise<boolean>`; star `onError` is a row-scoped functional inverse flip (snapshot deleted) with tests for both resurrection scenarios; the delete dialog stays open on failure with an inline error and closes only on success (per-call `mutate` callbacks, confirm disabled while pending); `Promise.all` same-key DELETE race test asserts both-204 / one-record / `is_deleted=1` / one-audit-row; the QA matrix landed (F4 route-seeded cross-user delete, fresh-key re-delete 204, viewer-role + 401, settled `aria-pressed`); delete `onMutate` awaits `cancelQueries`, key-shape comment corrected, `removeQueries` proven; AlertDialog gained `role="alertdialog"`/`aria-modal`/accessible name/Escape/initial-focus-on-Cancel and the trigger's accessible name carries the subject; the row-actions container became a `<div>` (no div-in-span); the storage guard now scans `features/mailbox/**` too.
- **H14 (gates, orchestrator-run)**: doctor 13/13 · typecheck clean · lint clean · unit **706/706** (692 baseline + 14 new: idempotency +1, contracts +4, StarButton +3, DeleteMessageButton +5, InboxListPage +1) · worker **698/702** (694 baseline + 8 new in messages.worker.test.ts; the 4 failures verified by name as exactly the documented pre-existing D1-parallelism set — `migrationsDb` R-DATA-004, `0015_credential_backfill` seeding, admin `seedRolesAndPermissions` ×2) · build EXIT=0 (`--dry-run` clean).

Recorded risk (implementer, accepted): the H1/H9 `Promise.all` race tests assert interleaving-independent invariants (identical responses, one record, one audit row, DB-vs-response agreement) rather than forcing the loser branch — a fully-serialized scheduling takes the begin-path replay and satisfies the same invariants; the batch-rollback branch is additionally exercised by the unique-violation shape. AlertDialog initial focus uses `autoFocus` (Button forwards no ref) — proven by `toHaveFocus` in happy-dom.

Verdict after fix pass: **Slice 3 accepted.** CAP-043 proceeds to closure with the deferred items recorded in task.md §"Slice 3 … Deferred to closure / follow-ups".
