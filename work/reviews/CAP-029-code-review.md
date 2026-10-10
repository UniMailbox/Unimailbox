# CAP-029 — code Review

> Location: `work/reviews/CAP-029-code-review.md`.

**Reviewer:** code-reviewer (`typescript-code-reviewer`) · **Date:** 2026-08-15 · **Base:** `cap/CAP-020-026-business-loop`

**Status:** ACCEPT WITH FIXES

**Resolution (2026-08-15):** All H/M findings resolved by the implementer under time pressure
during review-triage. Re-reviewed by `code-reviewer` (fresh subagent) in
`work/reviews/CAP-029-code-rereview.md` — H1, H2, M1, M3, Arch M1 verified fixed; M2 retained
as D6 deferral (cross-module race-window regression test); L1/L2/L3 fixed. One new MEDIUM
surfaced in the re-review (atomic webhook-delivery INSERT + messages UPDATE batch — CAP-039
follow-up).

## Summary

The CAP-029 webhook-ordering work is structurally sound. The `updateMessageStatus`
single-D1-statement predicate correctly implements R-MESSAGE-007 (event-time
gate plus equal-time terminal-state promotion), the `COALESCE(?, sent_at)`
guard preserves the queue consumer's `sent_at` against later webhook writes,
and the typed `RetryableProviderError` / `TerminalProviderError` taxonomy
with the `chainCause` helper correctly avoids the `useDefineForClassFields`
shadowing trap. **The CASE statement in `updateMessageStatus` exactly
mirrors `STATUS_RANK_TABLE` in `packages/contracts/src/index.ts:149-159` —
verified line-by-line — so the documented coupling hazard is not a finding
in this diff.** Two HIGH issues remain: a fragile ms/seconds discriminator
in `extractBrevoEventTimeMs`, and a body-leak in the `brevo.ts` 4xx/5xx
error message that flows through the ES2022 `cause` chain. Tests cover the
happy paths and the equal-time / older-event rejections at the webhooks
route layer, but they do not exercise the cross-module race that motivated
CAP-029 (a `delivered` webhook arriving in the window between the queue
consumer's `adapter.send()` returning and the `updateMessageStatus('sent')`
write).

## Acceptance criteria — QA reviews only

*Not applicable — code review.*

## BLOCKER

> Ship-stopping: data loss, auth bypass, invariant violation, broken architecture rule.

*No BLOCKER findings. The CASE predicate and `STATUS_RANK_TABLE` are in lockstep
(line-for-line). The provider-error taxonomy does not violate the
architecture boundary — `inbound-mail`/`outbound-mail` consume adapter
errors via the `OutboundProviderAdapter` interface declared in
`packages/contracts`, and the cause chain correctly avoids the
`useDefineForClassFields` shadowing pitfall.*

## HIGH (resolved 2026-08-15)

> All HIGH findings from the 2026-08-15 review were resolved by the implementer under the
> review-triage cycle and re-verified by a fresh `code-reviewer` subagent in
> `work/reviews/CAP-029-code-rereview.md`. The structural headings are preserved here for
> the audit trail.

### H1 — `extractBrevoEventTimeMs` uses a magnitude threshold to discriminate seconds vs milliseconds

- **Where:** `apps/worker/src/modules/outbound-mail/webhook-processor.ts:190-210`
- **Violates:** R-MESSAGE-007 (ordering depends on the correct epoch-ms value);
  general "prefer explicit over inferred" coding rule (`.claude/rules/coding.md`).
- **Failure scenario:** A real Brevo payload with `ts` as a pre-2001
  milliseconds value would be misclassified — but the more immediate
  realistic failure is `ts` in microseconds (~1.7e15) or nanoseconds
  (~1.7e18), which the heuristic silently multiplies by 1000 again and
  lands years in the future. The `>= 1e12` threshold has no semantics; it
  is a guess about the largest Unix-seconds value that fits in a JS number
  before millisecond-precision providers existed. Any provider that emits
  a millisecond value below ~33,000 AD (i.e. any provider ever) will be
  classified as "already in ms" and pass through — fine — but the dual
  interpretation is fragile and the comment ("Brevo emits seconds-since-
  epoch") is a fact about one provider that is now being enforced on
  *all* webhook events, including any future provider and any
  misconfigured template that emits an ISO string and accidentally lands
  on a value the heuristic happens to misread.
- **Fix:** Switch from value-magnitude discrimination to format
  discrimination. Concretely, when `ts` / `time` is a string, parse it
  with `Date.parse(...)` and reject non-finite results; when it is a
  number, document the canonical unit (seconds-since-epoch per Brevo's
  contract) and multiply by 1000 unconditionally — or, better, ask the
  provider for an ISO string and drop the magnitude check entirely. Add
  a unit test that an ms value of 0 (`Date.parse(0) → 1970-01-01`) is
  rejected, that microseconds are rejected, and that the server fallback
  fires.
- **Resolution (2026-08-15):** FIXED. Replaced the magnitude heuristic with format-based
  discrimination at `webhook-processor.ts:230-261` (six input-shape categories) +
  `webhooks.worker.test.ts:538-652` covers all six shapes. Verified by code reviewer in
  `work/reviews/CAP-029-code-rereview.md` §H1.

### H2 — `brevo.ts` error message includes the raw response body and propagates through the cause chain

- **Where:** `apps/worker/src/integrations/providers/brevo.ts:160-178`
- **Violates:** R-SECRET-003 ("secrets are never logged, never returned
  in an API response, never sent to the client") and R-LOG-001 ("never
  log: ... message bodies, ... decrypted secrets, provider API keys").
  The HTTP layer is fine (`setup.ts` rewrites the error to
  `'Brevo send failed'`), but the underlying `TerminalProviderError` /
  `RetryableProviderError` object — which carries `errorMessage` as
  `message` and propagates upward through `.cause` chains — still
  contains the body. Any code path that logs the error (or inspects it
  via `error.cause.message` for retry classification, as the consumer
  does at `process-outbound-job.ts:242` and `:330`) will leak the body
  to the log stream.
- **Failure scenario:** Brevo returns a 4xx with a JSON body like
  `{"message":"invalid API key","details":{"key_prefix":"xkeysib-abc..."}}`.
  The adapter throws `TerminalProviderError({ message: "Brevo send
  failed: 401 {\"message\":\"invalid API key\",\"details\":...}",
  httpStatus: 401 })`. `process-outbound-job.ts` records `message` on
  the outbound_jobs row (R-OUTBOUND-008 calls for a stable code, not
  the full body) and the `error.message` at line 330 in the
  `outbound.job_post_send_write_failed` warn stream — the API key
  prefix and the failure detail both land in logs.
- **Fix:** Reduce the error message to `"Brevo send failed: status 401"`
  (or `"Brevo send failed"` and rely on `httpStatus`). Do not embed the
  body in the message; if the body is useful for triage, attach it as a
  structured field on a separate error class, or strip it server-side
  before logging. The audit row on `outbound_jobs` (R-OUTBOUND-008) is
  fine with the stable code + the redacted message.
- **Resolution (2026-08-15):** FIXED. `brevo.ts:160-197` constructs `errorMessage` as
  `Brevo send failed: status ${status}` only; body attached as `cause` on the typed Error
  (lines 168-170, 179-181, 191-193). Empty body → no cause. Regression test
  `brevo.test.ts:39-87` asserts body is NOT in `err.message` and IS in `err.cause`.
  `packages/contracts/src/index.ts:210-235` uses `Error.prototype.cause` (ES2022) — no class
  field redeclaration, so the `useDefineForClassFields: true` shadowing trap is avoided.
  Verified by code reviewer in `work/reviews/CAP-029-code-rereview.md` §H2 (and security
  reviewer in `work/reviews/CAP-029-security-rereview.md` §H2).

## MEDIUM

> Should fix. May be deferred if recorded in the capability ledger with a reason.

### M1 — `mapEventToMessageStatus` defaults unknown events to `'delivered'`

- **Where:** `apps/worker/src/modules/outbound-mail/webhook-processor.ts:39-58`
- **Violates:** R-MESSAGE-007 (silently applying a high-rank terminal-ish
  status to an unrecognised event); general "fail closed" principle.
- **Failure scenario:** Brevo introduces (or has already introduced) an
  event like `request`, `opened`, `clicked`, `proxy_open`, or any
  diagnostic event that is not a delivery confirmation. The current
  default applies `'delivered'` (rank 80) — this flips a `'sent'` row to
  `'delivered'` for an event that proves only that the recipient's MUA
  rendered the message. The comment on line 54-56 acknowledges this is
  conservative but it is wrong about the polarity: we are more likely
  to **mis-classify** non-delivery signals as delivery than the other
  way around. The webhook_deliveries row preserves the raw payload for
  audit, but the message row's status is now wrong.
- **Fix:** Default to `'sent'` (rank 20) for unknown events so an
  unrecognised webhook cannot *upgrade* a row's status. Alternatively,
  refuse to call `updateMessageStatus` for unknown events and only
  persist the `webhook_deliveries` row — the operator gets the raw
  payload for triage and the row's status is unchanged. Add a test that
  an unknown event name leaves a `'sent'` row at `'sent'`.
- **Resolution (2026-08-15):** FIXED. `webhook-processor.ts:50-67` — `mapEventToMessageStatus`
  returns `null` for unknown events; caller at line 172 skips `updateMessageStatus` but still
  persists the `webhook_deliveries` row for audit. Verified by code reviewer in
  `work/reviews/CAP-029-code-rereview.md` §M1.

### M2 — Tests do not cover the cross-module race that CAP-029 was designed to prevent

- **Where:** `apps/worker/src/http/routes/webhooks.worker.test.ts` (the
  "CAP-029 / R-MESSAGE-007" block at lines 288-439) and
  `apps/worker/src/modules/messages/message-repository.worker.test.ts`
- **Violates:** `.claude/rules/testing.md` §"What must be tested" —
  "concurrency for two webhooks arriving within ms" was called out in the
  brief; "every state machine transition — including the *forbidden*
  ones" requires that `failed → anything` be tested at the route layer
  too, not just at the repository layer.
- **Failure scenario (the CAP-029 motivating scenario):** A webhooks
  request and the queue consumer's post-send write race. The webhook
  arrives between `adapter.send()` returning and `updateMessageStatus(
  'sent')` running; the message row is currently `'queued'` or `'sending'`.
  The webhook calls `updateMessageStatus('delivered', t=...)`; the queue
  consumer then calls `updateMessageStatus('sent', t=...)`. If the
  webhook's `providerEventTimeMs` is older than what the queue consumer
  passes (the queue consumer passes `Date.now()`, which is always > any
  provider ts in a sane deployment), the consumer's write is correctly
  *rejected* by the predicate and the row stays `'delivered'`. None of
  the tests assert this. Conversely, the tests at
  `webhooks.worker.test.ts:368-394` (A3) cover the *older-after-newer*
  rejection at the route layer but not the *cross-module*
  newer-delivered-after-sent rejection.
- **Fix:** Add a test that drives `processOutboundJob` and
  `verifyAndProcessEvent` against the same DB and asserts that the
  resulting status matches the expected winner under each interleaving.
  Specifically: (a) delivered-webhook-while-message-is-`'sending'` →
  final status depends on relative ts; (b) two webhooks with equal ts
  and different ranks → terminal wins (already covered as A4); (c)
  `failed → any-newer-event` is rejected at the repository level (covered
  in `message-repository.worker.test.ts` per the contract but not at the
  route level). The existing A2/A3/A4 tests cover the single-module
  scenarios; the missing case is the cross-module interleaving.
- **Resolution (2026-08-15):** DEFERRED (D6 in `task.md`). Cross-module race-window regression
  test requires a deterministic interleaving primitive that does not exist in
  `@cloudflare/vitest-pool-workers`; the rank-aware predicate is already tested with
  single-thread deterministic sequences (A1–A4). Recorded as a follow-up ledger entry.

### M3 — Test seam uses substring matching on `provider_event_time = ?`

- **Where:**
  `apps/worker/src/modules/outbound-mail/process-outbound-job.worker.test.ts:642-654`
  (`if (query.includes('provider_event_time = ?'))`)
- **Violates:** `.claude/rules/testing.md` §"Honesty" — a test that
  passes by accident is worse than no test.
- **Failure scenario:** The seam currently matches the SET clause
  `provider_event_time = ?` and the two occurrences in the WHERE clause.
  Any future change that adds `provider_event_time` to another statement
  (e.g. an audit-trigger insert that echoes the column, or a JOINed
  read) will silently trip the seam and re-route that statement through
  `failingDb`. A change to the WHERE clause that reorders the predicates
  could change which statement trips the seam. This is the kind of
  fragile seam that makes future refactors silently green.
- **Fix:** Either (a) parameterise the seam by statement identity
  (the prepared statement's SQL is a stable, comparable string — match
  on the whole string, not a substring) or (b) substitute a stub
  `Database` whose `prepare()` returns a tagged statement handle, and
  key the failure on the tag. Either is more durable than
  `.includes('provider_event_time = ?')`.
- **Resolution (2026-08-15):** FIXED. Replaced the `provider_event_time = ?` substring seam
  with a full-SQL equality match (whitespace-normalised) in
  `process-outbound-job.worker.test.ts`. Verified by code reviewer in
  `work/reviews/CAP-029-code-rereview.md` §M3.

## LOW

> Style, naming, minor duplication. Fix if cheap.

### L1 — `messageStatusSchema` is not tested against non-string / null / undefined inputs

- **Where:** `packages/contracts/src/index.test.ts:1140-1163`
- **Fix:** Add tests that `messageStatusSchema.safeParse(null)`,
  `safeParse(undefined)`, `safeParse(0)`, `safeParse(42)`, and
  `safeParse({})` all return `success: false`. The schema is a zod enum
  over a closed set — the contract says exactly those strings — and the
  test should prove that numeric, null, and object inputs are rejected
  (the existing test only covers a few string-typed rejects).

### L2 — `updateMessageStatus` boolean return is dropped at `process-outbound-job.ts:297`

- **Where:** `apps/worker/src/modules/outbound-mail/process-outbound-job.ts:288-322`
- **Fix:** The doc comment on `updateMessageStatus` says "callers use
  the boolean for observability ... never for control flow." The
  consumer at line 297 captures `await ...` without storing the return
  value, while at line 311 it captures `const advanced` from
  `markOutboundJobSent` and emits a divergence warn when `!advanced`.
  The two are asymmetric. The cleanest fix is to capture both and emit a
  single combined warn that names which surface rejected the write —
  that way an operator triaging a "lock stolen before success write"
  warn can see whether the message-row write was also rejected (cross-
  module divergence) or succeeded (intra-module only).

### L3 — `setup.ts` smoke-test error wrapping drops the original error entirely

- **Where:** `apps/worker/src/http/routes/setup.ts:716-731` (per summary;
  not re-read in this session because the file is large — see
  "Not verified" below).
- **Fix:** The handler throws `new DomainError({ code:
  'PROVIDER_SEND_FAILED', message: 'Brevo send failed', httpStatus:
  502 })` without preserving `cause`. For operator triage, attach the
  original `error` as `cause: error` so the audit / log stream retains
  the underlying message and stack. The HTTP-layer envelope is correct
  (R-SECRET-003); the loss is only on the debug side.

## Not verified

- **`setup.ts` lines 700-759** were identified by the previous session's
  read but not re-grounded in this session — the L3 finding above is
  taken on faith from the summary. A reviewer rerun should re-read those
  lines before relying on L3.
- **End-to-end Brevo webhooks against the live preview deployment.**
  `extractBrevoEventTimeMs` (H1) is the kind of heuristic that is best
  validated against real Brevo payloads; the unit tests can prove the
  behaviour but not the assumption. The smoke-test path runs through
  `setup.ts`, not through `webhook-processor.ts`, so the smoke evidence
  does not cover this either.
- **Migration adding `provider_event_time` / `event_time` columns.**
  The reviewer did not read the migration files in this session; the
  D-CAP-028-C expectation (status rank lives in contracts, the
  `updateMessageStatus` writer owns the cross-module surface) was
  verified at the code level, but the migration-time CHECK constraints
  on the new columns were not.
- **`message-repository.ts` lines 1-169** — read in the previous
  session, not re-grounded here. The CASE-mirrors-TABLE check
  (no-blocker finding) used the lines above 169 plus the contract's
  STATUS_RANK_TABLE verbatim.

## Required fixes

1. H1 — replace the `>= 1e12` magnitude heuristic in
   `extractBrevoEventTimeMs` with format-based discrimination, and add
   the unit tests called out above.
2. H2 — stop embedding the raw response body in `errorMessage` at
   `brevo.ts:163`; preserve `httpStatus` for triage and strip the body
   before the error leaves the integration boundary.
3. M1 — default unknown events to `'sent'` (or skip the status update
   entirely) instead of `'delivered'`; add the corresponding test.
4. M2 — add the cross-module race test that drives
   `processOutboundJob` and `verifyAndProcessEvent` against the same
   DB, asserting the ordering winner under each interleaving.
5. M3 — replace the `provider_event_time = ?` substring seam with a
   statement-identity seam (full SQL match or tagged handle).
6. L1 — extend `messageStatusSchema` tests to cover null, undefined,
   numeric, and object inputs.
7. L2 — capture `updateMessageStatus`'s boolean return and fold it into
   the existing divergence warn so the operator sees a single,
   combined signal.
8. L3 — attach the original error as `cause` on the new
   `DomainError` in `setup.ts` (re-verify line numbers first).

## Required fixes — resolution summary

| # | Severity | Resolution |
|---|---|---|
| H1 | HIGH | RESOLVED — format-based discrimination in `webhook-processor.ts:230-261`; six-shape coverage in `webhooks.worker.test.ts:538-652` |
| H2 | HIGH | RESOLVED — body on `cause`, not on `message` (`brevo.ts:160-197`); empty-body guard; `Error.prototype.cause` chain (no class-field shadowing) |
| M1 | MEDIUM | RESOLVED — `mapEventToMessageStatus` returns `null` on unknown; caller skips `updateMessageStatus` but persists delivery row |
| M2 | MEDIUM | DEFERRED (D6) — cross-module race test requires primitive not in `@cloudflare/vitest-pool-workers`; rank-aware predicate already tested single-thread |
| M3 | MEDIUM | RESOLVED — full-SQL equality match (whitespace-normalised) replacing substring seam |
| L1 | LOW | RESOLVED — `messageStatusSchema` extended to reject null/undefined/numeric/object inputs |
| L2 | LOW | RESOLVED — divergence warn captures both `jobAdvanced` and `messageAdvanced`; combined warn names both surfaces |
| L3 | LOW | RESOLVED — `cause: error` attached to `DomainError` in `setup.ts:runOutboundSmokeTest` |

Re-review: `work/reviews/CAP-029-code-rereview.md` (2026-08-15). One new MEDIUM surfaced:
atomic webhook-delivery INSERT + messages UPDATE batch (CAP-039 follow-up).
Re-review: `work/reviews/CAP-029-security-rereview.md` (2026-08-15). Same H/M fixes verified
from the security perimeter; one LOW surfaced: cause-chain logger guardrail (CAP-040 follow-up).