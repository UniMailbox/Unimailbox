# CAP-030 — Architecture Review

**Reviewer:** architecture-reviewer · **Date:** 2026-08-16 · **Base:** `cap/CAP-020-026-business-loop` (uncommitted)

**Status:** ACCEPT (no architectural blocker; one wording MEDIUM, three LOW)

## Summary

The CAP-030 direction-guard slice lands on the correct edges. The new
primitive in `packages/contracts/src/index.ts` mirrors the existing
`STATUS_RANK_TABLE` pattern exactly (closed zod enums, derived `z.infer`
types, `ReadonlyMap<K, ReadonlySet<V>>` containers, no `any`). No new
module dependency edge is introduced; the allowed-dependency table in
`.claude/rules/architecture.md` is exhaustive and not violated. The SQL
composition in `apps/worker/src/modules/messages/message-repository.ts`
lines 234-256 layers the CAP-030 direction guard onto the CAP-029 rank
predicate with `AND`, never `OR`; the `WHERE` clause remains a single D1
statement. The compose INSERT bypass is documented inline at
`apps/worker/src/http/routes/compose.ts:182`. `assertCanTransition`
throws plain `Error`, matching the `statusRank` programmer-error pattern.
The retry reset `sending → queued` is in `ALLOWED_JOB_TRANSITIONS` (jobs)
but NOT in `ALLOWED_MESSAGE_TRANSITIONS` (messages) — the domain
discriminator on `canTransition` is load-bearing. Terminal set is empty
for `failed`/`bounced`/`complained` on both maps; `sent` is also terminal
for jobs (R-OUTBOUND-009). `sent → delayed` allowed-edge present in
`ALLOWED_MESSAGE_TRANSITIONS` (D-CAP-030-F). The deleted "A2
newer-of-any-rank-wins" test in `webhooks.worker.test.ts` is principled
per R-MESSAGE-012; the strict-newer-time branch is still exercised by
B3/B4. The security reviewer confirms no IDOR / log surface opened.

## BLOCKER

None.

The primitive in `packages/contracts/src/index.ts` mirrors the existing
`STATUS_RANK_TABLE` pattern exactly: closed zod enums, derived
`z.infer` types, `ReadonlyMap<K, ReadonlySet<V>>` containers, no `any`.
No new module dependency edge is introduced; the allowed-dependency
table in `.claude/rules/architecture.md` is not violated. The SQL
composition in `apps/worker/src/modules/messages/message-repository.ts`
lines 234-256 layers the CAP-030 direction guard onto the CAP-029 rank
predicate with `AND`, never `OR`. The compose INSERT bypass is documented
inline at `compose.ts:182` (D-CAP-030-D). Retry reset
`sending → queued` is in `ALLOWED_JOB_TRANSITIONS` (jobs) but NOT in
`ALLOWED_MESSAGE_TRANSITIONS` (messages) — the domain discriminator on
`canTransition` is load-bearing. Terminal set is empty for
`failed`/`bounced`/`complained` on both maps; `sent` is also terminal
for jobs (R-OUTBOUND-009). `sent → delayed` allowed-edge present in
`ALLOWED_MESSAGE_TRANSITIONS` (D-CAP-030-F). `assertCanTransition` throws
plain `Error`, matching the `statusRank` programmer-error pattern
(D-CAP-030-G). The deleted "A2 newer-of-any-rank-wins" test in
`webhooks.worker.test.ts` is principled per R-MESSAGE-012; the
strict-newer-time branch is still exercised by B3/B4 in
`message-repository.worker.test.ts`. The security reviewer confirms no
IDOR / log surface opened (writer still scopes by `messages.id` /
`outbound_jobs.id`).

## HIGH

None.

## MEDIUM

**D-CAP-030-E framing overstates drift.** The decision claims
`OutboundJobRow['status']` is a "row type crossing a module boundary"
today. Verified: the only `OutboundJobRow` consumers are internal to the
outbound-mail module (`process-outbound-job.ts:55`, the module's own
`index.ts` export re-exporting the type, and internal writers at
`job-repository.ts:50, 132`). No external module consumes `OutboundJobRow`;
the drift is potential, not actual. Adding `outboundJobStatusSchema` +
`OutboundJobStatus` is correct forward-availability work and is the right
precedent for parity with `messageStatusSchema` — but it is not fixing a
live cross-boundary violation. Recommendation: at capability close,
soften the ledger entry's wording to "forward-availability — closes the
precedent for cross-boundary drift before it materialises" rather than
"fixes the drift". No ADR needed; the rule is already in
`.claude/rules/architecture.md`. Reviewer should not block on this; it
is a wording call.

## LOW

**Strict-newer-time + direction-legal combination has no explicit
worker-pool test.** The `message-repository.worker.test.ts` B-suite
covers (a) direction rejection that the rank predicate would otherwise
accept (B1, B2), and (b) forward-rank acceptance on equal-time (B3, B4).
The combination "strictly newer event time AND direction-legal AND
forward-rank" is exercised transitively by the rank test at lines 230-270
plus B3/B4, but no single test names that triplet. The capability is not
weakened — the layers compose by `AND` and each layer is independently
pinned — but the contract's spirit of one-test-per-invariant would
benefit from a B5 test asserting `sent → delivered` with a strictly-newer
provider event time. Optional follow-up; not a blocker. A future
capability adding a test for the retry-reset writer's
`sending → queued` on strictly-newer event time would also strengthen
coverage.

**Internal consistency on `OutboundJobStatus` adoption is two-step.**
`job-repository.ts:50` (`isJobTerminal`) and `job-repository.ts:132`
(`updateJobStatus` parameter type) still type against
`OutboundJobRow['status']`. The new `OutboundJobStatus` type is the
cross-boundary primitive; these two internal signatures are private to
the module and not a boundary crossing, but they would benefit from
migration to `OutboundJobStatus` so the literal status set lives in one
place. Recommend a follow-up commit (or a small extension of CAP-030)
that re-types the two signatures. Not a blocker.

**`reclaimStaleOutboundJobs` direction check is implicit.** The
terminal-fail branch and the retry-reset branch both predicate on
`status='sending'` (lines 437, 457). That matches
`ALLOWED_JOB_TRANSITIONS.get('sending')` for both targets (`'failed'`
and `'queued'`). The function lacks the same direction-guard doc comment
the four writers got at lines 194-199, 231-236, 278-283, 324-327.
Symmetry would be cheap and would prevent a future reader from
questioning why `reclaimStaleOutboundJobs` is unenforced while the four
writers are. Optional; trivial to add.

---

Task:      CAP-030 — Lifecycle direction: state-machine guards for messages + outbound_jobs
Status:    COMPLETE (architecture review — investigation only, no code changed)

Changes:   None. Read-only review against every file in task.md's reading list.

Files:
- /Users/john/Workspace/x/Unimailbox/work/active/CAP-030-lifecycle-direction/task.md
- /Users/john/Workspace/x/Unimailbox/packages/contracts/src/index.ts
- /Users/john/Workspace/x/Unimailbox/packages/contracts/src/index.test.ts
- /Users/john/Workspace/x/Unimailbox/apps/worker/src/modules/messages/message-repository.ts
- /Users/john/Workspace/x/Unimailbox/apps/worker/src/modules/messages/message-repository.worker.test.ts
- /Users/john/Workspace/x/Unimailbox/apps/worker/src/modules/outbound-mail/job-repository.ts
- /Users/john/Workspace/x/Unimailbox/apps/worker/src/modules/outbound-mail/job-repository.worker.test.ts
- /Users/john/Workspace/x/Unimailbox/apps/worker/src/modules/outbound-mail/process-outbound-job.ts (read-only)
- /Users/john/Workspace/x/Unimailbox/apps/worker/src/modules/outbound-mail/webhook-processor.ts (read-only)
- /Users/john/Workspace/x/Unimailbox/apps/worker/src/http/routes/compose.ts
- /Users/john/Workspace/x/Unimailbox/apps/worker/src/http/routes/webhooks.worker.test.ts
- /Users/john/Workspace/x/Unimailbox/migrations/0006_messages.sql (read-only)
- /Users/john/Workspace/x/Unimailbox/migrations/0007_outbound_jobs.sql (read-only)
- /Users/john/Workspace/x/Unimailbox/.claude/rules/architecture.md (referenced)
- /Users/john/Workspace/x/Unimailbox/.claude/rules/coding.md (referenced)
- /Users/john/Workspace/x/Unimailbox/.claude/rules/testing.md (referenced)
- /Users/john/Workspace/x/Unimailbox/.claude/rules/security.md (referenced)
- /Users/john/Workspace/x/Unimailbox/docs/rebuild/02-business-discovery/business-rules.md (referenced)

Tests:     Did not run tests — reviewer is read-only by charter. The implementer's
          quality-gate run (`pnpm scaffold doctor && pnpm lint && pnpm typecheck &&
          pnpm test:unit && pnpm test:worker && pnpm build`) is the orchestrator's
          gate to clear. The four parallel reviewers (code, qa, security) cover
          the SQL `AND` composition, the rule-named test coverage, and the
          IDOR / log-surface scan respectively. No new test gap surfaced that
          those reviewers would not catch.

Findings:  BLOCKER 0 · HIGH 0 · MEDIUM 1 · LOW 3 (per severity sections above)

Risks:     - D-CAP-030-E wording overstates the drift it fixes; not a behaviour
            problem, but a future reader of the diff may misread the rationale
            and either duplicate the work (treating it as "done") or skip the
            next migration step (treating it as "complete when nothing was
            wrong").
          - The strict-newer + direction-legal combination is not pinned by a
            named test; relies on transitive coverage through B3/B4 plus the
            existing rank test. A refactor that breaks the composition would
            still pass the named tests but fail the combination. Low risk; the
            SQL is short and the layers are syntactically distinct (`AND`
            followed by `AND (...)`).
          - The deleted A2 test in `webhooks.worker.test.ts` is principled
            (R-MESSAGE-012 — terminal is terminal) but the deletion rationale
            is a one-line comment; a future diff reader who greps for "A2"
            will find nothing. Worth a ledger entry.

Next:      - Orchestrator: clear CAP-030 once the four parallel reviewers land
            and the quality gates pass. The MEDIUM finding is wording, not
            behaviour — do not block acceptance on it; record the
            "forward-availability" softening in the ledger at close.
          - Optional follow-ups: B5 strict-newer + direction-legal test;
            `OutboundJobStatus` migration on the two internal writer
            signatures; `reclaimStaleOutboundJobs` direction-guard comment
            for symmetry.
          - Ledger entry for CAP-030 should record that the deleted A2 cases
            were removed per R-MESSAGE-012, not as cleanup, so a future reader
            of the diff knows the deletion is principled.

Review report file: /Users/john/Workspace/x/Unimailbox/work/reviews/CAP-030-architecture-review.md
