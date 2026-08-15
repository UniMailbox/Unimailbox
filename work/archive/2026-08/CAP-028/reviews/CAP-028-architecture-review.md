# CAP-028 — architecture Review

**Reviewer:** `.claude/agents/architecture-reviewer.md` · **Date:** 2026-08-15 · **Base:** `5acb242` + uncommitted working tree

**Status:** ACCEPT WITH FIXES

## Summary

The slice is architecturally sound: all logic lives in `modules/outbound-mail` plus one platform
constant, the scheduled entrypoint stays a thin shell, ownership of `outbound_jobs` is respected,
and ADR-003 step 5 (scheduled recovery) is now real. The one rule violation is the entrypoint
deep-importing a module internal file instead of the module's `index.ts` — a one-line fix, but the
rule is written as a block-on-sight constraint. Everything else is MEDIUM or below.

## BLOCKER

### B1 — Entrypoint imports a module internal, not the module's `index.ts`

- **Where:** `apps/worker/src/entrypoints/scheduled.ts:12`
- **Violates:** `.claude/rules/architecture.md` §Dependency direction — Forbidden: "Importing
  anything but a module's `index.ts`. Internal layout is private." (`reclaim-stale-jobs.ts`'s own
  header says "Private file — export through `modules/outbound-mail/index.ts`".)
- **Failure scenario:** `entrypoints/scheduled.ts` imports
  `reclaimStaleJobs` from `../modules/outbound-mail/reclaim-stale-jobs`. The internal layout of
  `outbound-mail` becomes load-bearing for an entrypoint: a future refactor that renames or merges
  `reclaim-stale-jobs.ts` (e.g. folding the wrapper into the repository when a second cron target
  lands) compiles the entrypoint's import into a broken build, and any future consumer copying
  this import style erodes the module-boundary rule the rest of the codebase respects
  (`queue.ts:19` and `inbound-email.ts:26-40` all import module `index.ts` only). Notably,
  `modules/outbound-mail/index.ts:47` already re-exports `reclaimStaleJobs`, so the public path
  exists and is unused.
- **Fix:** change `scheduled.ts:12` to `import { reclaimStaleJobs } from '../modules/outbound-mail';`.

## HIGH

None. No dependency-edge violation beyond B1, no entrypoint logic leak, no persistence-ownership
breach introduced by this diff, no reverse or cyclic edge, no `integrations/*` → `modules/*` import,
and no provider SDK imported outside an adapter.

## MEDIUM

### M1 — Clock seam documented but not used; determinism contract is fiction in the use case

- **Where:** `apps/worker/src/modules/outbound-mail/process-outbound-job.ts:118`
  (`new Date(Date.now() + OUTBOX_LEASE_TTL_MS)`); same file uses `new Date()` for `now` in the
  success path; `apps/worker/src/entrypoints/scheduled.ts:23` (`new Date()`).
- **Violates:** `.claude/rules/testing.md` §Determinism ("Domain code takes `Clock` and `ids` from
  `platform/` precisely so tests can inject fixed values") and the doc-comments themselves:
  `job-repository.ts:161` claims the lease is "computed once by the caller via
  `Clock.now() + OUTBOX_LEASE_TTL_MS`", and `outbox-config.ts:43` claims "`now` is taken from
  `Clock.now()` in production". Neither is true — `platform/clock.ts` exports `systemClock` and
  nothing in this capability imports it. `reclaimStaleJobs(db, now)` does accept a `Date` parameter
  (good), but `processOutboundJob` has no seam at all.
- **Failure scenario:** a future test needs to assert "the lease expiry written by the claim is
  exactly `T + 60s`" — there is no way to pin `T`; the test must either sleep (forbidden) or
  assert loosely. Separately, a reader trusting `job-repository.ts:161` believes the claim and the
  expiry compare against an injected, single instant; in reality the claim computes its own
  `now = sqliteTimestamp(new Date())` internally, so the written `locked_at` and the passed
  `leaseUntil` can straddle a second boundary.
- **Fix:** have `processOutboundJob` take an optional `clock?: Clock` (default `systemClock`) in
  `ProcessJobDeps` and use it for both the lease computation and the success-path `now`; fix or
  delete the misleading doc-comments. Cheap now, expensive after CAP-029/030 build on top.

### M2 — `sqliteTimestamp` duplicated in `platform/outbox-config.ts`

- **Where:** `apps/worker/src/platform/outbox-config.ts:34-36` — a private copy of the helper that
  already exists in `platform/idempotency.ts` and is imported by both `job-repository.ts` and
  `process-outbound-job.ts`.
- **Violates:** "One fact, one home" (`.claude/rules/documentation.md`, applied to code) and the
  file's own admission ("Mirrors the helper in platform/idempotency.ts"). This is not a Rule-of-Three
  abstraction question — the helper already exists; this is a fork.
- **Failure scenario:** the format comment itself says mixing SQLite-datetime formats is "a silent
  correctness bug" — with two independent implementations, a future fix to one (e.g. handling
  sub-second truncation or a `datetime('now')` default change) will not propagate to the other,
  and lease comparisons silently skew.
- **Fix:** `import { sqliteTimestamp } from './idempotency'` in `outbox-config.ts` and delete the
  private copy.

### M3 — Pre-existing, not introduced by CAP-028: cross-module write to `messages` from `outbound-mail`

- **Where:** `apps/worker/src/modules/outbound-mail/process-outbound-job.ts:209-211` —
  `UPDATE messages SET status='sent' ...` issued directly against the `messages` table, which
  `architecture.md` §Persistence ownership assigns to the `messages` module ("Cross-module reads go
  through the owner's public interface" — this is a cross-module *write* with no interface at all).
- **Violates:** `.claude/rules/architecture.md` §Persistence ownership (in spirit; the letter of the
  rule addresses reads).
- **Failure scenario:** the `messages` module later adds a side-effect on status transition (e.g.
  `message_user_state` sync, CAP-030 audit hooks) inside its own status-setting function;
  `outbound-mail`'s raw UPDATE bypasses it, so messages sent via the queue diverge from messages
  finalized by any other path.
- **Fix:** not this capability's diff — the UPDATE predates CAP-028 (CAP-023; the diff only renames
  the bound id). Record it in the ledger as a follow-up (e.g. `messages.markSent()` on the module's
  public API) and keep it out of this slice. Flagging so it is a decision, not an oversight.

## LOW

### L1 — `OutboundJobRow` remains on the module's public API

- **Where:** `apps/worker/src/modules/outbound-mail/index.ts:30`.
- `architecture.md` forbids "Drizzle row types crossing a module boundary". `OutboundJobRow` is a
  hand-declared row interface (not a Drizzle inferred type), it predates CAP-028, and no file
  outside `modules/outbound-mail` imports it (verified by grep; only `dist/` build output and
  in-module files). No boundary is crossed today. If CAP-029/030 or `admin` ever needs job state,
  the type to export is a `contracts` DTO, not this row. No action required in this slice; noted so
  the export does not ossify into a dependency.

### L2 — Dead parameter gesture in `scheduled.ts`

- **Where:** `apps/worker/src/entrypoints/scheduled.ts:19` — `void _controller;` after naming the
  parameter `_controller`. The `void` expression is redundant (an underscore-prefixed unused param
  is already inert) and slightly undercuts the "thin shell" claim by adding ceremony. Delete the
  line. Also: the file lacks a trailing newline (diff marker `\ No newline at end of file`).

## Acceptance-criteria architecture mapping (informational)

- AC1–AC6 all land inside `modules/outbound-mail` + `platform/outbox-config.ts`; no new
  module-to-module edge, exactly as the contract's "New module dependency edges introduced: none"
  claims. Verified by reading every changed import.
- AC7 wiring is thin (one call, env unwrap, no branching) — the entrypoint has not gained business
  logic.
- AC8 cron config in `wrangler.jsonc` / `wrangler.test.jsonc` matches; configuration change only,
  no architecture impact.

## ADR-003 conformance

All five decision steps are now implemented or previously implemented: (1) batch write — CAP-023,
unchanged; (2) job + queue dispatch — CAP-023; (3) handler returns `queued` — CAP-023; (4) consumer
claims, calls provider, updates status — CAP-028 makes the word "claims" literal for the first
time; (5) scheduled dispatcher recovers stalled jobs — the subject of this slice. Nothing the ADR
requires is silently dropped. Deferred items are legitimately owned: webhook convergence (CAP-029)
and audit hooks / forbidden-transition matrix (CAP-030) are named in `task.md` §Out of scope with
owning capability IDs. `isJobTerminal` pre-declaring `bounced`/`complained` (set only by CAP-029)
is forward-compatible, not scope creep — documented in the function's doc-comment.

## Not verified

- Whether the worker-pool tests actually pass — the other reviewers / orchestrator run the gates.
  I reviewed structure and imports, not test execution.
- `apps/worker/dist/**` contains compiled `.d.ts` for the new exports; it is gitignored, so no
  build artifact is at risk of being committed.

## Required fixes

1. B1 — `scheduled.ts` must import `reclaimStaleJobs` from `../modules/outbound-mail`, not the
   internal file. One line.
2. M1 — add a `Clock` seam to `processOutboundJob` (or fix the three doc-comments that claim one
   already exists). Do this before CAP-029/030 build on the use case.
3. M2 — import `sqliteTimestamp` from `platform/idempotency` in `outbox-config.ts`; delete the copy.
4. M3 — record the pre-existing `UPDATE messages` cross-module write as a ledger follow-up; no code
   change in this capability.
