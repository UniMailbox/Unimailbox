# CAP-027 — Idempotency review-fix round

Scope: fix confirmed findings from the independent code review of commit `ba35bd3`.
Findings were verified by the orchestrator against the code before inclusion here.

Reading list (paste-order for any agent working this contract):

- `apps/worker/src/platform/idempotency.ts` (+ `idempotency.test.ts`)
- `apps/worker/src/http/middleware/idempotency.ts`
- `apps/worker/src/http/routes/{auth,compose,mailboxes,messages,setup}.ts`
- `apps/worker/src/http/routes/{auth,compose,mailboxes,messages,admin-invite-codes}.worker.test.ts`
- `migrations/0009_idempotency_records.verify.sql`
- `migrations/0004_registration_keys.sql` (schema reference)
- `.claude/rules/{security,testing,coding,architecture}.md`
- `work/archive/2026-08/CAP-027-idempotency-task.md` (original contract)

## File ownership (this round)

Implementer owns: `platform/idempotency.ts` + test, `http/routes/{auth,compose,mailboxes,messages,setup,admin}.ts`,
`modules/onboarding/claim-setup.ts` (only if the route change requires it),
`database/schema/admin.ts`, `database/schema/identity.ts`, `database/schema-version.ts`,
their `*.worker.test.ts` files, `migrations/0009_idempotency_records.verify.sql`.
No other files. Do not edit `.claude/rules/`, `docs/rebuild/`, or the ledger.

Amendment (architecture review): the secret-bearing endpoint set is wider than the code review
found — see Fix 1. Middleware order and schema placement fixes were added as Fixes 10-11.

## Fixes (ordered by severity)

### Fix 1 — BLOCKER: plaintext secrets persisted in idempotency_records

Secret-bearing endpoints (confirmed by code + architecture reviews):

- `login` (auth.ts ~361-383): plaintext `accessToken` + 30-day `refreshToken`
- `refresh` (auth.ts ~465-481): plaintext `accessToken`
- `setup/claim` (route around claim-setup.ts): the 30-minute setup `sessionToken`
- `admin/invite-codes` (admin.ts ~149-168): the raw invite code — shown once, stored only as a
  hash in `registration_keys`

All four write their success body verbatim into `idempotency_records.response_json`. This is a
plaintext copy of live credentials that survives R-AUTH-005 session revocation, with no purge
cron yet. Violates R-SECRET-003 in spirit.

**Orchestrator decision (binding):**

- The record is still written (same key/reuse semantics: different body + same key →
  409 `IDEMPOTENCY_KEY_REUSED`), but `responseJson` stores a **redacted** body: secret values
  replaced with a placeholder (e.g. `"redacted"`). The stored body is never served to clients.
- Replay semantics for these four endpoints **deviate from ADR-004's letter**: same key + same
  hash → **re-execute** the handler (fresh credentials), do NOT serve the stored response.
  Rationale: a stored response may contain secrets that were later revoked (R-AUTH-005),
  expired, or already revealed; serving them hands back dead or dangerously-live credentials.
  Re-execution is safe for all four: login/refresh mint a new session/access token (pre-CAP-027
  retry behaviour), claim issues a second short-lived setup session token, invite-codes mints a
  second independent code. The orchestrator records this deviation in the implementation log
  and as an ADR-004 amendment — implementers do not edit ADRs.
- `register` keeps normal replay (its response carries no tokens — verify while touching the
  file; if it does carry secrets, stop and report).
- Existing tests that assert identical replay for these four endpoints (notably
  admin-invite-codes "replays response when same key and body" and the setup equivalents) must
  be updated to the new semantics: same key + same body → 200 with fresh secret, no 409;
  same key + different body → 409.

Tests: for each of the four — replay-hit returns 200 with a usable fresh secret (login: new
session row exists; invite-codes: second registration_keys row); different body → 409; and an
assertion that `idempotency_records.response_json` for that operation contains none of the
secret values from either response.

### Fix 2 — BLOCKER: idempotency tests absent from compose / mailboxes / messages test files

Add to each of the three files a describe block with, per endpoint (compose send, mailboxes
create, messages read):

1. missing `Idempotency-Key` → 400 `IDEMPOTENCY_KEY_REQUIRED`
2. same key + same body → identical response (same messageId / mailbox id / status), and no
   second business row (query the table)
3. same key + different body → 409 `IDEMPOTENCY_KEY_REUSED`
4. concurrency race: two in-flight requests with the same key (fire both, await both) → the
   loser replays the winner's response; **must not** 500 and **must not** return 409
   `DOMAIN_ADDRESS_TAKEN` on mailboxes. If the vitest-pool cannot produce a true interleaved
   race, simulate the loser path directly: pre-insert the winner's record via
   `prepareCreateIdempotencyRecord`, then call the handler and assert replay. Name the test
   after the race it proves.

Name the rule-ID tests so `grep R-OUTBOUND-005 test/`, `R-OUTBOUND-006`, and `R-API-004` find
their proofs (compose: R-OUTBOUND-005/006 + R-API-004; mailboxes + messages: R-API-004).
Replace the trivial messages "is idempotent — re-marking…" test with a real replay assertion.

### Fix 3 — HIGH: UNIQUE-race helpers are dead code; race loser 500s or gets a false 409

`replayAfterRace` / `isIdempotencyUniqueViolation` are exported but called by no route. Wire
them into the strict-batch routes (`compose`, `mailboxes`, `messages`):

- Wrap the batch execution; on a D1 error that is `isIdempotencyUniqueViolation`, call
  `replayAfterRace` (re-read + hash check + stored response). This is the path Fix 2.4 tests.
- In `mailboxes.ts`, the idempotency UNIQUE loss must be distinguished from the
  `(domain_id, local_part)` business UNIQUE — only the latter maps to 409 `DOMAIN_ADDRESS_TAKEN`.

### Fix 4 — MEDIUM: POST /mailboxes is best-effort; contract says strict batch

`task.md` (original) classifies mailbox create as strict batch; the code INSERTs the record in
a separate statement after the use case. Move `prepareCreateIdempotencyRecord` into the same D1
batch as the business write (mailbox + audit + record atomically). Crash-gap retry then replays
instead of 409ing forever. `messages` PATCH read may stay best-effort (natural no-op re-run) —
note it in a `// why` comment.

### Fix 5 — MEDIUM: verify.sql check 1 counts 9 columns against `= 8`

`migrations/0009_idempotency_records.verify.sql` line 16: table and IN-list both have 9
columns; the assertion and the "8 expected columns" comment are wrong. Fix to 9 and fix the
comment. Then actually run the verify file against a migrated database (e.g. apply migrations
to a scratch D1 local file or use the test-kit harness) and record the result — it has
evidently never passed.

### Fix 6 — MEDIUM: smoke-test pending path throws a raw Error → 500

`setup.ts` `/outbound-smoke-test`: hitting a pending record throws `new Error(...)` → 500.
Replace with a typed `DomainError`, 409, stable code `IDEMPOTENCY_REQUEST_PENDING`. Guard the
pending INSERT against the UNIQUE race using the Fix 3 helpers, and reuse
`findIdempotencyRecord` instead of the inline lookup SQL with the `as` cast.

### Fixes 7–9 — LOW

7. Unify the defensive missing-key error: everywhere, throw `DomainError`
   `IDEMPOTENCY_KEY_REQUIRED` (400), never a bare `Error` (500).
8. `compose.ts` local `sqliteNow()` backed by `new Date()` → use `systemClock` +
   `sqliteTimestamp` like every sibling.
9. Auth routes: read raw body → compute requestHash → replay/hash check → `schema.parse` last,
   so a stored replay isn't re-validated against the current schema (compose already does this).

### Fix 10 — MEDIUM: middleware order on setup routes (contract divergence)

Setup routes mount `requireIdempotencyKey, setupSession` → a tokenless, keyless request gets
400 before 401. The original contract and the middleware's own header comment specify authn
first. Swap the order so `setupSession` (401) runs before `requireIdempotencyKey` (400),
matching compose/mailboxes (requirePermission first). Update any setup test that asserts the
current 400-before-401 behaviour.

### Fix 11 — MEDIUM: Drizzle typing for idempotency_records is in the wrong owner's schema

`database/schema/admin.ts` carries the `idempotencyRecords` typing, but architecture.md's
persistence-ownership table assigns the table to `identity` (and `schema/identity.ts` exists).
The original task.md specified admin.ts — a contract error, corrected here. **Move** the typing
to `schema/identity.ts` (do not delete it: the SQL migration remains, and schema↔migration
consistency is checked by gates). Keep `schema-version.ts` consistent with whatever the move
requires; `drizzle-kit check` (via scaffold doctor / typecheck) must stay green.

## Constraints

- One D1 batch for business write + idempotency record where the contract says strict
  (R-OUTBOUND-006). Parameterized SQL only. No new dependencies. No `any`.
- Never mock D1/KV/Queue; mock provider HTTP only.
- Do not commit. Leave the tree dirty; report exact changed paths.
- Gates (run all, report verbatim pass/fail): `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`,
  `pnpm test:worker`, `pnpm build`, `pnpm scaffold doctor`.

## Report

Handoff format per `.claude/rules/agent-collaboration.md`. Flag any place the code contradicts
this contract instead of improvising.
