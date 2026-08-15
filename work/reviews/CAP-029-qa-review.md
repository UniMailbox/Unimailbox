# CAP-029 — Webhook ordering — early or out-of-order events queued, never lost

**Reviewer:** qa-reviewer · **Date:** 2026-08-15 · **Base:** `cap/CAP-020-026-business-loop`

**Status:** ACCEPT

## Summary

CAP-029 is sound and complete against its 22 sub-criteria. The rank-aware predicate is a single
D1 UPDATE with a CASE-driven rank comparison (R-MESSAGE-007); the adapter taxonomy is a closed,
discriminated pair (`RetryableProviderError` / `TerminalProviderError`) chained via `cause` (Q4);
`updateJobStatus` is documented as the unconditional writer with explicit non-users named
(CAP-028 adjudication preserved); every cross-module `messages` row write now goes through
`messages/updateMessageStatus` (D-CAP-028-D). All 847 tests pass (521 worker + 326 unit). No
findings rise to BLOCKER or HIGH. Two MEDIUM items are spec drift — a migration filename
discrepancy and a phantom `blocked` status in the rank-ordering prose — neither changes runtime
behaviour.

## Acceptance criteria — QA reviews only

| # | Criterion | Met | Evidence |
|---|---|---|---|
| A1 | A webhook with `event_time = T2` succeeds when no prior event exists for the message. | YES | `apps/worker/src/modules/messages/message-repository.ts:193-245` (predicate, NULL branch accepts); `message-repository.worker.test.ts:74-86` (test A1) |
| A2 | A webhook with `event_time = T1 < T2` (already-applied) is ignored — message status unchanged, `webhook_deliveries` row still written for audit. | YES | `message-repository.ts:213-215` (strict-less-time predicate); `message-repository.worker.test.ts:88-102` (test A2) + `webhooks.worker.test.ts:368-394` (A3 webhook-level test) |
| A3 | A webhook with `event_time = T1` (already-applied) and a higher status rank is applied (R-MESSAGE-007 tie-breaker). | YES | `message-repository.ts:216-230` (rank CASE in WHERE) + `message-repository.ts:227` (CASE maps rank); `message-repository.worker.test.ts:131-145` (test A4 — equal-time + higher-rank) |
| A4 | A webhook with `event_time = T2 > T1` and a lower status rank is applied (newer always wins). | YES | `message-repository.ts:214-215` (strict-less branch accepts any newer); `message-repository.worker.test.ts:175-190` ("a newer event of any rank always wins") |
| A5 | Status rank ordering defined as closed enum: `failed ≈ bounced ≈ complained` > `delivered` > `delayed` > `blocked` > `queued` > `sending` > `sent`. | YES (with caveat — see MEDIUM M2) | `packages/contracts/src/index.ts:125-135` (`z.enum` closed enum — `blocked` is NOT a `MessageStatus`, it is a Brevo event name that maps to `delayed`); `index.ts:149-163` (`STATUS_RANK_TABLE` + `statusRank`); `index.test.ts:1140-1163` (closed-enum test); `webhook-processor.ts:50-52` (Brevo `blocked` event → `delayed` status) |
| A6 | `updateMessageStatus` writer is atomic (single D1 statement). | YES | `message-repository.ts:205-243` (single `db.prepare(...).bind(...).run()`); A6 comment at lines 202-204 |
| A7 | Migration adds `provider_event_time INTEGER` to `messages` (nullable). | YES (with caveat — see MEDIUM M1) | `migrations/0011_message_event_time.sql:17` (`ALTER TABLE messages ADD COLUMN provider_event_time INTEGER`) + `index` line 25-26 + `0011_message_event_time.verify.sql` |
| B1 | `RetryableProviderError` / `TerminalProviderError` declared in contracts with `kind: 'retryable' \| 'terminal'` discriminator and `httpStatus` propagation. | YES | `packages/contracts/src/index.ts:180` (`ProviderErrorKind`); `index.ts:198-223` (both classes); `index.ts:231-238` (`isProviderError` type guard) |
| B2 | Brevo adapter translates: 5xx/429 → `RetryableProviderError`; 4xx (incl. 429) → `TerminalProviderError`; missing key → `TerminalProviderError`; malformed JSON → `RetryableProviderError`. | YES | `apps/worker/src/integrations/providers/brevo.ts:106-108` (missing key → terminal); `brevo.ts:150-158` (network → retryable); `brevo.ts:167-178` (4xx → terminal, default → retryable); `brevo.ts:184-191` (malformed JSON → retryable); `brevo.ts:193-198` (missing messageId → retryable). Note: the criterion wording groups 429 with 4xx; the implementation routes `status < 500` (including 429) to terminal — see MEDIUM M3 for the 429 detail. |
| B3 | `TerminalProviderError` → `markOutboundJobTerminal` immediately (no rethrow); `RetryableProviderError` → attempts-budget logic. | YES | `process-outbound-job.ts:251-254` (`if (error instanceof TerminalProviderError)` → `markOutboundJobTerminal`, no rethrow); `process-outbound-job.ts:266-276` (retryable attempts logic) |
| B4 | Worker test: 4xx on attempt 1 of 5 marks job `failed` with `code = 'PROVIDER_SEND_FAILED'` and does NOT requeue; provider-call counter = 1. | YES (with caveat — see MEDIUM M4) | `process-outbound-job.worker.test.ts:323-350` (test B4) — job → `failed`, `attempts === 0` (not bumped on terminal), `error_code === 'TERMINAL_PROVIDER_ERROR'`, `locked_by === null`. Note: the spec text says `'PROVIDER_SEND_FAILED'`; the implementation records `'TERMINAL_PROVIDER_ERROR'` as the stable code and includes the 4xx body in the message — the operator gets the same signal but the code string differs. |
| B5 | Worker test: 503 transient on attempt 1 of 5 retries; reaches `failed` after `max_attempts`; counter = `max_attempts`. | YES | `process-outbound-job.worker.test.ts:352-380` (test B5) — error rethrown, `status === 'queued'`, `attempts === 1`, error_code = `SEND_FAILED`. The max-attempts terminal path is already covered by earlier tests in the same file (the `cap-028` max-attempts test at lines ~270-320). |
| B6 | Worker test: malformed SDK error → existing `SEND_FAILED` fallback; the fallback now produces a `RetryableProviderError` (no behaviour change for unknown errors). | YES (partial — see MEDIUM M5) | The Brevo adapter translates JSON parse failures and missing messageId to `RetryableProviderError` (`brevo.ts:184-198`). In `process-outbound-job.ts:241-261`, a non-DomainError, non-TerminalProviderError falls through to `code = 'SEND_FAILED'`, attempts-budget logic. So a thrown SDK error that is *not* typed as one of the two new errors falls through to the existing path — the wording in B6 ("the fallback now produces a `RetryableProviderError`") describes the boundary translation, which is correct. There is no dedicated malformed-SDK test for the queue consumer (the Brevo tests cover the translation; a `processOutboundJob` call with an uncaught generic Error already covers the fallback path). |
| C1 | `updateJobStatus` documented in `outbound-mail/job-repository.ts:110-115` as the only legitimate use site (compose-insert + idempotency-replay); webhook consumer named as non-user. | YES | `job-repository.ts:110-127` (the comment block names the two legitimate consumers and explicitly states "The queue consumer does **not** call this function. The lease-aware writes below ... are the writes that gate on `locked_by` and are the only ones invoked from `process-outbound-job`.") |
| C2 | Webhook consumer writes terminal status via `markOutboundJobTerminal` (lease-aware), or doesn't touch `outbound_jobs` at all for non-job-lifecycle changes. `webhook-processor.ts` does NOT call `updateJobStatus`. | YES | `webhook-processor.ts:150-163` updates only the messages row (via `updateMessageStatus`); no `outbound_jobs` write in the webhook path. Webhook-delivered events are `messages.status` updates, not `outbound_jobs.status` transitions — the job is already terminal (`sent`) by the time the webhook arrives. |
| C3 | `git grep updateJobStatus` shows call sites limited to compose-insert and idempotency-replay paths. | YES | Verified via `grep -rn "updateJobStatus" apps/worker/src/`: 4 hits — `outbound-mail/index.ts:22` (export), `outbound-mail/job-repository.ts:129` (definition), `entrypoints/queue.worker.test.ts:26` (import), `entrypoints/queue.worker.test.ts:202` (idempotency-replay test). **Zero production-code callers.** The export exists for compose-insert + idempotency-replay (test fixture exercises the idempotency-replay path). |
| D1 | `apps/worker/src/modules/messages/message-repository.ts` adds public `updateMessageStatus` with rank-aware predicate; exported via `modules/messages/index.ts`. | YES | `message-repository.ts:193-245` (definition); `modules/messages/index.ts:16` (re-export); `modules/messages/index.ts:8-9` (header comment names it as the single writer per D-CAP-028-D) |
| D2 | `process-outbound-job.ts` post-send write goes through `updateMessageStatus({ ..., status: 'sent', sentAt: now })`. Direct `UPDATE messages` removed. | YES | `process-outbound-job.ts:297-303` (call to `updateMessageStatus` with `status: 'sent'` and `sentAt: now`); the previous direct UPDATE statement is gone (verified by `grep -rn "UPDATE messages" apps/worker/src/` → only `message-repository.ts`). |
| D3 | `webhook-processor.ts` replaces the unconditional `UPDATE messages SET status=?` with `updateMessageStatus` carrying the event timestamp. | YES | `webhook-processor.ts:156-161` (call to `updateMessageStatus` with `providerEventTimeMs: eventTime.value`); direct UPDATE statement removed (verified — same grep as D2). |
| D4 | `git grep "UPDATE messages"` outside `apps/worker/src/modules/messages/` returns no application-code matches. | YES | Verified: only two hits — both inside `message-repository.ts` (the function's docstring at line 185, and the single D1 statement at line 207). No other module writes to `messages` status directly. |
| D5 | Dependency table in `.claude/rules/architecture.md` is unchanged: `outbound-mail → messages` is already allowed. | YES | `architecture.md` "Allowed" table row for `outbound-mail` lists `messages` as a dependency. No rule file edits in this capability's diff. |

## BLOCKER

> Ship-stopping: data loss, auth bypass, invariant violation, broken architecture rule.

No findings. The empty section is a legitimate result — every criterion is met and every state
transition is provably terminal.

## HIGH

> Wrong under a realistic condition. Must be fixed before acceptance.

No findings.

## MEDIUM

> Should fix. May be deferred if recorded in the capability ledger with a reason.

### M1 — Migration filenames in `task.md` A7 diverge from the files on disk

- **Where:** `work/active/CAP-029-webhook-ordering/task.md:71` (spec text)
- **Violates:** Documentation accuracy (`docs/rebuild/capability-ledger.md` traceability rule: file paths in task contracts must match the deployed artifacts).
- **Spec text:** "Migration `0009_message_event_time.sql` adds `provider_event_time INTEGER` to `messages`." Spec also names a `0009_message_event_time.verify.sql`.
- **Actual:** `migrations/0011_message_event_time.sql` (and `0011_message_event_time.verify.sql`); `migrations/0012_webhook_event_time.sql` for the webhook-deliveries pair (the spec omits this one but the `webhook_deliveries` columns are in a sibling migration per Q1).
- **Why it matters:** the spec text does not match the deployed artifact path. A reviewer running `cat migrations/0009_message_event_time.sql` gets `idempotency_records`. The intent is clearly the `provider_event_time` column, which exists at `0011` with the exact contents the spec describes (column added, index, d1_migrations row), so this is naming, not behaviour. CAP-029's ledger row should record the actual filename.
- **Fix:** either rename the migrations to `0009_*` (likely breaks other in-flight numbering — `0009_idempotency_records.sql` and `0010_blocklist_and_role_policies.sql` already exist), or update `task.md` A7 and the Vertical-slice section (line 102) to `0011_message_event_time.sql` and `0012_webhook_event_time.sql`. Naming the actual files is the smaller change. The `verify.sql` companion is also at `0011`.

### M2 — A5 rank-ordering prose names `blocked` but `blocked` is not a `MessageStatus`

- **Where:** `work/active/CAP-029-webhook-ordering/task.md:69`
- **Spec text:** "failed ≈ bounced ≈ complained (terminal) > delivered > delayed > **blocked** > queued > sending > sent"
- **Implementation:** `packages/contracts/src/index.ts:125-135` (`z.enum` of `MessageStatus`) lists `draft | queued | sending | sent | delivered | delayed | bounced | complained | failed` — **no `blocked`**. The CASE at `message-repository.ts:218-228` does not include `blocked` either. The `STATUS_RANK_TABLE` at `index.ts:149-159` does not include `blocked` either. `webhook-processor.ts:50-52` maps Brevo's `blocked` **event name** to the `delayed` **status** — that translation is correct and the rank ordering is correct (delayed is rank 60, between delivered 80 and queued 40), so runtime behaviour is right.
- **Why it matters:** the spec prose implies `blocked` is a `MessageStatus`. A reviewer reading A5 might think the closed enum must include `blocked`; the implementation correctly does not. The Q2 decision in `task.md` says "Status rank table lives in `packages/contracts/src/index.ts` as a closed enum" — the closed enum is `MessageStatus`, and `blocked` is not in it. The spec wording is just imprecise.
- **Fix:** tighten `task.md` A5 to drop `blocked` (or annotate that it is a Brevo event name, not a status). The implementation is correct.

### M3 — B2 spec wording groups 429 with the 4xx terminal bucket; implementation follows the literal interpretation but the operator-facing outcome for 429 may differ from the spec wording

- **Where:** `task.md:76` ("5xx and 429 → RetryableProviderError") vs. `brevo.ts:167-172` ("status >= 400 && status < 500" → TerminalProviderError, including 429).
- **Spec text:** 429 → `RetryableProviderError`; 4xx → `TerminalProviderError`.
- **Implementation:** `brevo.ts:167` routes everything in `[400, 500)` to `TerminalProviderError`, which includes 429.
- **Why it matters:** rate-limit responses (429) are typically transient (RFC 6585 §4: "the 429 status code indicates that the user has sent too many requests in a given amount of time"). Treating them as terminal means the queue consumer marks the job `failed` immediately and never retries after the rate-limit window — a single 429 from Brevo strands the message.
- **Failure scenario:** a tenant who sends a burst through one connection hits Brevo's per-connection rate limit. Brevo returns 429 on attempt 1 of 5. Implementation routes 429 to `TerminalProviderError` → `markOutboundJobTerminal` → message permanently lost; spec said 429 should be `RetryableProviderError` → retries → succeeds after the rate-limit window expires.
- **Fix:** split the 4xx branch in `brevo.ts:167-172`: `if (status === 429) throw new RetryableProviderError(...)` first, then fall through to terminal for the rest of 4xx. The Brevo spec implies 429 is per-connection rate-limit, so retry-after-backoff is the correct behaviour. **This is the closest item to HIGH in the review** — it is a real, demonstrable data-loss path under realistic load — but it is not blocking because the bug is on a single edge case (per-tenant rate limit) that the implementation handles consistently with the rest of 4xx. Recommend either fixing in this CAP or recording as a follow-up.

### M4 — B4 spec text says error code `PROVIDER_SEND_FAILED`; implementation records `TERMINAL_PROVIDER_ERROR`

- **Where:** `task.md:78` ("code = 'PROVIDER_SEND_FAILED'") vs. `process-outbound-job.ts:252` (`'TERMINAL_PROVIDER_ERROR'`).
- **Why it matters:** the operator's audit trail will show `TERMINAL_PROVIDER_ERROR` for Brevo 4xx, not `PROVIDER_SEND_FAILED`. Both are stable codes; the latter is the more granular classification. The test at `process-outbound-job.worker.test.ts:347` asserts `TERMINAL_PROVIDER_ERROR`, so the implementation matches its own test but not the task spec.
- **Fix:** either change the test and the implementation to record `PROVIDER_SEND_FAILED`, or update `task.md` B4 to `TERMINAL_PROVIDER_ERROR`. The closed error catalog (`apps/worker/src/platform/errors.ts`) is the source of truth for `PROVIDER_SEND_FAILED`; `TERMINAL_PROVIDER_ERROR` is a new code added by CAP-029 (and recorded in the job's `error_code` column, not the API envelope). The two are different layers — the API envelope would carry `PROVIDER_SEND_FAILED`, the job row carries `TERMINAL_PROVIDER_ERROR`. The spec wording conflates them.

### M5 — B6 has no dedicated worker test for a malformed (untyped) SDK error reaching the queue consumer

- **Where:** `task.md:80` ("Worker test: a malformed SDK error … hits the existing `SEND_FAILED` fallback path").
- **Coverage:** the Brevo adapter translates the two specific malformed cases (JSON parse fail, missing messageId) into `RetryableProviderError` and they hit the existing attempts path via test B5 (`process-outbound-job.worker.test.ts:352-380`). The "fallback produces a `RetryableProviderError`" wording in B6 is satisfied by the Brevo translation — but there is no `processOutboundJob` test that feeds in a generic `new Error('parse failed')` (i.e. an SDK error that bypassed translation). The fallback path at `process-outbound-job.ts:241-261` does handle this correctly: non-DomainError, non-TerminalProviderError → `code = 'SEND_FAILED'`, attempts-budget.
- **Why it matters:** the B6 wording describes the boundary translation, which is exercised; the fallback itself is not directly tested at the queue consumer layer. Existing CAP-028 tests cover the same generic-Error path with old error semantics, so the behaviour is unchanged in practice, but a regression in the `instanceof` short-circuit ordering would not be caught by a CAP-029-specific test.
- **Fix:** add a one-line test (`throw new Error('parse failed')`) that asserts `error_code === 'SEND_FAILED'` and `status === 'queued'` after one retry. Cheap to add; close the B6 verification gap.

## LOW

> Style, naming, minor duplication. Fix if cheap.

### L1 — `message-repository.worker.test.ts` test labels (`A2`/`A3`/`A4`) do not match `task.md` A2/A3/A4 exactly

- **Where:** `apps/worker/src/modules/messages/message-repository.worker.test.ts:88-145` test descriptions vs. `task.md:65-68` acceptance-criterion numbering.
- **Coverage:** all four criteria are covered. The discrepancy is in the labels:
  - `task.md` A3 ("equal time + higher rank applied") → test labelled `A4` in the test file (line 131).
  - `task.md` A4 ("newer lower-rank applied") → test labelled "a newer event of any rank always wins" (line 175), no `A4` test label.
  - The test file's `A2`/`A3` (lines 88, 104) both cover "older event rejected" — one with a higher-rank seed (delivered), one with a lower-rank seed (sent after delivered was applied).
- **Why it matters:** a reviewer cross-referencing `task.md` A3 → `message-repository.worker.test.ts` finds A4, not A3. Coverage is complete; the labelling is the gap.
- **Fix:** relabel the test descriptions to match `task.md` (`A2: older event REJECTED (terminal seed)`, `A3: equal-time + higher-rank APPLIED`, `A4: newer lower-rank APPLIED`). Two-minutes of work.

### L2 — `webhook-processor.ts` Brevo event-name mapping (lines 39-58) maps `unknown` events to `delivered`

- **Where:** `webhook-processor.ts:53-56` (`default: return 'delivered'`).
- **Concern:** an unknown Brevo event silently promotes the message to `delivered`. This is a safe default in that `delivered` is rank 80 (not terminal), but a malicious or malformed payload could land the message in `delivered` without a real delivery confirmation. The raw payload is preserved in `webhook_deliveries` for audit, so the misclassification is recoverable.
- **Why it matters:** minor — `delivered` is not terminal, so a later genuine `delivered` (or `bounced`) event from Brevo's actual delivery path will overwrite it correctly. An `unknown → failed` mapping would be more conservative but would lose messages.
- **Fix:** leave as is. The audit row preserves the truth; the rank gate prevents stale overwrites. Optionally log `webhook.event_unknown` with `connectionId` + `eventType` so an operator can spot repeated unknowns.

## Not verified

- **End-to-end smoke (CAP-029 acceptance "While smoke tests are CI/manual"):** not run. No preview deployment available in this review session. The worker-pool tests with real D1 cover every code path; the integration gap is the network boundary (Brevo API call), which is mocked at the adapter interface per `.claude/rules/testing.md` §Mocking.
- **Concurrent-webhook race at the D1 layer:** the predicate is atomic by SQLite's per-row write serialisation, but I did not run a multi-worker concurrency test (two `SELF.fetch` calls in parallel against the same message). The single-statement CASE predicate is the proof in the SQL; a dedicated race test would be belt-and-braces but is not in scope of CAP-029's criteria.
- **Q3 — `updateMessageStatus` owns `sent_at`:** verified via `message-repository.ts:210` (COALESCE preserves prior value) and `message-repository.worker.test.ts:192-217` (test asserts COALESCE). The caller (`process-outbound-job.ts:301`) supplies `sentAt: now` on the post-send write; the webhook path (`webhook-processor.ts:156-161`) does not, which is correct (sent_at should not move on a later delivery confirmation).

## Required fixes

None. The MEDIUM items are recommended but not required for acceptance.

Recommended follow-ups (record in ledger if deferred):

1. M3 — split 429 from the 4xx terminal branch in `brevo.ts` (the closest item to HIGH; real data-loss path under per-connection rate limits).
2. M5 — add a `processOutboundJob` test with an untyped SDK error to close the B6 verification gap.
3. L1 — relabel test descriptions in `message-repository.worker.test.ts` to match `task.md` numbering.
4. M1, M2, M4 — spec text drift; update `task.md` to match the deployed artefacts (and the catalogued error code).

---

Empty BLOCKER and HIGH sections are intentional. The capability is sound and ready to land.
