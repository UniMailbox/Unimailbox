# CAP-029 — Webhook ordering — early or out-of-order events queued, never lost

**Phase:** 2 · **Status:** In Progress · **Started:** 2026-08-15

## Goal

A webhook delivered out of order (e.g. `delayed` arrives after `delivered`) can no longer rewind or
clobber a message's status, and a provider-side failure classification (`4xx` vs `5xx`) reaches the
queue consumer so that a permanent provider error is no longer retried to the limit.

## Scope

One capability, four converging concerns. All four touch the same code path — provider-authoritative
status converging on `messages.status` — and splitting them across two slices would have two agents
both writing the new `messages` row writer. Keeping them together makes the writer contract the
single coherent surface to review.

| # | Concern | Source |
|---|---|---|
| 1 | **R-MESSAGE-007 ordering** — apply webhook status only if newer (event time) or higher-rank on tie | Ledger line 107 |
| 2 | **D-CAP-028-A** — typed `RetryableError`/`TerminalError` at the `OutboundProviderAdapter` boundary | Ledger D-CAP-028-A |
| 3 | **D-CAP-028-C** — document or consolidate `updateJobStatus` unconditional writer | Ledger D-CAP-028-C |
| 4 | **D-CAP-028-D** — restructure cross-module `messages` write through messages module's public interface | Ledger D-CAP-028-D |

**Scope decision (recorded):** all four concerns in one CAP. Recorded because a reviewer may
propose splitting — the orchestrator should reject any split that re-introduces two agents writing
the new `messages` row writer.

## Out of scope

- **State machine guards** — R-MESSAGE-006 lifecycle validation (`draft → queued → sending → sent
  → delivered`, terminal states provably terminal) is **CAP-030** per ledger line 108. The new
  `updateMessageStatus` MUST be a no-op guard against state-machine violations, but the *full*
  guard catalogue (e.g. `failed → queued` is forbidden) is CAP-030's work. CAP-029 adds the
  only-if-newer-or-higher-rank check; CAP-030 adds the lifecycle-direction check.
- **Provider messaging extensions** — adding hooks for CC/BCC bounce handling (R-OUTBOUND-012),
  retryable 5xx vs transient 4xx policy tuning, or webhook signature rotation is out of scope.
- **Generic event bus** — the system is deliberately not building one (architecture.md). The
  webhook → messages update path is the one consumer that doesn't need one.
- **Multi-provider webhook dispatch** — Phase 1 inbound is Brevo-only. The route handler's
  `providerKey` parameter is unused and remains so.

## Business rules

| Rule ID | What it means for this slice |
|---|---|
| `R-MESSAGE-007` | Webhook status updates are applied only if `provider_event_time` is newer than the stored value, or equal with a strictly higher status rank. |
| `R-MESSAGE-006` | The new `updateMessageStatus` writer enforces the lifecycle direction (no backward steps outside the rank exception below). |
| `R-OUTBOUND-008` | A retryable error re-queues with backoff; a terminal error marks the job `failed`. CAP-029 makes the adapter's `RetryableError`/`TerminalError` the carrier for this distinction (so a `4xx` is terminal immediately, not after `max_attempts` retries). |
| `R-OUTBOUND-004` | Provider calls use the canonical message ID as idempotency key. The adapter taxonomy does not change this. |
| `R-INBOUND-SIGNATURE` | Signature verification runs **before** JSON parse (CAP-024, unchanged). |
| `R-OUTBOUND-007` | The lock-holding writes predicate on `locked_by` is preserved. The new `updateMessageStatus` is *not* lease-aware (it does not write `outbound_jobs`); its lease-aware sibling is `markOutboundJobSent`, which is the writer at `process-outbound-job.ts:282`. |
| `R-AUDIT-001` | Every status transition writes an `audit_events` row. The webhook route handler already emits `webhook.delivered`; CAP-029 does not duplicate. |
| `R-DATA-005` | No JSON-in-text columns. The new `provider_event_time` is an INTEGER (Unix epoch ms) — typed, indexable, comparable. |
| `R-SECRET-003` | Webhook events never include the decrypted API key. The new error types do not change this. |

Source: `docs/rebuild/02-business-discovery/business-rules.md`.

## Acceptance criteria

Each is objectively checkable and maps to a test or a demonstrable behaviour.

### A. R-MESSAGE-007 ordering

- [ ] A1. A webhook with `event_time = T2` succeeds when no prior event exists for the message.
- [ ] A2. A webhook with `event_time = T1 < T2` (already-applied) is ignored — message status unchanged, `webhook_deliveries` row still written for audit.
- [ ] A3. A webhook with `event_time = T1` (already-applied) and a higher status rank is applied. (R-MESSAGE-007 tie-breaker.)
- [ ] A4. A webhook with `event_time = T2 > T1` and a lower status rank is applied. (Newer always wins.)
- [ ] A5. Status rank ordering is defined as a closed enum: `failed` ≈ `bounced` ≈ `complained` (terminal) > `delivered` > `delayed` > `queued` > `sending` > `sent`. (`blocked` is a Brevo event name mapped to `delayed` in `mapEventToMessageStatus`; it is NOT a messages.status value — see QA M2 review-triage note.) (Rank ranks first by terminal-ness, then by recency-of-life. Concrete ranked enum lives in the contract schema, not a magic number.)
- [ ] A6. The `updateMessageStatus` writer is atomic (single D1 statement). Mid-tie computation is not a concurrent concern (D1 serializes writes per row).
- [ ] A7. Migration `0011_message_event_time.sql` adds `provider_event_time INTEGER` to `messages` (nullable; `NULL` for messages never seen by a provider event). Migration `0011_message_event_time.verify.sql` proves it. Migration `0012_webhook_event_time.sql` adds `event_time INTEGER` and `event_time_source TEXT` to `webhook_deliveries`. (QA M1 review-triage: filenames match the actual deployed artifacts; CAP-029 was bumped to N≥11 because intervening CAPs landed first.)

### B. D-CAP-028-A adapter taxonomy

- [ ] B1. `packages/contracts/src/index.ts` (or `apps/worker/src/platform/errors.ts` per architecture) declares `RetryableProviderError` and `TerminalProviderError` as identifiable thrown types (discriminator: `kind: 'retryable' | 'terminal'`). Both extend or pair with `DomainError` so the existing `httpStatus` field carries through.
- [ ] B2. `apps/worker/src/integrations/providers/brevo.ts` translates HTTP status to typed errors: `5xx` and `429` → `RetryableProviderError`; `4xx` (other than `429`) and `404` of outbound resource → `TerminalProviderError`. Validation failures (missing key, malformed response) → `TerminalProviderError`.
- [ ] B3. `process-outbound-job.ts` recognises the typed errors: `TerminalProviderError` → `markOutboundJobTerminal` immediately, no rethrow, no further retries — even when `attempts + 1 < max_attempts`. `RetryableProviderError` → existing attempts-exhaustion logic (preserves today's behaviour for ambiguous errors).
- [ ] B4. Worker test: a Brevo `4xx` (e.g. `400 Bad Request`) on attempt 1 of 5 marks the job `failed` with `code = 'TERMINAL_PROVIDER_ERROR'` and does NOT requeue. The provider-call counter in the test is exactly 1. (QA M4 review-triage: stable closed-catalog code lives in `platform/errors.ts`; `PROVIDER_SEND_FAILED` was a legacy short form. The queue consumer's `markOutboundJobTerminal` accepts the `code` field from `TerminalProviderError`'s message-or-error path.)
- [ ] B5. Worker test: a Brevo `503` (transient) on attempt 1 of 5 retries; reaches `failed` after `max_attempts`. The provider-call counter is `max_attempts`. (Today's behaviour, preserved.)
- [ ] B6. Worker test: a malformed SDK error (e.g. `parse failed`) hits the existing `SEND_FAILED` fallback path — untouched, except the fallback now produces a `RetryableProviderError` to the same effect as a `5xx` (no behaviour change for unknown errors).

### C. D-CAP-028-C writer consolidation

- [ ] C1. `updateJobStatus` (the unconditional writer, exported from `outbound-mail/job-repository.ts`) is documented in `outbound-mail/job-repository.ts` lines 110–115 as the only legitimate use site: compose-insert + idempotency-replay. The comment names the webhook consumer explicitly as a non-user. (No code change other than the comment.)
- [ ] C2. The webhook consumer writes terminal status via `markOutboundJobTerminal` (lease-aware) or, if the status change is a no-op for the job lifecycle (a `delivered` event is purely a `messages` row update), does not touch `outbound_jobs` at all. The `webhook-processor.ts` does NOT call `updateJobStatus`.
- [ ] C3. Reviewer audit: a `git grep updateJobStatus` shows call sites limited to compose-insert and idempotency-replay paths.

### D. D-CAP-028-D cross-module write

- [ ] D1. `apps/worker/src/modules/messages/message-repository.ts` adds a public `updateMessageStatus` function with the R-MESSAGE-007 rank-aware predicate; exported via `modules/messages/index.ts`.
- [ ] D2. `apps/worker/src/modules/outbound-mail/process-outbound-job.ts:270-274` (the post-send `UPDATE messages SET status='sent'`) is replaced by a call to `updateMessageStatus({ ..., status: 'sent', sentAt: now })`. The direct `UPDATE messages` statement is removed.
- [ ] D3. `apps/worker/src/modules/outbound-mail/webhook-processor.ts:136-139` (the unconditional `UPDATE messages SET status=?`) is replaced by a call to `updateMessageStatus` carrying the event timestamp from the parsed payload (or server fallback — see Open Questions).
- [ ] D4. `git grep "UPDATE messages"` outside `apps/worker/src/modules/messages/` returns no application code matches. (Build output / migrations are excluded.)
- [ ] D5. The dependency table in `.claude/rules/architecture.md` is unchanged: `outbound-mail → messages` is already allowed.

## Vertical slice

Layers this touches, in dependency order:

- [ ] domain — `packages/contracts/src/index.ts` (status rank enum, error types)
- [ ] domain — `apps/worker/src/platform/errors.ts` (or contracts, see B1)
- [ ] migration — `migrations/0009_message_event_time.sql` (+ `.verify.sql`)
- [ ] repository — `apps/worker/src/modules/messages/message-repository.ts` (new `updateMessageStatus`)
- [ ] repository — `apps/worker/src/modules/outbound-mail/job-repository.ts` (C1 comment only)
- [ ] integration — `apps/worker/src/integrations/providers/brevo.ts` (B2)
- [ ] use case — `apps/worker/src/modules/outbound-mail/process-outbound-job.ts` (D2, B3)
- [ ] use case — `apps/worker/src/modules/outbound-mail/webhook-processor.ts` (D3, A1–A5)
- [ ] module index — `apps/worker/src/modules/messages/index.ts` (export `updateMessageStatus`)
- [ ] tests — `apps/worker/src/http/routes/webhooks.worker.test.ts` (extend for A2–A4)
- [ ] tests — `apps/worker/src/modules/outbound-mail/process-outbound-job.worker.test.ts` (extend for B4–B6)
- [ ] tests — `apps/worker/src/modules/messages/message-repository.worker.test.ts` (new, for D1 + A1–A4)

New module dependency edges introduced: **none**. `outbound-mail → messages` is already in the
allowed table; the new call goes through `messages/index.ts` (the existing public surface).

## File ownership

One writer per file. A single implementation slice — no parallel writers.

| Agent | Owns |
|---|---|
| implementer | All files above. No parallel sub-slices. The four concerns are <300 lines of total change; one implementer fits the slice cleanly. |

The implementer must explain in the final report **which acceptance criteria each file satisfies** so the orchestrator can audit traceability.

## Reading list

The implementer reads exactly this — not the whole `docs/` tree.

- `CLAUDE.md` (project entry point)
- this file
- `.claude/agents/implementer.md`
- `.claude/rules/architecture.md` (dependency direction, module public surface)
- `.claude/rules/coding.md` (errors, abstraction, naming)
- `.claude/rules/testing.md` (worker-pool tests, real D1, mock at adapter boundary)
- `.claude/rules/security.md` (R-LOG-001, R-SECRET-003, R-INBOUND-SIGNATURE)
- `.claude/rules/git.md` (commit granularity, no `git add -A`)
- `docs/rebuild/02-business-discovery/business-rules.md` (R-MESSAGE-006, R-MESSAGE-007, R-MESSAGE-012, R-OUTBOUND-004, R-OUTBOUND-008, R-OUTBOUND-012)
- `docs/rebuild/09-decisions/ADR-002-provider-adapter-registry.md`
- `docs/rebuild/09-decisions/ADR-003-durable-outbox.md`
- `docs/rebuild/09-decisions/ADR-004-idempotency.md`
- `docs/rebuild/09-decisions/ADR-007-secret-storage.md`

Existing code to extend (read-only):

- `apps/worker/src/modules/outbound-mail/webhook-processor.ts` (CAP-024)
- `apps/worker/src/modules/outbound-mail/webhook-repository.ts`
- `apps/worker/src/modules/outbound-mail/process-outbound-job.ts` (CAP-023 + CAP-028)
- `apps/worker/src/modules/outbound-mail/job-repository.ts`
- `apps/worker/src/integrations/providers/brevo.ts`
- `apps/worker/src/modules/messages/message-repository.ts`
- `apps/worker/src/modules/messages/index.ts`
- `apps/worker/src/http/routes/webhooks.ts`
- `apps/worker/src/http/routes/webhooks.worker.test.ts`
- `packages/contracts/src/index.ts` (for adding B1 types)
- `apps/worker/src/platform/errors.ts` (closed catalog, CAP-032)
- `migrations/0008_webhook_events.sql` (precedent for 0009)

## Dependencies

- Requires: CAP-024 (Webhook delivery — signature verification + delivery row) — **Implemented**
- Requires: CAP-028 (Durable outbox — lease, attempts, reclaim) — **Implemented** (the D-CAP-028-* deferrals originate here)
- Requires: CAP-032 (Stable error model — closed catalog + canonical envelope) — **Implemented** (the closed catalog is the carrier for CAP-029's adapter taxonomy)
- Blocks: CAP-030 (State machine guards — R-MESSAGE-006 + R-MESSAGE-012). The new `updateMessageStatus` is the seam CAP-030 will add lifecycle-direction guards to.

## Decisions made during this capability

**Q1 — Event timestamp source.** Provider payload first, server time as fallback, with a
`webhook_deliveries` column (or extension of `raw_payload` metadata) recording the source. Rationale:
R-MESSAGE-007 ordering correctness depends on the value being comparable across providers; falling
back silently would make audits unactionable. The implementer extends the `webhook_deliveries`
schema (or adds a sibling column) to record `event_time_source: 'provider' | 'server'`.

**Q2 — Status rank table.** Lives in `packages/contracts/src/index.ts` as a closed enum + a
`statusRank(status): number` helper. Rationale: `R-MESSAGE-007` rank is the public contract; any
module with a status update consumes the rank. Putting it in `messages` module would force a
second consumer to import messages internals, which architecture.md forbids.

**Q3 — `updateMessageStatus` owns `sent_at`.** The new function accepts `sentAt?: string` and writes
it when the caller supplies it. Rationale: the function is the single `messages` row writer for
outbound status; splitting `sent_at` to a separate caller would re-introduce the boundary that
D-CAP-028-D is closing.

**Q4 — Adapter errors chain via `cause`.** `RetryableProviderError` and `TerminalProviderError`
carry the original `Error` as `cause` (the standard ES2022 chain). Rationale: `R-LOG-001` is
preserved (no bodies, no keys) — the chain carries the message and stack, which are exactly the
fields a log line should have when a provider call fails.

**Q5 — Test infrastructure.** `apps/worker/src/modules/outbound-mail/process-outbound-job.worker.test.ts`
exists. The implementer extends it. No `message-repository.worker.test.ts` exists yet; the
implementer creates it as part of the slice (test-only file, no production code).

**D6 (deferral — Code M2).** Cross-module race regression test deferred. The Code review
flagged the absence of an explicit test asserting that a webhook status update landing
during a concurrent `process-outbound-job` post-send write cannot clobber the 'sent' status.
The rank-aware predicate (R-MESSAGE-007) is enforced on the messages-row writer, but a
dedicated test exercising the cross-module race (two concurrent writes to the same message)
is deferred to a follow-up CAP. Rationale: the predicate is already tested with single-thread
deterministic sequences (A1–A4); the race-window simulation requires a deterministic interleaving
primitive that does not exist in `@cloudflare/vitest-pool-workers` and is out of CAP-029 scope.

**D7 (deferral — Arch L2).** Per-provider timestamp heuristic location deferred. The
Architecture reviewer noted that `extractBrevoEventTimeMs` lives in `webhook-processor.ts` but
the unit-discrimination rule is Brevo-specific. Moving it into the brevo adapter integration
would require a second small consumer (resend, cf-sendmail) to land before the move is
worthwhile (Rule of Three, coding.md). The current location keeps the audit trail in one place.
Recorded for the next CAP that adds a second provider.

**Security L2 (no action).** The Security reviewer flagged that webhook_deliveries stores the
raw payload verbatim (R-AUDIT-001 requires this), but did not require redaction of PII headers
(e.g. To/CC). Out of scope for CAP-029 — redaction belongs to a separate audit-log sanitization
CAP that should also handle outbound_jobs error_message and outbound provider response logging.
Recorded for the orchestrator to add as a follow-up capability.

## Open questions

Empty. The orchestrator has resolved the five pre-slice design questions above. The implementer
records any *new* decisions here as they arise.

## Review-triage resolutions (post-implementation)

Three independent parallel reviews (architecture, code, qa) ran against the slice. A fourth
security review was provided inline by the orchestrator. All H and M findings were fixed; L
findings were fixed when cheap. Resolution per finding:

| ID | Severity | Where | Fix |
|---|---|---|---|
| Security H1 | BLOCKER | `webhook-repository.ts:findJobByProviderMessageId` | Repository signature changed to require `connectionId`; SQL adds `AND connection_id = ?`. Cross-tenant IDOR closed. (R-AUTHZ-004.) |
| Code H1 | HIGH | `webhook-processor.ts:extractBrevoEventTimeMs` | Replaced the magnitude heuristic with format-based discrimination (string → Date.parse; integer > 1e10 → ms; integer ≤ 1e10 → seconds × 1000; fractional/bool/null/object → server fallback). |
| Code H2 | HIGH | `integrations/providers/brevo.ts` | 4xx error `message` no longer contains provider body; body attached as `cause` on a structured Error. (R-SECRET-003.) |
| Code M1 / QA L2 | MEDIUM / LOW | `webhook-processor.ts:mapEventToMessageStatus` | Default returns `null`; caller skips `updateMessageStatus` but still persists the delivery row for audit. |
| Arch M1 / Security M3 | MEDIUM | guard test in `packages/contracts/src/index.test.ts` | Test asserts `STATUS_RANK_TABLE` is in sync with the SQL CASE in `updateMessageStatus`. |
| Code M2 (deferred) | MEDIUM | race-window regression test | See D6 above. |
| Code M3 | MEDIUM | `process-outbound-job.worker.test.ts` substring seam | Replaced `query.includes('provider_event_time = ?')` with full-SQL equality match (whitespace-normalised). |
| Code M4 / QA M3 | MEDIUM | `brevo.ts` 429 split | 429 → `RetryableProviderError`; all other 4xx → `TerminalProviderError`. |
| Code M5 | MEDIUM | `process-outbound-job.ts` divergence warn | Captures `messageAdvanced` from `updateMessageStatus`; combined warn names both booleans. |
| QA M1 | MEDIUM | A7 migration filenames | Updated `0009_*` → `0011_*` and added `0012_webhook_event_time.sql`. |
| QA M2 | MEDIUM | A5 phantom `blocked` | Documented that `blocked` is a Brevo event name mapped to `delayed`, not a `messages.status` value. |
| QA M4 | MEDIUM | B4 error code | Updated to `TERMINAL_PROVIDER_ERROR` (closed catalog). |
| QA M5 | MEDIUM | untyped SDK error coverage | Existing B6 test extended to cover raw `Error` from fetch failure after the typed error path. |
| Code L1 / Arch L2 | LOW | `messageStatusSchema` extra inputs | `safeParse(null|undefined|0|42|{})` all return `success: false` (added in `packages/contracts/src/index.test.ts`). |
| Code L2 | LOW | `process-outbound-job.ts` divergence warn | See Code M5. |
| Code L3 | LOW | `setup.ts:runOutboundSmokeTest` | `cause: error` added to the `DomainError` wrap. |
| QA L1 | LOW | test description labels | Relabelled to match task.md numbering. |
| Arch L2 (deferred) | LOW | `extractBrevoEventTimeMs` location | See D7 above. |
| Security L2 (no action) | LOW | `webhook_deliveries.raw_payload` PII | See Security L2 above. |

## Anti-patterns to avoid

- Do not introduce a `BaseAdapter` or `AbstractProviderError` "for future providers" (Rule of Three,
  coding.md). The two error types ARE the abstraction.
- Do not move `mapEventToMessageStatus` into `messages` — it is a Brevo-specific translation
  (event name → status) and lives in `outbound-mail` (the integration adapter's caller). The
  status rank is the contracts-side concern.
- Do not add a generic event bus. The webhook → messages update is the one consumer that does
  not need one (architecture.md).
- Do not weaken `R-INBOUND-SIGNATURE` — signature verification still runs before JSON parse.
- Do not weaken `R-LOG-001` — webhook error logs carry the code, not the body or the API key.
- Do not write Drizzle row types across module boundaries (architecture.md). The new function
  uses the contracts-side `MessageStatus` enum, not the Drizzle row type.
