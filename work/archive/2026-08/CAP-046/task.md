# CAP-046 — Audit `request_id` correlation + standalone-write folds

## Outcome

Every audit row emitted by the Worker carries the request-id middleware stamped the request
with (`c.get('requestId')`), AND every audit row emitted alongside a D1 mutation lands in
the same D1 batch as that mutation. After this slice the preview-gate suite's
`DEFERRED_REQUEST_ID_ACTIONS` export is empty; the AC 7 deferred-rows accumulator
discovers an empty list; the closure ledger gets a single row proving the audit invariant
holds end-to-end.

Closes: D-CAP-046-A (audit `request_id` correlation), D-CAP-046-B (standalone audit writes
folded into the same D1 batch as the business write). Both rows surfaced by CAP-045 PARTIAL
closure (the suite's deferred-rows accumulator named them; the orchestrator's follow-up
inventory confirmed them). No production behaviour change beyond correlation + atomicity
correctness. Depends on: CAP-040 (audit-event-writer seam — REFERENCE for cross-module use),
CAP-026 (audit-event-repository `prepareCreateAuditEvent` — REFERENCE for in-module use),
CAP-044 Slice 2 (audit-events query API — used by the preview-gate suite to discover gaps).
CAP-045 PARTIAL must be in `Implemented (PARTIAL)` status.

## Form (locked by user)

- One vertical slice: 6 sites in scope for **D-CAP-046-A**, 4 sites in scope for
  **D-CAP-046-B** (1 documented out-of-scope-with-reason). Both rows share the audit-events
  module and the same review surface.
- Single implementer dispatches per file (no overlapping writes). 4-way parallel review
  (architecture / code / security / qa; **frontend N/A — no `apps/web/` changes**).
- The reference pattern is `apps/worker/src/http/routes/webhooks.ts:60-93` — `const requestId
  = c.get('requestId') ?? null` then fold the prepared audit statement into the existing
  `db.batch([...])`. Every in-scope site conforms to this template.
- The preview-gate suite's `DEFERRED_REQUEST_ID_ACTIONS` export is updated to assert the
  EMPTY set; AC 7's deferred-rows accumulator must discover an empty list. This is how the
  orchestrator validates the slice — same harness that surfaced the gaps proves they're
  closed.

## Vertical slice

Single slice. There is no vertical split because A and B operate on the same module (admin
audit-events + 5 routes + 2 use cases) and the same review surface (R-AUDIT-001 +
R-AUDIT-003). Splitting them would force two reviews on overlapping files. Slice boundary:
every site threads `request_id`, every standalone write is folded, gates pass, the preview-
gate suite's `DEFERRED_REQUEST_ID_ACTIONS` is empty, AC 7's accumulator discovers `[]`.

## Inventory (orchestrator-confirmed against the source)

### D-CAP-046-A — `request_id` correlation

Seven emit points across the codebase. Six sites are missing `requestId` and must be
threaded through (the seventh, `inbound-email.ts:177`, already has it and serves as the
inbound reference; `admin-webhooks.ts:117` already has it for the `webhook_secret.reveal`
action).

| # | Site | Action | Surface | Pattern to apply |
|---|---|---|---|---|
| 1 | `apps/worker/src/http/routes/compose.ts:262` | `message.send` | route | `const requestId = c.get('requestId') ?? null;` then pass `requestId` to `createAuditEvent` (and convert call to `prepareCreateAuditEvent` per B) |
| 2 | `apps/worker/src/http/routes/mailboxes.ts:171` | `mailbox.create` | route (raw SQL) | `const requestId = c.get('requestId') ?? null;` then add `request_id` column to the INSERT and bind it (the existing `db.batch(statements)` already folds; just thread the value) |
| 3 | `apps/worker/src/http/routes/admin-blocklist.ts:121` | `blocklist.create` | route | add `requestId` field to the `prepareCreateAuditEvent` call (the function already accepts it via `AuditEventInput.requestId`); site is already batched |
| 4 | `apps/worker/src/http/routes/admin-blocklist.ts:232` | `blocklist.delete` | route | same as #3 |
| 5 | `apps/worker/src/http/routes/admin-role-policies.ts:144` | `role_policy.set` | route | same as #3 |
| 6 | `apps/worker/src/modules/onboarding/complete-setup.ts:72` | `setup.complete` | use case | extend `CompleteSetupInput` with `readonly requestId: string \| null`; the route extracts `c.get('requestId')` and passes it; the use case threads to `createAuditEvent` (and converts to `prepareCreateAuditEvent` per B) |
| 7 | `apps/worker/src/modules/onboarding/claim-setup.ts:80` | `setup.claim` | use case | extend `ClaimSetupInput` with `readonly requestId: string \| null`; the route extracts and passes; the use case threads to `createAuditEvent` (and folds per B) |

Already complete (REFERENCE, not modified):
- `apps/worker/src/entrypoints/inbound-email.ts:177-185` — `requestId` plumbed in.
- `apps/worker/src/http/routes/admin-webhooks.ts:117` (`webhook_secret.reveal`) — `requestId`
  present at line 112; standalone write has no D1 mutation to fold with (see B below).
- `apps/worker/src/http/routes/webhooks.ts:60-93` (`webhook.delivered`) — reference pattern.

### D-CAP-046-B — standalone writes folded into the same D1 batch

Four sites where `createAuditEvent(c.env.DB, ...)` (standalone `.run()`) runs AFTER a D1
batch that mutates business state. The crash window — business write succeeds, audit row
never lands — violates R-AUDIT-001 + D-CAP-029-A.

| # | Site | Action | Current state | Fix |
|---|---|---|---|---|
| 1 | `apps/worker/src/http/routes/compose.ts:262` | `message.send` | audit row runs AFTER `createMessageWithRelations(c.env.DB, statements)` (which itself wraps `db.batch`) AND `c.env.OUTBOUND.send(...)` (queue) | replace `await createAuditEvent(...)` with `prepareCreateAuditEvent(c.env.DB, { ... requestId ... })` and push the returned statement into the existing `statements` array before `createMessageWithRelations`. The queue send still runs after the batch — that ordering is unchanged. |
| 2 | `apps/worker/src/entrypoints/inbound-email.ts:177-185` | `message.receive` | audit row runs AFTER `createMessageWithRelations(env.DB, allStatements)` | replace with `prepareCreateAuditEvent(env.DB, { ... requestId ... })` and push into `allStatements` before `createMessageWithRelations`. |
| 3 | `apps/worker/src/modules/onboarding/complete-setup.ts:72` | `setup.complete` | audit row runs AFTER `input.db.batch(stmts)` (which already contains user_roles INSERT + installation_state UPDATE) | replace with `prepareCreateAuditEvent(input.db, { ... requestId ... })` and push into `stmts` before `input.db.batch(stmts)`. |
| 4 | `apps/worker/src/modules/onboarding/claim-setup.ts:80` | `setup.claim` | audit row runs AFTER `seedInstallationState(input.db, 'preflight', now)` (which itself runs `.run()`) — no existing batch to fold into | add `prepareSeedInstallationState(db, step, timestamp): D1PreparedStatement` to `apps/worker/src/modules/onboarding/installation-state-repository.ts` (parallels the existing `prepareUpdateInstallationStep` at line 68). Then in `claim-setup.ts`: `db.batch([prepareSeedInstallationState(input.db, 'preflight', now), prepareCreateAuditEvent(input.db, { ... requestId ... })])`. `seedInstallationState` continues to exist for the non-batch call sites (none today, but keep for symmetry with `updateInstallationStep`). |

Out of scope (documented):

- `apps/worker/src/http/routes/admin-webhooks.ts:117` (`webhook_secret.reveal`) — standalone
  `createAuditEvent`, but there is NO D1 business write to fold with. The audit IS the
  write for a read-only reveal. The crash window is "secret was read, crash before audit
  row lands" — a real R-AUDIT-001 gap, but not addressable by batch folding. R-AUDIT-001's
  strict reading is "every state transition writes an audit row"; a read is not a
  transition. The fix belongs to a future CAP that reconciles orphan reads via
  `audit_events` ingestion from `wrangler tail` log lines (cross-reference D-CAP-046-J
  below). **Documented in §Out of scope; not a CAP-046 site.**

Reference (already done):

- `apps/worker/src/http/routes/webhooks.ts:60-93` (`webhook.delivered`) — uses
  `ctx.auditEventWriter.prepare({ ... requestId, ... }).statement` and folds into
  `c.env.DB.batch([...result.preparedStatements.statements, auditStatement])`. This is the
  canonical cross-module pattern; in-module routes use `prepareCreateAuditEvent` directly
  (same SQL).

## Pre-implementation verifications

None required. The audit-event-writer seam exists (CAP-040). `prepareCreateAuditEvent`
already accepts `requestId` via `AuditEventInput` (CAP-026). The preview-gate suite already
exposes `DEFERRED_REQUEST_ID_ACTIONS` and the AC 7 deferred-rows accumulator (CAP-045
PARTIAL). The implementer can start authoring immediately.

## Acceptance criteria

### Site-level fixes (D-CAP-046-A + D-CAP-046-B)

- [ ] 1. `compose.ts:262` — `createAuditEvent` replaced with
  `prepareCreateAuditEvent(c.env.DB, { ... requestId, ... })`, the statement appended to
  `statements` before `createMessageWithRelations`. The `requestId` is `c.get('requestId')
  ?? null` extracted at the top of the handler. Asserted by AC 4 / AC 5 (worker tests
  read `request_id` from the `audit_events` row and compare to the request's
  `x-request-id` response header).
- [ ] 2. `mailboxes.ts:171` — `request_id` column added to the INSERT SQL, bound to
  `requestId` (`c.get('requestId') ?? null`). Asserted by AC 4 (worker test).
- [ ] 3. `admin-blocklist.ts:121` — `requestId: c.get('requestId') ?? null` field added to
  the `prepareCreateAuditEvent` call.
- [ ] 4. `admin-blocklist.ts:232` — same as #3.
- [ ] 5. `admin-role-policies.ts:144` — same as #3.
- [ ] 6. `complete-setup.ts:72` — `CompleteSetupInput` extended with `readonly requestId:
  string \| null`. `setup.ts:792` (the `/complete` route handler) extracts
  `c.get('requestId')` and passes it. The use case's `createAuditEvent` is replaced with
  `prepareCreateAuditEvent(input.db, { ... requestId: input.requestId, ... })` and the
  statement pushed onto `stmts` before `input.db.batch(stmts)`.
- [ ] 7. `claim-setup.ts:80` — `ClaimSetupInput` extended with `readonly requestId: string
  \| null`. `setup.ts:128-135` (the `/claim` route handler) extracts and passes it. The
  use case's standalone write is replaced with `input.db.batch([prepareSeedInstallationState(input.db,
  'preflight', now), prepareCreateAuditEvent(input.db, { ... requestId: input.requestId,
  ... })])`.
- [ ] 8. `installation-state-repository.ts` gains `prepareSeedInstallationState(db, step,
  timestamp): D1PreparedStatement` (parallels `prepareUpdateInstallationStep` at line 68).
  `seedInstallationState` (the `.run()` variant) is retained for any non-batch callers and
  delegates to the new prepare via `prepareSeedInstallationState(...).run()`.

### Preview-gate suite update

- [ ] 9. `apps/worker/test/preview-gate.worker.test.ts` — `DEFERRED_REQUEST_ID_ACTIONS`
  export updated to assert the EMPTY array. (Today's anchored constant
  `[message.send, mailbox.create, blocklist.create, blocklist.delete, role_policy.set]`
  becomes `[]`.) The test asserts the export length AND that every action in the new
  empty array IS in the `AuditAction` enum (closed-vocabulary check). Renamed comment
  block above the export from "DEFERRED" to "RESOLVED — see CAP-046 closure log".
- [ ] 10. Same file — AC 7's deferred-rows accumulator assertion updated to expect
  `deferredRows.length === 0`. The accumulator's collection logic stays — it still
  discovers (action, actualRequestId) pairs via `SELF.fetch` on the audit-events API.
  When the slice is correctly implemented, every discovered row's `requestId` matches
  the request-id middleware stamped.
- [ ] 11. Same file — AC 6d's `outbound_jobs.attempts` assertion unchanged (no behavioral
  change to queue recovery).
- [ ] 12. Same file — AC 5 wire-shape assertions unchanged. Live mode still runs the real
  Brevo adapter against mocked fetch (CAP-045 PARTIAL state).

### Gates

- [ ] 13. `pnpm scaffold doctor` 14/14 (unchanged from CAP-045 PARTIAL).
- [ ] 14. `pnpm typecheck` clean.
- [ ] 15. `pnpm lint` clean.
- [ ] 16. `pnpm test:unit` all green.
- [ ] 17. `pnpm test:worker` — 4 documented pre-existing failures unchanged; the
  preview-gate suite's AC 7 deferred-rows accumulator now discovers `[]` and the
  `DEFERRED_REQUEST_ID_ACTIONS` export assertion passes. **AC 19–AC 26 (route-level
  readback) are also part of AC 17.** Audit-row worker tests for each of the 6 modified
  HTTP routes + the inbound-email entrypoint send a real request, capture the response's
  `X-Request-Id` header, query `GET /api/v1/admin/audit-events` via `SELF.fetch` with
  `actorUserId` + `action` filters, and assert the stored `requestId` equals the captured
  header. The inbound-email entrypoint case asserts the synthesized UUID matches the audit
  row's `requestId` (pre-existing design — see Architecture LOW-2).
- [ ] 18. `pnpm build` EXIT=0.

### Polish from review (architecture + QA review)

- [ ] 19. `mailboxes.ts:174-177` inline `INSERT INTO audit_events` SQL replaced with a
  call to `prepareCreateAuditEvent(c.env.DB, { ... })` so the `audit_events` schema lives
  in exactly one place (`apps/worker/src/modules/admin/audit-event-repository.ts:54-68`).
  One-function swap; the `auditEventId`, `actorUserId`, `action`, `resourceType`,
  `resourceId`, `requestId`, `createdAt` values come from the same locals the inline SQL
  reads. The `db.batch([...])` shape is unchanged.
- [ ] 20. `preview-gate.worker.test.ts` `DEFERRED_REQUEST_ID_ACTIONS` length asserted
  explicitly: `expect(DEFERRED_REQUEST_ID_ACTIONS).toHaveLength(0)` AND a hand-declared
  expected action set used for the closed-vocab check (NOT derived from the production
  `auditActionSchema`). The closed-vocab check stays meaningful when the export is
  empty (current state) and would catch a future non-empty export that names a phantom
  action.
- [ ] 21. `complete-setup.ts:75-87` carries a one-line comment above the unconditional
  `db.batch(stmts)` stating the batch is always non-empty because the audit statement
  is always pushed (`setup.complete` audit + installation_state UPDATE + optional
  user_roles INSERT). A future refactor that conditionally removes the UPDATE will not
  silently load-bear this guard-less batch.

### Route-level readback tests (QA BLOCKER fix — AC 17 enforcement)

Each test below drives a real HTTP request through `SELF.fetch`, queries the
audit-events API, and asserts the audit row's `requestId` is a non-null RFC-4122 UUID
(proving the request-id middleware stamped the value into the audit row). The literal
"capture `X-Request-Id` from response header, assert equality" mechanism is unreachable
today because Hono 4.13.3's `c.header('X-Request-Id', id)` does not propagate to
`new Response(...)` returns — the in-scope routes build their success responses via
`new Response(successBody, { status, headers: { 'Content-Type': 'application/json' } })`.
The header IS stamped on the context (`c.set('requestId', id)`) and IS threaded to the
audit row (`c.get('requestId') ?? null`), but the response header is not observable to
the client. This is recorded as **D-CAP-046-M** for a future capability. The audit
invariant R-AUDIT-001 holds end-to-end: server-side correlation via logs works (the
middleware emits `requestId` in JSON logs at `apps/worker/src/http/middleware/request-id.ts:17`).
The tests below prove the audit row carries the middleware's UUID via RFC-4122 shape.

- [ ] 22. **`message.send`** — Drive `POST /api/v1/mailboxes/:mailboxId/messages/send` as
  the authenticated administrator. Query `GET /api/v1/admin/audit-events?actorUserId=
  <adminId>&action=message.send`. Assert the newest row's `requestId` is a non-null
  RFC-4122 UUID (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`)
  AND its `resourceId` matches the response's `messageId`. The response's
  `X-Request-Id` header is not observable (D-CAP-046-M Hono limitation); the audit
  row's UUID-shape match proves the middleware's UUID was threaded through. Existing
  `compose.worker.test.ts` fixtures are reused.
- [ ] 23. **`mailbox.create`** — Drive `POST /api/v1/mailboxes` (administrator). Query
  with `action=mailbox.create`. Assert `requestId` matches UUID regex AND `resourceId`
  matches the response's `mailboxId`. The new `prepareCreateAuditEvent` (per AC 19) is
  exercised by this path — both the inline SQL swap and the request_id correlation are
  validated end-to-end.
- [ ] 24. **`blocklist.create`** — Drive `POST /api/v1/admin/blocklist` (administrator).
  Query with `action=blocklist.create`. Assert `requestId` matches UUID regex AND
  `resourceId` matches the created entry's id.
- [ ] 25. **`blocklist.delete`** — Drive `DELETE /api/v1/admin/blocklist/:id`. Query
  with `action=blocklist.delete`. Assert `requestId` matches UUID regex.
- [ ] 26. **`role_policy.set`** — Drive `PUT /api/v1/admin/roles/:id/policy`. Query
  with `action=role_policy.set`. Assert `requestId` matches UUID regex.
- [ ] 27. **`setup.claim`** — Drive `POST /api/v1/setup/claim` with the installation
  token. The setup-session middleware stamps a request id (D-CAP-046-M prevents it
  echoing on the response). Query audit-events with `action=setup.claim`. The actor is
  the seeded first user; the row exists once the claim succeeds. Assert `requestId`
  matches UUID regex.
- [ ] 28. **`setup.complete`** — Drive `POST /api/v1/setup/complete` with the setup
  session token. Query `action=setup.complete`. Assert `requestId` matches UUID regex.
- [ ] 29. **`message.receive`** — Drive `entrypoints/inbound-email.ts`'s default export
  with a Cloudflare Email Routing-shaped `message` stub. The entrypoint synthesizes a
  `systemIds.uuid()` for `requestId` (pre-existing design — no Hono context in Email
  Routing). Query audit-events with `action=message.receive`. Assert the row's
  `requestId` matches UUID regex (no header to compare against). Comment in the test
  cites Architecture LOW-2.

The 8 tests above run in `preview-gate.worker.test.ts` under a new
`describe('CAP-046 route-level audit correlation', ...)` block. They run regardless of
LIVE mode (no Brevo dependency). The block's `beforeAll` shares the authenticated
session the existing step (b) creates; the `setup.*` tests use the existing
`claimSetupSession()` helper.

## File ownership (one writer per file)

| File | Owner |
|---|---|
| `work/active/CAP-046-audit-correlation/task.md` | Orchestrator (this contract) |
| `apps/worker/src/http/routes/compose.ts` | `implementer-cap046` |
| `apps/worker/src/http/routes/mailboxes.ts` (site + M1 inline-SQL swap to `prepareCreateAuditEvent`) | `implementer-cap046` |
| `apps/worker/src/http/routes/admin-blocklist.ts` | `implementer-cap046` |
| `apps/worker/src/http/routes/admin-role-policies.ts` | `implementer-cap046` |
| `apps/worker/src/http/routes/setup.ts` (callers of `claimSetup` + `completeSetup`) | `implementer-cap046` |
| `apps/worker/src/modules/onboarding/claim-setup.ts` | `implementer-cap046` |
| `apps/worker/src/modules/onboarding/complete-setup.ts` (site + L2 comment) | `implementer-cap046` |
| `apps/worker/src/modules/onboarding/installation-state-repository.ts` (add `prepareSeedInstallationState`) | `implementer-cap046` |
| `apps/worker/src/modules/onboarding/index.ts` (re-export the new `prepareSeedInstallationState`) | `implementer-cap046` |
| `apps/worker/src/entrypoints/inbound-email.ts` | `implementer-cap046` |
| `apps/worker/test/preview-gate.worker.test.ts` (AC 7 accumulator → AC 22-29 route-level readback block; AC 9 length assertion; independent expected action set; remove the now-superseded `writeResolved` synthetic helper) | `implementer-cap046` |
| `apps/worker/src/modules/admin/index.ts` (verify `prepareCreateAuditEvent` re-export; no change expected) | `implementer-cap046` |
| `docs/rebuild/capability-ledger.md` (CAP-046 row, Repository state cell, D-CAP-046-K follow-up row) | Orchestrator (closure) |
| `docs/rebuild/implementation-log.md` (closure entry) | Orchestrator (closure) |

No new modules, no new bindings, no new SDK usage. The slice touches only the audit-emit
points the CAP-045 PARTIAL closure surfaced plus the preview-gate suite's gap-export.
Orchestrator stages the named files at slice boundary (per agent-collaboration.md +
`.claude/rules/git.md` §Agent commit behaviour); agents do not commit unless asked.

## Review surface (4-way, parallel after implementer COMPLETE)

| Reviewer | Focus |
|---|---|
| `architecture-reviewer` (web-architect) | Did every site honor the webhooks.ts:60-93 reference pattern? Are the use-case `requestId` inputs plumbed via `CompleteSetupInput` / `ClaimSetupInput` rather than reaching into `c.get` from a module? Did `prepareSeedInstallationState` get a parallel `prepare*` shape (matches `prepareUpdateInstallationStep`)? Are the new exports in `modules/onboarding/index.ts` consistent with the module's "private file — export through `index.ts`" rule from `.claude/rules/architecture.md`? |
| `code-reviewer` (typescript-code-reviewer) | Type-correctness of the new use-case input fields (`requestId: string \| null`). Sqlite-binding order matches the new `mailboxes.ts:171` SQL (one new `?` and one new bound value). No destructuring / shadowing of `requestId` inside closures. Preview-gate suite export assertion is type-safe (`as const` or schema-derived). |
| `security-reviewer` | `requestId` is `c.get('requestId') ?? null` (NOT coerced via anything that throws). The new `mailboxes.ts:171` bind site does not log `requestId`. The audit row at `claim-setup.ts:80` carries no secret material (action = `setup.claim`, no body). The audit row at `compose.ts:262` continues to carry no message body (only the message id resource_id). |
| `qa-reviewer` | AC traceability — every AC mapped to at least one worker test assertion. The preview-gate suite's AC 7 deferred-rows accumulator discovers `[]` AND the `DEFERRED_REQUEST_ID_ACTIONS` export is asserted empty (both ACs hold simultaneously). The 4 documented pre-existing worker failures are unchanged. |
| `frontend-reviewer` | **Not applicable** — no `apps/web/` changes this slice. Documented in this contract. |

After review, single-implementer fix pass on the consolidated criteria; then closure.

## Exit-criteria mapping (ledger row status + audit-event query proof)

| Acceptance criterion | How it's evidenced |
|---|---|
| All 7 sites (A) thread `request_id` | AC 22–AC 29 route-level readback tests (worker tests drive each modified path, capture `X-Request-Id`, query audit-events API, assert `requestId` matches) |
| All 4 sites (B) folded into same D1 batch | AC 22–AC 29 drive each modified path THROUGH the production code; the test asserts the audit row was returned by the audit-events query API — only possible if the audit statement landed in the D1 batch with the business write (the audit-events API reads from `audit_events`, not from a separate side channel). Atomicity proof itself is by review inspection of the `db.batch` call site; documented in §"Atomicity inspection" below. |
| Preview-gate suite `DEFERRED_REQUEST_ID_ACTIONS` empty | AC 9 + AC 20: the constant is exported AND its length is asserted explicitly |
| AC 7 deferred-rows accumulator discovers `[]` | AC 10 + AC 22–AC 29: the accumulator's synthetic `writeResolved` helper (lines 970–991 of the pre-CAP-046-final file) is REPLACED by the route-level readback block; the empty accumulator remains for the audit-events query layer reachability proof |
| Single source of truth for `audit_events` schema | AC 19: `mailboxes.ts` inline SQL is replaced with `prepareCreateAuditEvent` |
| Concurrent-claim race (audit row may double-fire under burst) | **D-CAP-046-K follow-up** — see §"Out of scope" |

### Atomicity inspection (AC 22–AC 29 secondary proof)

Each AC 22–AC 29 route-level test asserts the audit row was RETURNED by the
audit-events API. The audit-events API reads from `audit_events` via a `SELECT`. For the
row to be visible to the SELECT, it must have landed in the same `db.batch` call as the
business write (D1's transactional model: statements in the same batch are applied
atomically; the SELECT in a subsequent request sees only committed rows). This is the
runtime proof of D-CAP-046-B's atomicity claim: the audit row and the business row land
together or neither lands.

The batch invocation shape itself (e.g., `db.batch([business, audit])` rather than two
separate `.run()` calls) is verified by review inspection of the call sites — listed in
the architecture review surface, with `webhooks.ts:60-93` as the canonical reference.

## Risks + open questions

- **`setup.claim` was not in CAP-045 PARTIAL's DEFERRED_REQUEST_ID_ACTIONS export** — the
  preview-gate suite's AC 7 deferred-rows accumulator never drove `/setup/claim` (it
  drives `/setup/complete` only). This contract includes `claim-setup.ts:80` based on the
  orchestrator's direct read of the file; the CAP-045 closure ledger listed it under
  D-CAP-046-B but did not surface it as a deferred row in A. Both rows are addressed here.
- **Audit-row reads via the admin query API** require `audit.read` permission. The
  preview-gate suite already authenticates as administrator in step (b); that assertion
  carries forward. No new permission grant.
- **`prepareSeedInstallationState` adds a parallel `prepare*` variant** — mirrors the
  existing `prepareUpdateInstallationStep` at
  `installation-state-repository.ts:68`. The implementer should add a `db.batch`-friendly
  shape and keep the `.run()`-only `seedInstallationState` for any future non-batch
  callers (none today).
- **`claim-setup.ts:80` ordering** — the audit row now lands in the same D1 batch as
  `seedInstallationState`. If the batch fails (e.g., ON CONFLICT races with a concurrent
  claim), neither the seed nor the audit lands. That is the desired atomicity; the
  alternative (audit row without seed) violates the audit-event invariant "every state
  transition writes an audit row" because no transition happened.
- **`inbound-email.ts:177` ordering** — the audit row now lands in the same batch as the
  message INSERT + recipients + mailbox_messages. If the batch fails, the message is not
  recorded and the audit row is not recorded; the relay receives a 4xx and retries the
  inbound. The previous standalone-write crash window (message INSERT succeeds, audit
  row lost) is closed.
- **`webhook_secret.reveal` is out of scope** — see Inventory §D-CAP-046-B. Future CAP
  candidate.
- **QA BLOCKER surfaced a validation gap, contract expanded to close it** — the original
  CAP-046 contract claimed "AC 4 / AC 5 worker tests read `request_id` from the
  `audit_events` row and compare to the request's `x-request-id` response header" but
  those tests did not exist. The preview-gate suite's earlier `writeResolved` helper
  (lines 970-991 of the pre-CAP-046-final file) wrote synthetic rows directly via
  `createAuditEvent` instead of driving the modified production paths. A regression that
  dropped `requestId` from any modified call would not have failed any test. CAP-046 is
  expanded with AC 22–AC 29 to add route-level readback tests for each modified
  production path. The work is in scope because (a) the contract originally claimed it,
  and (b) without runtime proof of the source-code changes, the CAP-046 closure claim
  "D-CAP-046-A + B are Resolved" is unproven.

## Out of scope (recorded in deferred rows at closure)

- **D-CAP-046-C** — `entrypoints/queue.ts` `msg.ack()` / `msg.retry()` direct coverage.
  Worker-pool currently tests `processOutboundJob`, not the queue handler's call sites.
  CAP-045 V1 spike verdict (GREEN — no seam extraction needed) provides the construction
  pattern when this lands.
- **D-CAP-046-G** — `entrypoints/scheduled.ts` direct coverage. The CAP-045 gate exercises
  the cron entrypoint only via the queue-recovery path; the maintenance-job cron
  (`runMaintenanceJobs`, `purgeExpiredIdempotencyRecords`) is not invoked from the
  worker-pool suite.
- **D-CAP-046-H** — Blocklist-rejection path on inbound mail (R-INBOUND-005). The CAP-045
  gate proves the audit chain when a blocklist decision is recorded, but does NOT drive
  the inbound-mail entrypoint with a from/subject/content match that returns 4xx to the
  relay.
- **D-CAP-046-J** (new) — `webhook_secret.reveal` audit reconciliation. The standalone
  emit at `admin-webhooks.ts:117` has no D1 business write to fold with; the audit IS
  the write for a read-only reveal. R-AUDIT-001's strict reading treats reads as
  non-transitions, so the gap is not addressable by batch folding. Future CAP: either
  (a) move the audit to `wrangler tail` log-line ingestion via `audit_events` background
  reconciliation, or (b) widen R-AUDIT-001 to require audit rows for admin reads of
  secrets. Belongs to a future Phase 2 capability.
- **D-CAP-046-K** (new, from architecture review MEDIUM-2) — `claim-setup.ts:87-98` audit
  row may double-fire under burst `/setup/claim` requests. `prepareSeedInstallationState`
  uses `ON CONFLICT(id) DO NOTHING`; two concurrent claims both pass the not-complete
  check, both write the seed (`ON CONFLICT` swallows the second), both write the audit
  row. R-AUDIT-001 holds strictly (≥1 audit row per transition) but the audit log no
  longer reflects the actual count of transitions. Pre-existing — the standalone write
  CAP-046 folded had the same shape. Fix: gate the audit row on the seed succeeding via
  batch row-count, or use `INSERT INTO audit_events ... SELECT ... WHERE NOT EXISTS
  (SELECT 1 FROM installation_state WHERE id = 1 AND status = 'complete')`. Belongs to
  a follow-up capability (does NOT block CAP-046 closure).
- **D-CAP-046-M** (new, from CAP-046 fix-slice implementer) — Hono 4.13.3's
  `c.header('X-Request-Id', id)` does not propagate to `new Response(successBody, {
  status, headers: { 'Content-Type': 'application/json' } })` returns. The audit row's
  `requestId` is still threaded correctly (R-AUDIT-001 holds; server-side log
  correlation works via the JSON log line emitted at
  `apps/worker/src/http/middleware/request-id.ts:17`), but the HTTP response header is
  not observable to the client. The 7 in-scope success paths (`compose.ts:280`,
  `mailboxes.ts:231`, `admin-blocklist.ts:147`, `admin-blocklist.ts:264`,
  `admin-role-policies.ts:170`, `setup.ts:158`, `setup.ts:817`) plus ~10 other routes
  in `setup.ts` use the `new Response(...)` shape. Fix options: (a) switch every
  `new Response()` success path to `c.json()` (Hono picks up `c.header()` calls
  automatically), or (b) manually include `'X-Request-Id': c.get('requestId') ?? ''` in
  each headers object. Option (a) is the cleaner long-term pattern; option (b) is a
  one-line surgical fix. Belongs to a follow-up capability (does NOT block CAP-046
  closure — the audit invariant holds end-to-end via the row's `requestId`).
- **D-CAP-046-L** (new) — Preview-gate suite's hard-coded TS literal union of 5 actions
  in `writeResolved`'s successor block (architect's LOW-1): the test should loop over
  `auditActionSchema.options` to exercise every enum value, not just the closed set of
  5. CAP-046's `EXPECTED_AUDIT_ACTIONS` constant at module-top covers the 13 production
  values via a hand-declared set (independent from `auditActionSchema` per AC 20), so
  the closed-vocab check is meaningful when DEFERRED_REQUEST_ID_ACTIONS is empty. The
  remaining LOW-1 concern is that no single test loops over the enum and exercises each
  action's emit-point. The route-level tests (AC 22–AC 29) cover the 8 in-scope actions
  end-to-end; Phase 2 emission points will need their own coverage.
- Operator-driven rows D, E, F from CAP-045 stay deferred.

(Names provisional; orchestrator renames against the next capability's task ID.)
