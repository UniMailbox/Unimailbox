# CAP-029 — Architecture Review

**Reviewer:** architecture-reviewer · **Date:** 2026-08-15 · **Base:** `cap/CAP-020-026-business-loop` (uncommitted)

**Status:** ACCEPT WITH FIXES

## Summary

The diff is architecturally sound. The four converging concerns land on the correct
edges (`outbound-mail → messages` for the cross-module write; provider SDK boundary
for the error taxonomy; queue consumer for the retryable/terminal decision). The
single substantive concern is **the SQL `CASE` statement in `updateMessageStatus`
duplicates `STATUS_RANK_TABLE` in `packages/contracts`** — a real single-source-of-truth
risk that the author already flagged with an inline comment, but one I want a
concrete mitigation for (either a migration-time check or an integration test
that walks the enum).

## BLOCKER

> Empty — none. No architectural rule is violated.

Dependency direction is correct (`outbound-mail → messages` per
`.claude/rules/architecture.md` §Dependency direction, Allowed table). Both new
importers use `'../messages'` (the module index), never internals — verified by:

```
apps/worker/src/modules/outbound-mail/process-outbound-job.ts:48
apps/worker/src/modules/outbound-mail/webhook-processor.ts:24
```

Drizzle row types do not cross module boundaries: a grep for `@unimailbox/db`
imports under `apps/worker/src/modules/` and `packages/contracts/src/` returns
zero matches. No Hono / Cloudflare SDKs are imported into module code (the two
`@cloudflare/workers-types` imports in `outbound-mail` are for the `D1Database`
type binding — not a provider SDK, not a finding for this capability). No
provider SDK is imported outside `integrations/` — `brevo.ts` is the only
adopter and it is the correct home.

The messages write is now consolidated through one public function
(`updateMessageStatus`); a grep for `UPDATE messages` outside
`message-repository.ts` returns only the doc comment line at `:185`. This is
the D-CAP-028-D invariant satisfied in code, not just declared.

## HIGH

> Empty — none. R-MESSAGE-007 is implemented as a single D1 statement whose
> predicate is exercised end-to-end against real D1 in
> `message-repository.worker.test.ts` (8 cases: A1, A2, A3, A4, equal-time-tied,
> equal-time-lower-rank, strictly-newer-of-any-rank wins, sent_at COALESCE) and
> against the route in `webhooks.worker.test.ts` (A2, A3, A4, A5 plus the
> server-fallback audit row). No race window is left open: the rank + event-time
> gate runs in one `UPDATE` so SQLite's per-row write serialisation resolves
> concurrent webhooks for the same message (A6).
>
> D-CAP-028-A is satisfied at the right boundary: every provider failure path
> in `apps/worker/src/integrations/providers/brevo.ts` ends in a typed
> `RetryableProviderError` or `TerminalProviderError`, and `setup.ts:707-731`
> consumes those via `isProviderError()` (type guard from contracts) — the
> boundary is the SDK call site in the adapter, not the queue consumer.
>
> D-CAP-028-C is satisfied: `updateJobStatus` (the unconditional writer from
> CAP-023) has been removed in favour of the predicate-bound writers
> (`markOutboundJobSent` / `markOutboundJobRetryable` / `markOutboundJobTerminal`),
> all of which carry `WHERE locked_by = ?`. See the diff entry for
> `process-outbound-job.ts` lines 297-303 (the previous unconditional
> `UPDATE messages SET status = 'sent'` is gone).

## MEDIUM

### M1 — `STATUS_RANK_TABLE` duplicated as a SQL `CASE` statement

- **Where:**
  - `packages/contracts/src/index.ts:149-159` (`STATUS_RANK_TABLE`)
  - `apps/worker/src/modules/messages/message-repository.ts:218-229`
    (`CASE status WHEN 'failed' THEN 100 ...`)
- **Violates:** `.claude/rules/architecture.md` §Shape (one source of truth per
  fact; the `STATUS_RANK_TABLE` is the fact here), `.claude/rules/coding.md`
  §Abstraction discipline. The author's own comment at
  `message-repository.ts:198-201` acknowledges: *"The literal defaults are
  mirrored exactly; if STATUS_RANK_TABLE changes, update here too."* A manual
  sync comment is a known smell.
- **Failure scenario:**
  1. A future capability adds `'deferred'` (or any new closed-enum value) to
     `messageStatusSchema` (contracts) and `statusRank()` table.
  2. The reviewer / implementer forgets the SQL `CASE`.
  3. The new status is accepted by zod, falls through the `ELSE -1` branch in
     SQL, and the rank gate silently treats every stored `'deferred'` row as
     rank `-1`. Any later update with rank ≥0 promotes — including a strictly
     older event from a webhook — because the stored value's rank comparison
     collapses to "always less than anything".
  4. R-MESSAGE-007's terminal-state-promotion guarantee is broken for the new
     status with no test failure (the existing tests only cover the nine
     statuses already in the table).
- **Why defensible:** SQL cannot call TypeScript, so a literal `CASE` is the
  only way to express the rank comparison inside a single D1 statement (the
  rank-aware predicate is the entire point of the consolidation). The author's
  comment is honest about the coupling.
- **Fix (smallest acceptable):** Add a unit test in
  `packages/contracts/src/` (or `message-repository.worker.test.ts`) that
  asserts `STATUS_RANK_TABLE` covers every `MessageStatus` exactly once AND
  mirrors the SQL `CASE`. Two viable shapes:
  - **Option A — extraction.** Move the rank literals into a single `.ts`
    constant exported from contracts as both the runtime `STATUS_RANK_TABLE`
    and a `STATUS_RANK_SQL_CASE` string fragment, then build the SQL statement
    from that fragment. One source of truth; the diff can be a `+=` line when
    a status is added.
  - **Option B — guard test.** A unit test that lists every `MessageStatus`
    and asserts the SQL `CASE` includes a `WHEN '<status>' THEN <rank>` arm
    matching `STATUS_RANK_TABLE`. A new status without a SQL update trips the
    test, not production.
  - Option A is the architecturally pure fix. Option B is the smallest correct
    fix. Either is acceptable; the author picks.

## LOW

### L1 — Magic-number epoch-ms threshold

- **Where:** `apps/worker/src/modules/outbound-mail/webhook-processor.ts:206`
- **Pattern:** `const asMs = candidate > 1e12 ? candidate : candidate * 1000;`
- **Concern:** `1e12` is a heuristic distinguishing seconds-since-epoch from
  milliseconds-since-epoch. It works for any timestamp after 2001-09-09
  (the 1e12 s mark), which is the entire relevant range — but a bare literal
  does not explain itself. Future maintainers will wonder.
- **Fix:** A named constant — `const MS_THRESHOLD = 1e12;` or, better, a
  constant with the unit in the name:
  ```ts
  // A value > this many is already ms (post-2001-09-09); below is seconds.
  const EPOCH_MS_THRESHOLD = 1e12;
  ```
  Cheap and self-documenting. Optional.

### L2 — Brevo-specific heuristic lives in `outbound-mail`

- **Where:** `apps/worker/src/modules/outbound-mail/webhook-processor.ts:190-210`
  (`extractBrevoEventTimeMs`)
- **Concern:** The `candidate > 1e12` heuristic is Brevo-shape knowledge
  bleeding into the dispatcher. A second provider with a different event
  shape will require a second heuristic.
- **Why acceptable now:** The same file already holds `mapEventToMessageStatus`
  with the same Brevo-shape coupling. ADR-002 (provider-adapter registry)
  pre-approves per-provider dispatch, and Brevo is the only implemented
  provider. Resolving this is a follow-up capability when a second provider
  ships, not this one. Recording as LOW.

## Not verified

- **Migrations / D1 column semantics.** I read `0011_message_event_time.sql`
  and `0012_webhook_event_time.sql` to confirm the new columns exist; I did
  not run `scaffold doctor` or `migrations verify` (those run via the
  test/worker scripts that the code / QA reviewers will execute). My
  architecture call — that `provider_event_time INTEGER` matches the TS
  contract (ms epoch, nullable) — depends on a working migration apply.
- **Worker-pool integration beyond the new tests.** I read the new
  `message-repository.worker.test.ts` and the ordering tests in
  `webhooks.worker.test.ts`. I did not exercise the broader regression
  surface (smoke / business-loop). The test-business-loop skill is the
  authoritative runner for that.
- **Cross-process ordering.** R-MESSAGE-007 says "newer" — across separate
  worker invocations the predicate is correct *per-row*. A pathological
  case where the same message receives a webhook before the queue
  consumer has finished its post-send write is still bounded: the
  consumer's write is the higher-rank one (`'sent'`, rank 20) only after
  the webhook has already applied a higher-rank terminal (`'bounced'`,
  rank 100), in which case the consumer's write is correctly rejected
  by the predicate. The reverse (terminal webhook after consumer's
  `'sent'`) is also correctly rejected. The unit tests cover both.

## Required fixes

1. **M1** — Consolidate `STATUS_RANK_TABLE` ↔ SQL `CASE` (Option A or B above).
   Smallest acceptable: the Option B guard test in
   `packages/contracts/src/message-status.test.ts` (new file).
2. **L1** — Name the `1e12` threshold. Cheap; do it while in the file.

---

## Positives worth recording in the ledger

- The boundary ownership is correct. `webhook_deliveries` and
  `provider_message_state` stay in `outbound-mail` (the integration owner per
  architecture §Persistence ownership). The `messages` write is no longer
  written from `outbound-mail`; it goes through the messages-module public
  surface.
- No new abstraction was introduced without three call sites. `updateMessageStatus`
  has three: `process-outbound-job` success path, `webhook-processor` event
  handler, and the new worker-pool test file. The rule of three is met.
- The error taxonomy is closed at the right seam. `RetryableProviderError`
  / `TerminalProviderError` are declared in `packages/contracts` (the only
  types crossing module boundaries per architecture §Dependency direction),
  thrown only by adapter code, and consumed by the queue consumer via the
  exported `isProviderError()` type guard. No SDK symbol escapes `integrations/`.
- The 1 MB body limit and zod validation are unchanged and untouched —
  CAP-029 stays inside its lane.
- `extractBrevoEventTimeMs` returns both the resolved ms *and* the source
  (`'provider' | 'server'`), and the delivery row records both. That audit
  trail is what makes "why was this status not applied?" answerable later,
  which is the point of CAP-029's observability contract.
- The two migrations (`0011`, `0012`) are additive `ALTER TABLE ... ADD
  COLUMN` with no destructive changes, matching the convention.

## Risks I am explicitly accepting

- **M1** above. The SQL `CASE` is a real duplication; I am not blocking on
  it because the author's inline comment is honest about the coupling and
  a unit test (Option B) is a single-file fix. The orchestrator decides
  whether to ship the test or land the extraction.
- **L2** above. Provider-specific heuristic in the dispatcher is the right
  call for one provider; it becomes an MEDIUM if a second provider ships
  without consolidating the dispatch into per-provider adapters.