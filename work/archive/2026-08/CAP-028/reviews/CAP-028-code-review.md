# CAP-028 — Code Review

**Reviewer:** `.claude/agents/code-reviewer.md` · **Date:** 2026-08-15 · **Base:** `5acb242` (uncommitted working tree)

**Status:** ACCEPT WITH FIXES

## Summary

The repository layer is sound: the claim UPDATE, the three lock-predicated writes, and the reclaim's
re-check-then-update loop are individually correct, and the time-format discipline
(`sqliteTimestamp` everywhere, TEXT comparisons consistent) checks out at every site. The two
substantive problems are at the seams: (1) the reclaim resets a row to `queued` but nothing ever
re-drives it, so the "eventually succeeds or reaches terminal failed" goal is not actually closed;
(2) the stale-worker success path silently swallows the no-op write while its own docstring (and
AC3) claim it is detected and surfaced — the code does not do what the documentation says it does.

Verified: `pnpm test:worker` → **32 files, 495 tests, all passing** on this working tree.

## BLOCKER

None. No data loss, auth bypass, or architecture-rule violation found in the diff itself. (H1 below
is the closest candidate; it is a recovery-loop gap rather than an invariant break inside these
functions, so it is ranked HIGH and the orchestrator should rule on whether it blocks acceptance.)

## HIGH

### H1 — A reclaimed `queued` row is never re-driven: the recovery loop does not close

- **Where:** `apps/worker/src/modules/outbound-mail/job-repository.ts:375-416` (reclaim resets
  `status='queued'`), `apps/worker/src/entrypoints/queue.ts:42-60` (only re-drive mechanism, not in
  this diff), `apps/worker/src/entrypoints/scheduled.ts:23` (reclaim call, no enqueue)
- **Violates:** CAP-028 Goal (`work/active/CAP-028-durable-outbox/task.md:6-11`: "the job eventually
  succeeds or reaches a terminal `failed` state"); `R-OUTBOUND-008` in spirit
- **Failure scenario:** Worker A claims a job (60s lease), the provider call hangs past the queue's
  consumer timeout, and the delivery throws. `queue.ts` calls `msg.retry()`. Every redelivery that
  arrives while A's lease is still live throws `LOCK_CONTENTION` → `msg.retry()` again — each one
  burns a queue retry. Cloudflare Queues' default retry budget (3) is exhausted with the lease still
  live. The message is then gone (no DLQ is configured anywhere — `wrangler.jsonc` has a producers
  block only). Sixty seconds later the lease expires; the cron reclaim dutifully resets the row to
  `queued`, `locked_at=NULL`. And then: nothing. No queue message exists for that job, the reclaim
  does not `env.OUTBOUND.send({ jobId })`, and there is no polling dispatcher over `queued` rows.
  The job — and the user's message, still `messages.status='queued'` — sits in `queued` forever.
  It neither succeeds nor reaches the terminal state this capability exists to guarantee.
- **Fix:** Smallest correct change: the reclaim path re-enqueues every row it resets to `queued`
  (`env.OUTBOUND.send(JSON.stringify({ jobId }))` from the scheduled entrypoint / wrapper, keeping
  the repository D1-only). Belt-and-braces: the scheduled handler also sweeps
  `status='queued' AND updated_at < cutoff` rows for orphans whose enqueue was lost. If this is
  deliberately deferred to CAP-029/030, it must be recorded in the ledger — but the Goal paragraph
  promises it now.

### H2 — Stale-worker success write is silently swallowed, and its docstring claims the opposite; AC3 is not implemented as written

- **Where:** `apps/worker/src/modules/outbound-mail/job-repository.ts:204-247` (docstring at
  211-215), `apps/worker/src/modules/outbound-mail/process-outbound-job.ts:216-227`
- **Violates:** `.claude/rules/coding.md` §Errors ("Never swallow an error to keep a happy path
  green. If a failure is genuinely ignorable, log it at `warn` with a reason"); AC3 in
  `task.md:85-90` ("The row is read back to verify the update took effect (a `0 rows updated`
  result is a stale-worker race — surfaced as an error)"); comment honesty
- **Failure scenario:** Concrete divergence: worker A claims (attempts=2, max=3), sends
  successfully, writes `messages.status='sent'` (line 219). Meanwhile the lease expired, the cron
  reclaim marked the job `failed` (`RECLAIM_EXHAUSTED`). A's `markOutboundJobSent` matches 0 rows
  and returns void — no exception, no check of `result.meta.changes`, no `logger.warn`. Result:
  `messages.status='sent'` and `outbound_jobs.status='failed'` diverge **permanently**, with no log
  line anywhere. The comment at `job-repository.ts:211-214` says "The function reads the row back
  after the write so the caller can detect a 0-rows-updated result … surfaced as a thrown `Error`"
  — the function does neither (it runs the UPDATE and returns `void`), and the same docstring then
  says the use case "treats that as a silent-skip", contradicting itself. The user's message shows
  as sent in the messages table while the outbox says it failed; nothing reconciles the two.
- **Fix:** Check `result.meta.changes === 0` in `markOutboundJobSent` (or at the call site) and emit
  `logger.warn({ event: 'outbound.job_send_divergence' }, { jobId })`. Fix the docstring to match
  the chosen behavior, and reconcile the AC3 wording in `task.md` (the "read back + thrown error"
  clause was dropped at implementation without a recorded decision). Also note the
  `messages.status='sent'` write at `process-outbound-job.ts:216-227` and `markOutboundJobSent` are
  two separate awaits — a crash between them leaves `messages='sent'`, job=`'sending'` → reclaim →
  resend (provider idempotency key mitigates the double-send but the divergence repeats). At
  minimum the divergence must be observable.

## MEDIUM

### M1 — `TERMINAL_FAILURE` is a magic sentinel nothing emits; the terminal/retryable split is dead-branch code

- **Where:** `apps/worker/src/modules/outbound-job/../outbound-mail/process-outbound-job.ts:240`
  (`code === 'TERMINAL_FAILURE'`), `apps/worker/src/integrations/providers/brevo.ts:45-134` (the
  only adapter throws `PROVIDER_CONFIG_ERROR` / `PROVIDER_CONNECTION_FAILED` /
  `PROVIDER_SEND_FAILED`)
- **Failure scenario:** Brevo returns a hard 400 "invalid sender address" — a permanent rejection.
  The adapter throws `DomainError(PROVIDER_SEND_FAILED)`; the sentinel check misses; the job is
  retried the full `max_attempts` times, hammering the provider with a request that can never
  succeed. Meanwhile `code === 'TERMINAL_FAILURE'` can never be true in production: it is not in
  the closed `ERROR_CODES` catalog (`platform/errors.ts:38-107`) and no adapter emits it. The test
  that "covers" it (`process-outbound-job.worker.test.ts:293-312`) manufactures the sentinel with
  `Object.assign(terminal, { code: 'TERMINAL_FAILURE' })` — it pins a fictional contract, papering
  over the fact that the branch is unreachable. Per `.claude/rules/coding.md`: delete dead code, or
  make it live (e.g., classify 4xx-vs-5xx at the adapter boundary into the existing
  `PROVIDER_SEND_FAILED` code plus a retryable flag on `OutboundProviderAdapter`).
- **Fix:** Either delete the sentinel check and record "terminal = attempts-exhausted only" as the
  decision in `task.md`, or define a real classification on the adapter interface. Do not ship a
  string literal that exists only in a test.

### M2 — Clock injection is claimed but absent; `Date.now()` in the use case and `new Date()` in the repository

- **Where:** `apps/worker/src/modules/outbound-mail/process-outbound-job.ts:120`
  (`new Date(Date.now() + OUTBOX_LEASE_TTL_MS)`), `job-repository.ts:123,180,223,258,297,392,412`
  (`sqliteTimestamp(new Date())`), `apps/worker/src/platform/outbox-config.ts:43-44` (docstring:
  "The `now` parameter is taken from `Clock.now()` in production"), `entrypoints/scheduled.ts:23`
  (`new Date()`), tests at `scheduled.worker.test.ts:17-22` and
  `process-outbound-job.worker.test.ts:131-134` (both seed with real `Date.now()`)
- **Violates:** `.claude/rules/testing.md` §Determinism ("A test that calls `Date.now()` … is a
  test that will flake"); `.claude/rules/coding.md` §Structure ("No `Date.now()` — take a `Clock`
  from `platform/clock.ts`")
- **Failure scenario:** The docstrings promise `Clock` injection that does not exist:
  `reclaimStaleJobs` takes `now` (good) but `processOutboundJob` computes its lease from raw
  `Date.now()`, so the lease instant cannot be pinned in tests — the tests work around it by
  seeding lease literals relative to the real clock with 60-120s margins. That is practically
  stable but categorically the flake pattern the rule forbids, and `ProcessJobDeps` (which already
  grew `lockedBy?` for exactly this reason) has no `clock?`. The repository's internal
  `new Date()` calls are determinism-benign (only `updated_at`, never compared), but they make the
  repository untestable against a fixed clock if a future comparison ever uses them.
- **Fix:** Add `readonly clock?: Clock` to `ProcessJobDeps` (default `systemClock`), compute
  `leaseUntil` from it, and pass a fixed clock in the tests. Fix the `outbox-config.ts:43`
  docstring to describe what production actually does.

### M3 — Reclaim does N+1 sequential round trips; the two UPDATE bodies are near-duplicates

- **Where:** `apps/worker/src/modules/outbound-mail/job-repository.ts:375-418`
- **Failure scenario:** With S stale rows, the cron tick issues 1 SELECT + S sequential awaited
  UPDATEs. Not a correctness bug — the WHERE re-check (`status='sending' AND locked_at < ?` with
  the same cutoff) correctly makes a row re-claimed between SELECT and UPDATE a no-op, because the
  fresh claim's `locked_at` is in the future relative to the cutoff, so no TOCTOU remains. But D1
  charges a round trip per statement and the cron has a CPU/duration budget; a backlog burst
  (e.g., after a provider outage stalls many consumers) makes the tick the slowest thing in the
  Worker. `db.batch([...])` would do it in one round trip (D1 batches are atomic and sequential —
  safe here since each UPDATE is independent).
- **Fix:** Build the statement list and submit one `db.batch`. Optional at current scale; fine to
  defer if recorded.

## LOW

### L1 — `updateJobStatus` has no production callers left

- **Where:** `apps/worker/src/modules/outbound-mail/job-repository.ts:116-139`; grep shows only a
  test import (`entrypoints/queue.worker.test.ts:26,202`). The NOTE comment explains the intent
  (idempotency replay), but no such caller exists. Keep only if CAP-029/030 will use it; otherwise
  it is dead code per `.claude/rules/coding.md` ("Delete dead code — git remembers").

### L2 — `'code' in error` can yield the string `'undefined'`

- **Where:** `apps/worker/src/modules/outbound-mail/process-outbound-job.ts:230-232`. An error
  object with an own `code` property set to `undefined` passes the `in` check and
  `String(undefined)` stores `'undefined'` in `error_code`. Harmless today (adapters always set a
  code) but a one-line guard (`typeof v === 'string'`) removes the wart.

### L3 — `sqliteTimestamp` is privately duplicated in `outbox-config.ts`

- **Where:** `apps/worker/src/platform/outbox-config.ts:34-36` vs the exported
  `platform/idempotency.ts:93-95`. The duplication comment even explains why mixing formats is a
  bug — which is exactly why the function should have one home. Import it.

### L4 — Minor

- `scheduled.ts:19` — `void _controller;` is redundant when the parameter is already `_`-prefixed.
- `reclaim-stale-jobs.ts:22-24` — "Pure (no thrown errors)" is false: a D1 failure rejects and the
  cron handler will surface it (which is the right behavior). Fix the docstring.
- `job-repository.ts` is now 421 lines. The stated reason (single owner of all `outbound_jobs`
  SQL) is defensible, but the file is drifting toward the legacy "everything in one module" shape —
  worth splitting reclaim into its own file when CAP-029/030 touch it again.

## Not verified

- **Live cron behavior.** The `*/2 * * * *` trigger is asserted via direct invocation of
  `scheduled.scheduled(...)`; I did not verify Cloudflare actually registers the trigger or that
  the test config's trigger is consumed by the vitest pool as intended.
- **Queue consumer config.** `wrangler.jsonc` declares no `consumers` block (no `max_retries`, no
  DLQ). This is CAP-023 territory and outside this diff, but it is load-bearing for H1 — the retry
  budget that decides when the queue gives up is currently a platform default nobody has chosen.
- **Brevo idempotency-key honor semantics** — whether the provider actually deduplicates on the
  `idempotencyKey` sent (R-OUTBOUND-004) is an external behavior I could not check from the repo.
- **Typecheck/lint/build gates** — I ran `pnpm test:worker` (passing, 495/495) but not the full
  `pnpm lint` / `pnpm typecheck` / `pnpm build` suite.

## Required fixes

1. H1 — close the recovery loop: re-enqueue reclaimed rows (or record an explicit, ledger-approved
   deferral with the owner named).
2. H2 — detect the 0-rows-updated success write, log the divergence at `warn`, and make the
   docstring (and AC3 wording) match the code.
3. M1 — delete or realize the `TERMINAL_FAILURE` sentinel; a test must not be the only emitter of
   a production code path.
4. M2 — inject `Clock` into `ProcessJobDeps` and stop seeding tests from `Date.now()`.
5. M3, L1-L4 — at the implementer's discretion; record any deferral in the ledger.

## Fix-round re-review (2026-08-15)

**Status of this round:** ACCEPT WITH FIXES — H1 and H2 are closed as adjudicated, M1 and M2 are
closed, L3 is closed. Two new findings (F1 HIGH, F2 MEDIUM), both at the seams the fix round
touched. Gates verified on this tree: `pnpm lint` clean, `pnpm typecheck` clean,
`pnpm test:worker` → **32 files, 501/501 passing** (up from 495).

### H1 verdict — CLOSED for the primary path; residual orphan window remains (see F1)

Walked end-to-end: `reclaimStaleOutboundJobs` resets the row to `queued` with `locked_at=NULL,
locked_by=NULL` and returns `reclaimedIds` (`job-repository.ts:407-427`); the wrapper sends
`JSON.stringify({ jobId })` per ID (`reclaim-stale-jobs.ts:65-67`) — byte-identical to the compose
producer (`http/routes/compose.ts:257`) and exactly what `entrypoints/queue.ts:46-49` parses
(`typeof msg.body === 'string'` → `JSON.parse` → `payload.jobId`). The redelivered consumer then
re-claims cleanly: `claimOutboundJob`'s `WHERE status='queued' AND (locked_at IS NULL OR ...)`
matches the reclaimed state. A duplicate delivery racing the re-enqueue is harmless — the claim is
atomic and the loser gets `LOCK_CONTENTION` → `msg.retry()`. Tests pin the body format
(`reclaim-stale-jobs.worker.test.ts:112-133`). Terminal rows are correctly never re-driven.

### H2 verdict — CLOSED

`markOutboundJobSent` returns `(result.meta?.changes ?? 0) > 0` (`job-repository.ts:217-239`);
the use case warns on `false` with `outbound.job_sent_divergence` carrying `jobId` + `reason`
(`process-outbound-job.ts:245-256`). R-LOG-001 compliant: job ID only, no bodies, no tokens; the
`LogFields`/context split matches `platform/logger.ts`. Both docstrings now describe what the code
does, AC3 wording in `task.md` matches the adjudication, and the test asserts the warn line
(`process-outbound-job.worker.test.ts:250`). The `messages.status='sent'`-before-lock-guarded-write
hazard is now observable in the stale-worker case — but a *different* facet of it is misrouted (F2).

### M1 / M2 / L verdicts

- M1 closed — `TERMINAL_FAILURE` has zero occurrences in `apps/worker/src`; terminal routing is
  attempts-exhaustion only, recorded in `task.md` §Decisions.
- M2 closed — `clock?: Clock` on `ProcessJobDeps` (`process-outbound-job.ts:67,121,136`);
  `outbox-config.ts:32-34` docstring now says production passes `new Date()` (true:
  `scheduled.ts:24`); tests drive a single fixed clock explicitly.
- L3 closed — `outbox-config.ts:16` imports `sqliteTimestamp` from `platform/idempotency`.
- L2 **not** closed and the fix-round comment makes a claim the code does not enforce — see F3.

## Fix-round findings (ranked)

### F1 (HIGH) — A reclaimed row whose re-enqueue fails is orphaned in `queued` forever, and two comments claim a backstop that does not exist

- **Where:** `apps/worker/src/modules/outbound-mail/reclaim-stale-jobs.ts:44-48` (docstring: "The
  next cron tick is the backstop for a row whose re-enqueue failed … the next tick or a queue
  redelivery will re-drive it" at 70-72)
- **Failure scenario:** Reclaim resets the row to `queued` and clears the lease; then
  `outbound.send` throws (queue producer outage — realistic, and note the two events correlate:
  the reclaim exists because the queue path already failed). The catch logs
  `outbound.reclaim_reenqueue_failed` and moves on. Next cron tick:
  `reclaimStaleOutboundJobs` scans `WHERE status='sending' AND locked_at IS NOT NULL AND
  locked_at < ?` (`job-repository.ts:369-378`) — a `queued` row with a cleared lock is invisible.
  There is no sweep of `queued` rows anywhere in the codebase (verified by grep). And the "queue
  redelivery" claim is false in exactly the scenario the re-enqueue was built for: the typical H1
  crash path burns the queue's retry budget before the lease expires, so **no redelivery remains**.
  Result: `outbound_jobs.status='queued'`, `messages.status='queued'`, forever — the Goal's
  "eventually succeeds or reaches a terminal `failed` state" is still breakable, and the comment
  asserts otherwise. This is the same comment-honesty class the original H2 blocked on.
- **Fix:** Either (a) add the belt-and-braces orphan sweep the original H1 named — the scheduled
  tick re-enqueues `status='queued' AND updated_at < (now - grace)` rows with
  `attempts < max_attempts` — or (b) fix both comments to state the truth and record the deferral
  (with owner) in the ledger. (a) also closes the identical pre-existing window on the compose
  path (`compose.ts` commits the job, then `OUTBOUND.send` at line 257 — same orphan shape).

### F2 (MEDIUM) — The try/catch spanning steps 3–9 misroutes success-path write failures into the retryable/terminal path

- **Where:** `apps/worker/src/modules/outbound-mail/process-outbound-job.ts:153` (try opens before
  step 3) … `234-237` (`messages.status='sent'` write) … `245` (`markOutboundJobSent`) …
  `257-279` (catch)
- **Failure scenario:** Provider send succeeds; the `UPDATE messages SET status='sent'` commits;
  then `markOutboundJobSent` itself rejects (transient D1 error — a different statement failing
  than the one that just succeeded is normal under retries/limits). The catch cannot distinguish
  "the send failed" from "the success write failed": with attempts left, `markOutboundJobRetryable`
  burns an attempt on a send that succeeded and requeues it (provider idempotency key mitigates the
  double-send; converges, but attempts are consumed by bookkeeping, not attempts). On the final
  attempt the same error writes `status='failed'` while `messages.status='sent'` — and because
  `markOutboundJobSent` *threw* rather than returned `false`, the H2 divergence warn never fires.
  The exact permanent divergence H2 existed to surface, via a route the fix round opened by
  widening the try.
- **Fix:** Narrow the catch to end after the provider call (or re-check inside the catch whether
  `messages.status='sent'` was already written / whether the error came from the success writes),
  and warn on the job/message divergence when a success-path write fails after the send succeeded.
  Alternatively record as a ledger deferral — but the warn is cheap and the scenario is realistic.

### F3 (LOW) — `code` extraction still stores junk for non-DomainError errors, and the new comment claims otherwise

- **Where:** `apps/worker/src/modules/outbound-mail/process-outbound-job.ts:259-263`. The comment
  says "the only code we trust here is a DomainError's stable `code` field" — but the check is
  `error instanceof Error && 'code' in error`, not `instanceof DomainError`. A `DOMException`
  (e.g. from Web Crypto) has a legacy numeric `code` → stores `'18'`; a library error with
  `code: 'ECONNRESET'` stores that. Neither is in the closed `ERROR_CODES` catalog (CAP-032).
- **Fix:** `error instanceof DomainError ? error.code : 'SEND_FAILED'`. One line, plus it makes
  the comment true.

### F4 (LOW) — Carried-over L4 items unchanged

`reclaim-stale-jobs.ts:37-39` still claims "Pure (no thrown errors)" while a D1 failure inside
`reclaimStaleOutboundJobs` rejects straight through to the cron handler (correct behaviour, false
docstring); `scheduled.ts:19` still has the redundant `void _controller`. Discretionary.

## Fix-round verdict

**ACCEPT WITH FIXES.** H1 and H2 are genuinely closed for the adjudicated scope, M1/M2 are closed,
no defects were introduced by the boolean signature or the `OutboundJobEnqueuer` structural type
(`env.OUTBOUND: Queue` is assignable as-is — parameter contravariance plus `Promise<unknown>` —
and typecheck confirms), and all gates pass on the current tree. F1 must be resolved before
acceptance — implement the orphan sweep **or** correct the two false backstop comments and record
the deferral in the ledger. F2 should be fixed or explicitly deferred; F3/F4 are discretionary.

## Fix-round-2 verification (2026-08-15)

**Scope:** F1/F2 closure + new-defect scan of the two changed files only. Gates re-run by the
orchestrator (lint, typecheck, unit 324/324, worker 505/505, build) — not re-run here.

### F1 (HIGH) — CLOSED

The original scenario, re-walked against the fix: reclaim resets the row to `queued`
(`job-repository.ts:411-423`, `updated_at` stamped `sqliteTimestamp(new Date())`); the re-enqueue
throws (`reclaim-stale-jobs.ts:76-88`, warn without the job ID — R-LOG-001). Previously the story
ended there. Now every subsequent tick runs `findOrphanedQueuedJobs(db, orphanSweepCutoff(now))`
(`reclaim-stale-jobs.ts:100-118`) — `SELECT id FROM outbound_jobs WHERE status='queued' AND
updated_at < ?` (`job-repository.ts:452-463`) — and once the row has been queued past the 5-minute
threshold (`OUTBOUND_ORPHAN_SWEEP_AFTER_MS = 300_000`, `outbox-config.ts:38`; `orphanSweepCutoff`
at 63-66) it is re-enqueued in the exact `JSON.stringify({ jobId })` body format the consumer
parses (`entrypoints/queue.ts:46-51`). The recovery loop now closes for both the failed-reenqueue
path **and** the pre-existing compose-path orphan shape (compose commits the job, then
`OUTBOUND.send` at `compose.ts:257` can fail leaving the same row state — the sweep covers it).

New-defect scan of the sweep, by area:

- **Threshold vs healthy pipeline:** `updated_at` is bumped by every state write (compose insert
  via `sqliteTimestamp` at `compose.ts:159`, claim, retryable mark, reclaim reset), so the
  predicate measures time-since-last-write, not time-since-creation. A fresh queued row is claimed
  in seconds; a retryable row gets a fresh `updated_at` at each `markOutboundJobRetryable`. 5 min
  sits comfortably past lease TTL (60s) + cron cadence (2 min). No race with a live pipeline.
- **TEXT vs ISO:** every `outbound_jobs.updated_at` writer uses the shared
  `sqliteTimestamp` (`YYYY-MM-DD HH:MM:SS`); the cutoff goes through the same helper. Verified no
  writer stores ISO — an ISO writer would sort above the TEXT cutoff forever and orphan itself
  *invisibly*; none exists.
- **Double-enqueue consequences:** covered structurally, and now pinned by a test. The claim is
  atomic with exactly one winner (`claimOutboundJob` WHERE, `job-repository.ts:184-194`); a late
  duplicate finds the row `sent` and takes the pre-claim skip (R-OUTBOUND-009) or gets
  `LOCK_CONTENTION → msg.retry()`; a genuine concurrent resend is deduped by the provider
  idempotency key = message ID (R-OUTBOUND-004). `process-outbound-job.worker.test.ts:700-741`
  drives sweep-delivery + late-delivery and asserts exactly one provider call, `attempts` 0.
- **No `attempts` filter in the sweep:** harmless — no code path can leave a row `queued` with
  `attempts >= max_attempts` (retryable marks only happen below the ceiling; the reclaim terminal
  branch fails such rows instead of re-queueing). A re-driven over-ceiling row would go terminal
  on its next failure anyway.
- **Tests prove the fix:** `reclaim-stale-jobs.worker.test.ts:245-266` (old queued row → one send
  in the consumer body format; fails with empty bodies if the sweep is absent) and `:268-302`
  (the literal F1 two-tick scenario: failed re-enqueue → later sweep re-drives it).
  `:189-206` pins the negative side (fresh queued row untouched). Real D1 via the worker pool,
  fixed clock, no sleeps — testing.md compliant.

### F2 (MEDIUM) — CLOSED

The original scenario, re-walked: provider send succeeds (step 9, line 236); the `UPDATE messages
SET status='sent'` (272-274) or `markOutboundJobSent` (282) rejects. The success writes now sit in
their own try/catch (270-305) that is *outside* the steps-3–9 catch — the failure hits
`logger.error` with event `outbound.job_post_send_write_failed` carrying `jobId` only (296-303,
R-LOG-001: no bodies, no provider payload, no decrypted key), then rethrows raw with **no**
attempts logic. Consequences, per the F2 fix requirement: no attempt is burned on a successful
send, `status='failed'` can no longer be written for a send the provider accepted, and the row
keeps its lease so the lease-expiry + cron reclaim recovers it (resend deduped by R-OUTBOUND-004).
The misroute into `markOutboundJobRetryable`/`markOutboundJobTerminal` is structurally impossible
now — those calls exist only inside the pre-send catch (251-257).

The H2 stale-worker facet is preserved: a `false` from `markOutboundJobSent` still warns
`outbound.job_sent_divergence` (283-293); a *thrown* error is no longer conflated with that
divergence (it logs the distinct `job_post_send_write_failed` event — the two cases are now
distinguishable in logs).

Test proves the fix: `process-outbound-job.worker.test.ts:515-618` forces the post-send messages
UPDATE to throw via a delegating D1 proxy (every other statement hits the real binding), then
asserts: raw rethrow of the D1 error, `attempts` unchanged at 1, `status='sending'`, lease held by
`worker-a`, `error_code` NULL (no retryable/terminal write happened), the error log line with the
job ID, and full recovery through `reclaimStaleJobs` back to `queued` without an attempts
increment. This test fails against the pre-fix code on four separate assertions.

Minor coverage note (not a finding): the forced failure is on the messages UPDATE, not on
`markOutboundJobSent` throwing — but both flow through the identical catch, and the
messages-UPDATE-succeeds/`markOutboundJobSent`-throws ordering is the F2-original prose scenario.
The one behavioural difference (messages row already `sent`) converges via the same reclaim path
and is invisible to the assertions that matter.

### Minor items

- **F3 — closed.** `process-outbound-job.ts:243`:
  `const code = error instanceof DomainError ? error.code : 'SEND_FAILED';` — exactly as
  prescribed; the comment at 239-242 now tells the truth. (`'SEND_FAILED'` as a stored fallback
  literal is the adjudicated shape; `error_code` is not restricted to the closed catalog —
  `RECLAIM_EXHAUSTED` already lives there.)
- **F5 — closed.** Zero occurrences of "next tick is the backstop" or "Pure (no thrown errors)"
  in `apps/worker/src`. The replacement docstrings describe real behavior: the reclaim-stale-jobs
  header (40-55) states D1 failures reject to the cron handler and failed enqueues are recovered
  by the sweep — both now true because the sweep exists.

### New defects introduced by the fix round

**None.** Specific things hunted and cleared: sweep threshold vs live pipeline (above);
TEXT/ISO mixing at every `updated_at` writer; sweep amplification for a row whose queue delivery
is merely delayed (bounded — one duplicate per 2-min tick, each resolving via the sent-skip or
LOCK_CONTENTION, both cheap and both explicitly accepted by the F1 adjudication in `task.md`
§Decisions); `sendResult` definite-assignment across the narrowed try (catch always throws or
returns — typecheck green); logging discipline at all three new/widened sites (job ID and error
message only). The `enqueuedOrphans` count addition to the tick log line is R-LOG-001-safe.

### Verdict

**ACCEPT.** F1 and F2 are closed, F3/F5 landed, and the fix round introduced no new defects. No
outstanding findings from this review's scope.
