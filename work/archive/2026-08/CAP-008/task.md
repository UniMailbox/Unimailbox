# CAP-008 — `POST /api/v1/setup/claim` — INSTALLATION_TOKEN binds a KV setup session

**Phase:** 0 · **Status:** In Progress · **Started:** 2026-08-12

## Goal

The operator proves they hold the `INSTALLATION_TOKEN` (provisioned at deploy time in
Cloudflare Secrets Store). In exchange, they receive a short-lived KV setup session token
that authenticates all subsequent setup API calls. Wrong token → 401.

This capability also lands the **error middleware** (replacing the CAP-001 stub) and a
**constant-time comparison** utility — both required for the 401 error path.

## Scope

- **`POST /api/v1/setup/claim` route handler** in `http/routes/setup.ts`.
  - Request body: `{ "token": string }` validated by `setupClaimRequestSchema` (zod, contracts).
  - Reads `env.INSTALLATION_TOKEN` from Secrets Store.
  - Constant-time compares the provided token against the stored token.
  - If wrong → throws `DomainError({ code: 'SETUP_CLAIM_INVALID_TOKEN', httpStatus: 401 })`.
  - If correct → creates KV session, seeds `installation_state`, returns `{ sessionToken, expiresIn }`.
  - If `installation_state.status === 'complete'` → throws `DomainError({ code: 'SETUP_ALREADY_COMPLETE', httpStatus: 409 })`.

- **`claimSetup` use case** in `modules/onboarding/claim-setup.ts`.
  - Takes input + `{ clock, ids }` dependencies.
  - Constant-time token comparison.
  - Generates session token via `ids.uuid()`.
  - Stores session in `env.SETUP_SESSION` KV with `expirationTtl: 1800` (30 minutes).
  - Seeds `installation_state` row (id=1, status='setup', current_step='preflight') if absent.
  - Returns `{ sessionToken: string, expiresIn: number }`.

- **Error middleware** — replace the CAP-001 stub in `http/middleware/error.ts`.
  - `DomainError` → its `httpStatus` (or 500 if unset).
  - `ZodError` → 400 with `VALIDATION_ERROR` code.
  - Unknown errors → 500 with `INTERNAL` code.

- **`constantTimeCompare`** in `platform/crypto.ts` (currently empty stub).
  - XOR-based byte comparison; returns early only on length mismatch.
  - Unit-tested.

- **`readSecret` helper** in `platform/secrets.ts` (new).
  - Handles both `SecretsStoreSecret` (production: `.get()`) and `string` (test: miniflare override).
  - Required because miniflare may provide secrets as plain strings.

- **`seedInstallationState`** in `installation-state-repository.ts`.
  - `INSERT ... ON CONFLICT(id) DO NOTHING` — idempotent row seed.
  - Only inserts if the row doesn't exist (fresh DB). Does not overwrite.

- **Worker-pool tests** — correct token, wrong token, missing/empty token, complete-state rejection,
  KV session created, installation_state seeded to `preflight`.

## Out of scope

- **Session validation middleware** — CAP-009 introduces the middleware that validates
  `Authorization: Bearer <sessionToken>` on protected setup routes.
- **`POST /api/v1/setup/preflight`** — CAP-009.
- **Idempotency records** — CAP-027 (Phase 2). Claim is a POST but idempotency is not in Phase 0.
- **Request-ID in error responses** — the `requestId` middleware is still a CAP-001 stub.
  Error responses include `code` and `message` but not `requestId` until that lands.
- **Session token refresh / revocation** — the KV TTL handles expiry. Explicit revocation is a later concern.

## Business rules

| Rule ID | What it means for this slice |
|---|---|
| `R-AUTH-001` | The `INSTALLATION_TOKEN` is the sole credential for the initial claim. No other auth is available before the first user exists. |
| `R-SETUP-002` | A fresh DB (no row) is treated as `status = 'setup'` — claim is allowed and seeds the row. |
| `R-SECRET-001` | Secrets are never logged. The token comparison must not leak timing information (constant-time compare). |

> `R-SETUP-*` IDs are local to Phase 0 setup invariants. `R-AUTH-*` and `R-SECRET-*` are
> defined in `docs/rebuild/02-business-discovery/business-rules.md`.

## Acceptance criteria

- [ ] 1. `POST /api/v1/setup/claim` with the correct `INSTALLATION_TOKEN` returns 200 with `{"data":{"sessionToken":"<uuid>","expiresIn":1800}}`.
- [ ] 2. `POST /api/v1/setup/claim` with a wrong token returns 401 with `{"error":{"code":"SETUP_CLAIM_INVALID_TOKEN",...}}`.
- [ ] 3. `POST /api/v1/setup/claim` with a missing or empty `token` field returns 400 with a validation error envelope.
- [ ] 4. After a successful claim, `GET /api/v1/setup/status` returns `currentStep: 'preflight'` (the row was seeded).
- [ ] 5. After a successful claim, the returned `sessionToken` exists as a key in `env.SETUP_SESSION` KV.
- [ ] 6. `POST /api/v1/setup/claim` when `installation_state.status = 'complete'` returns 409.
- [ ] 7. Error middleware maps `DomainError` → its `httpStatus`, `ZodError` → 400, unknown → 500. Unit-tested.
- [ ] 8. `constantTimeCompare` returns true for equal strings, false for unequal, and does not short-circuit on character mismatch (unit test).
- [ ] 9. `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:worker`, `pnpm build` all exit 0.
- [ ] 10. `pnpm scaffold doctor` exits 0 (10/10).

## Vertical slice

- [ ] contract — `packages/contracts/src/index.ts` — add `setupClaimRequestSchema`
- [ ] platform/crypto — `apps/worker/src/platform/crypto.ts` — `constantTimeCompare`
- [ ] platform/secrets — `apps/worker/src/platform/secrets.ts` (new) — `readSecret`
- [ ] platform/errors middleware — `apps/worker/src/http/middleware/error.ts` — real DomainError mapping
- [ ] repository — `apps/worker/src/modules/onboarding/installation-state-repository.ts` — add `seedInstallationState`
- [ ] use case — `apps/worker/src/modules/onboarding/claim-setup.ts` (new) — `claimSetup`
- [ ] module public API — `apps/worker/src/modules/onboarding/index.ts` — export `claimSetup`
- [ ] route — `apps/worker/src/http/routes/setup.ts` — add `POST /claim`
- [ ] tests — `apps/worker/src/http/routes/claim.worker.test.ts` (new)
- [ ] tests — `apps/worker/src/platform/crypto.test.ts` — unit tests for `constantTimeCompare`
- [ ] test config — `apps/worker/vitest.workers.config.ts` — miniflare secret override

## File ownership

| Agent | Owns |
|---|---|
| implementer | `packages/contracts/src/index.ts` (add schema only) |
| implementer | `packages/contracts/src/index.test.ts` (add schema tests) |
| implementer | `apps/worker/src/platform/crypto.ts` |
| implementer | `apps/worker/src/platform/crypto.test.ts` (new) |
| implementer | `apps/worker/src/platform/secrets.ts` (new) |
| implementer | `apps/worker/src/http/middleware/error.ts` |
| implementer | `apps/worker/src/modules/onboarding/claim-setup.ts` (new) |
| implementer | `apps/worker/src/modules/onboarding/installation-state-repository.ts` |
| implementer | `apps/worker/src/modules/onboarding/index.ts` |
| implementer | `apps/worker/src/http/routes/setup.ts` |
| implementer | `apps/worker/src/http/routes/claim.worker.test.ts` (new) |
| implementer | `apps/worker/vitest.workers.config.ts` |

## Reading list

Read exactly these:

- `CLAUDE.md`
- this file (`work/active/CAP-008-setup-claim/task.md`)
- `.claude/agents/implementer.md`
- `.claude/rules/architecture.md` — §API conventions (envelope, status codes, error shape), §Forbidden
- `.claude/rules/coding.md` — §Structure, §Errors, §Data
- `.claude/rules/testing.md` — §Mocking, §Determinism, §Quality gates
- `.claude/rules/security.md` — §Passwords (constant-time compare pattern), §Secrets, §Idempotency (note: claim is exempt — Phase 0)
- `docs/rebuild/05-target-architecture/api-design.md` lines 105-121 (setup routes), lines 48-79 (envelope + status codes)
- Existing code:
  - `apps/worker/src/http/routes/setup.ts` (where to add the POST /claim route)
  - `apps/worker/src/http/middleware/error.ts` (the stub you are replacing)
  - `apps/worker/src/http/middleware/setup-gate.ts` (middleware pattern, how gate exempts `/api/v1/setup/*`)
  - `apps/worker/src/platform/errors.ts` (DomainError class — httpStatus, code, toJSON)
  - `apps/worker/src/platform/crypto.ts` (currently empty — you fill it)
  - `apps/worker/src/platform/env.ts` (Env type — INSTALLATION_TOKEN is SecretsStoreSecret)
  - `apps/worker/src/platform/cache.ts` (SetupSessionStore = KVNamespace)
  - `apps/worker/src/platform/ids.ts` (IdGenerator — uuid())
  - `apps/worker/src/platform/clock.ts` (Clock — now() returns Date)
  - `apps/worker/src/modules/onboarding/index.ts` (current public API)
  - `apps/worker/src/modules/onboarding/installation-state-repository.ts` (add seedInstallationState)
  - `apps/worker/src/modules/onboarding/setup-status.ts` (use case pattern)
  - `apps/worker/src/http/routes/setup-status.worker.test.ts` (worker-pool test pattern)
  - `apps/worker/src/http/middleware/setup-gate.worker.test.ts` (worker-pool test pattern)
  - `apps/worker/vitest.workers.config.ts` (where to add miniflare overrides)
  - `packages/contracts/src/index.ts` (where to add setupClaimRequestSchema)
  - `packages/test-kit/src/seed.ts` (seedInstallationState test helper — reuse in tests)
  - `packages/test-kit/src/index.ts` (test-kit exports)
  - `migrations/0001_initial.sql` lines 52-65 (installation_state DDL)

## Dependencies

- Requires: CAP-007 (setup routes sub-app, onboarding use case pattern) — Implemented
- Blocks: CAP-009 (`POST /setup/preflight` — needs the session created by claim)

## Design guidance

### Contract schema

```typescript
// packages/contracts/src/index.ts
export const setupClaimRequestSchema = z.object({
  token: z.string().min(1),
});
export type SetupClaimRequest = z.infer<typeof setupClaimRequestSchema>;
```

### Constant-time comparison (platform/crypto.ts)

```typescript
/**
 * Constant-time string comparison. Compares UTF-8 byte sequences with XOR
 * accumulation — no early exit on character mismatch. Returns false immediately
 * on length mismatch (the length of the user's input is not secret).
 *
 * Security rule: never use === for token/password comparison.
 */
export function constantTimeCompare(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    diff |= bufA[i] ^ bufB[i];
  }
  return diff === 0;
}
```

### Secret reader (platform/secrets.ts)

The `SecretsStoreSecret` type has a `.get()` method in production. In the miniflare test
environment, the binding override provides a plain string. This helper handles both:

```typescript
type SecretLike = string | { get(): Promise<string> };

export async function readSecret(secret: SecretLike): Promise<string> {
  return typeof secret === 'string' ? secret : secret.get();
}
```

### Error middleware (http/middleware/error.ts)

```typescript
import type { ErrorHandler } from 'hono';
import { ZodError } from 'zod';
import type { AppEnv } from '../../platform/env';
import { DomainError } from '../../platform/errors';

export const errorMiddleware: ErrorHandler<AppEnv> = (err, _c) => {
  if (err instanceof DomainError) {
    return Response.json(
      { error: { code: err.code, message: err.message } },
      { status: err.httpStatus ?? 500 },
    );
  }
  if (err instanceof ZodError) {
    return Response.json(
      { error: { code: 'VALIDATION_ERROR', message: err.errors[0]?.message ?? 'Validation failed' } },
      { status: 400 },
    );
  }
  return Response.json(
    { error: { code: 'INTERNAL', message: 'Internal server error' } },
    { status: 500 },
  );
};
```

Note: use `Response.json()` (the Web API static) rather than Hono's `c.json()` since the
error handler may not have a valid context body to read. Both produce the same output.

### claimSetup use case (modules/onboarding/claim-setup.ts)

```typescript
export interface ClaimSetupInput {
  readonly db: Database;
  readonly setupSessionStore: SetupSessionStore;
  readonly expectedToken: string;
  readonly providedToken: string;
}

export interface ClaimSetupResult {
  readonly sessionToken: string;
  readonly expiresIn: number;
}

const SESSION_TTL_SECONDS = 1800; // 30 minutes

export async function claimSetup(
  input: ClaimSetupInput,
  deps: { clock: Clock; ids: IdGenerator },
): Promise<ClaimSetupResult> {
  // Constant-time token comparison — never ===.
  if (!constantTimeCompare(input.providedToken, input.expectedToken)) {
    throw new DomainError({
      code: 'SETUP_CLAIM_INVALID_TOKEN',
      message: 'Invalid installation token',
      httpStatus: 401,
    });
  }

  // Reject if installation is already complete.
  const state = await getInstallationState(input.db);
  if (state?.status === 'complete') {
    throw new DomainError({
      code: 'SETUP_ALREADY_COMPLETE',
      message: 'Installation is already complete',
      httpStatus: 409,
    });
  }

  // Create KV session.
  const sessionToken = deps.ids.uuid();
  const now = deps.clock.now().toISOString();
  await input.setupSessionStore.put(
    sessionToken,
    JSON.stringify({ createdAt: now }),
    { expirationTtl: SESSION_TTL_SECONDS },
  );

  // Seed installation_state if absent (fresh DB). Does not overwrite existing rows.
  await seedInstallationState(input.db, 'preflight', now);

  return { sessionToken, expiresIn: SESSION_TTL_SECONDS };
}
```

### seedInstallationState repository

Add to `installation-state-repository.ts`:

```typescript
export async function seedInstallationState(
  db: Database,
  currentStep: InstallationStep,
  timestamp: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO installation_state (id, status, current_step, schema_version, updated_at, created_at)
       VALUES (1, 'setup', ?, 1, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(currentStep, timestamp, timestamp)
    .run();
}
```

### Route handler (http/routes/setup.ts)

```typescript
import { setupClaimRequestSchema } from '@unimailbox/contracts';
import { claimSetup } from '../../modules/onboarding';
import { readSecret } from '../../platform/secrets';
import { systemClock } from '../../platform/clock';
import { systemIds } from '../../platform/ids';

// ... inside setupRoutes():
routes.post('/claim', async (c) => {
  const body = setupClaimRequestSchema.parse(await c.req.json());
  const expectedToken = await readSecret(c.env.INSTALLATION_TOKEN);
  const result = await claimSetup(
    {
      db: c.env.DB,
      setupSessionStore: c.env.SETUP_SESSION,
      expectedToken,
      providedToken: body.token,
    },
    { clock: systemClock, ids: systemIds },
  );
  return c.json({ data: result });
});
```

### Test approach

**Worker-pool test config** (`vitest.workers.config.ts`):

Add `miniflare.bindings` to provide test values for the Secrets Store bindings:

```typescript
cloudflareTest({
  wrangler: { configPath: './wrangler.jsonc' },
  miniflare: {
    bindings: {
      INSTALLATION_TOKEN: 'test-installation-token',
      CREDENTIAL_ENCRYPTION_KEY: 'test-encryption-key',
    },
  },
}),
```

The `readSecret` helper handles the `string` type from miniflare at runtime.

**Worker-pool tests** (`http/routes/claim.worker.test.ts`):

Use `SELF.fetch` through the real pipeline. Use `resetAndMigrate` and `seedInstallationState`
from `@unimailbox/test-kit`.

Test matrix:

| Scenario | Setup | Request body | Expected status | Expected body |
|---|---|---|---|---|
| Correct token, fresh DB | `resetAndMigrate` | `{"token":"test-installation-token"}` | 200 | `{data:{sessionToken,expiresIn:1800}}` |
| Wrong token | `resetAndMigrate` | `{"token":"wrong-token"}` | 401 | `{error:{code:"SETUP_CLAIM_INVALID_TOKEN",...}}` |
| Missing token | `resetAndMigrate` | `{}` | 400 | `{error:{code:"VALIDATION_ERROR",...}}` |
| Empty token | `resetAndMigrate` | `{"token":""}` | 400 | `{error:{code:"VALIDATION_ERROR",...}}` |
| Already complete | `seedInstallationState({status:'complete',currentStep:'complete'})` | `{"token":"test-installation-token"}` | 409 | `{error:{code:"SETUP_ALREADY_COMPLETE",...}}` |

Post-claim assertions (within the correct-token test or a follow-up test):
- `GET /api/v1/setup/status` returns `currentStep: 'preflight'`.
- The returned `sessionToken` exists as a key in `env.SETUP_SESSION`.

To check KV from the test: `import { env } from 'cloudflare:test'` and call `env.SETUP_SESSION.get(sessionToken)`.

**Unit tests** (`platform/crypto.test.ts`):

- `constantTimeCompare('abc', 'abc')` → true
- `constantTimeCompare('abc', 'abd')` → false
- `constantTimeCompare('abc', 'abcd')` → false (length mismatch)
- `constantTimeCompare('', '')` → true (empty strings)

## Decisions made during this capability

1. **Error middleware is real, not a stub.** CAP-008 is the first capability that returns a
   non-200 error response (401 for wrong token). The error middleware maps `DomainError` →
   its `httpStatus`, `ZodError` → 400, unknown → 500.

2. **`readSecret` helper.** `SecretsStoreSecret.get()` in production; plain `string` in tests
   (miniflare override). The helper handles both without the use case knowing about Cloudflare types.

3. **`ON CONFLICT DO NOTHING` for seed.** The seed query is idempotent — it only inserts if the
   row doesn't exist. If the operator re-claims (e.g., after session expiry), the existing row
   and its `current_step` are preserved.

4. **Session TTL is 30 minutes** (1800 seconds), per Phase 0 roadmap §Key technical decisions.

5. **No idempotency on claim.** Phase 0 explicitly defers idempotency records to CAP-027. The
   `ON CONFLICT DO NOTHING` seed provides natural idempotency for the row write. Re-claiming
   creates a new session, which is correct behaviour.

## Open questions

(None.)
