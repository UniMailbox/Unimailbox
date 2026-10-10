# CAP-028 — Durable outbox: lease, attempts, reclaim

**Phase:** 2 · **Status:** Implemented · **Started:** 2026-08-15 · **Closed:** 2026-08-15

## Goal

An outbound job survives a consumer crash mid-send: the lease expires, a scheduled
dispatcher reclaims the row, `attempts` increments, and the job eventually succeeds
or reaches a terminal `failed` state. Today the `outbound_jobs` row goes `sending`
unconditionally and never comes back if the consumer dies between the status write
and the provider call.

## Scope

- Atomic `claimOutboundJob`: `queued → sending` only when no live lease is held.
  Returns `null` when another worker is processing the row (R-OUTBOUND-007).
- `processOutboundJob` calls `claimOutboundJob` first with a per-invocation
  `lockedBy` UUID; if the claim returns `null`, the consumer throws so the queue's
  `msg.retry()` applies and the lease expiry is the eventual backstop.
- Lock-holding writes (`markOutboundJobSent`, `markOutboundJobRetryable`,
  `markOutboundJobTerminal`) update the row **only when `locked_by` matches** the
  caller. A reclaim that already grabbed the row means a stale worker cannot
  overwrite a recovered row.
- Scheduled dispatcher: `reclaimStaleOutboundJobs` re-queues rows whose lease has
  expired. If `attempts >= max_attempts` it sets `failed`; otherwise it resets to
  `queued` (clears `locked_at` + `locked_by`, no `attempts++`).
- Hardcoded lease-TTL constant in `apps/worker/src/platform/outbox-config.ts`
  (60s default, derived `leaseCutoff(now)` helper).
- Cron wiring in `apps/worker/wrangler.jsonc`: a `*/2 * * * *` trigger on the
  scheduled entrypoint, paired with the test-config override.
- Tests at every layer: repository functions (worker pool against real D1),
  use-case state-machine guards, scheduled dispatcher reclaim scenarios.

## Out of scope

- **Webhook-driven state transitions** (`bounced`, `complained`, `delayed`). CAP-029
  owns the `webhook_deliveries` lock and the consumer that converges the row with
  the provider's authoritative status. CAP-028 does not touch
  `webhook-processor.ts`.
- **State-machine guards beyond `sent`/`failed` terminals**. CAP-030 owns the
  per-transition audit hooks and the matrix of forbidden transitions.
- **Maintenance module cron targets** (TTL purge of `idempotency_records`,
  re-encryption of `encrypted_credentials`). These are separate capabilities;
  the scheduled entrypoint is *populated* here but the entrypoint surface stays
  a thin shell.
- **Backoff policy on the queue's `max_retries`.** The Cloudflare Queues
  retry/backoff for `msg.retry()` is unchanged; lease-TTL reclaim is the
  in-D1 recovery path, not the queue retry policy.
- **Per-job backoff scheduling** (e.g. `attempts * 5s` delayed re-queue). The
  scheduled dispatcher runs every 2 minutes; that cadence IS the backoff.

## Business rules

| Rule ID | What it means for this slice |
|---|---|
| `R-OUTBOUND-007` | A job can only be processed by one consumer at a time. The claim is atomic; subsequent writes check `locked_by`. |
| `R-OUTBOUND-008` | A retryable error increments `attempts` and returns the row to `queued` (clearing lock); a terminal error sets `failed` permanently. |
| `R-OUTBOUND-009` | A `sent` job is provably terminal — no reclaim, no retry, no overwrite. The claim returns `null` for any non-`queued` row. |
| `R-OUTBOUND-006` | The message + outbound_jobs + (deferred) idempotency batch from CAP-023 is unchanged here. CAP-028 writes lock columns only. |

Source: `docs/rebuild/02-business-discovery/business-rules.md` (lines 76-78).

## Acceptance criteria

- [x] **AC1 — Atomic claim.** `claimOutboundJob(db, jobId, lockedBy, leaseUntil)`
      executes an `UPDATE outbound_jobs SET status='sending', locked_at=?, locked_by=?
      WHERE id=? AND status='queued' AND (locked_at IS NULL OR locked_at < ?)` and
      returns the updated row, or `null` if no row matched. Tests cover:
      (a) `queued` + no lease → row returned, columns updated;
      (b) `sending` + live lease → `null`, columns unchanged;
      (c) `sending` + expired lease → `null` — the **reclaim path** (AC6) owns the
          `sending → queued` recovery transition, so a claim never steals an
          expired lease directly. This closes a claim/reclaim race: if the claim
          could take the row while `status='sending'`, the cron reclaim and a
          queue redelivery would both be able to re-drive the same row without
          the `locked_by` predicate protecting either. (Wording reconciled at
          implementation: the original draft said "lease stolen" — rejected.)
      (d) `sent` → `null` (terminal);
      (e) `failed` → `null` (terminal).
- [x] **AC2 — Use case claims first.** `processOutboundJob` performs only the
      idempotent already-sent skip read (R-OUTBOUND-009) before calling
      `claimOutboundJob`; the claim is the first *write* and precedes all other
      reads. If the claim returns `null`, the function
      throws a typed error (the queue consumer's catch block retries). Already-sent
      rows return silently without a provider call (R-OUTBOUND-009, at-least-once
      idempotency).
- [x] **AC3 — Lock-holding success write.** On successful provider send,
      `markOutboundJobSent(db, jobId, lockedBy, providerMessageId)` writes
      `status='sent', provider_message_id=?, locked_at=NULL, locked_by=NULL
      WHERE id=? AND status='sending' AND locked_by=?`. The function returns a
      boolean (rows-affected); on `false` the use case logs a `warn` — a
      stale-worker race where the row was already resolved by a reclaim
      (adjudicated at review triage: surfaced as a warn, not an error).
- [x] **AC4 — Retryable failure.** On a `RetryableError` from the adapter,
      `markOutboundJobRetryable(db, jobId, lockedBy, errorCode, errorMessage)`
      writes `status='queued', attempts=attempts+1, error_code=?, error_message=?,
      locked_at=NULL, locked_by=NULL WHERE id=? AND status='sending' AND
      locked_by=?`. Use case rethrows so the queue retries; reclaim is the
      backstop if the consumer dies.
- [x] **AC5 — Terminal failure.** When `attempts + 1 >= max_attempts`, the failure
      path uses `markOutboundJobTerminal` instead of `markOutboundJobRetryable`.
      The row is `status='failed'` permanently. `use case` does **not** rethrow
      on terminal failure (the job is `acked`, not `retried`).
- [x] **AC6 — Scheduled reclaim.** `reclaimStaleOutboundJobs(db, leaseCutoff)`:
      1. selects `id, attempts, max_attempts` for rows where
         `status='sending' AND locked_at IS NOT NULL AND locked_at < ?`;
      2. for each, writes either `status='failed'` (if `attempts >= max_attempts`)
         or `status='queued', locked_at=NULL, locked_by=NULL` (no `attempts++`).
      3. returns `{ reclaimed: number, terminal: number, reclaimedIds: string[] }` —
         counts for the entrypoint to log, IDs for the entrypoint to re-enqueue
         onto the OUTBOUND queue (R-LOG-001: no body bytes, no secrets, the IDs
         are never logged).
- [x] **AC7 — Scheduled entrypoint wires it.** `entrypoints/scheduled.ts`
      invokes the reclaim at the start of every cron tick. The function is
      idempotent and safe under cold-start race (no `attempts++` on reclaim).
- [x] **AC8 — Cron binding in `wrangler.jsonc`.** Production config has
      `triggers.crons = ['*/2 * * * *']`. Test config (`wrangler.test.jsonc`)
      has the same trigger so the worker-pool test scheduler can invoke it.
- [x] **AC9 — State-machine guards.** Tests assert forbidden transitions are
      impossible at the repository layer:
      `claimOutboundJob` against a `sent` row returns `null`;
      `claimOutboundJob` against a `failed` row returns `null`;
      `markOutboundJobSent` with mismatched `lockedBy` is a no-op.

## Vertical slice

Layers this touches, in dependency order:

- [x] domain — `apps/worker/src/platform/outbox-config.ts` (NEW — lease TTL constant + `leaseCutoff` helper)
- [x] repository — `apps/worker/src/modules/outbound-mail/job-repository.ts` (add `claimOutboundJob`, `markOutboundJobSent`, `markOutboundJobRetryable`, `markOutboundJobTerminal`, `reclaimStaleOutboundJobs`, `isJobTerminal`)
- [x] use case — `apps/worker/src/modules/outbound-mail/process-outbound-job.ts` (replace unconditional `updateJobStatus(..., 'sending')` with claim-then-update flow)
- [x] use case — `apps/worker/src/modules/outbound-mail/reclaim-stale-jobs.ts` (NEW — thin orchestrator wrapping `reclaimStaleOutboundJobs` + logging)
- [x] entrypoint — `apps/worker/src/entrypoints/scheduled.ts` (populate stub — call `reclaimStaleJobs(env.DB, leaseCutoff)`)
- [x] module re-export — `apps/worker/src/modules/outbound-mail/index.ts` (export the new public functions)
- [x] config — `apps/worker/wrangler.jsonc` (add `triggers.crons = ['*/2 * * * *']`)
- [x] config — `apps/worker/wrangler.test.jsonc` (same cron binding)
- [x] tests — `apps/worker/src/modules/outbound-mail/job-repository.worker.test.ts` (NEW — AC1, AC3, AC4, AC5, AC9)
- [x] tests — `apps/worker/src/modules/outbound-mail/process-outbound-job.worker.test.ts` (extend — AC2, terminal skip, stale-worker no-op)
- [x] tests — `apps/worker/src/modules/outbound-mail/reclaim-stale-jobs.worker.test.ts` (NEW — AC6)
- [x] tests — `apps/worker/src/entrypoints/scheduled.worker.test.ts` (NEW — AC7)

New module dependency edges introduced: **none.** All edits stay inside
`modules/outbound-mail/*` (with a single new platform constant in
`apps/worker/src/platform/outbox-config.ts`) and the `entrypoints/scheduled.ts`
shell. No new edges to `modules/*`, `integrations/*`, or `packages/contracts`.

## File ownership

One writer per file. Reading anything is fine; writing outside your list is not.

| Agent | Owns |
|---|---|
| implementer-1 | All files listed in the vertical slice above. **No other agent writes files in this slice.** |

## Reading list

Give the implementer exactly this — not the whole `docs/` tree.

- `CLAUDE.md` (orchestrator entry point; execution model)
- this file (`work/active/CAP-028-durable-outbox/task.md`)
- `.claude/agents/implementer.md` (implementer role + report format)
- `.claude/rules/architecture.md` §Modules (outbound-mail dependency edges) and §API conventions
- `.claude/rules/coding.md` (Rule of Three; naming; errors; comments)
- `.claude/rules/testing.md` (worker-pool tests against real D1; invariants by rule ID; forbidden transitions)
- `.claude/rules/security.md` §Idempotency (ADR-004 — the batch shape CAP-023 already uses)
- `docs/rebuild/09-decisions/ADR-003-durable-outbox.md` (the design contract)
- `docs/rebuild/02-business-discovery/business-rules.md` (`R-OUTBOUND-006`, `R-OUTBOUND-007`, `R-OUTBOUND-008`, `R-OUTBOUND-009`)

## Dependencies

- Requires: CAP-023 (outbound jobs table + `updateJobStatus` foundation) — **Implemented**
- Requires: CAP-014 (Brevo provider adapter + `OutboundProviderAdapter` interface) — **Implemented**
- Blocks: CAP-029 (webhook ordering — the `webhook-processor.ts` will land its terminal-status writes on top of the same `sent` / `failed` invariants CAP-028 proves)
- Blocks: CAP-030 (state machine guards — the audit hooks for terminal transitions will read `isJobTerminal`)

## Decisions made during this capability

(Append as the implementer goes. Each gets promoted at close: a rule, an ADR, the
implementation log, or deleted as not load-bearing.)

- **Lease TTL: 60 seconds.** Hardcoded constant `OUTBOX_LEASE_TTL_MS = 60_000` in
  `platform/outbox-config.ts`. Chosen to be at least 10× the expected
  single-job send duration (Brevo send + decrypt + persist takes <1s in tests;
  60s is two orders of magnitude of headroom). Raising it later is a one-line
  constant change; lowering it requires a migration of the cron cadence.
- **Cron cadence: every 2 minutes.** Matches the lease TTL: in the worst case
  a stale row is reclaimed 2 minutes after the lease expires. Cloudflare
  Workers free plan supports cron triggers; the binding sits on
  `entrypoints/scheduled.ts`.
- **`lockedBy` is a per-invocation UUID.** Generated by `platform/ids.ts`
  inside `processOutboundJob`, passed through to every lock-holding write.
  This is what makes the `locked_by = ?` predicate in the UPDATEs actually
  catch a stale worker (a fixed string would only catch the wrong instance).
- **No new migration.** `outbound_jobs.locked_at` + `locked_by` already exist
  from CAP-023 / `migrations/0007_outbound_jobs.sql`. CAP-028 only writes to
  those columns.
- **No new error code.** The reclaim path is internal — its `0 rows updated`
  result is logged (R-LOG-001 safe; no bodies, no tokens) and the next cron
  tick handles it. No `DomainError` surfaces to a route.

- **Review triage adjudications (2026-08-15, orchestrator).**
  - **AC3 reconciled:** a stale worker must not throw, so `markOutboundJobSent`
    returns a boolean (rows-affected) and the use case logs a `warn` on a 0-rows
    result — the job was resolved by whoever stole the lock, and the
    message/job status divergence is recorded in logs, not surfaced as an
    error. Original AC wording "surfaced as an error" replaced below.
  - **AC2 reconciled:** the pre-claim read exists solely for the idempotent
    already-sent skip (R-OUTBOUND-009). The claim is the first *write* and
    precedes all other reads.
  - **Reclaimed rows are re-enqueued.** The scheduled path pushes each
    reclaimed job ID onto the OUTBOUND queue after the reclaim, so recovery
    does not depend on the queue consumer's redelivery budget. The reclaim
    returns the reclaimed IDs for this purpose; they are never logged
    (R-LOG-001).
  - **`TERMINAL_FAILURE` sentinel deleted.** No adapter emits it; terminal
    routing happens via attempts exhaustion only. Real adapter-level
    Retryable/Terminal classification is deferred to CAP-029 (recorded in the
    ledger).
  - **Pre-existing cross-module `messages` write in
    `process-outbound-job.ts`** (CAP-023 legacy, flagged by architecture
    review M3) is recorded as a ledger follow-up; not fixed in this slice.

- **Orphan sweep (fix-round re-review F1, 2026-08-15).** A reclaimed row whose
  re-enqueue failed sat in `queued` forever (the reclaim only scans `sending`).
  The cron now sweeps `queued` rows older than
  `OUTBOUND_ORPHAN_SWEEP_AFTER_MS = 300_000` (5 min — comfortably past the
  lease TTL + cron cadence, so a healthy fresh queued row is never swept) and
  re-enqueues each in the same `JSON.stringify({ jobId })` body format. A
  double enqueue (sweep racing a live delivery) is safe by construction: the
  atomic claim has exactly one winner (R-OUTBOUND-007), the loser hits the
  pre-claim `sent` skip (R-OUTBOUND-009), and the provider call carries the
  message ID as its idempotency key (R-OUTBOUND-004). Per-send failures warn
  and continue; the next tick retries the sweep.

## Open questions

- (none — design fits inside the slice; out-of-scope items have owners)