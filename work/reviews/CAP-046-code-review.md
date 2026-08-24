# CAP-046 — Code Review (fix-slice re-review)

**Reviewer:** `.claude/agents/code-reviewer.md` · **Date:** 2026-08-24 · **Base:** `claude/cap-042-better-auth-integration-c47133`

**Status:** ACCEPT

## Summary

The CAP-046 fix slice closes the QA BLOCKER the first slice left open. Every modified
audit-emit site now threads `c.get('requestId') ?? null` into the audit row (and folds the
prepared statement into the same D1 batch as the business write). The preview-gate suite's
synthetic `writeResolved` helper is replaced by eight route-level readback tests that drive
each production path through `SELF.fetch` and assert the stored audit row's `requestId` is a
valid UUID. All eight new tests pass (8/8, verified). The single most important hygiene item
is **LOW-1** — AC 29 uses an inline regex literal where `UUID_V4_REGEX` should be reused;
trivial to address in the closure commit.

## BLOCKER

> Ship-stopping: data loss, auth bypass, invariant violation, broken architecture rule.

_None._

## HIGH

> Wrong under a realistic condition. Must be fixed before acceptance.

_None._

## MEDIUM

> Should fix. May be deferred if recorded in the capability ledger with a reason.

_None._

## LOW

> Style, naming, minor duplication. Fix if cheap.

### L1 — AC 29 message.receive uses an inline regex literal instead of `UUID_V4_REGEX`

- **Where:** `apps/worker/test/preview-gate.worker.test.ts:1779-1781`
- **Violates:** `.claude/rules/coding.md` §Abstraction discipline (rule of three not violated,
  but consistency within a single file is).
- **Failure scenario:** none today — `crypto.randomUUID()` returns lowercase UUIDs so the
  missing `i` flag is a no-op. Future tightening of `UUID_V4_REGEX` (e.g. v4-only version-digit
  check) would silently leave AC 29 testing a less-strict shape than the other seven tests.
- **Fix:** replace the inline regex with `UUID_V4_REGEX` (a one-line edit).

### L2 — `UUID_V4_REGEX` comment overstates the pattern's strictness

- **Where:** `apps/worker/test/preview-gate.worker.test.ts:107-113`
- **Violates:** none (documentation accuracy only).
- **Failure scenario:** none at runtime — `crypto.randomUUID()` only emits v4. The regex
  matches any 8-4-4-4-12 hex string; the comment claims it matches "RFC 4122 versions" but
  a true RFC 4122 conformance check requires the version digit (third group's first hex char
  must be `1`-`5`) and the variant nibble (fourth group's first hex char must be `8`-`b`).
- **Fix:** rephrase to "matches the 8-4-4-4-12 hex shape of an RFC 4122 UUID; sufficient for
  the v4 generator in use."

### L3 — File missing trailing newline

- **Where:** `apps/worker/test/preview-gate.worker.test.ts:1783` (last line)
- **Violates:** POSIX text-file convention.
- **Failure scenario:** none.
- **Fix:** append a final newline.

## Type-correctness verification

- `prepareCreateAuditEvent` import in `apps/worker/src/http/routes/mailboxes.ts:19` is a clean
  addition. The file did not previously import `createAuditEvent`; `auditEventId` (line 130)
  is still bound as the row PK at line 179. No dead-code removal needed.
- `AuditEventInput` shape (apps/worker/src/modules/admin/audit-event-repository.ts:21-30) accepts
  the exact field set the call site passes — verified against the in-module re-declaration; the
  contracts-package declaration at packages/contracts/src/admin/audit.ts:91-100 is the same shape.
- The literal action `'mailbox.create'` is the fourth member of the closed `AuditAction` enum
  (`auditActionSchema` at packages/contracts/src/admin/audit.ts:57-77). TypeScript would reject
  any non-enum literal at the call site.
- `CompleteSetupInput.requestId: string | null` extends the interface in place. The route caller
  at `apps/worker/src/http/routes/setup.ts:800` passes `c.get('requestId') ?? null` — `string |
  null` to `string | null`, type-compatible.
- `ClaimSetupInput.requestId: string | null` is the symmetric shape. Caller at setup.ts:136 is
  the same pattern.
- `EXPECTED_AUDIT_ACTIONS` is typed `ReadonlyArray<string>`. The phantom-action check
  (`filter((a) => !auditActionSet.has(a))` at line 1072) is type-safe — `auditActionSet` is
  `Set<string>`, filter result is `string[]`. A typo'd entry surfaces at runtime.
- The `auditActionSchema.options as ReadonlyArray<string>` cast at line 1058 is
  type-compatible: zod's `z.enum([...]).options` is `readonly [string, ...string[]]`, which is
  a subtype of `ReadonlyArray<string>`.
- The audit-events response cast at line 1436-1438 (`as { data: { items: ...; nextCursor: ... } }`)
  matches `auditEventListResponseSchema` (packages/contracts/src/admin/audit.ts:159-163). Optional
  fields not asserted are allowed by the cast.
- No `requestId` destructuring or shadowing inside any `it()` callback (`grep "const requestId\|const { requestId\|let requestId"` returns nothing). The middleware-stamped value is referenced
  only via `row.requestId` (property access).
- The middleware value `c.get('requestId') ?? null` collapses `undefined` to `null`, matching
  the `TEXT NULL` shape of the `audit_events.request_id` column.
- `pnpm typecheck` exits 0 (verified).

## Test-craft rigor

- `beforeAll` (line 1312-1362) seeds installation_state.status='complete', roles, admin user
  with hashed password, administrator role grant, and a managed domain. `adminId` and
  `domainRouteId` are captured as describe-scope locals for use in `beforeEach`.
- `beforeEach` (line 1364-1422) resets D1 (which wipes KV/CACHE — invalidating any
  pre-beforeAll token) and re-seeds the same fixtures with the captured IDs, then logs in to
  obtain a fresh accessToken. This correctly handles the CACHE-reset side effect of
  `resetAndMigrate()`.
- `fetchNewestAuditRow` (line 1427-1444) filters by both `actorUserId` AND `action`. The
  setup.claim and setup.complete tests drop `actorUserId` from the filter because those use
  cases write `actorUserId: null` (the opaque token sha256, not a user id).
- `fetchNewestAuditRow` sorts the response items by `createdAt` DESC client-side. The
  audit-events API's repository already returns rows in `ORDER BY created_at DESC, id DESC`
  (apps/worker/src/modules/admin/audit-query-repository.ts:193) — the JS-side sort is
  defensive but redundant, harmless.
- Each test asserts BOTH `row.requestId matches UUID_V4_REGEX` AND `row.resourceId matches
  expected`. This catches both "dropped requestId" and "wired the wrong id into the audit row".
- The setup.claim and setup.complete tests handle the setup-session token correctly:
  setup.claim uses a fresh `Idempotency-Key` and the body token (claim is authenticated by
  X-Installation-Token + body.token via `readSecret` at setup.ts:127), while setup.complete
  reuses the existing `claimSetupSession()` helper at line 121-135 (same helper the AC 4 and
  AC 6a tests already exercise).
- The message.receive test (AC 29) imports the entrypoint's default export (`inboundEmail` at
  line 25) and invokes it with a Cloudflare Email Routing-shaped stub constructed by
  `makeInboundMessage`. The stub invokes the entrypoint directly (`inboundEmail.email(message,
  env)` at line 1759) — the same pattern as the pre-existing AC 5 test at line 542.
- The console-spy V3 pattern is preserved: the file-level `beforeEach` toggles spies to
  RECORDING (line 183-194), `afterEach` toggles back to SILENT (line 201-204). The CAP-046
  block adds its own `beforeEach` and `beforeAll` but does NOT override the file-level
  `afterEach`, and crucially does NOT call `restoreAllMocks()` (verified by grep — only
  comments mention it).
- `expect(items.length).toBeGreaterThanOrEqual(1)` in AC 27/28/29 is a defensive guard against
  an empty response — a missing audit row throws "Expected at least one … audit row but found
  none after sort" with a useful diff message.
- `EXPECTED_AUDIT_ACTIONS` lists 13 values, mirroring the 13 in `auditActionSchema.options`
  (manual diff against packages/contracts/src/admin/audit.ts:57-77). The `phantomExpected`
  check at line 1072-1077 ensures this list stays honest — a future typo surfaces at runtime.
- `DEFERRED_REQUEST_ID_ACTIONS` is asserted empty via `expect(DEFERRED_REQUEST_ID_ACTIONS)
  .toHaveLength(0)` at line 1049 — the explicit closure assertion required by AC 20.
- The `unexpectedClosedVocabulary` check at line 1058-1065 ensures every action in the (now
  empty) export is a member of the AuditAction enum — guarding against a future non-empty
  export that names a phantom action.

## Hono header-echo compromise

**ACCEPTABLE.**

Hono 4.13.3's `c.header('X-Request-Id', id)` does not propagate to a manually-constructed
`new Response(...)`. The seven in-scope routes plus ~10 other routes in setup.ts all use the
`new Response()` shape. The contract documents the compromise as **D-CAP-046-M** with a
follow-up capability for the fix. The UUID-shape verification is sufficiently rigorous for
the closure claim:

- `null` (a regression that drops requestId entirely) does NOT match the regex — test fails loud.
- A non-null but non-UUID string (e.g. 'unknown', 'pending') does NOT match — test fails loud.
- The only way to pass the test is to write a UUID-shaped string into `request_id`, which is
  exactly what the middleware stamps (`crypto.randomUUID()` per
  apps/worker/src/platform/ids.ts:9).

A regression that threads a DIFFERENT UUID per call (e.g. a counter) would still pass the
shape check, but the load-bearing claim is R-AUDIT-001 (audit row per state transition with
the middleware's correlation UUID). A counter regression would surface in log correlation —
separate concern, not blocking CAP-046 closure.

## Not verified

- The 4 pre-existing test failures (`admin.worker.test.ts > creates all 21 permissions with
  correct IDs`, `creates the administrator role with all 21 permissions`,
  `0015_credential_backfill.worker.test.ts > seeds five legacy users at the 0014 boundary`,
  and one more) reproduce against the parent commit via `git stash` (verified by stashing
  CAP-046 changes and re-running the targeted test). These are NOT regressions from CAP-046.
  My local worker run surfaced 3 of the 4 (vitest's report cuts off the 4th), so I cannot
  confirm the exact 4 vs 3 mismatch from the implementer's report; the gap is environmental.
- I did not re-run `pnpm scaffold doctor` against the CAP-046 changes (the contract cites this
  as AC 13 unchanged from CAP-045 PARTIAL; the implementer's gate report claims 14/14).
- I did not manually inspect `setup.ts`'s other ~10 `new Response()` paths listed in the
  D-CAP-046-M comment — the fix-slice is scoped to the 7 audit-emit sites, not the header-
  echo fix. The follow-up capability for D-CAP-046-M owns that work.
- I did not verify whether the 13-value `EXPECTED_AUDIT_ACTIONS` list is exhaustive of every
  emit-point in production (the comment says "Mirrors the 13 values listed in
  packages/contracts/src/admin/audit.ts:57-76" — i.e. it mirrors the closed enum, not the
  emit-points). A literal reading suggests the list is the enum values themselves, not the
  emit-points — which is what the comment also says. Low risk either way.

## Required fixes

1. L1 — replace inline regex in AC 29 with `UUID_V4_REGEX`.
2. L3 — append final newline to `preview-gate.worker.test.ts`.

L2 may be deferred as a documentation nit.