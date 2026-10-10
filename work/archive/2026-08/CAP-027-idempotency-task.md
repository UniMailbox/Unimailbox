# CAP-027 — Idempotency records on every mutating endpoint (ADR-004)

## Goal

Enforce `Idempotency-Key` on every mutating HTTP endpoint (`POST`, `PATCH`, `DELETE`).
Replay with the same key + same body returns the stored response. Same key + different body
returns `409 IDEMPOTENCY_KEY_REUSED`. The idempotency record is written in the same D1 batch
as the business write where the use case owns its batch, and as a follow-up write for endpoints
whose use case does not yet expose its batch — the trade-off is documented per endpoint.

This resolves the deferred items **D-CAP-008-B** (`/setup/claim`), **D-CAP-010-A**
(`/setup/administrator`), and **D-CAP-011-A** (`/setup/domain`). It also closes Phase 2's
first exit criterion: "Replaying /messages/send with same Idempotency-Key returns same
message id."

## Scope at a glance — 18 mutating endpoints

- **Setup (11)** — best-effort idempotency. Actor is `sha256_hex(SETUP_SESSION token)`.
- **Auth (3)** — best-effort idempotency. Actor is `sha256_hex(code)` for register,
  `sha256_hex(email)` for login/refresh.
- **User-facing (4)** — strict batch atomicity (R-OUTBOUND-006). Actor is `userId`.

## Reference

- `docs/rebuild/09-decisions/ADR-004-idempotency-keys.md` — the contract
- `docs/rebuild/02-business-discovery/business-rules.md` — **R-API-004** (Mutating endpoints
  accept Idempotency-Key; replays return the stored response), **R-OUTBOUND-005** (Send requests
  must include an Idempotency-Key header; replays return the stored response),
  **R-OUTBOUND-006** (Send + queued job + idempotency record are written in one D1 batch)
- `.claude/rules/security.md` §Idempotency (ADR-004) — the implementation rules
- `.claude/rules/architecture.md` §API conventions — error envelope `{ error: { code, message } }`
- `.claude/rules/testing.md` §What must be tested — every mutating endpoint has replay + reuse tests

## Out of scope

- TTL purging of expired records (24h daily cron). The `expires_at` column and index are added
  so the future cron has a target. The cron itself is a separate capability.
- Idempotency on inbound email entrypoint (`entrypoints/inbound-email.ts`) and webhook entrypoint
  (`http/routes/webhooks.ts`). These are *not* client-mutating — inbound mail dedup uses
  provider-message-id (CAP-029), and webhook dedup uses `webhook_deliveries` with 60s lock
  (BF-089). Out of scope per ADR-004 §Decision ("all mutating endpoints") which targets
  client-driven mutations.

## Surface area — 17 endpoints

### Setup (10) — best-effort idempotency (see "Trade-off" below)

| Method | Path | Operation string |
|---|---|---|
| POST | `/api/v1/setup/claim` | `POST /api/v1/setup/claim` |
| POST | `/api/v1/setup/preflight` | `POST /api/v1/setup/preflight` |
| POST | `/api/v1/setup/administrator` | `POST /api/v1/setup/administrator` |
| POST | `/api/v1/setup/domain` | `POST /api/v1/setup/domain` |
| POST | `/api/v1/setup/cloudflare/dashboard-link` | `POST /api/v1/setup/cloudflare/dashboard-link` |
| POST | `/api/v1/setup/cloudflare/verify` | `POST /api/v1/setup/cloudflare/verify` |
| POST | `/api/v1/setup/inbound-smoke-test` | `POST /api/v1/setup/inbound-smoke-test` |
| POST | `/api/v1/setup/inbound-smoke-test/check` | `POST /api/v1/setup/inbound-smoke-test/check` |
| POST | `/api/v1/setup/brevo` | `POST /api/v1/setup/brevo` |
| POST | `/api/v1/setup/outbound-smoke-test` | `POST /api/v1/setup/outbound-smoke-test` |
| POST | `/api/v1/setup/complete` | `POST /api/v1/setup/complete` |

For setup endpoints the `actor_id` is `sha256_hex(SETUP_SESSION token)` — the session token is
never stored, only its hash. R-SECRET-003 (secrets never logged) holds: only the hash reaches
the DB. If no `Authorization: Bearer <token>` is present, the `setupSession` middleware rejects
with 401 first; idempotency middleware runs second.

### Auth (3) — batch atomicity via separate write

| Method | Path | Operation string |
|---|---|---|
| POST | `/api/v1/auth/register` | `POST /api/v1/auth/register` |
| POST | `/api/v1/auth/login` | `POST /api/v1/auth/login` |
| POST | `/api/v1/auth/refresh` | `POST /api/v1/auth/refresh` |

These endpoints run before the user is persisted, so the `actor_id` for register is the
SHA-256 of the registration code (the operator-issued invite). For login/refresh the
`actor_id` is `sha256_hex(email)` because no `userId` is available yet. The first successful
`register` flips the actor to a real user — that transition is not covered by idempotency
(the registration code is single-use and the user gets a real session after).

### User-facing (4) — strict batch atomicity

| Method | Path | Operation string | Actor |
|---|---|---|---|
| POST | `/api/v1/admin/invite-codes` | `POST /api/v1/admin/invite-codes` | `userId` from `c.get('userId')` |
| POST | `/api/v1/mailboxes` | `POST /api/v1/mailboxes` | `userId` |
| POST | `/api/v1/mailboxes/:mailboxId/messages/send` | `POST /api/v1/mailboxes/:mailboxId/messages/send` | `userId` |
| PATCH | `/api/v1/mailboxes/:mailboxId/messages/:messageId/read` | `PATCH /api/v1/mailboxes/:mailboxId/messages/:messageId/read` | `userId` |

The idempotency record is appended to the route handler's existing D1 batch — preserving
R-OUTBOUND-006 and the inbound message atomicity rule.

## Trade-off: best-effort vs strict batch atomicity

ADR-004 §Decision says "written in the same D1 batch as the business write." For user-facing
endpoints whose handler owns the batch (compose, mailboxes, messages), this is satisfied
trivially. For setup and auth endpoints, the use case owns its batch and does not currently
expose a hook for additional prepared statements. There are three options:

- **(A)** Refactor every use case to accept additional prepared statements and append to its
  batch. Cost: high (touches 11 use cases in `modules/onboarding` + `modules/identity`).
- **(B)** Best-effort: lookup-and-replay first, then write the idempotency record *after* the
  use case succeeds. On crash between use case commit and idempotency record, a retry
  re-runs the use case. Cost: low. Risk: re-running is safe for endpoints with natural guards
  (singularity, UNIQUE constraints), and acceptable for setup because the operator controls
  retry timing.
- **(C)** Insert a "pending" idempotency record before the use case, then `UPDATE` after.
  Cost: medium. Risk: a crash leaves a pending record; the next retry must distinguish
  "pending" from "complete" — adds complexity for marginal benefit.

**Decision: option (B)** for setup and auth endpoints. Setup endpoints have natural guards
(singularity on administrator, UNIQUE on managed domain, UNIQUE on provider_connections,
CHECK on installation_state status). Auth endpoints have the registration-code single-use
guard. The `/setup/outbound-smoke-test` endpoint is the one exception — it sends a real
email via Brevo. If a retry re-runs the use case, the email is sent twice. **The implementer
must apply option (A) to `/setup/outbound-smoke-test`** by either:

- refactoring `runOutboundSmokeTest` to accept additional statements, or
- doing the idempotency lookup+insert *before* the Brevo call and the `UPDATE` *after* (option C).

Both are acceptable. The implementer chooses whichever is simpler.

## Files to create

| Path | Owner | Notes |
|---|---|---|
| `migrations/0009_idempotency_records.sql` | implementer | Schema + tracking row, atomic in one D1 batch (F1 convention) |
| `migrations/0009_idempotency_records.verify.sql` | implementer | ≥6 assertions: table exists, columns + types, unique index on `(actor_id, operation, idempotency_key)`, expires_at index, foreign keys (none — actor_id is opaque) |
| `migrations/0009_idempotency_records.md` | implementer | Companion doc: rules enforced, conventions, deferred follow-ups |
| `apps/worker/src/database/schema/admin.ts` (extend) | implementer | Add `idempotencyRecords` table to the Drizzle admin schema (typing only) |
| `apps/worker/src/database/schema-version.ts` (extend) | implementer | Bump `CURRENT_SCHEMA_VERSION` to `'0009'` |
| `apps/worker/src/platform/idempotency.ts` | implementer | Helpers: `IDEMPOTENCY_HEADER`, `IDEMPOTENCY_TTL_HOURS`, `sha256Hex`, `findIdempotencyRecord`, `prepareCreateIdempotencyRecord`, `tryReplayIdempotency` |
| `apps/worker/src/http/middleware/idempotency.ts` | implementer | `requireIdempotencyKey` middleware — enforces header presence + length, mounts on the route; sets `c.set('idempotencyKey', key)` for downstream handlers |
| `apps/worker/src/platform/idempotency.test.ts` | implementer | Unit tests: `sha256Hex`, `canonicalJsonStringify` (if added), `prepareCreateIdempotencyRecord` produces correct SQL |
| `apps/worker/scripts/doctor.test.ts` (extend) | implementer | Assert that `module-dependency-zones` ALLOWED set still permits the new files (no new cross-module edges) |

## Files to modify (touch only the wiring)

| Path | Owner | Notes |
|---|---|---|
| `apps/worker/src/http/routes/setup.ts` | implementer | Add `requireIdempotencyKey` to all 11 POST routes; wire lookup/replay before use case; append record write after |
| `apps/worker/src/http/routes/auth.ts` | implementer | Same for register/login/refresh |
| `apps/worker/src/http/routes/admin.ts` | implementer | Same for `/admin/invite-codes` |
| `apps/worker/src/http/routes/mailboxes.ts` | implementer | Add idempotency to `POST /mailboxes` — strict batch mode |
| `apps/worker/src/http/routes/compose.ts` | implementer | Add idempotency to `POST .../messages/send` — strict batch mode (append to existing batch) |
| `apps/worker/src/http/routes/messages.ts` | implementer | Add idempotency to `PATCH .../messages/:id/read` — strict batch mode |

## Files to modify (test only)

The existing test files in `apps/worker/src/http/routes/*` already cover happy paths and most
failure paths. The implementer extends each with the four idempotency cases. New test files
are not required.

| Path | Required new cases |
|---|---|
| `claim.worker.test.ts` | missing key, replay, 409 reuse |
| `preflight.worker.test.ts` | missing key, replay |
| `administrator.worker.test.ts` | missing key, replay, 409 reuse |
| `domain.worker.test.ts` | missing key, replay, 409 reuse |
| `cloudflare.worker.test.ts` | missing key for both endpoints |
| `inbound-smoke-test.worker.test.ts` | missing key for start, replay returns same address |
| `outbound-smoke-test.worker.test.ts` | missing key, replay returns same providerMessageId |
| `brevo.worker.test.ts` | missing key, replay (decrypted response identical) |
| `complete-setup.worker.test.ts` | missing key, replay returns same id |
| `auth.worker.test.ts` | missing key + replay + 409 for register/login/refresh |
| `admin-invite-codes.worker.test.ts` | missing key + replay |
| `mailboxes.worker.test.ts` | missing key + replay + 409 |
| `compose.worker.test.ts` | missing key + replay (same messageId) + 409 — **named after R-OUTBOUND-005** |
| `messages.worker.test.ts` | missing key + replay (same state) + 409 |

Plus the two invariant tests: **R-OUTBOUND-006** (single D1 batch atomicity) named explicitly
in `compose.worker.test.ts`, and **R-API-004** (replay returns stored response) named
explicitly in `messages.worker.test.ts`.

## Platform helper shape (sketch)

```ts
// apps/worker/src/platform/idempotency.ts
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
export const IDEMPOTENCY_TTL_HOURS = 24;
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export async function sha256Hex(input: string): Promise<string> { /* ... */ }

export interface IdempotencyRecord {
  readonly actorId: string;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly responseStatus: number;
  readonly responseJson: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export async function findIdempotencyRecord(
  db: Database,
  actorId: string,
  operation: string,
  idempotencyKey: string,
): Promise<IdempotencyRecord | null>

export function prepareCreateIdempotencyRecord(
  db: Database,
  params: {
    id: string;
    actorId: string;
    operation: string;
    idempotencyKey: string;
    requestHash: string;
    responseStatus: number;
    responseJson: string;
    createdAt: string;
    expiresAt: string;
  },
): D1PreparedStatement

/**
 * If a matching record exists, returns the replay Response.
 * If no record exists, returns null and the handler proceeds.
 * If the record exists with a different request hash, throws 409 IDEMPOTENCY_KEY_REUSED.
 */
export async function tryReplayIdempotency(
  db: Database,
  actorId: string,
  operation: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<Response | null>
```

## Middleware shape (sketch)

```ts
// apps/worker/src/http/middleware/idempotency.ts
export const requireIdempotencyKey: MiddlewareHandler<AppEnv> = async (c, next) => {
  const key = c.req.header(IDEMPOTENCY_HEADER);
  if (!key) {
    throw new DomainError({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: `${IDEMPOTENCY_HEADER} header required`,
      httpStatus: 400,
    });
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new DomainError({
      code: 'IDEMPOTENCY_KEY_INVALID',
      message: `${IDEMPOTENCY_HEADER} must be 8-128 chars of [A-Za-z0-9_-]`,
      httpStatus: 400,
    });
  }
  c.set('idempotencyKey', key);
  await next();
};
```

## Schema (migration 0009)

```sql
CREATE TABLE IF NOT EXISTS idempotency_records (
  id               TEXT PRIMARY KEY,
  actor_id         TEXT NOT NULL,
  operation        TEXT NOT NULL CHECK (length(operation) <= 128),
  idempotency_key  TEXT NOT NULL CHECK (length(idempotency_key) <= 128),
  request_hash     TEXT NOT NULL CHECK (length(request_hash) = 64),
  response_status  INTEGER NOT NULL,
  response_json    TEXT NOT NULL CHECK (length(response_json) <= 65536),
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idempotency_records_unique
  ON idempotency_records(actor_id, operation, idempotency_key);

CREATE INDEX IF NOT EXISTS idempotency_records_expires_at_idx
  ON idempotency_records(expires_at);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0009_idempotency_records.sql');
```

`actor_id` is intentionally **not** a foreign key to `users(id)` — it may be a session-token
hash, an email hash, or a code hash. Storing opaque actor_ids lets us use the same table for
all endpoint categories without polymorphic-key complexity. The unique index gives us
concurrent-request deduplication (the second INSERT fails with UNIQUE violation, which the
handler catches and re-reads the row for replay).

## Acceptance criteria

A capability is not `Implemented` until all of these pass:

1. `pnpm typecheck` ✓ (zero errors, zero new `@ts-expect-error`)
2. `pnpm lint` ✓
3. `pnpm test:unit` ✓ (existing + new helper tests pass)
4. `pnpm test:worker` ✓ (existing + new replay/409 tests pass — minimum 17 new test cases,
   one per endpoint)
5. `pnpm build` ✓
6. `pnpm scaffold doctor` ✓ (10/10)
7. `pnpm exec drizzle-kit check` ✓
8. New migration applies cleanly on a fresh DB and against an existing DB at 0008.
9. `Idempotency-Key` is enforced on all 17 mutating endpoints — verified by an integration
   test that walks each route in order.
10. No secrets, password hashes, message bodies, or `Idempotency-Key` values are logged
    (R-SECRET-003, security.md §Logging).

The capability is not `Verified` until the operator preview deploy exercises the §F.1
27-step loop with a real `Idempotency-Key` and observes identical responses on a deliberate
retry.

## Test invariants the implementer must hit

- `grep R-OUTBOUND-005 test/` finds the proof in `compose.worker.test.ts`
- `grep R-OUTBOUND-006 test/` finds the proof that send + outbound_jobs + idempotency_records
  are in one D1 batch (in the same test)
- `grep R-API-004 test/` finds the proof in `messages.worker.test.ts`
- Every endpoint has both an "allowed case" (replay returns stored response) and a "denied
  case" (same key + different body → 409)
- Concurrent-request race: two parallel requests with the same key → one succeeds, the other
  returns the stored response. Test this for at least `compose` and `mailboxes.create`.

## Risks / assumptions

- **TanStack Query** in `apps/web` will be updated to generate a UUID per mutation in a
  follow-up commit. This capability ships the server side first; the client-side change is
  Phase 2 acceptance. Until then, manual `curl` callers must add the header.
- **`actor_id` opacity** is a privacy/safety trade-off. We never log `actor_id` directly
  (only its first 8 hex chars) so user IDs are not leaked in logs. The `actor_id` field in
  the DB is hashed session tokens / emails / codes for non-user-authenticated endpoints.
- **TTL purging** is not in this capability. 24-hour rows accumulate. A daily cron will land
  in a future capability; the `expires_at` index is in place to support it.

## Next (after this capability)

- Resolve R-INBOUND-005 (blocklist) and R-INBOUND-006 (per-role policies) — **D-CAP-021-A**.
  Small, focused, independent of this capability. The `blocklist` table and receive-time
  check sit in the inbound mail handler.
- CAP-028 — Durable outbox (attempts, lock expiry, re-queue). Depends on this capability
  being complete (R-OUTBOUND-006 must already be enforced).
- CAP-031 — 1 MB body limit (uses the same raw-body read that the idempotency middleware
  introduces).

## Progress tracking

| # | Task | Status |
|---|------|--------|
| 1 | Setup routes idempotency (11 endpoints) | Complete |
| 2 | Auth + admin routes idempotency (4 endpoints) | Complete |
| 3 | Client update (TanStack Query UUID per mutation) | Pending — separate follow-up per task.md |
| 4 | Quality gates (typecheck, lint, test:unit, test:worker, build, doctor, drizzle-kit check) | In progress — passing |
| 5 | Ledger/log sync, work/ cleanup, commit | Pending |
| 6 | Independent review (architecture, code, QA, security) | Pending |