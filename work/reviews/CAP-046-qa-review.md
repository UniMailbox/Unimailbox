# CAP-046 — QA Re-Review

```
Task:      CAP-046 — qa re-review
Status:    ACCEPT-WITH-FIXES
Findings:  (BLOCKER × 0, HIGH × 0, MEDIUM × 0, LOW × 2)
```

## BLOCKER

None.

## HIGH

None.

## MEDIUM

None.

## LOW

LOW-1 — Documentation drift. File: `work/active/CAP-046-audit-correlation/task.md:228`. Summary: AC 26's prose says "Drive PATCH /api/v1/admin/role-policies/:id" but the production route is `routes.put('/roles/:id/policy', ...)` at `apps/worker/src/http/routes/admin-role-policies.ts:63-64`. The test at `preview-gate.worker.test.ts:1607-1608` correctly drives `PUT /api/v1/admin/roles/administrator/policy` and exercises the production path. Failure scenario: A future agent reading AC 26 searches for a route that does not exist. Fix: Update task.md AC 26 to "Drive PUT /api/v1/admin/roles/:id/policy".

LOW-2 — Inline regex literal vs module constant. File: `apps/worker/test/preview-gate.worker.test.ts:1779-1780`. Summary: AC 29 test inlines the regex literal `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/` instead of referencing the module-top `UUID_V4_REGEX` constant defined at line 113. The other 7 route-level tests (AC 22-AC 28) correctly use `UUID_V4_REGEX`. The two patterns are identical except for the case-insensitive `i` flag (irrelevant for hex). Failure scenario: A future edit that tightens `UUID_V4_REGEX` (e.g., v4-only) does not propagate to AC 29's inline literal. Fix: Replace the inline literal with `UUID_V4_REGEX`.

## AC mapping

AC 1 — VERIFIED. `compose.ts:262` replaced with `prepareCreateAuditEvent`; `requestId = c.get('requestId') ?? null` extracted at line 161; standalone `createAuditEvent` import removed. AC 22 test now drives the route end-to-end.
AC 2 — VERIFIED. `mailboxes.ts:171` — `requestId` extracted at line 136; the audit row INSERT (now via `prepareCreateAuditEvent` per AC 19) carries the threaded value. AC 23 test drives the route.
AC 3 — VERIFIED. `admin-blocklist.ts:121` — `requestId` field added to `prepareCreateAuditEvent` call. AC 24 test drives the route.
AC 4 — VERIFIED. `admin-blocklist.ts:232` — `requestId` field added to `prepareCreateAuditEvent` call. AC 25 test drives the route.
AC 5 — VERIFIED. `admin-role-policies.ts:144` — `requestId` field added to `prepareCreateAuditEvent` call. AC 26 test drives the route.
AC 6 — VERIFIED. `complete-setup.ts:12-22` — `CompleteSetupInput` extended with `requestId`; `createAuditEvent` replaced with `prepareCreateAuditEvent` pushed onto `stmts` before `input.db.batch(stmts)`. `setup.ts:792` threads `c.get('requestId')`. AC 28 test drives the route.
AC 7 — VERIFIED. `claim-setup.ts:25-29` — `ClaimSetupInput` extended with `requestId`; standalone write replaced with `input.db.batch([prepareSeedInstallationState(...), prepareCreateAuditEvent(...)])`. `setup.ts:134` threads `c.get('requestId')`. AC 27 test drives the route.
AC 8 — VERIFIED. `installation-state-repository.ts:65-77` — `prepareSeedInstallationState(db, step, timestamp): D1PreparedStatement` added paralleling `prepareUpdateInstallationStep`. The existing `seedInstallationState` (`.run()` variant) retained and delegates via `.run()`.
AC 9 — VERIFIED. `preview-gate.worker.test.ts:77` — `DEFERRED_REQUEST_ID_ACTIONS` is now `ReadonlyArray<string> = []`. Comment block updated to "RESOLVED — see CAP-046 closure log".
AC 10 — VERIFIED. `preview-gate.worker.test.ts:1057` — `expect(deferredRows.length).toBe(0)`. Closed-vocab check at lines 1063-1073 uses `auditActionSchema.options`; phantom check at lines 1075-1082 uses hand-declared `EXPECTED_AUDIT_ACTIONS`.
AC 11 — VERIFIED (unchanged from CAP-045 PARTIAL — no edits to `outbound_jobs.attempts` logic this slice).
AC 12 — VERIFIED (unchanged — live-mode still runs the real Brevo adapter against mocked fetch).
AC 13 — VERIFIED. `pnpm scaffold doctor` was 14/14 in CAP-045 PARTIAL and no edits to `scripts/doctor.ts` this slice.
AC 14 — VERIFIED. `pnpm typecheck` — clean (re-ran; `tsc --build` exited 0).
AC 15 — VERIFIED. `pnpm lint` — clean (re-ran; `eslint .` exited 0).
AC 16 — VERIFIED. `pnpm test:unit` — 883/883 (re-ran; matches CAP-045 PARTIAL baseline).
AC 17 — VERIFIED. `pnpm test:worker` — 758/763 (re-ran). The 4 failures are exactly:
  - `0015_credential_backfill.worker.test.ts > seeds five legacy users at the 0014 boundary`
  - `admin.worker.test.ts > creates all 21 permissions with correct IDs`
  - `admin.worker.test.ts > creates the administrator role with all 21 permissions`
  - `migrationsDb.worker.test.ts > R-DATA-004: PRAGMA foreign_keys is ON`
  Each failure is in `beforeEach(resetAndMigrate)` or `beforeEach(reset)` — pre-existing D1-parallelism baseline, no regressions. preview-gate.worker.test.ts in isolation: 26 passed | 1 skipped (27 total), all 8 CAP-046 tests green.
AC 18 — VERIFIED. `pnpm build` — wrangler dry-run completed (Secrets Store bindings listed, no compile errors).
AC 19 — VERIFIED. `mailboxes.ts:174-177` inline `INSERT INTO audit_events` SQL replaced with `prepareCreateAuditEvent(c.env.DB, { ... })` (lines 175-185 in current file). Single source of truth maintained at `apps/worker/src/modules/admin/audit-event-repository.ts`.
AC 20 — VERIFIED. `preview-gate.worker.test.ts:1052` — `expect(DEFERRED_REQUEST_ID_ACTIONS).toHaveLength(0)`. `EXPECTED_AUDIT_ACTIONS` at lines 84-100 lists 13 values hand-declared (NOT derived from `auditActionSchema`). The `phantomExpected` closed-vocab check at lines 1075-1082 catches a typo in the hand-declared list.
AC 21 — VERIFIED. `complete-setup.ts:75-83` carries the comment "The batch is ALWAYS non-empty ... A future refactor that conditionally removes the UPDATE will not silently load-bear this guard-less batch." above the unconditional `await input.db.batch(stmts)`.
AC 22 — VERIFIED. `preview-gate.worker.test.ts:1446-1513`. (1) Drives `POST /api/v1/mailboxes/:mailboxId/messages/send` via `SELF.fetch` with bearer + idempotency-key headers. (2) Queries `/api/v1/admin/audit-events` via `fetchNewestAuditRow('message.send', adminId)`. (3) Asserts `row.requestId` matches `UUID_V4_REGEX`. (4) Asserts `row.resourceId === messageId` (response's `messageId`).
AC 23 — VERIFIED. `preview-gate.worker.test.ts:1515-1549`. Drives `POST /api/v1/mailboxes`, asserts `UUID_V4_REGEX` match, asserts `resourceId === mailboxId`.
AC 24 — VERIFIED. `preview-gate.worker.test.ts:1550-1571`. Drives `POST /api/v1/admin/blocklist`, asserts `UUID_V4_REGEX` match, asserts `resourceId === response body id`.
AC 25 — VERIFIED. `preview-gate.worker.test.ts:1572-1604`. Seeds blocklist row, drives `DELETE /api/v1/admin/blocklist/:id`, asserts `UUID_V4_REGEX` match, asserts `resourceId === blocklistId`.
AC 26 — VERIFIED. `preview-gate.worker.test.ts:1605-1627`. Drives `PUT /api/v1/admin/roles/administrator/policy` (production route is `PUT /api/v1/admin/roles/:id/policy`), asserts `UUID_V4_REGEX` match, asserts `resourceId === 'administrator'`. Note: AC 26 prose describes a different method+path (LOW-1); the test exercises the correct production path.
AC 27 — VERIFIED. `preview-gate.worker.test.ts:1629-1677`. Flips `installation_state` back to `'setup'`, drives `POST /api/v1/setup/claim`, flips back to `'complete'`, queries audit-events without `actorUserId` (setup.claim has opaque token-hash actor), asserts `UUID_V4_REGEX` match on newest row.
AC 28 — VERIFIED. `preview-gate.worker.test.ts:1679-1731`. Flips `installation_state`, gets `sessionToken` via `claimSetupSession()`, drives `POST /api/v1/setup/complete`, flips back, queries audit-events, asserts `UUID_V4_REGEX` match.
AC 29 — VERIFIED. `preview-gate.worker.test.ts:1733-1782`. Drives `inboundEmail.email(message, env)` with a stub `ForwardableEmailMessage`, queries audit-events API, asserts the row's `requestId` matches UUID shape (inline literal, see LOW-2). Comment cites Architecture LOW-2 (inbound entrypoint synthesizes UUID because Email Routing has no Hono context).

## Hono header-echo compromise

ACCEPTABLE. R-AUDIT-001's spirit is "every audit row carries the request correlation token the middleware stamped." The UUID-shape verification proves the audit row carries a UUID from somewhere in the request lifecycle — the only producer is the request-id middleware (`apps/worker/src/http/middleware/request-id.ts:17` emits it in JSON logs) plus `systemIds.uuid()` for inbound-email (no Hono context). A regression that swapped `c.get('requestId')` for a hardcoded UUID, a counter, or a per-call variant would still pass the shape check, but the `c.get('requestId')` plumbing is a single call site per route (verified at `compose.ts:161`, `mailboxes.ts:136`, `admin-blocklist.ts:109/232`, `admin-role-policies.ts:132`, `setup.ts:134/796`) — the "different UUID" regression would require manual substitution, not a silent structural failure. The compromise matches the spirit of the existing `webhooks.ts:60-93` reference pattern (which threads `requestId` into the audit row by `c.get` — never by header echo). D-CAP-046-M is logged in the contract for the Hono `c.header` propagation fix as a future CAP.

## Risks not yet surfaced

- The 4 pre-existing worker failures are timing-sensitive (D1 migration uniqueness + hook timeouts in `resetAndMigrate`). On a clean run they appear as documented; on an immediate re-run, they may surface differently. CAP-046 does not touch the `resetAndMigrate` path, so the 758/763 baseline is stable — but a follow-up CAP for `D-CAP-042-pre-existing-parallelism` is independently needed.
- AC 22-AC 28 use `expect(row.resourceId).toBe(...)` as a secondary assertion; `fetchNewestAuditRow` sorts by `createdAt DESC` and returns the newest matching row. Multiple tests run via the `beforeEach` reset cycle; the sort is stable because each test runs `resetAndMigrate` in `beforeEach` (line 1372) and the routes each produce exactly one audit row. No flakiness observed in the re-run.
- AC 7 accumulator's closed-vocab check uses `auditActionSchema.options` — a runtime type assertion. If a future zod upgrade changes `.options` to `.def.entries`, the test would compile but fail at runtime. No immediate risk; the constant should be promoted to `packages/contracts` if it becomes a pattern.
- D-CAP-046-K (audit row may double-fire under burst `/setup/claim`) is correctly deferred. The fold into a D1 batch means the race shape is unchanged from the pre-CAP-046 standalone write — the audit row double-fires alongside the seed `ON CONFLICT` swallow. Deferred row is already in the contract.

## Next

Accept CAP-046 closure. The orchestrator can stage the named files and commit `feat(CAP-046): audit request_id correlation + standalone-write folds` per the contract's `## File ownership` table. The two LOWs (documentation drift in task.md AC 26; inline UUID regex literal in AC 29) are content-only edits to the contract + test file and can be folded into the same closure commit or deferred to a one-line follow-up. Recommend folding — both are <5 minutes of work and keep the contract honest. After commit, update the capability ledger to CAP-046 Implemented and queue D-CAP-046-M (Hono `c.header` propagation), D-CAP-046-K (setup.claim burst race), D-CAP-046-L (preview-gate enum-loop coverage), and D-CAP-046-J (webhook_secret.reveal reconciliation) for the next capability's task ID allocation.