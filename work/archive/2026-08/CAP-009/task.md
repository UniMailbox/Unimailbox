# CAP-009 — `POST /api/v1/setup/preflight` — reports each binding present + schema version

**Phase:** 0 · **Status:** In Progress · **Started:** 2026-08-12

## Goal

A session-protected endpoint that verifies every Cloudflare binding is present and the D1
database is migrated. This is the operator's "is the deployment healthy?" check during setup.
It also introduces the **setup-session middleware** that validates `Authorization: Bearer
<sessionToken>` against KV — the gate for all setup endpoints after claim.

## Scope

- **Setup-session middleware** (`http/middleware/setup-session.ts`, new).
  - Reads `Authorization: Bearer <token>` header.
  - Looks up the token in `env.SETUP_SESSION` KV.
  - If found → `await next()`. If not found or no header → throws `DomainError({ code: 'SETUP_SESSION_INVALID', httpStatus: 401 })`.

- **`POST /api/v1/setup/preflight` route handler** in `http/routes/setup.ts`.
  - Protected by the setup-session middleware (applied inline: `routes.post('/preflight', setupSession, handler)`).
  - Calls the `runPreflight` use case.
  - Returns `{ data: { bindings: {...}, schemaVersion: "0001" } }`.

- **`runPreflight` use case** in `modules/onboarding/preflight.ts` (new).
  - Checks each binding exists: `DB`, `ATTACHMENTS`, `SETUP_SESSION`, `CACHE`, `OUTBOUND`, `INSTALLATION_TOKEN`, `CREDENTIAL_ENCRYPTION_KEY`.
  - Reads schema version from `d1_migrations` table (`SELECT name FROM d1_migrations ORDER BY name DESC LIMIT 1`).
  - Returns `{ bindings: Record<string, boolean>, schemaVersion: string }`.

- **Preflight response contract** — `setupPreflightResponseSchema` in `packages/contracts`.

- **Worker-pool tests** — valid session → 200 with binding report; no session → 401; invalid session → 401; binding check accuracy; schema version from migrated DB.

## Out of scope

- **Deep binding health checks** (actual D1 queries, R2 puts, KV operations per binding). Phase 0 checks existence only — is the binding object present? Future capabilities can add functional checks.
- **`POST /api/v1/setup/administrator`** — CAP-010.
- **Session refresh / sliding TTL.** The 30-minute TTL from CAP-008 is fixed.
- **Rate limiting.** Phase 0.

## Business rules

| Rule ID | What it means for this slice |
|---|---|
| `R-SETUP-003` | `/api/v1/setup/preflight` is exempt from the setup gate (already handled — prefix match `/api/v1/setup/`). |
| `R-AUTH-001` | After claim, the setup session (not the INSTALLATION_TOKEN) is the credential. The preflight endpoint requires a valid session. |

## Acceptance criteria

- [ ] 1. `POST /api/v1/setup/preflight` with a valid session token returns 200 with `{"data":{"bindings":{...},"schemaVersion":"0001"}}`.
- [ ] 2. `POST /api/v1/setup/preflight` without an `Authorization` header returns 401.
- [ ] 3. `POST /api/v1/setup/preflight` with an invalid session token returns 401.
- [ ] 4. The response `bindings` object has exactly 7 keys: `DB`, `ATTACHMENTS`, `SETUP_SESSION`, `CACHE`, `OUTBOUND`, `INSTALLATION_TOKEN`, `CREDENTIAL_ENCRYPTION_KEY` — all `true`.
- [ ] 5. The `schemaVersion` matches the latest migration name prefix from `d1_migrations`.
- [ ] 6. The setup-session middleware is applied to `/preflight` but NOT to `/status` or `/claim` (those remain public).
- [ ] 7. `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:worker`, `pnpm build` all exit 0.
- [ ] 8. `pnpm scaffold doctor` exits 0 (10/10).

## Vertical slice

- [ ] contract — `packages/contracts/src/index.ts` — add `setupPreflightResponseSchema`
- [ ] middleware — `apps/worker/src/http/middleware/setup-session.ts` (new)
- [ ] use case — `apps/worker/src/modules/onboarding/preflight.ts` (new)
- [ ] module public API — `apps/worker/src/modules/onboarding/index.ts` — export `runPreflight`
- [ ] route — `apps/worker/src/http/routes/setup.ts` — add `POST /preflight` with session middleware
- [ ] tests — `apps/worker/src/http/routes/preflight.worker.test.ts` (new)

## File ownership

| Agent | Owns |
|---|---|
| implementer | `packages/contracts/src/index.ts` (add schema only) |
| implementer | `packages/contracts/src/index.test.ts` (add schema tests) |
| implementer | `apps/worker/src/http/middleware/setup-session.ts` (new) |
| implementer | `apps/worker/src/modules/onboarding/preflight.ts` (new) |
| implementer | `apps/worker/src/modules/onboarding/index.ts` |
| implementer | `apps/worker/src/http/routes/setup.ts` |
| implementer | `apps/worker/src/http/routes/preflight.worker.test.ts` (new) |

## Reading list

- `CLAUDE.md`
- this file (`work/active/CAP-009-setup-preflight/task.md`)
- `.claude/agents/implementer.md`
- `.claude/rules/architecture.md` — §API conventions, §Forbidden
- `.claude/rules/coding.md` — §Structure, §Errors
- `.claude/rules/testing.md` — §Mocking, §Determinism
- `.claude/rules/security.md` — §Secrets, §Authorization
- `docs/rebuild/05-target-architecture/api-design.md` lines 105-121 (setup routes)
- Existing code:
  - `apps/worker/src/http/routes/setup.ts` (current setup sub-app — where to add /preflight)
  - `apps/worker/src/http/middleware/setup-gate.ts` (middleware pattern)
  - `apps/worker/src/http/middleware/error.ts` (error middleware — how DomainError maps to status)
  - `apps/worker/src/platform/env.ts` (Env type — all bindings)
  - `apps/worker/src/platform/errors.ts` (DomainError)
  - `apps/worker/src/platform/secrets.ts` (readSecret)
  - `apps/worker/src/modules/onboarding/index.ts` (current public API)
  - `apps/worker/src/modules/onboarding/claim-setup.ts` (use case pattern)
  - `apps/worker/src/http/routes/claim.worker.test.ts` (test pattern — claim, session, KV)
  - `apps/worker/src/http/routes/setup-status.worker.test.ts` (test pattern)
  - `packages/contracts/src/index.ts` (where to add schema)
  - `packages/test-kit/src/seed.ts` (test helpers)
  - `migrations/0001_initial.sql` lines 226-232 (d1_migrations table)

## Dependencies

- Requires: CAP-008 (claim endpoint creates the session this endpoint validates) — Implemented
- Blocks: CAP-010 (administrator) — the session middleware pattern established here is reused by all post-claim setup endpoints

## Design guidance

### Setup-session middleware

```typescript
// http/middleware/setup-session.ts
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../../platform/env';
import { DomainError } from '../../platform/errors';

export const setupSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) {
    throw new DomainError({
      code: 'SETUP_SESSION_REQUIRED',
      message: 'Authorization header required',
      httpStatus: 401,
    });
  }

  const token = auth.slice('Bearer '.length);
  const session = await c.env.SETUP_SESSION.get(token);
  if (!session) {
    throw new DomainError({
      code: 'SETUP_SESSION_INVALID',
      message: 'Invalid or expired session',
      httpStatus: 401,
    });
  }

  await next();
};
```

### Preflight use case

The use case takes the full `Env` (or individual bindings) and checks each one's existence.
For Secrets Store bindings, use `readSecret` to verify the value is accessible.

```typescript
// modules/onboarding/preflight.ts
export interface PreflightResult {
  readonly bindings: Readonly<Record<string, boolean>>;
  readonly schemaVersion: string;
}

export async function runPreflight(db: Database, env: PreflightBindings): Promise<PreflightResult> {
  // Check each binding's existence
  const bindings: Record<string, boolean> = {
    DB: !!env.DB,
    ATTACHMENTS: !!env.ATTACHMENTS,
    SETUP_SESSION: !!env.SETUP_SESSION,
    CACHE: !!env.CACHE,
    OUTBOUND: !!env.OUTBOUND,
    // For secrets, check the value is accessible
    INSTALLATION_TOKEN: await checkSecret(env.INSTALLATION_TOKEN),
    CREDENTIAL_ENCRYPTION_KEY: await checkSecret(env.CREDENTIAL_ENCRYPTION_KEY),
  };

  // Read schema version from d1_migrations
  const row = await db
    .prepare('SELECT name FROM d1_migrations ORDER BY name DESC LIMIT 1')
    .first<{ name: string }>();
  const schemaVersion = row?.name?.replace(/\.sql$/, '') ?? 'unknown';

  return { bindings, schemaVersion };
}
```

For `checkSecret`, use `readSecret` in a try/catch — if it throws, the secret is not available.

### Route handler

Apply the session middleware inline on the preflight route only:

```typescript
// In setupRoutes():
routes.post('/preflight', setupSession, async (c) => {
  const result = await runPreflight(c.env.DB, c.env);
  return c.json({ data: result });
});
```

### Test approach

The test must first call `POST /api/v1/setup/claim` to get a session token, then use it for
the preflight request. Use `resetAndMigrate` for a clean, migrated DB.

Test matrix:

| Scenario | Auth header | Expected status | Expected body |
|---|---|---|---|
| Valid session | `Bearer <token-from-claim>` | 200 | `{data:{bindings:{...all true...},schemaVersion:"0001"}}` |
| No auth header | (none) | 401 | `{error:{code:"SETUP_SESSION_REQUIRED",...}}` |
| Invalid token | `Bearer invalid-token` | 401 | `{error:{code:"SETUP_SESSION_INVALID",...}}` |

## Decisions made during this capability

1. **Session middleware applied inline** on `/preflight` only. `/status` and `/claim` remain
   public. When more session-protected routes land (CAP-010+), they add `setupSession` inline
   or a route group is introduced (Rule of Three).

2. **Binding checks are existence-only.** Checking `typeof env.BINDING !== 'undefined'` catches
   missing binding declarations. For secrets, `readSecret` in a try/catch verifies accessibility.
   Deep health checks (actual D1 queries, R2 puts) are a future concern.

3. **Schema version from `d1_migrations`** — the table records applied migration filenames.
   The latest one's name prefix is the schema version. This is more meaningful than the code
   constant because it reflects what the database was actually migrated to.

## Open questions

(None.)
