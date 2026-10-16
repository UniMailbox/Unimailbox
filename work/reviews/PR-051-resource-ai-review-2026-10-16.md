# PR #51 self-review and repairs — 2026-10-16

Scope: base `0d61ab9` through PR head `5e73f98`, including the inbound/outbound
reliability, two-section resource dashboard, shared mail mutations, query/cache
and AI governance changes. Reviewed by the main session; no independent reviewer
or delegated review is claimed. The unrelated PersonalMcpSettings edit is excluded.

## Confirmed findings

1. **P1: Definite AI rejections permanently occupied concurrency.** OpenAI and
   Anthropic SDK 401/429 errors supplied no terminal observation. The service
   marked them unknown, and the maintenance classifier correctly retained their
   holds indefinitely. With the default per-user concurrency of one, a single
   rejected request blocked that user's later requests even after credentials or
   throttling recovered. Record terminal evidence for explicit request rejection,
   release concurrency and retain conservative token accounting when usage is
   absent. Keep transport errors, 408, 409 and 5xx uncertain.
2. **P2: Missing Workers AI binding looked like submitted upstream work.** The
   service reserved before invoking the adapter, but its early unavailable-binding
   error had no terminal evidence. Record a known zero-work observation before
   returning AI_NOT_CONFIGURED; no provider call occurred.
3. **P2: Late reads overwrote confirmed message mutations.** Mark-read did not
   cancel in-flight sibling reads. Star/delete cancellation skipped first reads
   without cached data. A delayed thread response could revert read state or
   bring a deleted message back. Cancel folder/detail/thread reads, including
   first reads, before mutation and again before applying confirmed results.
   Keep cancellation scoped to the caller/mailbox and exclude scheduled-send
   projections.

## Evidence

New regression tests failed first: five AI cases (both protocols' 401/429 and
missing native binding) plus two delayed-cache cases. After repair, the focused
AI governance suite passed 24 tests and mailbox-cache suite passed eight tests.
The AI tests run real SDK code and local D1/audit bindings with synthetic upstream
HTTP only; 408/500 controls still retain unknown holds and prohibit new admission.
No real inference or private mail is used. Focused lint and TypeScript passed.
Full validation and any subsequent staging evidence are recorded in the current
ledger and dated QA; these initial focused counts are historical.

## Review boundaries

Checked receipt deduplication/lease recovery, outbound send fencing and positive
acceptance reconciliation, policy/configuration revisions and atomic quota
admission, authorization/replay boundaries, thread-root triggers and cache scope.
No additional confirmed regression was identified in those inspected paths.
This is not proof of provider-side duplicate suppression, model token/billing
bounds, browser rendering or full disaster recovery.

Reference: [AI governance](../../docs/rebuild/24-ai-usage-governance.md),
[cache design](../../docs/rebuild/23-query-cache-optimization.md),
[OpenAI error codes](https://developers.openai.com/api/docs/guides/error-codes)
and [Anthropic errors](https://platform.claude.com/docs/en/api/errors), retrieved
2026-10-16. Pinned SDKs were exercised rather than assuming their error shapes.

## Final local validation

The final owned source passed doctor 14/14, generated bindings, lint, TypeScript,
Web/Worker builds, 1,436 non-Worker tests and 1,115 Worker tests. The migration
suite's first run hit a 10-second beforeEach/reset timeout on a historical 0037
fixture (29 passed); its unchanged isolated rerun passed all 30 in 4.16 seconds.
Combined passing coverage is 2,581 tests, including 16 new cases. The single
full command had that initialization failure; it is not reported as a clean
full-command pass. No timeout was relaxed or test skipped.

## Publication

The unchanged prepared source subsequently passed the complete canonical gate
cleanly: **2,581 tests** (1,436 non-Worker, 1,115 Worker, 30 migrations),
doctor 14/14, binding drift, lint, types and builds. Repository-configured
Gitleaks scanned all 432 reachable commits without leaks before deployment.
PR #51 includes separate AI and cache repair commits. Staging published
`5331214`, Worker `5e09edb5-68a1-4a2f-ae5d-8e995240defa`, schema 0042, with all 42 remote SQL
companions, exact-source smoke, preserved configuration, authenticated metadata
and a real scheduled tick passing. See [dated QA](../../docs/qa/ai-governance-staging-2026-10-16.md).
No live paid inference, email, browser or full disaster-recovery acceptance.
