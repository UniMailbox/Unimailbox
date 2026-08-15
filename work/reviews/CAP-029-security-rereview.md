# CAP-029 — security re-review of H/M-class fixes

**Reviewer:** security-reviewer · **Date:** 2026-08-15 · **Base:** working tree on `cap/CAP-020-026-business-loop` (CAP-029 in flight)

**Status:** ACCEPT WITH FIXES

## Summary

The three H/M-class fixes from the CAP-029 review-triage cycle are correctly implemented
and the regression tests genuinely exercise the failure modes. One residual observation —
the cause chain is preserved through `Error.prototype.cause` rather than redeclared as a
class field, and that decision is the right one. Two adjacent surfaces (R-INBOUND-SIGNATURE
ordering, no new module-scope credential cache) are intact. One LOW-grade note follows on
the logger path that consumes the new typed errors downstream — it does NOT regress the H2
fix, but the chain still carries the body and a future logger change could leak it. Worth
recording as a defensive guardrail, not a blocker.

## Acceptance criteria — QA reviews only

Not applicable — security review.

## BLOCKER

> Ship-stopping: data loss, auth bypass, invariant violation, broken architecture rule.

None.

## HIGH (resolved 2026-08-15)

> All HIGH findings from the 2026-08-15 review were verified fixed by this re-review
> (R-AUTHZ-004 closed via connection-scoped SQL; R-SECRET-003 / R-LOG-001 closed via body on
> `cause` not on `message`). Structural headings are preserved for the audit trail.

### H1 — Cross-tenant IDOR closed on `findJobByProviderMessageId` (verified)

- **Where:** `apps/worker/src/modules/outbound-mail/webhook-repository.ts:139-150`
- **Violates (before fix):** R-AUTHZ-004 — IDOR via cross-tenant lookup when
  `provider_message_id` collided between connections.
- **Fix (verified):**
  - SQL `WHERE` clause: `provider_message_id = ? AND provider_connection_id = ?`
    (line 146). Binds `(providerMessageId, connectionId)` in that order (line 148)
    — matches the `?` placeholders.
  - Schema column name confirmed in `migrations/0007_outbound_jobs.sql:18` —
    `provider_connection_id`, not `connection_id`. The implementer caught the
    typo mid-cycle as noted in the task.
  - Repository signature now requires `connectionId` (line 141). The call site at
    `webhook-processor.ts:168` (`findJobByProviderMessageId(db, connectionId, event.messageId)`)
    supplies the receiving connection — the route URL `:connectionId` is the trusted
    source of truth (it is matched against `provider_connections.id` for the HMAC key).
- **Regression test:** `apps/worker/src/http/routes/webhooks.worker.test.ts:458-529`
  — "cross-tenant: webhook to connection A does NOT update the message owned by
  connection B when provider_message_id collides". The test (a) seeds two connections
  A/B, (b) updates both jobs to share the same `provider_message_id`, (c) confirms the
  collision is in place (`expect(collision?.n).toBe(2)` line 482), (d) posts to A only,
  (e) asserts message A flipped to `delivered` (line 508), and — critically —
  (f) asserts message B remains `sent` (line 516). The pre-fix code would have
  updated B because the lookup ignored connection.
- **Concrete attack (now blocked):**
  - Attacker controls connection A's webhook secret (e.g. via operator compromise of
    a low-privileged tenant) and crafts a payload `{event: 'delivered', messageId: X}`
    where X is a provider_message_id they observed on connection B (provider-assigned
    IDs are not globally unique across Brevo accounts; collisions are realistic).
  - Asset at risk: message row of tenant B — status could be clobbered from terminal
    `bounced` to `delivered`, hiding a security-relevant terminal state in B's audit
    trail.
  - Minimal fix applied: connection_id scope in the SQL WHERE clause.

### H2 — Brevo provider body no longer in `error.message` (verified)

- **Where:** `apps/worker/src/integrations/providers/brevo.ts:160-197`
- **Violates (before fix):** R-SECRET-003 / R-LOG-001 — Brevo response body was
  interpolated into `error.message`; bodies can carry PII (recipient addresses) and
  `xkeysib-…` secret prefixes that would land in the queue consumer's logger.
- **Fix (verified):**
  - `errorMessage` is constructed as `Brevo send failed: status ${status}` only
    (line 171) — no body interpolation.
  - Body is attached as `cause` on the typed Error (lines 181, 188, 195) using
    `new Error(\`provider body: ${body}\`)`. Empty body → no `cause` (line 181
    `body ? … : undefined`).
  - The cause chain does NOT lose type information: `RetryableProviderError` and
    `TerminalProviderError` in `packages/contracts/src/index.ts:210-235` pass
    `cause` to `super(message, chainCause(options))` — they rely on
    `Error.prototype.cause` (ES2022) and do NOT redeclare `cause` as a class field.
    Under `useDefineForClassFields: true` (TS default for ES2022 + ESNext modules)
    a redeclared field would shadow the prototype assignment and reset `cause` to
    `undefined`. The explicit inline comment at `index.ts:213-216` documents this
    trap and why the field is intentionally absent.
- **Regression test:** `apps/worker/src/integrations/providers/brevo.test.ts:39-87`
  — feeds Brevo a synthetic body `xkeysib-deadbeef1234567890 recipient=alice@example.com`
  on a 401 response, asserts:
  - `err.message` does NOT contain `'xkeysib-'`, `'recipient=alice'`, or the
    full `SECRET_LOOKING_BODY` (lines 74–76);
  - `err.message` still surfaces `Brevo send failed` and `401` for operator
    triage (lines 78–79);
  - `err.cause` is an `Error` whose message DOES contain the body (lines 83–85).
- **Empty-body coverage:** `brevo.test.ts:189-215` — an empty 401 body leaves
  `err.cause === undefined`. No spurious `"provider body: "` line in the chain.
- **Concrete attack (now blocked):**
  - Attacker tricks Brevo into returning a body containing a credential prefix
    (e.g. operator pastes their own API key into a request body that Brevo
    surfaces verbatim in an error). The body would previously have flowed into
    the worker log stream via `error.message`.
  - Asset at risk: log stream containing `xkeysib-…` and PII.
  - Minimal fix applied: body on `cause`, never on `message`.

### M1 — 429 split from terminal 4xx branch (verified)

- **Where:** `apps/worker/src/integrations/providers/brevo.ts:177-196`
- **Classification (verified against RFC 6585 §4):**
  - `status === 429` → `RetryableProviderError` (lines 177–183).
  - `status >= 400 && status < 500` (other 4xx) → `TerminalProviderError`
    (lines 184–190).
  - 5xx (and anything outside 4xx/5xx not yet classified) → `RetryableProviderError`
    (lines 192–196).
  - Network failure (fetch rejection) → `RetryableProviderError` (lines 150–158) —
    confirmed in `brevo.test.ts:217-245` and not regressed.
- **Regression test:** `brevo.test.ts:89-122` — "429 routes through
  `RetryableProviderError`". Asserts the body is on `cause`, not on `message`,
  consistent with the H2 fix.
- **Concrete attack (now blocked):**
  - Operator on a free-tier Brevo account hits the per-connection rate limit
    mid-send. Under the old terminal-on-4xx policy, every queued message
    would mark `failed` permanently on the first 429 → silent message loss
    and broken R-OUTBOUND-008 retry contract.
  - Asset at risk: queued outbound messages on rate-limited connections.
  - Minimal fix applied: 429 routed through the retryable path; queue budget +
    provider idempotency key (R-OUTBOUND-004) make retries safe.

## MEDIUM

None.

## LOW

### L1 — `process-outbound-job.ts` logs `error.message` on post-send write failure

- **Where:** `apps/worker/src/modules/outbound-mail/process-outbound-job.ts:340`
- **Observation:** The catch block logs `error.message` via
  `error: error instanceof Error ? error.message : String(error)`.
  Today this is safe — a `TerminalProviderError` from `brevoAdapter.send()` has
  `message = "Brevo send failed: status 401"` (no body, no PII), and the body sits
  on `cause`. The H2 fix is intact.
- **Risk:** Future log-line changes that include `error.cause` (e.g. via
  `JSON.stringify(err, Object.getOwnPropertyNames(err))` or a structured-logging
  helper that walks the chain) would re-leak the body into the log stream. The
  current code path is the only place that consumes these errors and it is safe
  by construction.
- **Verdict:** hardening opportunity, not a vulnerability. Recommend recording
  in the ledger as a follow-up: "audit logger calls in `process-outbound-job.ts`
  and the queue consumer for any chain-walking that could re-leak the cause
  body on retryable/terminal errors".

## Not verified

- I did not run the test suite. The implementer's reports (`pnpm test:unit`,
  `pnpm test:worker`) show all green per the task.md; the orchestrator should
  re-run them as part of acceptance.
- I did not verify the new `updateMessageStatus` write predicate at
  `messages/message-repository.ts:193-245` — out of scope for this re-review
  (not an H/M fix from the triage cycle).
- I did not verify that the `extractBrevoEventTimeMs` format-based
  discrimination covers every Brevo timestamp variant — that is the code
  reviewer's lane per the task scope.
- I did not verify the `provider_event_time` column type (`INTEGER`) matches the
  Drizzle schema declaration — out of scope.
- I did not re-verify the webhook route handler's audit-event emission after
  the rank-aware predicate rejects an event — the existing audit row is
  preserved (delivery row written regardless), but a state-transition audit row
  for a rejected update is out of scope and is consistent with R-AUDIT-001
  (the audit is the delivery row + the unchanged messages row, not a separate
  transition event).

## Threat walk

| Threat | Applicable? | Evidence | Finding id |
|---|---|---|---|
| Cross-tenant IDOR via provider_message_id collision | Yes (was BLOCKER) | `webhook-repository.ts:146` SQL scope + test `webhooks.worker.test.ts:458-529` | H1 (verified fixed) |
| Webhook signature skipped (parsing first) | Yes | `webhooks.ts:42-43` `c.req.text()` before any JSON; `webhook-processor.ts:101-142` HMAC + constant-time compare before `JSON.parse(rawBody)` at line 145 | — (not regressed) |
| Provider body / secret prefix leaked via `error.message` into logger | Yes (was BLOCKER) | `brevo.ts:171` message construction + `brevo.test.ts:39-87` assertions | H2 (verified fixed) |
| Provider body / secret prefix leaked via class field redeclaration resetting `cause` | Yes (defensive) | `packages/contracts/src/index.ts:210-235` uses `super(message, chainCause(options))`, relies on `Error.prototype.cause` | H2 (verified clean) |
| 429 misclassified as terminal → permanent message loss under rate limits | Yes (was HIGH) | `brevo.ts:177-183` 429 → `RetryableProviderError`; `brevo.test.ts:89-122` | M1 (verified fixed) |
| Logger chain-walking re-leaks cause body in the future | Plausible | `process-outbound-job.ts:340` logs `error.message` only (safe today); no chain walk present | L1 (hardening opportunity) |
| Module-scope decrypted credential held > 1 request | No | Brevo API key read from `ctx.env.BREVO_API_KEY` per request (`brevo.ts:101`); no `let` at module scope | — (not present) |
| `Idempotency-Key` value logged | No | No `logger.*` call in `brevo.ts` or `webhook-repository.ts`; `process-outbound-job.ts` logger calls use only `{jobId, booleans}` or `error.message` from the typed chain | — (not present) |
| `console.log` of request body or secret | No | No `console.*` calls in production modules of the diff | — (not present) |
| `webhook_secret` returned in an API response | No | `webhook-repository.ts:189-197` `ProviderConnectionRow` exposes it for admin display only; `listWebhookDeliveries` (lines 171-182) deliberately omits `raw_payload` | — (intentional, documented) |
| HMAC secret cached longer than one request | No | `webhook-processor.ts:104-108` returns early if cached; otherwise computed inline | — (not present) |
| New IDOR via `updateMessageStatus` writer | Plausible | `message-repository.ts:193-245` writer is scoped to `messages.id`; caller (`webhook-processor.ts`) supplies the `messageId` resolved by `findJobByProviderMessageId` (now connection-scoped). No `body.userId` or `body.ownerId` consumption. | — (not present in writer; caller scoping verified in H1) |

## Required fixes

1. L1 — record the "do not chain-walk `error.cause` into the logger" guardrail
   as a follow-up capability in the ledger (or as an inline test asserting
   `process-outbound-job`'s logger never traverses the cause chain).
