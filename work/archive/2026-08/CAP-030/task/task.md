# CAP-030 — Lifecycle direction: state-machine guards for messages + outbound_jobs

> The shared contract for this capability. Every agent working on it reads this file first.

**Phase:** 2 · **Status:** In Progress · **Started:** 2026-08-16

## Goal

A `messages` row and its companion `outbound_jobs` row can only transition through states that
are permitted by the documented lifecycle. Terminal states (`failed`, `bounced`, `complained`)
cannot be left; the forward path is enforced in SQL, not in application code, so a buggy or
malicious caller cannot resurrect a terminal row.

## Scope

- Add `ALLOWED_MESSAGE_TRANSITIONS` and `ALLOWED_JOB_TRANSITIONS` (and a `canTransition` /
  `assertCanTransition` helper) to `packages/contracts`, mirroring the existing
  `STATUS_RANK_TABLE` pattern.
- Add an `outboundJobStatusSchema` + `OutboundJobStatus` type to `packages/contracts` so the
  direction table is closed-enum typed (parity with `messageStatusSchema`).
- Extend the SQL `WHERE` predicate in `updateMessageStatus` (the single `messages` row status
  writer) so a transition out of a non-allowed `from`-status is rejected even when the
  rank-aware predicate would accept it.
- Document why the lease-aware writers (`claimOutboundJob`, `markOutboundJobSent`,
  `markOutboundJobRetryable`, `markOutboundJobTerminal`) already enforce direction via their
  `status = '...'` predicate, and add explicit worker tests proving each writer's `from` is in
  the allowed-from set declared in `ALLOWED_JOB_TRANSITIONS`.
- Cover every `(from, to)` pair in both direction tables with a contracts-side unit test, and
  exercise a representative subset (forward, retry-reset, terminal, prohibited regression) with
  worker-pool tests against real D1 bindings.

## Out of scope

- **Schema changes.** The CHECK constraints on `messages.status` and `outbound_jobs.status`
  already enumerate every state; CAP-030 does not introduce or remove a status value. Removing
  the dead `sent → delayed/bounced/complained/failed` transitions from `outbound_jobs.status`
  is a separate ADR if it ever becomes worth doing.
- **Atomic webhook-delivery + messages-status writes.** The CAP-029 code re-review
  (`work/reviews/CAP-029-code-rereview.md` M1) noted these two writes are not in a single D1
  batch. CAP-030 keeps them separate; bundling them into `db.batch([...])` is a follow-up.
- **A `draft` lifecycle path.** Compose-send inserts a `messages` row directly at `'queued'`
  (`apps/worker/src/http/routes/compose.ts:182`); the schema supports `draft` but no path
  produces one today. CAP-030 keeps the schema CHECK and adds `draft` to the direction table
  (R-MESSAGE-010), but does not introduce a draft-write use case. That is a separate capability
  (a future drafts module).
- **`updateJobStatus` (the unconditional job writer) gaining a direction predicate.** Per the
  CAP-028 review adjudication (`apps/worker/src/modules/outbound-mail/job-repository.ts:110-127`)
  that writer is reserved for compose-insert and admin paths and is explicitly
  *not* called from the queue consumer; the queue-consumer path is the one CAP-030 hardens.
  Adding a direction predicate to `updateJobStatus` would be cosmetic, not a behavioural
  improvement — the consumer never reaches it.
- **Replacing the rank-aware predicate.** CAP-029 closed that invariant; CAP-030 layers
  direction on top, never below.
- **An `OutboxConfig` or `Clock` change.** No new infra.

> This section prevents more drift than the Scope section does. Be generous with it.

## Business rules

| Rule ID | What it means for this slice |
|---|---|
| `R-MESSAGE-006` | A message's status follows the lifecycle: `draft → queued → sending → sent → delivered (or terminal)`. CAP-030 enforces this in SQL. |
| `R-MESSAGE-010` | A successful send transitions a draft irreversibly to `sent` (or `queued`). The direction table encodes the allowed `draft → {sent, queued}` transitions; this is preparation for a future drafts module. |
| `R-MESSAGE-012` | `failed` is terminal; to resend, create a new draft. CAP-030 makes `failed` terminal in the direction table (empty allowed set) and the SQL predicate rejects any transition out. |
| `R-MESSAGE-007` | Webhook status updates are applied only if newer (event time) or higher-rank on tie. Already closed by CAP-029. CAP-030 layers *direction* on top — the new SQL clause is added with `AND`, not `OR`. |
| `R-OUTBOUND-008` | A retryable error marks the job `queued` (NOT `failed`); `sending → queued` is an explicit retry reset. CAP-030 allows it in the direction table and labels it `// retry reset (R-OUTBOUND-008)`. |
| `R-OUTBOUND-009` | The job's terminal states (`failed`, `bounced`, `complained`) are terminal — no reclaim, no retry, no overwrite. CAP-030 makes the allowed-from set empty for each, matching the `messages` table. |

Source: `docs/rebuild/02-business-discovery/business-rules.md`.

## Acceptance criteria

Objectively checkable. No "works correctly". Each maps to a test or a demonstrable behaviour.

- [ ] 1. `packages/contracts/src/index.ts` exports `outboundJobStatusSchema` (closed zod enum
       matching `migrations/0007_outbound_jobs.sql` CHECK) and `OutboundJobStatus` derived type.
- [ ] 2. `packages/contracts/src/index.ts` exports `ALLOWED_MESSAGE_TRANSITIONS: ReadonlyMap<
       MessageStatus, ReadonlySet<MessageStatus>>` and `ALLOWED_JOB_TRANSITIONS: ReadonlyMap<
       OutboundJobStatus, ReadonlySet<OutboundJobStatus>>`. The terminal set is empty for
       `failed`/`bounced`/`complained` on both maps.
- [ ] 3. `packages/contracts/src/index.ts` exports `canTransition(from, to): boolean` and
       `assertCanTransition(from, to): void` (throws `Error` with a `from→to` message when
       forbidden — same plain-`Error` pattern as `statusRank`).
- [ ] 4. `updateMessageStatus` SQL (`apps/worker/src/modules/messages/message-repository.ts:205-242`)
       adds an `AND status IN (allowed-from-set-for-:status)` predicate **alongside** the
       existing rank predicate. The `WHERE` clause is still a single D1 statement, still
       atomic, still returns the boolean for the divergence warn.
- [ ] 5. Each lease-aware job writer (`claimOutboundJob`, `markOutboundJobSent`,
       `markOutboundJobRetryable`, `markOutboundJobTerminal`) has an explicit comment that the
       hard-coded `status = '...'` predicate matches `ALLOWED_JOB_TRANSITIONS` for the
       writer's only legal `from`. No SQL change to those writers.
- [ ] 6. `compose.ts:170-195` has an inline comment explaining why the INSERT path bypasses
       the direction guard (no prior row → vacuously true; the schema CHECK is the safety net).
- [ ] 7. `packages/contracts/src/index.test.ts` adds a `describe('ALLOWED_*_TRANSITIONS —
       CAP-030 direction guard')` block with tests that pin each map to a literal expected set
       and exercise `canTransition` for: every forward transition (allowed), every regression
       in a non-terminal state (forbidden), every transition out of a terminal state
       (forbidden), and the retry-reset `sending → queued` (allowed).
- [ ] 8. `apps/worker/src/modules/messages/message-repository.worker.test.ts` adds:
       - one test that `updateMessageStatus` rejects `sent → queued` (direction violation;
         rank predicate would accept on a strictly newer event time);
       - one test that `updateMessageStatus` rejects `failed → sent` (terminal violation;
         rank predicate would accept on a strictly newer event time);
       - one test that `updateMessageStatus` accepts `sent → delivered` (forward + higher rank);
       - one test that `updateMessageStatus` accepts `delivered → bounced` (retroactive
         correction; rank permits at equal-time + higher-rank).
- [ ] 9. `apps/worker/src/modules/outbound-mail/job-repository.worker.test.ts` adds a test
       per lease-aware writer proving the writer's `from` matches the direction table for
       the writer's only legal `to` (4 tests total). The retry-reset writer
       (`markOutboundJobRetryable`) test pins the `sending → queued` allowed edge.
- [ ] 10. `pnpm scaffold doctor`, `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`,
        `pnpm test:worker`, and `pnpm build` all pass locally.

## Vertical slice

Layers this touches, in dependency order:

- [ ] domain — `packages/contracts/src/index.ts` (direction tables + helper + job status enum)
- [ ] domain — `apps/worker/src/modules/messages/message-repository.ts` (extend `WHERE`)
- [ ] domain — `apps/worker/src/modules/outbound-mail/job-repository.ts` (annotate, no SQL change)
- [ ] domain — `apps/worker/src/modules/outbound-mail/process-outbound-job.ts` (no change; the
             call sites at lines 252, 270, 275, 300, 314 are already correct)
- [ ] domain — `apps/worker/src/modules/outbound-mail/webhook-processor.ts` (no change; the
             call site at line 174 is already correct)
- [ ] route — `apps/worker/src/http/routes/compose.ts` (add inline comment, no code change)
- [ ] tests — `packages/contracts/src/index.test.ts` (new describe block, mirror of the
             `STATUS_RANK_TABLE` block at lines 1184–1227)
- [ ] tests — `apps/worker/src/modules/messages/message-repository.worker.test.ts`
             (4 new tests against real D1, mirroring the rank test at lines 230–270)
- [ ] tests — `apps/worker/src/modules/outbound-mail/job-repository.worker.test.ts`
             (4 new tests, one per lease-aware writer)

New module dependency edges introduced: **none.** The direction tables live in `contracts`
(parity with `STATUS_RANK_TABLE`); no module imports another module's internals.

## File ownership

One writer per file. Reading anything is fine; writing outside your list is not.

| Agent | Owns |
|---|---|
| implementer | All files below — one implementer subagent because every file hangs off the single `contracts` primitive. |

Implementer-owned files (the exact list, one per line):

- `packages/contracts/src/index.ts`
- `packages/contracts/src/index.test.ts`
- `apps/worker/src/modules/messages/message-repository.ts`
- `apps/worker/src/modules/messages/message-repository.worker.test.ts`
- `apps/worker/src/modules/outbound-mail/job-repository.ts`
- `apps/worker/src/modules/outbound-mail/job-repository.worker.test.ts`
- `apps/worker/src/modules/outbound-mail/process-outbound-job.worker.test.ts`
- `apps/worker/src/http/routes/compose.ts`
- `apps/worker/src/http/routes/webhooks.worker.test.ts`

The implementer leaves `process-outbound-job.ts` and `webhook-processor.ts` untouched (no
behavioural change) but reads them.

After the implementer reports COMPLETE, four reviewers run in parallel (never alongside the
implementer — they read the diff against this contract):

- `architecture-reviewer` — validates the primitive pattern matches `STATUS_RANK_TABLE` and
  that no new module dependency edge is introduced.
- `code-reviewer` — validates the SQL `AND` clause composes with the rank predicate correctly,
  that the unit-test literal pins cover every state pair, and that the worker-pool tests use
  real bindings.
- `qa-reviewer` — validates every numbered acceptance criterion above has a corresponding
  passing test or demonstrable behaviour.
- `security-reviewer` — validates that no IDOR surface is opened (the writer still scopes by
  `messages.id` / `outbound_jobs.id`, never by body-supplied identity) and that no log line
  gains a body / secret / PII / `Idempotency-Key` value.

## Reading list

Give each subagent exactly this — not the whole `docs/` tree.

- `CLAUDE.md` (entry point)
- this file
- `.claude/agents/implementer.md` (or whichever reviewer role)
- `.claude/rules/architecture.md` (dependency direction, table ownership, forbidden patterns)
- `.claude/rules/coding.md` (errors, comments, dependency rules)
- `.claude/rules/testing.md` (rule-named tests, no mocks for D1/R2/KV/Queue, mock only the
  provider HTTP boundary)
- `.claude/rules/security.md` (R-AUTHZ-004 IDOR rule, R-LOG-001, R-MESSAGE-007 / R-MESSAGE-012)
- `docs/rebuild/02-business-discovery/business-rules.md` (R-MESSAGE-006 / R-MESSAGE-010 /
  R-MESSAGE-012, R-OUTBOUND-008 / R-OUTBOUND-009)
- `packages/contracts/src/index.ts:110-175` (existing `messageStatusSchema` +
  `STATUS_RANK_TABLE` + `statusRank` pattern to mirror)
- `packages/contracts/src/index.test.ts:1184-1227` (existing rank-table test pattern to mirror)
- `apps/worker/src/modules/messages/message-repository.ts:1-245` (the writer to extend; note
  the `D-CAP-028-D` public-surface rule on lines 7-9)
- `apps/worker/src/modules/messages/message-repository.worker.test.ts:220-270` (existing rank
  test pattern to mirror)
- `apps/worker/src/modules/outbound-mail/job-repository.ts:1-330` (the lease-aware writers
  and the `CAP-028 / C1 adjudication` doc-comment on lines 110-127)
- `apps/worker/src/modules/outbound-mail/process-outbound-job.ts:230-330` (call sites at
  252, 270, 275, 300, 314 — read-only)
- `apps/worker/src/modules/outbound-mail/webhook-processor.ts:130-200` (call site at 174 —
  read-only)
- `apps/worker/src/http/routes/compose.ts:170-195` (the INSERT path)
- `migrations/0006_messages.sql` (schema CHECK on `messages.status`)
- `migrations/0007_outbound_jobs.sql` (schema CHECK on `outbound_jobs.status`)

## Dependencies

- Requires: CAP-029 (Webhook ordering — rank-aware status updates + IDOR closure) — **Implemented
  2026-08-15 on `cap/CAP-020-026-business-loop`** (`git log --oneline | head -1` is `feat(CAP-029)`).
- Blocks: a future "drafts" capability (when a use case writes a `draft` row, it will rely on the
  direction table).

## Decisions made during this capability

Append as you go. At close, each is promoted to a rule, an ADR, the implementation log — or
deleted as not load-bearing. Nothing stays only here.

- **D-CAP-030-A — One slice.** All three pieces (primitive, message writer, job writers)
  hang off the same `canTransition` helper. Splitting would mean two contracts updates and
  two PRs for what is functionally one change. Recorded here so the implementer does not
  propose a second slice.
- **D-CAP-030-B — Retry reset `sending → queued` is allowed.** It is the documented
  R-OUTBOUND-008 retry semantic; the direction table names it explicitly with an inline
  comment. Recorded so a reviewer does not file it as a regression finding.
- **D-CAP-030-C — No SQL change to the lease-aware job writers.** Their existing
  `status = '...'` predicates already match the only legal `from` for each writer. A reviewer
  who proposes "also add the `IN (...)` clause" is invited to confirm the single-`status`
  predicate is a strict subset of the direction table — the addition would be cosmetic.
- **D-CAP-030-D — Compose INSERT bypasses the direction guard.** The `messages` row has no
  prior state on insert; the schema CHECK is the safety net. The implementer adds an inline
  comment to `compose.ts:182` so a future reader does not "fix" the gap by routing the
  compose write through `updateMessageStatus`.
- **D-CAP-030-E — `outboundJobStatusSchema` is added to `packages/contracts`.** Today the job
  status is consumed via `OutboundJobRow['status']` (Drizzle row type) inside the outbound-mail
  module — not a live cross-boundary violation (all `OutboundJobRow` consumers are internal to the
  module), but the precedent matters: the architecture rule says cross-boundary types come from
  `contracts`. CAP-030 closes the precedent **before** it can materialise with a closed zod enum
  + derived type, mirroring `messageStatusSchema`. (Architecture review MEDIUM finding softened
  from "fixes drift" to "forward-availability" — the drift is potential, not actual.)
- **D-CAP-030-F — `sent → delayed` on a message is allowed.** A late provider `delayed` event
  after `sent` is a temporary provider-side state, not a regression. R-MESSAGE-006's
  parenthetical "(or terminal)" is read as "any forward path"; rank-aware behaviour
  (`sent` rank 20 → `delayed` rank 60) is preserved.
- **D-CAP-030-G — Plain `Error` (not `DomainError`) for `assertCanTransition`.** This is a
  programmer-error guard, not a user-facing 409. Same pattern as `statusRank` at
  `packages/contracts/src/index.ts:172`. The HTTP layer never sees it; SQL writers return
  `false` on direction rejection (silent no-op, like CAP-029 rank rejection). No new catalog
  entry needed.

## Open questions

None as of contract sign-off. The retry-reset, the `sent → delayed` forward path, and the
INSERT bypass all have explicit decisions above; reviewers should not re-litigate them without
new evidence.
