# CAP-028 — QA Review

**Reviewer:** `.claude/agents/qa-reviewer.md` · **Date:** 2026-08-15 · **Base:** `5acb242` (working tree, uncommitted)

**Status:** ACCEPT WITH FIXES

## Summary

The lease machinery itself is sound and well-tested at the repository layer: AC1's five sub-cases, AC6's reclaim branches, and AC9's forbidden transitions are all pinned against real D1, and both suites pass (worker 495/495, unit 324/324). The two things that must be fixed before acceptance: (1) AC3's read-back/surfaced-error requirement is not implemented — the code silently no-ops and a doc comment claims a read-back that does not exist; (2) any failure *before* `adapter.send` (missing message/connection/credential, decrypt failure) escapes with the lease still held and no error recorded, so such a job ping-pongs between claim, `LOCK_CONTENTION`, and reclaim forever and can never reach a terminal state. The capability's headline scenario — crashed consumer → reclaim → re-claim → send succeeds — also has no single test that walks the loop end-to-end.

## Acceptance criteria

| # | Criterion | Met | Evidence |
|---|---|---|---|
| AC1 | Atomic claim, sub-cases (a)–(e) | YES | (a) `job-repository.worker.test.ts:106` (b) `:117` (c) `:133` (d) `:152` (e) `:158` — all five pinned, columns re-read after each |
| AC2 | Claim-first; null → typed throw; sent → silent skip | PARTIAL | Throw + zero provider calls: `process-outbound-job.worker.test.ts:130`; silent sent-skip: `:190`. But a precheck read (`process-outbound-job.ts:109`) runs *before* the claim, deviating from "before any other read or write" — see M4 |
| AC3 | `markOutboundJobSent` + read-back, 0-rows surfaced as error | **NO** | No read-back exists. `job-repository.ts:217-238` is a fire-and-forget UPDATE; `process-outbound-job.ts:222-227` explicitly does not throw; the test at `process-outbound-job.worker.test.ts:208` pins the *opposite* (must-not-throw silent no-op) |
| AC4 | Retryable: attempts+1, queued, lock cleared, rethrow | YES | Repo: `job-repository.worker.test.ts:201`; use case incl. rethrow: `process-outbound-job.worker.test.ts:244` |
| AC5 | Terminal: `failed`, no rethrow (ack) | YES | Repo: `job-repository.worker.test.ts:242`; use case (attempts=2/max=3 → failed, resolves): `process-outbound-job.worker.test.ts:272`; `TERMINAL_FAILURE` code regardless of attempts: `:293` |
| AC6 | Reclaim branches + counts + no attempts++ | YES | `reclaim-stale-jobs.worker.test.ts:101` (expired→queued, attempts unchanged), `:119` (exhausted→failed), `:138` (live lease untouched), `:155` (terminal/queued untouched), `:168` (second tick no-op), `:183` (mixed batch 2/1) |
| AC7 | Scheduled entrypoint wires reclaim | YES | `scheduled.worker.test.ts:83-122` drives `scheduled.scheduled(controller(), env)` against real D1, incl. repeated ticks |
| AC8 | Cron in both wrangler files | YES | `apps/worker/wrangler.jsonc:73` and `apps/worker/wrangler.test.jsonc:40`, both `*/2 * * * *` |
| AC9 | Forbidden transitions impossible | YES | claim vs sent/failed: `job-repository.worker.test.ts:152,158`; mismatched `lockedBy` no-op for sent/retryable/terminal: `:183`, `:220`, `:261` |

## BLOCKER

None. All 495 worker tests and 324 unit tests pass; no invariant tested is violated; the silent stale-worker no-op cannot double-send (provider dedupe via `R-OUTBOUND-004` message-id idempotency key).

## HIGH

### H1 — AC3's read-back requirement is unimplemented, and a doc comment claims code that does not exist

- **Where:** `apps/worker/src/modules/outbound-mail/job-repository.ts:211-238`, `apps/worker/src/modules/outbound-mail/process-outbound-job.ts:222-227`
- **Violates:** CAP-028 AC3 (`work/active/CAP-028-durable-outbox/task.md:85-90`); `.claude/rules/coding.md` §Comments (comment restates code that isn't there)
- **Failure scenario:** The contract says a 0-rows-updated result "is a stale-worker race — surfaced as an error". The implementation runs the UPDATE and discards `meta.changes`. Worse, the doc comment on `markOutboundJobSent` (lines 211-215) is self-contradictory and partially false: it states "The function reads the row back after the write so the caller can detect a 0-rows-updated result (a stale-worker race surfaced as a thrown `Error`)". No read-back exists and nothing is thrown — then the very next sentence says the use case "treats that as a silent-skip". A future maintainer reading that comment cannot tell which behavior is real (answer: neither described one — the UPDATE result is simply discarded, and there is no signal to treat at all). The deviation from AC3 is recorded nowhere: the task.md "Decisions" section does not mention it, and the test (`process-outbound-job.worker.test.ts:208-235`) pins the opposite behavior (must-not-throw).
- **Fix:** The orchestrator must adjudicate. Either (a) implement the contract: return the change count (or re-read) from `markOutboundJobSent` and have `processOutboundJob` throw, with a test pinning the throw; or (b) accept the silent no-op as the deliberate design (defensible — the provider accepted, the row was resolved by whoever stole the lock) and *record it in task.md §Decisions + rewrite the false comment*. Do not ship the comment/code mismatch.

### H2 — Failures before `adapter.send` hold the lease forever recorded nowhere; the job can never reach a terminal state

- **Where:** `apps/worker/src/modules/outbound-mail/process-outbound-job.ts:134-207` (outside the try/catch that starts at line 214)
- **Violates:** `R-OUTBOUND-008` (a job eventually succeeds or reaches terminal `failed`); `.claude/rules/testing.md` §What must be tested item 5 (failure paths); CAP-028 task.md Goal ("the job eventually succeeds or reaches a terminal `failed` state")
- **Failure scenario:** Consumer claims the row (status → `sending`, lease 60s), then `Message not found` / `Provider connection not found` / `Credential not found` / a decrypt failure throws at lines 137-176 — *before* the try block. The error escapes with the lease still held, no `error_code` written, `attempts` never incremented. Queue retries hit `LOCK_CONTENTION` until the lease expires; the cron reclaim re-queues (still no `attempts++` — by design); the next redelivery claims, throws at the same lookup, forever. A permanently mis-configured job cycles every ~2 minutes indefinitely and never becomes `failed`. The only not-found test (`process-outbound-job.worker.test.ts:314`) covers the job row itself, before the claim — the post-claim lookup failures are untested.
- **Fix:** Move the lookup/decrypt phase inside the failure-recording path (or wrap it so any throw after a successful claim marks the job terminal — these are non-retryable config errors), and add a test: seed job + claim, delete the message row, assert the job lands `failed` with an error code, not `sending`-with-lease.

### H3 — The capability's headline scenario (crash → reclaim → re-claim → send succeeds) has no end-to-end test

- **Where:** missing test across `reclaim-stale-jobs.worker.test.ts` + `process-outbound-job.worker.test.ts`
- **Violates:** `.claude/rules/testing.md` §What must be tested (the E2E scenario for the capability); CAP-028 task.md Goal
- **Failure scenario:** The pieces are each correct in isolation, but no test drives the loop: claim → simulate consumer death (lease expires) → `reclaimStaleJobs` re-queues → `processOutboundJob` claims again → provider send succeeds → `sent`. A regression that only manifests across the seam (e.g. reclaim writing a `locked_at` format the claim's `locked_at < ?` comparison mis-reads, or a status the claim rejects) would pass every existing test. The two halves use *different* timestamp conventions today (reclaim tests use fixed literals; process tests use `Date.now()`-relative seeds) — precisely the kind of mismatch a loop test would catch.
- **Fix:** One worker-pool test: seed a `sending` row with a stale lease (reclaim's `NOW` fixed-clock style), run `reclaimStaleJobs`, then run `processOutboundJob` with a succeeding mock adapter, assert `sent` + provider called once.

## MEDIUM

### M1 — Attempts exhaustion is only ever tested via the `attempts = max - 1` seed shortcut

- **Where:** `process-outbound-job.worker.test.ts:272` (seed `attempts: 2`), `reclaim-stale-jobs.worker.test.ts:119` (seed `attempts: 3`)
- **Failure scenario:** No test lets `attempts` actually climb 0 → 1 → 2 → terminal `failed` through repeated `processOutboundJob` invocations with a failing adapter. The climb exercises the state the shortcut skips: each retryable write must re-arm the row (`queued`, lock cleared) such that the *next* invocation can claim it again. A regression in lock release that only bites on the second re-claim would pass.
- **Fix:** Loop `processOutboundJob` three times with a always-failing adapter (fresh `lockedBy` each time), assert attempts 1, 2, then `failed` on the third.

### M2 — Concurrent claims (two claims, one wins) are not pinned

- **Where:** `job-repository.worker.test.ts:117-131`
- **Failure scenario:** The single-consumer guarantee (R-OUTBOUND-007) is proven only against a *seeded* `sending`+live-lease row, never against two live `claimOutboundJob` calls racing (`Promise.all` with distinct `lockedBy`). The code comment (`job-repository.ts:177-179`) asserts SQLite serialises the UPDATE — that assertion is untested. D1 does serialise writes, so this is more belt-and-braces than a suspected bug.
- **Fix:** `const [a, b] = await Promise.all([claim(...,'w1',...), claim(...,'w2',...)]); expect([a?.locked_by, b?.locked_by].filter(Boolean)).toHaveLength(1)`.

### M3 — In the stale-worker race the `messages` row is marked `sent` unconditionally, before the lock-guarded job write

- **Where:** `process-outbound-job.ts:217-227`
- **Failure scenario:** Reclaim steals the row mid-send and (attempts exhausted) marks the job `failed`; the stale worker's provider call then succeeds; `messages.status` is set `sent` while the job row stays `failed` — a permanent user-visible divergence (client sees sent, admin sees failed) with no convergence path until CAP-029. The stale-race test (`process-outbound-job.worker.test.ts:208`) never asserts `messages.status`.
- **Fix:** At minimum, extend the stale-race test to assert what happens to the message row and record the intended divergence semantics in task.md §Decisions; ideally make the message write conditional on the job write having taken (the change count from H1's fix supplies this).

### M4 — AC2's "claim before any other read or write" is deviated from, unrecorded

- **Where:** `process-outbound-job.ts:109-115`
- **Failure scenario:** A precheck `getOutboundJob` read precedes the claim so `sent` rows can skip silently. Functionally harmless (the claim remains the authority; a TOCTOU between precheck and claim still ends in `LOCK_CONTENTION`), but it contradicts the AC's letter and the deviation is in neither the code's decision log nor task.md. The silent-skip requirement could equally be met by checking status on a null claim.
- **Fix:** Record the precheck in task.md §Decisions (or drop the precheck and branch on the claim result). One-line doc fix either way.

### M5 — Nothing re-enqueues a reclaimed row; recovery depends entirely on queue redelivery surviving

- **Where:** `job-repository.ts:356-421` (reclaim only flips status), `entrypoints/scheduled.ts:23`
- **Failure scenario:** Reclaim sets `queued` but never sends to the OUTBOUND queue. If the original queue message has exhausted its retries (DLQ) or was lost, the row sits `queued` forever — the reclaim only scans `sending`. Every recovery path presumes a live queue redelivery arrives. This may be the accepted design (out-of-scope item defers queue-retry policy), but it is not stated anywhere and no test pins it.
- **Fix:** Record the assumption in task.md §Decisions, or note it as a follow-up capability (dispatcher-driven re-enqueue of `queued` rows older than N).

## LOW

- **L1** — `isJobTerminal` (`job-repository.ts:50`) is exported from the module index but has no production caller; only CAP-030 is listed as a future consumer. Dead export until then — acceptable given the ledger names the consumer, but worth a note.
- **L2** — AC8's stated purpose for the test-config cron ("so the worker-pool test scheduler can invoke it") is not realized: `scheduled.worker.test.ts` invokes `scheduled.scheduled` directly and never exercises the trigger. The config requirement itself is met; only the rationale is untested.
- **L3** — Determinism drift: `processOutboundJob` computes the lease from `Date.now()` (`process-outbound-job.ts:120`) and every repository write uses `new Date()`, so the process/scheduled tests must seed wall-clock-relative timestamps with 60-120s margins (`process-outbound-job.worker.test.ts:131`, `scheduled.worker.test.ts:21-22`). Not flaky at current margins, but against the spirit of `.claude/rules/testing.md` §Determinism — an injected `Clock` (as `reclaimStaleJobs` already takes) would remove the margin arithmetic.

## Not verified

- Real Cloudflare cron-trigger invocation and queue redelivery behavior (DLQ, retry cadence) — the worker-pool tests bind real D1 but cannot exercise the platform's queue/cron delivery; H3's loop test would close the in-D1 portion only.
- Production deployability of `secrets_store_secrets` IDs and account placeholders — out of QA scope for this capability.

## Required fixes

1. H1 — adjudicate AC3: implement the surfaced error or record the silent no-op as a decision and delete the false doc comment.
2. H2 — record lookup/decrypt failures on the job (terminal) instead of escaping with the lease held; add the post-claim failure test.
3. H3 — add the crash → reclaim → re-claim → send loop test.
4. M1/M2/M3/M4/M5 — per above; acceptable as recorded follow-ups if the ledger notes them.

## Fix-round re-review (2026-08-15)

**Status:** ACCEPT — all previously blocking findings resolved or adjudicated as recorded
decisions. Worker 501/501 pass, unit 324/324 pass (run by this reviewer, verbatim below).

### Updated AC scoreboard

| # | Criterion | Previous | Now | Evidence |
|---|---|---|---|---|
| AC1 | Atomic claim, sub-cases (a)–(e) + concurrent claims | YES | YES | (a)–(e) as before (`job-repository.worker.test.ts:106-162`); **M2 fixed:** `R-OUTBOUND-007: two concurrent claims — exactly one wins` (`:164`) — `Promise.all` with distinct `lockedBy`, asserts exactly one non-null winner and the row's `locked_by` matches it |
| AC2 | Skip-read then claim-first; null → typed throw; sent → silent skip | PARTIAL | YES | Wording reconciled in task.md (skip read IS the R-OUTBOUND-009 precheck); throw + zero sends: `process-outbound-job.worker.test.ts:140`; silent sent-skip: `:200`; also `failed` row → `LOCK_CONTENTION` (`:175`), and all other reads (message/recipients/conn/cred) verifiably execute only after the claim (they live inside the post-claim try block, `process-outbound-job.ts:153-197`) |
| AC3 | `markOutboundJobSent` returns boolean; `false` → `warn` (adjudicated) | NO | YES | `markOutboundJobSent ... returns true` / `... returns false` (`job-repository.worker.test.ts:189,202`); warn path pinned: `leaves the row alone when the lock is stolen mid-send ... R-OUTBOUND-007` (`process-outbound-job.worker.test.ts:218-260`) asserts exactly one `outbound.job_sent_divergence` warn, correct `jobId`, and no body bytes (regex against `/body|html/i`); the false doc comment is gone — `job-repository.ts:202-238` now describes the boolean + adjudicated warn accurately |
| AC4 | Retryable: attempts+1, queued, lock cleared, rethrow | YES | YES | Repo `:221`; use case `:269`; plus the new post-claim message-vanished and decrypt-failure variants (see H2 below) |
| AC5 | Terminal on exhaustion, no rethrow; attempts not re-incremented | YES | YES | Repo `:262`; use case seed-shortcut `:297`; **M1 fixed:** `drives retryable failures 0→1→2→3: the third failure routes terminal` (`:468-512`) — three real `processOutboundJob` invocations with distinct `lockedBy`, no seed shortcut, asserts queued/1, queued/2, then `failed` with `error_message` pinned and `attempts` still 2 (terminal write never increments — documented in `job-repository.ts:286-289`) |
| AC6 | Reclaim branches + counts + `reclaimedIds` + re-enqueue | YES | YES | All six branches as before, now each with a recording enqueuer asserting bodies (`reclaim-stale-jobs.worker.test.ts:112-230`); re-enqueue body asserted byte-for-byte as `JSON.stringify({ jobId })` — the exact format `entrypoints/queue.ts:46-49` parses |
| AC7 | Scheduled entrypoint wires reclaim + re-enqueue | YES | YES | `scheduled.worker.test.ts:83-100` now also spies `env.OUTBOUND.send` and asserts one call with the exact consumer-parseable body; exhausted → no send (`:102`); repeated ticks idempotent (`:115`) |
| AC8 | Cron in both wrangler files | YES | YES | `wrangler.jsonc:73`, `wrangler.test.jsonc:40` — unchanged, verified |
| AC9 | Forbidden transitions impossible | YES | YES | As before (`job-repository.worker.test.ts:152,158,202,240,281`) |

### The three new/changed test areas, verified

**H3 — end-to-end loop test.** `recovers a job whose consumer died mid-claim, without losing
or double-sending it` (`process-outbound-job.worker.test.ts:521-592`). It genuinely walks the
seam: real `claimOutboundJob` (crashed worker, `sending` + lock asserted) → fixed clock
advanced `+3 × OUTBOX_LEASE_TTL_MS` (comment explains the strict-`<` predicate needs a full
TTL of margin) → `reclaimStaleJobs` with a recording enqueuer, asserting `reclaimed: 1`,
`queued`, lock columns NULL, `attempts` still 0, **and** the queue body
`toEqual([JSON.stringify({ jobId })])` → clock `+30s` → `processOutboundJob` with a fixed
injected clock and a succeeding adapter → `sent`, exactly one provider call,
`messages.status = 'sent'`, `provider_message_id` recorded. One fixed clock instance drives
every phase via explicit `t` reassignment; zero sleeps; the only `Date.now()`-relative
timestamps are seed `created_at` values that no predicate reads. This closes the timestamp-
convention mismatch the original review flagged.

**H2 — Proxy-based message-missing test.** `re-queues with attempts+1 and rethrows when the
message vanished after the claim` (`process-outbound-job.worker.test.ts:346-410`). The
simulation is confined exactly as claimed: the Proxy intercepts only `db.prepare`, arms on the
single `FROM messages WHERE id = ?` SELECT, and within that one statement only `first()` is
replaced (returns `null`); `bind` chains and every other statement/read delegate to the real
binding, and all writes (claim, retryable mark) hit real D1. The `armed` flag proves ordering:
the precheck (`SELECT * FROM outbound_jobs`) does not match the interceptor, so the wrapped
read can only be the post-claim one. A block comment (`:354-360`) explains why a literal
DELETE is impossible — verified: `migrations/0007_outbound_jobs.sql:17` has
`ON DELETE CASCADE` on `message_id`. **Judgement on the testing-rule seam:** acceptable. The
"never mock D1" rule exists because "a test that mocks the database tests the mock"; here the
database is real and one read is fault-injected — a surgical race-window simulation with no
other way to produce the state. It mocks at a boundary for a failure path, which the rule
explicitly permits for external systems; I would not extend the pattern beyond
single-statement fault injection. Two sibling tests (`:412`, `:441`) pin the decrypt-failure
post-claim path against real D1 with a genuinely wrong key, no Proxy needed — including the
exhausted-budget terminal variant.

**M2/M1 — concurrent claim and sequential exhaustion.** Both do what they claim. Concurrent:
`Promise.all` of two real `claimOutboundJob` calls, exactly one non-null winner, row's
`locked_by` matches the winner (`job-repository.worker.test.ts:164-180`). Sequential:
0→1→2→terminal across three invocations with distinct `lockedBy` (a fresh UUID per attempt is
what re-exercises the claim against the previously released lock), no `attempts` seeding.

### Absence hunting on the fix round

- **Warn-divergence path: tested.** The stale-worker test asserts the
  `outbound.job_sent_divergence` warn fires exactly once, carries the `jobId`, and does not
  leak body bytes (`process-outbound-job.worker.test.ts:247-255`). The logger's `warn` →
  `console.warn` JSON line verified against `platform/logger.ts`.
- **Re-enqueue-failure path: tested.** `H2: a failed queue send logs a warn WITHOUT the job ID
  and does not abort the remaining re-enqueues` (`reclaim-stale-jobs.worker.test.ts:232-265`)
  — first `send` throws, second still attempted (both rows reclaimed in D1), warn asserted
  with `jobId` explicitly `undefined` (R-LOG-001) and the error message present. The
  loop-continues claim is pinned, not just logged.
- **TERMINAL_FAILURE sentinel: gone.** `grep -r TERMINAL_FAILURE apps/ packages/` — zero
  hits; its test is deleted; no other consumer of the removed branch exists. Terminal routing
  is attempts-exhaustion only, matching the adjudication (CAP-029 owns adapter taxonomy).
- **Nothing previously passing broke:** worker suite 495 → 501 (+7 new tests, −1 deleted
  sentinel test), all green; unit unchanged at 324, all green.

### Findings (this round)

- **LOW-1** — The comment in `job-repository.worker.test.ts:134-137` still says "AC1c in
  task.md words this as 'lease stolen by claim'" — task.md has since been reconciled and no
  longer words it that way. The comment is now historical; trim on next touch.
- **LOW-2** — The stale-race divergence test still does not assert `messages.status` after the
  stale worker's success (the original M3 tail). The divergence semantics are now adjudicated
  and recorded in task.md §Decisions, and `messages` is set `sent` before the lock-guarded job
  write (`process-outbound-job.ts:234-237`), so the divergence is by design — but the
  message-row outcome in that race is still unpinned. A one-line extension whenever this file
  is next touched; also noted that the pre-existing cross-module `messages` write is recorded
  as a ledger follow-up, per the adjudication.
- **LOW-3** — `scheduled.worker.test.ts:85` uses `vi.spyOn(env.OUTBOUND, 'send')`, which
  replaces the real queue producer's behaviour. Same category as the Proxy seam: the D1 work
  is real, only the outbound producer is intercepted at its boundary, and worker-pool tests
  cannot observe a produced queue message any other way. Acceptable; noting for the record.

### Verbatim test counts (run by this reviewer, 2026-08-15)

```
pnpm test:worker
 Test Files  32 passed (32)
      Tests  501 passed (501)

pnpm test:unit
 Test Files  18 passed (18)
      Tests  324 passed (324)
```

### Re-review verdict

**ACCEPT.** H1, H2, H3 fully resolved with pinned tests; M1, M2 resolved; M3/M4/M5 resolved
by adjudication and recorded in task.md §Decisions (re-enqueue now implemented, closing M5's
stronger form). Remaining findings are LOW and non-blocking. From a QA standpoint CAP-028's
acceptance criteria AC1–AC9 are all met against the updated contract.
