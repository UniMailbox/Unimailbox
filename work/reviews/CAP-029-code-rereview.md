# CAP-029 — Code Re-review

> Code re-review of H-class fixes (H1, H2) and M-class fixes (M1, M3, Arch M1) applied under time pressure during the CAP-029 review-triage cycle.

**Reviewer:** code-reviewer (fresh subagent) · **Date:** 2026-08-15 · **Base:** `cap/CAP-020-026-business-loop` (uncommitted)

**Status:** ACCEPT WITH FIXES

## Summary

The H-class fixes are sound. The format-based timestamp discriminator in `extractBrevoEventTimeMs` correctly handles all six input-shape categories (undefined/null, string, integer ms, integer seconds, fractional, other types) and never silently treats a plausible-seconds value as already-in-ms. The `cause` chain in `RetryableProviderError`/`TerminalProviderError` is the standard ES2022 Error pattern with `super(message, options)` and is not shadowed by a class-field redeclaration. The M-class fixes hold up against the acceptance criteria they were written for. One MEDIUM finding exists: the webhook-delivery INSERT and the `messages` UPDATE are not in a single D1 batch, so a worker crash between them leaves an applied status change with no audit row. Recommend recording a follow-up capability before acceptance; not blocking today because the audit-trail completeness invariant is not in `R-*` for this slice.

## BLOCKER

> Empty — leave empty when there are no findings.

## HIGH

> Empty — leave empty when there are no findings.

## MEDIUM

### M1 — Webhook delivery INSERT and `messages` UPDATE are not in a single D1 batch

- **Where:** `apps/worker/src/modules/outbound-mail/webhook-processor.ts:166-198`
- **Violates:** `R-OUTBOUND-006`-style atomicity expectation (audit row writes should land in the same transaction as the state transition they describe)
- **Failure scenario:** A `delivered` event arrives; signature verifies; `updateMessageStatus` applies (rank 80 wins the predicate over the previous rank-20 `sent`); the worker is killed (or the isolate is reaped) before line 189's `createWebhookDelivery` runs. The state transition is persisted with no `webhook_deliveries` row recording it. An operator looking at the audit log sees the prior `sent` delivery and a gap; the actual `delivered` transition has no audit trail.
- **Fix:** Wrap the `updateMessageStatus` call and `createWebhookDelivery` call in a single `db.batch([...])` so they apply atomically. Two trade-offs to weigh before merging:
  1. The `updateMessageStatus` predicate depends on the *current* `messages` row state, which `db.batch` reads inside the same transaction. That is fine here — the batch is still atomic against the row, and a concurrent webhook would lose the race, which is the desired behaviour (one winner, the predicate rejects the loser).
  2. `db.batch` does not return per-statement row counts in older D1, so the boolean from `updateMessageStatus` cannot drive the "applied or rejected" log line. The pattern would need a small adjustment: instead of branching on the result, log the delivery row's `event_time` + `event_type` and let the operator correlate via `messages.status` history if needed.

  Defer to a follow-up capability (CAP-NNN) and record the reason in the ledger — this is not a blocker for CAP-029 because the audit-trail completeness invariant is not in scope for this slice (CAP-029 owns the *ordering* invariant, not the *atomicity* invariant).

## LOW

### L1 — `extractBrevoEventTimeMs` is not exported for testing in isolation

- **Where:** `apps/worker/src/modules/outbound-mail/webhook-processor.ts:230-261`
- The function is the canonical answer to the H1 review finding, and the worker test (`webhooks.worker.test.ts:538-652`) exercises it indirectly through the route handler. The six input-shape categories are covered by that test, but the function itself is private to the module.
- **Fix:** None needed today. If a future capability needs to test additional formats (e.g. microsecond precision from a new provider), extract `extractBrevoEventTimeMs` into a `packages/contracts` or `packages/email-core` helper with its own unit-test file. The current arrangement is correct under the architecture rules ("import anything but a module's `index.ts`" — the unit-test file in the same directory is allowed).

## Not verified

- **Concurrent D1 serialisation claim in `updateMessageStatus` doc-comment.** The doc says "D1 serialises per row" (message-repository.ts:179). The worker pool with real D1 bindings does not expose a way to inject two concurrent writes and assert ordering, so the claim is plausible but not directly testable in this code base. The Arch M1 test (`message-repository.worker.test.ts:238-270`) does pin the SQL CASE against `STATUS_RANK_TABLE` for every `[status, rank]` pair, which is what the contract actually requires.
- **Provider HTTP retry behaviour.** The Brevo adapter tests stub `fetch`; real Brevo retry semantics (Retry-After headers, idempotency-key handling) are out of scope for this code review.
- **D1 batch return-shape for `updateMessageStatus` boolean.** The doc-comment in `message-repository.ts:178-182` describes the function as "single D1 statement" — this is true today. If the M1 fix above moves it into a batch, the boolean return path needs re-design. Verified the current shape, not the future shape.

## Required fixes

1. M1 — record a follow-up capability in the ledger for atomic webhook-delivery + messages-status writes; do not block CAP-029 acceptance.

---

## Verification details

### H1 — format-based timestamp discrimination

`apps/worker/src/modules/outbound-mail/webhook-processor.ts:230-261`

- Threshold `SECONDS_MS_THRESHOLD = 1e10` (year 2286 sentinel) — verified at line 254.
- Fractional rejection via `!Number.isInteger(raw)` — verified at line 247.
- String path via `Date.parse`, rejects `NaN-Infinity` and `<= 0` — verified at lines 239-244.
- Other types (boolean, bigint, object, undefined, null) route to server fallback — verified at lines 234, 259-260.
- Server fallback recorded as `source: 'server'` — verified at line 235.
- Worker-pool test coverage at `apps/worker/src/http/routes/webhooks.worker.test.ts:538-652` exercises all six input shapes.

### H2 — `cause` not in `error.message`

`apps/worker/src/integrations/providers/brevo.ts:160-197`

- Body attached via `{ cause: body ? new Error(...) : undefined }` — verified at lines 168-170, 179-181, 191-193.
- Empty body → no cause — verified at the `body ?` guard.
- Unit-test coverage at `apps/worker/src/integrations/providers/brevo.test.ts:39-87` asserts the body is NOT in `err.message` and IS in `err.cause`.
- `packages/contracts/src/index.ts:210-235` — `cause` is NOT redeclared as a class field; the explicit comment at lines 213-216 calls out the `useDefineForClassFields: true` shadowing trap and `super(message, chainCause(options))` correctly threads it.

### M1 — unknown Brevo events skip status update

`apps/worker/src/modules/outbound-mail/webhook-processor.ts:50-67, 166-182`

- `mapEventToMessageStatus` returns `null` for unknown events — verified at line 65.
- Caller branches on `if (status !== null)` at line 172 — skips `updateMessageStatus` but still sets `messageId` (line 170) so the delivery row links correctly (lines 188-198).

### M3 — `SeedOptions.maxAttempts` + B6c test

`apps/worker/src/modules/outbound-mail/process-outbound-job.worker.test.ts:61-104, 442-459`

- `SeedOptions` interface declares `readonly maxAttempts?: number` — verified at line 64.
- `seedJob` honours `opts.maxAttempts ?? 3` — verified at line 100.
- B6c test (line 442-459) seeds `attempts: 1, maxAttempts: 2`, throws a bare `Error('parse failed: missing closing brace')`, asserts `status === 'failed'`, `attempts === 1` (terminal path does not increment), `error_code === 'SEND_FAILED'`.

### Arch M1 — SQL CASE rank predicate consistency test

`apps/worker/src/modules/messages/message-repository.worker.test.ts:230-270`

- Iterates `STATUS_RANK_TABLE` (verified at line 244).
- Seeds each `[seedStatus, rank]` at `provider_event_time = 500`, then applies a same-time `delivered` (rank 80).
- Asserts `applied === (rank < 80)` and the row reflects the outcome.
- Guards against a false-positive "predicate accepts but row not updated" by also reading the row.

### Contracts drift-pin — `STATUS_RANK_TABLE` tuple shape

`packages/contracts/src/index.ts:155-165` exports `ReadonlyArray<readonly [MessageStatus, number]>` with `[status, rank]` ordering.

`packages/contracts/src/index.test.ts:1184-1227`:

- Line 1208 iterates `for (const s of messageStatusSchema.options)` for the closed-enum accept-list.
- Line 1214-1216: `expect(STATUS_RANK_TABLE).toEqual(EXPECTED_PAIRS)` pins the exact `[status, rank]` pairs.
- Lines 1218-1226: terminal-rank check uses `[s, rank]` and `[, rank]` destructuring matching the `[status, rank]` export order. The implementer's fix to the previous `[rank, status]` bug is correct.

### Concurrency / atomicity

- `updateMessageStatus` (`apps/worker/src/modules/messages/message-repository.ts:193-245`) is a single D1 statement with the rank predicate inside the `WHERE` clause. No read-compute-write window exists. D1 serialises per row, so two concurrent webhooks for the same `messageId` resolve cleanly: one wins the predicate, the other gets `(changes ?? 0) === 0` and returns `false`. Verified.
- `findJobByProviderMessageId` (`apps/worker/src/modules/outbound-mail/webhook-repository.ts:139-150`) is a single SELECT that returns `message_id` atomically with the connection scope. No TOCTOU window: the lookup and the `UPDATE messages` are separate statements, but the predicate handles the race by design. Verified.
- `webhook_deliveries` INSERT and `messages` UPDATE are separate statements (webhook-processor.ts:174, 189). This is the M1 finding above.

---