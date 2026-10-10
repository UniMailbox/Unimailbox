# CAP-031 — Request validation + 1 MB body limit on all `/api/v1/*`

## Goal

Every `/api/v1/*` POST/PUT/PATCH/DELETE route:

1. Rejects request bodies over **1 MB** with `413 BODY_TOO_LARGE` (per
   `.claude/rules/security.md` §Input and transport).
2. Surfaces malformed JSON as a stable `400 INVALID_JSON` code with a
   structured warn log (no body) — not a generic `VALIDATION_ERROR` and not a
   `500`.
3. Codifies the rule "**do not write an `idempotency_records` row on
   client-side validation failures**" once, in a single helper. Resolves
   `D-CAP-037-A`.

Phase 2 acceptance criterion: "No `/api/v1/*` endpoint accepts a request > 1 MB"
(`docs/rebuild/H-progressive-rebuild-roadmap.md:128`,
`docs/rebuild/08-roadmap/phase-2-core-loop.md:35`).

## Scope

**In scope:**

- **New helper** `parseJsonBody` at
  `apps/worker/src/http/middleware/parse-json-body.ts`. Signature:
  ```ts
  parseJsonBody<T>(
    rawBody: string,
    schema: ZodSchema<T>,
    ctx: { event: string; actorUserId?: string },
  ): T
  ```
  Behavior:
  - `JSON.parse(rawBody)` wrapped in try/catch.
  - `SyntaxError` → `logger.warn({ event, actorUserId })` (no body) →
    `throw new DomainError({ code: 'INVALID_JSON', message: 'Request body is
    not valid JSON', httpStatus: 400 })`.
  - `ZodError` falls through (re-thrown) so the existing error middleware
    keeps producing `400 VALIDATION_ERROR` for structural failures. **Do not**
    catch `ZodError` here.
  - File header comment cites **ADR-004 + D-CAP-037-A** so the no-record rule
    travels with the helper, not with every call site.

- **New middleware** `enforceBodySize(maxBytes: number)` at
  `apps/worker/src/http/middleware/body-size.ts`. Behavior:
  - Reads `Content-Length` header; rejects with
    `413 BODY_TOO_LARGE` (stable code, per `.claude/rules/security.md`
    §Input and transport) when present and over the limit.
  - As a defense-in-depth fallback (some clients omit `Content-Length`),
    reads the raw body once, measures its byte length, and rejects with
    `413 BODY_TOO_LARGE` when over the limit. Returns the body as a `Response`
    body downstream (Hono's `await next()` does not propagate the body after
    `c.req.text()` has been consumed — implementer verifies the propagation
    pattern against the existing `requireIdempotencyKey` middleware and
    documents the chosen approach in the helper file header).
  - Middleware emits **no log line** for over-limit rejections (no body
    content logged — `.claude/rules/security.md` §Logging forbids logging
    request bodies).

- **Router wiring** at `apps/worker/src/http/router.ts`. Mount
  `enforceBodySize(1024 * 1024)` on the `/api/v1/*` parent sub-app **before**
  the `requestId → setupGate → authn → routes` chain, and **skip** it for the
  `/api/v1/webhooks/*` sub-app (see Open question Q1).

- **Site refactors — 9 sites using `parseJsonBody`** (one helper, one call):
  | File | Line | Operation | Auth posture |
  |---|---|---|---|
  | `apps/worker/src/http/routes/admin-role-policies.ts` | 132-151 | `PUT /api/v1/admin/role-policies/:roleId` | requirePermission + idempotency |
  | `apps/worker/src/http/routes/admin-blocklist.ts` | 89-108 | `POST /api/v1/admin/blocklist` | requirePermission + idempotency |
  | `apps/worker/src/http/routes/compose.ts` | 125 | `POST /api/v1/messages/send` | idempotency |
  | `apps/worker/src/http/routes/mailboxes.ts` | 94 | `POST /api/v1/mailboxes` | idempotency |
  | `apps/worker/src/http/routes/admin.ts` | 135 | `POST /api/v1/admin/invite-codes` | requirePermission + idempotency |
  | `apps/worker/src/http/routes/setup.ts` | 86 | `POST /api/v1/setup/claim` | best-effort idempotency |
  | `apps/worker/src/http/routes/setup.ts` | 231 | `POST /api/v1/setup/administrator` | best-effort |
  | `apps/worker/src/http/routes/setup.ts` | 287 | `POST /api/v1/setup/domain` | best-effort |
  | `apps/worker/src/http/routes/setup.ts` | 542 | (TBD — fourth setup site) | best-effort |

  Each call site replaces its existing `schema.parse(JSON.parse(rawBody))` with
  `parseJsonBody(rawBody, schema, { event: '<route>.invalid_json', actorUserId:
  userId })` and **removes** the now-redundant try/catch block.

- **Site refactors — 3 sites with try/catch only (NOT `parseJsonBody`)**:
  | File | Line | Operation | Why not `parseJsonBody` |
  |---|---|---|---|
  | `apps/worker/src/http/routes/auth.ts` | 98 | `POST /api/v1/auth/register` | Fix 9 (CAP-027): must extract `actorId` field BEFORE schema parse and BEFORE replay lookup |
  | `apps/worker/src/http/routes/auth.ts` | 284 | `POST /api/v1/auth/login` | Same — Fix 9 |
  | `apps/worker/src/http/routes/auth.ts` | 467 | `POST /api/v1/auth/refresh` | Same — Fix 9 |

  These sites retain the bare `JSON.parse(rawBody)` + `actorId` extraction, and
  wrap **only** the `JSON.parse` in a try/catch producing the same `INVALID_JSON`
  DomainError. The wrapper logic mirrors `parseJsonBody`'s — but locally,
  because the helper would force validation before replay, breaking Fix 9.

- **Cleanup** `apps/worker/src/http/middleware/error.ts:31-41`. The
  `SyntaxError → 400 VALIDATION_ERROR` branch becomes **defense-in-depth**
  once every route catches `SyntaxError` explicitly. Add a comment explaining
  the post-CAP-031 role. Do **not** delete the branch — a future route that
  forgets to use `parseJsonBody` will still get `400` (not `500`).

- **Tests.** Every test is named after the rule it proves.

## Out of scope

- **Webhook body limit.** `/api/v1/webhooks/*` is **exempt** from
  `enforceBodySize` in this capability. The receiver (`webhooks.ts:43`) reads
  `c.req.text()` to verify the provider HMAC signature **before** parsing, so
  capping at 1 MB would reject legitimate provider payloads (inbound email
  webhooks can be multi-MB). Recorded as **D-CAP-031-A** — see Open question
  Q1.
- **Per-provider webhook size policy** (Brevo/Resend/Cloudflare). Future
  capability.
- **`messages.ts:165` `PATCH /api/v1/messages/:id/read`** — reads `rawBody`
  but never calls `JSON.parse` (PATCH with no required body, hashes empty
  bytes). The middleware will still apply; the route needs no helper change.
- **Stable `code` on every endpoint.** That's CAP-032.
- **`Idempotency-Key` header on every mutating route.** That's already CAP-027.
- **Schema-level body-size limits** (zod `.max(n)` per field). Out of scope;
  the global 1 MB cap is the only size policy.

## Business rules

- **R-INPUT-001** (or equivalent — cite by ID from `business-rules.md` if
  present, else describe) — Request body must be valid JSON.
- **R-INPUT-002** — Malformed JSON returns `400 INVALID_JSON` (stable code),
  not `400 VALIDATION_ERROR` and not `500`.
- **R-INPUT-003** — Zod structural validation failures continue to return
  `400 VALIDATION_ERROR` (unchanged behavior).
- **R-API-005** — Request body > 1 MB returns `413 BODY_TOO_LARGE` (stable
  code). `.claude/rules/security.md` §Input and transport.
- **R-API-004** (ADR-004) — `Idempotency-Key` replays do not block corrected
  retries when the original request was malformed (no `requestHash` stored for
  INVALID_JSON). Codifies **D-CAP-037-A** as a route-level policy.
- **R-LOG-001** (`.claude/rules/security.md` §Logging) — Malformed body
  rejection emits a warn log with `event` + `actorUserId`, **never** the body
  bytes.

## Acceptance criteria

Each criterion is demonstrated by at least one test named after the rule ID.
Acceptance fails if a criterion has no named test.

### Helper (`parseJsonBody`)

- **AC1.** `parseJsonBody('not valid json', schema, ctx)` throws
  `DomainError({ code: 'INVALID_JSON', httpStatus: 400 })`.
- **AC2.** `parseJsonBody('not valid json', schema, ctx)` logs at `warn` with
  `{ event, actorUserId }` and **no** body field. Verify via `vi.spyOn(logger,
  'warn')`.
- **AC3.** `parseJsonBody('{"badField": "x"}', schema, ctx)` re-throws
  `ZodError` unchanged (the error middleware still maps it to `400
  VALIDATION_ERROR`).
- **AC4.** `parseJsonBody('{"good": true}', schema, ctx)` returns the parsed
  object.

### Middleware (`enforceBodySize`)

- **AC5.** A POST with `Content-Length: 1048577` returns `413` with body
  `{"error":{"code":"BODY_TOO_LARGE",...}}` before any handler runs (no
  authn/idempotency lookups — verify the request never reaches them).
- **AC6.** A POST with no `Content-Length` header and a 1.5 MB raw body
  returns `413`.
- **AC7.** A POST with `Content-Length: 1024` and a 1 KB raw body is passed
  through to the next middleware.
- **AC8.** The middleware emits **no log line** for over-limit rejections
  (no body logged).
- **AC9.** Webhook routes (`/api/v1/webhooks/*`) are **not** subject to the
  middleware — a 2 MB POST to `/api/v1/webhooks/brevo/abc` reaches the
  handler (verifiable by signature-verification failure, not `413`).

### Per-route INVALID_JSON coverage

For **each of the 12 sites** (9 helper + 3 try/catch), one worker test:

- **AC10.** POST/PUT with `Content-Type: application/json`, body
  `'not valid json'`, valid `Idempotency-Key`, valid auth → response `400`
  with body `{"error":{"code":"INVALID_JSON",...}}`.

The 9 helper sites use the shared helper; the 3 auth sites use their local
try/catch. Each test is the smallest variation that proves the guard fires
(matching the `admin-role-policies.worker.test.ts:672-693` precedent from
CAP-035 / CAP-037).

### Per-route idempotency-record absence (D-CAP-037-A codification)

- **AC11.** After the INVALID_JSON rejection above, a corrected retry with
  the **same `Idempotency-Key`** and a **valid JSON body** returns `2xx` (or
  the route's success status) — **not** `409 IDEMPOTENCY_KEY_REUSED`. This is
  tested on at least one site per pattern (helper + try/catch), for a minimum
  of 2 representative routes.

### Defense-in-depth

- **AC12.** If a future contributor adds a new POST endpoint that calls
  `JSON.parse(rawBody)` without `parseJsonBody`, the request still returns
  `400` (not `500`) — via the error middleware's `SyntaxError` branch.

### Quality gates (`.claude/rules/testing.md`)

- `pnpm lint`
- `pnpm typecheck` (zero new `@ts-expect-error`)
- `pnpm test:unit`
- `pnpm test:worker`
- `pnpm build`
- `pnpm scaffold doctor`

## Vertical slice

Roughly in order. The implementer should not feel bound by sequence — these
are the natural groupings, not dependencies between commits.

1. **Helper + middleware + their unit tests.** New files only. No route
   changes. Tests prove AC1-AC9.
2. **Router wiring.** Mount `enforceBodySize` on `/api/v1/*` (skip webhooks).
   Tests prove AC5-AC9 end-to-end on the existing `/api/v1/mailboxes` POST
   route (no new test for the skip — AC9 covers it).
3. **Refactor 9 helper sites.** Mechanical; each removes a try/catch block.
   One new worker test per site. AC10 + AC11 (helper half).
4. **Refactor 3 auth sites.** Local try/catch, no helper. One new worker test
   per site. AC10 + AC11 (try/catch half).
5. **`error.ts:31-41` defense-in-depth comment.** No test (covered by AC12).

## File ownership

The implementer owns every file below for the duration of this slice. No
other agent writes them.

**New:**

- `apps/worker/src/http/middleware/parse-json-body.ts`
- `apps/worker/src/http/middleware/parse-json-body.test.ts`
- `apps/worker/src/http/middleware/body-size.ts`
- `apps/worker/src/http/middleware/body-size.test.ts`

**Modified:**

- `apps/worker/src/http/router.ts` (mount `enforceBodySize` on `/api/v1/*`,
  excluding webhooks)
- `apps/worker/src/http/middleware/error.ts` (add defense-in-depth comment at
  `:31-41`)
- `apps/worker/src/http/routes/admin-role-policies.ts:132-151`
- `apps/worker/src/http/routes/admin-blocklist.ts:89-108`
- `apps/worker/src/http/routes/compose.ts:125`
- `apps/worker/src/http/routes/mailboxes.ts:94`
- `apps/worker/src/http/routes/admin.ts:135`
- `apps/worker/src/http/routes/setup.ts` (lines 86, 231, 287, 542)
- `apps/worker/src/http/routes/auth.ts` (lines 98, 284, 467 — try/catch only)
- Corresponding `*.worker.test.ts` files: add 1 test per site for AC10 (12
  tests total). Add 2 representative tests for AC11.

The implementer does **not** modify:

- `packages/contracts/**` (no schema change)
- `apps/worker/src/platform/idempotency.ts` (no new helpers; existing
  `findIdempotencyRecord` / `assertSameRequestHash` continue to work — no
  record is written on the INVALID_JSON path, so no replay happens)
- `docs/rebuild/**` (orchestrator updates the ledger + implementation log +
  deferred items at acceptance)
- `work/active/CAP-031-request-validation-body-limit/task.md` (this file)

## Reading list

Implementer reads these before writing code:

- `CLAUDE.md`
- `.claude/agents/implementer.md`
- `.claude/rules/coding.md`
- `.claude/rules/security.md` (especially §Input and transport, §Idempotency,
  §Logging)
- `.claude/rules/architecture.md` (especially §API conventions — error envelope
  shape)
- `.claude/rules/testing.md`
- `.claude/rules/agent-collaboration.md`
- `.claude/templates/handoff.md` (only if reporting blocked)
- `docs/rebuild/capability-ledger.md` — CAP-027, CAP-035, CAP-037 rows;
  `D-CAP-037-A` definition; quality-gate evidence format
- `work/reviews/CAP-037-code-review.md` — M2 finding defines D-CAP-037-A;
  L2 defines the line-number citation convention
- **Canonical guard pattern** — `apps/worker/src/http/routes/admin-role-policies.ts:132-151`
  and `apps/worker/src/http/routes/admin-blocklist.ts:89-108`
- **Canonical INVALID_JSON test** — `apps/worker/src/http/routes/admin-role-policies.worker.test.ts:672-693`
- **Canonical Fix 9 (CAP-027)** — `apps/worker/src/http/routes/auth.ts:85-130`
  (register), `:275-315` (login), `:455-495` (refresh)

## Dependencies

- Phase 1 closed: `pnpm scaffold doctor` exits 0; `pnpm test:worker` passes
  against the current route inventory. The new middleware adds no binding
  dependency.
- The 1 MB limit (1024 × 1024 bytes) is a literal — no config knob, no env
  var. If we ever need to tune it per-environment, that becomes a separate
  capability.

## Decisions made during this capability

- **D-CAP-031-A.** Webhook routes (`/api/v1/webhooks/*`) are exempt from
  `enforceBodySize` in this capability. Rationale: signature verification
  reads the raw body before parsing, and provider payloads (inbound email
  webhooks, in particular) can legitimately exceed 1 MB. A future capability
  introduces a per-provider size policy based on each provider's documented
  limits. Tracked in `docs/rebuild/capability-ledger.md` deferred items at
  capability acceptance.
- **D-CAP-031-B.** `parseJsonBody` does **not** catch `ZodError`. Structural
  validation failures continue to surface as `400 VALIDATION_ERROR` from the
  existing error middleware — a behavior change there is a CAP-032 decision.
  Rationale: keeping the helper focused on its single responsibility (JSON
  syntax, not schema structure) makes the rule citation cleaner and avoids
  two error-code sources in one helper.
- **D-CAP-031-C.** The 3 `auth.ts` sites do **not** use `parseJsonBody`.
  They use a local try/catch that mirrors it. Rationale: Fix 9 (CAP-027)
  requires extracting the `actorId` field from the raw JSON **before**
  schema parse and **before** replay lookup, so the body must be parsed
  twice (once for `actorId`, once for the schema) and the validation must
  not happen before the replay. A single helper that parses + validates
  would force the wrong order.
- **D-CAP-031-D.** `error.ts:31-41` retains its `SyntaxError → 400
  VALIDATION_ERROR` branch. Rationale: defense-in-depth. A future contributor
  who forgets to use `parseJsonBody` should still get `400`, not `500`.

## Open questions

- **Q1.** Confirm the webhook exemption with the operator. The Phase 2
  acceptance criterion is written as a blanket "no /api/v1/* endpoint
  accepts a request > 1 MB" statement. The exemption is a deviation;
  D-CAP-031-A records it as a future-capability follow-up. If the operator
  rejects the deviation, scope expands to add per-provider size limits in
  this capability (escalates Q1 to the orchestrator at the review round).

## Risks

- **Routing pattern for body propagation.** Hono's middleware order is
  load-bearing: once `enforceBodySize` calls `c.req.text()`, subsequent
  middleware that needs the body (the `parseJsonBody` call in the route
  handler) must not call `c.req.text()` again — they receive the bytes the
  middleware cached. The implementer must verify this against Hono's
  middleware composition docs or the existing `requireIdempotencyKey`
  precedent. If Hono re-reads from the network, the middleware must cache
  the body in a Hono context variable. (Not anticipated to be a problem —
  `requireIdempotencyKey` does not need the body, so the precedent does not
  exist. The implementer verifies and documents the chosen pattern.)
- **`messages.ts:165` PATCH read-state.** The route reads `rawBody` to hash
  empty bytes but does not call `JSON.parse`. The middleware still applies
  (which is correct — PATCH must respect the 1 MB cap). No code change in
  the route.
- **Worker test fixture drift.** Several sites already have worker tests
  with malformed-body scenarios from CAP-035 / CAP-037. The new tests must
  not collide on the `Idempotency-Key` (each test uses a fresh UUID per the
  CAP-037 precedent). The implementer scans the existing tests for
  malformed-body keys before writing new ones.