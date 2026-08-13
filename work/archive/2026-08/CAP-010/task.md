# CAP-010 — `POST /api/v1/setup/administrator` — first user, PBKDF2 password (ADR-006)

**Phase:** 1 · **Status:** In Progress · **Started:** 2026-08-13

## Goal

The operator creates the first user (the initial administrator) with a PBKDF2-hashed password.
This is setup-wizard step 3 (`administrator`). The endpoint is session-protected (requires a
valid setup session from `/claim`). After successful creation, the installation step advances
from `administrator` to `domain`.

This capability also introduces the **identity module** (owns `users`, `sessions`) and the
**`hashPassword` function** in `platform/crypto.ts` (PBKDF2-SHA256, 600k iterations per ADR-006).

## PBKDF2 verification

Cloudflare Workers supports PBKDF2 via the standard Web Crypto API:
`crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256)`.
ADR-006 confirms this and provides the exact implementation. The ~600ms compute time is
within the Workers Paid plan CPU budget (30s).

## Scope

- **`hashPassword` in `platform/crypto.ts`** — PBKDF2-SHA256, 600,000 iterations, 16-byte salt.
  Returns `{ algorithm, iterations, salt, hash }`. Uses `crypto.subtle.deriveBits` per ADR-006.

- **Identity module** (`modules/identity/`, new).
  - `user-repository.ts` — `createUser(db, input)` inserts a row into `users`.
  - `index.ts` — exports `createUser`.

- **`createAdministrator` use case** in `modules/onboarding/create-administrator.ts` (new).
  - Hashes the password via `hashPassword`.
  - Calls `createUser` from the identity module (onboarding depends on identity — allowed).
  - Updates `installation_state.current_step` to `'domain'`.
  - Returns `{ userId }`.

- **`updateInstallationStep`** in `installation-state-repository.ts` — `UPDATE installation_state
  SET current_step = ?, updated_at = ? WHERE id = 1`.

- **`POST /api/v1/setup/administrator` route handler** in `http/routes/setup.ts`.
  - Session-protected (uses `setupSession` middleware from CAP-009).
  - Validates body with `setupAdministratorRequestSchema`.
  - Calls `createAdministrator` use case.
  - Returns `{ data: { userId } }`.

- **Request contract** — `setupAdministratorRequestSchema` in `packages/contracts`:
  `{ email: EmailAddress, password: z.string().min(8).max(72), displayName: z.string().max(100).optional() }`.

- **Worker-pool tests** — successful creation, duplicate email → 409, session required, password
  too short → 400, installation step advances.

## Out of scope

- **Login / password verification** — CAP-019. `verifyPassword` lands there.
- **Role + permission seeding** — CAP-017. The user is created without role assignment; the
  setup session authenticates all setup operations. After setup completes, CAP-017 seeds roles
  and assigns the `administrator` role to this user.
- **Session creation (access/refresh tokens)** — CAP-019.
- **Audit events for user creation** — CAP-026. Phase 0/1 setup steps don't emit audit events yet.
- **Rate limiting** — Phase 0/1.

## Business rules

| Rule ID | What it means for this slice |
|---|---|
| `R-AUTH-002` | `users.status` is `'active'` for the new administrator. |
| `R-AUTH-009` | `email` is stored case-insensitively (COLLATE NOCASE in DDL). |
| ADR-006 | PBKDF2-SHA256, 600k iterations, 16-byte salt, 256-bit hash. Algorithm stored alongside for future rehashing. |

## Acceptance criteria

- [ ] 1. `POST /api/v1/setup/administrator` with a valid session + `{ email, password }` returns 200 with `{"data":{"userId":"<uuid>"}}`.
- [ ] 2. The user row exists in D1 with `status='active'`, `password_algorithm='pbkdf2-sha256'`, `password_iterations=600000`.
- [ ] 3. The `password_salt` and `password_hash` columns are non-empty BLOBs (16+ bytes salt, 32 bytes hash).
- [ ] 4. After creation, `GET /api/v1/setup/status` returns `currentStep: 'domain'`.
- [ ] 5. Duplicate email → 409 with error code `USER_EMAIL_TAKEN`.
- [ ] 6. Without a valid session → 401.
- [ ] 7. Password shorter than 8 characters → 400 VALIDATION_ERROR.
- [ ] 8. The response does NOT include the password hash, salt, or iterations.
- [ ] 9. `hashPassword` is unit-tested: output has correct algorithm, iterations, salt length ≥16, hash length = 32.
- [ ] 10. `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:worker`, `pnpm build` all exit 0.
- [ ] 11. `pnpm scaffold doctor` exits 0 (10/10).

## Vertical slice

- [ ] contract — `packages/contracts/src/index.ts` — add `setupAdministratorRequestSchema`
- [ ] platform/crypto — `apps/worker/src/platform/crypto.ts` — add `hashPassword`
- [ ] identity module — `apps/worker/src/modules/identity/` (new) — `createUser` repository
- [ ] onboarding use case — `apps/worker/src/modules/onboarding/create-administrator.ts` (new)
- [ ] onboarding repository — `apps/worker/src/modules/onboarding/installation-state-repository.ts` — add `updateInstallationStep`
- [ ] onboarding module API — `apps/worker/src/modules/onboarding/index.ts` — export `createAdministrator`
- [ ] route — `apps/worker/src/http/routes/setup.ts` — add `POST /administrator`
- [ ] tests — `apps/worker/src/http/routes/administrator.worker.test.ts` (new)
- [ ] tests — `apps/worker/src/platform/crypto.test.ts` — add `hashPassword` tests

## File ownership

| Agent | Owns |
|---|---|
| implementer | `packages/contracts/src/index.ts` (add schema) |
| implementer | `packages/contracts/src/index.test.ts` (add schema tests) |
| implementer | `apps/worker/src/platform/crypto.ts` |
| implementer | `apps/worker/src/platform/crypto.test.ts` |
| implementer | `apps/worker/src/modules/identity/index.ts` (new) |
| implementer | `apps/worker/src/modules/identity/user-repository.ts` (new) |
| implementer | `apps/worker/src/modules/onboarding/create-administrator.ts` (new) |
| implementer | `apps/worker/src/modules/onboarding/installation-state-repository.ts` |
| implementer | `apps/worker/src/modules/onboarding/index.ts` |
| implementer | `apps/worker/src/http/routes/setup.ts` |
| implementer | `apps/worker/src/http/routes/administrator.worker.test.ts` (new) |

## Reading list

Read exactly these:

- `CLAUDE.md`
- this file (`work/active/CAP-010-setup-administrator/task.md`)
- `.claude/agents/implementer.md`
- `.claude/rules/architecture.md` — §Dependency direction (identity ← onboarding), §API conventions, §Forbidden
- `.claude/rules/coding.md` — §Structure, §Errors, §Data
- `.claude/rules/testing.md` — §Mocking, §Determinism, §Quality gates
- `.claude/rules/security.md` — §Passwords (PBKDF2 parameters, constant-time verify), §Secrets
- `docs/rebuild/09-decisions/ADR-006-pbkdf2-password-hashing.md` — exact `hashPassword` implementation
- `docs/rebuild/05-target-architecture/api-design.md` lines 105-121 (setup routes)
- Existing code:
  - `apps/worker/src/platform/crypto.ts` (currently has `constantTimeCompare` — add `hashPassword`)
  - `apps/worker/src/platform/ids.ts` (IdGenerator)
  - `apps/worker/src/platform/clock.ts` (Clock)
  - `apps/worker/src/platform/errors.ts` (DomainError)
  - `apps/worker/src/platform/env.ts` (Env type)
  - `apps/worker/src/modules/onboarding/index.ts` (current public API)
  - `apps/worker/src/modules/onboarding/claim-setup.ts` (use case pattern — same structure)
  - `apps/worker/src/modules/onboarding/installation-state-repository.ts` (add updateInstallationStep)
  - `apps/worker/src/modules/onboarding/setup-status.ts` (use case pattern)
  - `apps/worker/src/http/routes/setup.ts` (where to add POST /administrator)
  - `apps/worker/src/http/middleware/setup-session.ts` (session middleware)
  - `apps/worker/src/http/routes/claim.worker.test.ts` (test pattern — claim → use session)
  - `apps/worker/src/http/routes/preflight.worker.test.ts` (test pattern — session-protected endpoint)
  - `apps/worker/src/database/schema/identity.ts` (users table Drizzle typing)
  - `migrations/0001_initial.sql` lines 78-95 (users DDL — BLOB columns, CHECK constraints)
  - `packages/contracts/src/index.ts` (emailAddressSchema, existing schemas)
  - `packages/test-kit/src/seed.ts` (test helpers)

## Dependencies

- Requires: CAP-009 (setup-session middleware, preflight) — Implemented
- Blocks: CAP-011 (`POST /setup/domain`), CAP-017 (roles + permissions seed)

## Design guidance

### `hashPassword` (platform/crypto.ts)

Per ADR-006. Uses the Web Crypto API — no external dependencies.

```typescript
export interface PasswordHash {
  readonly algorithm: 'pbkdf2-sha256';
  readonly iterations: number;
  readonly salt: Uint8Array;
  readonly hash: Uint8Array;
}

const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_HASH_BITS = 256;

export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const hashBuffer = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    PBKDF2_HASH_BITS,
  );
  return {
    algorithm: 'pbkdf2-sha256',
    iterations: PBKDF2_ITERATIONS,
    salt,
    hash: new Uint8Array(hashBuffer),
  };
}
```

### Identity module — user repository

```typescript
// modules/identity/user-repository.ts (private)
import type { Database } from '../../platform/database';
import type { EmailAddress } from '@unimailbox/contracts';

export interface CreateUserInput {
  readonly id: string;
  readonly email: EmailAddress;
  readonly displayName: string | null;
  readonly status: 'active' | 'banned' | 'deleted';
  readonly passwordAlgorithm: string;
  readonly passwordIterations: number;
  readonly passwordSalt: Uint8Array;
  readonly passwordHash: Uint8Array;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export async function createUser(db: Database, input: CreateUserInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (id, email, display_name, status,
        password_algorithm, password_iterations, password_salt, password_hash,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id, input.email, input.displayName, input.status,
      input.passwordAlgorithm, input.passwordIterations, input.passwordSalt, input.passwordHash,
      input.createdAt, input.updatedAt,
    )
    .run();
}
```

### Identity module — index.ts

```typescript
// modules/identity — owner of users, sessions, idempotency_records.
// Exports: createUser — inserts a user row.
export { createUser } from './user-repository';
export type { CreateUserInput } from './user-repository';
```

### `updateInstallationStep` (onboarding repository)

```typescript
export async function updateInstallationStep(
  db: Database,
  step: InstallationStep,
  timestamp: string,
): Promise<void> {
  await db
    .prepare('UPDATE installation_state SET current_step = ?, updated_at = ? WHERE id = 1')
    .bind(step, timestamp)
    .run();
}
```

### `createAdministrator` use case

```typescript
// modules/onboarding/create-administrator.ts
// Depends on identity module (allowed: onboarding → identity per architecture rules).

export interface CreateAdministratorInput {
  readonly db: Database;
  readonly email: EmailAddress;
  readonly password: string;
  readonly displayName: string | null;
}

export interface CreateAdministratorResult {
  readonly userId: string;
}

export async function createAdministrator(
  input: CreateAdministratorInput,
  deps: { clock: Clock; ids: IdGenerator },
): Promise<CreateAdministratorResult> {
  const passwordHash = await hashPassword(input.password);
  const userId = deps.ids.uuid();
  const now = deps.clock.now().toISOString().slice(0, 19).replace('T', ' ');

  try {
    await createUser(input.db, {
      id: userId,
      email: input.email,
      displayName: input.displayName,
      status: 'active',
      passwordAlgorithm: passwordHash.algorithm,
      passwordIterations: passwordHash.iterations,
      passwordSalt: passwordHash.salt,
      passwordHash: passwordHash.hash,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    // D1 unique constraint violation on email → 409
    if (String(err).includes('UNIQUE constraint failed: users.email')) {
      throw new DomainError({
        code: 'USER_EMAIL_TAKEN',
        message: 'A user with this email already exists',
        httpStatus: 409,
      });
    }
    throw err;
  }

  // Advance setup step: administrator → domain
  await updateInstallationStep(input.db, 'domain', now);

  return { userId };
}
```

### Route handler

```typescript
// In setupRoutes(), after /preflight:
routes.post('/administrator', setupSession, async (c) => {
  const body = setupAdministratorRequestSchema.parse(await c.req.json());
  const result = await createAdministrator(
    {
      db: c.env.DB,
      email: body.email,
      password: body.password,
      displayName: body.displayName ?? null,
    },
    { clock: systemClock, ids: systemIds },
  );
  return c.json({ data: result });
});
```

### Contract schema

```typescript
export const setupAdministratorRequestSchema = z.object({
  email: emailAddressSchema,
  password: z.string().min(8).max(72),
  displayName: z.string().max(100).optional(),
});
```

### Test approach

Tests follow the claim → session → use-session pattern from CAP-009 preflight tests.

1. Claim a session (POST /claim with test token)
2. POST /administrator with session + body → 200 + userId
3. Verify user row in D1 (email, status, password columns)
4. Verify GET /status returns currentStep='domain'
5. Duplicate email → 409
6. No session → 401
7. Short password → 400

For verifying the user row in D1, use `env.DB.prepare('SELECT ...').first()` from `cloudflare:test`.

**Note on PBKDF2 timing in tests:** `hashPassword` takes ~600ms. Worker-pool tests have a 5s default
timeout per test. The `administrator` endpoint test will take ~600ms — well within the limit. Do NOT
reduce iterations for tests (testing.md §Determinism: test what you ship).

## Decisions made during this capability

1. **Use case in onboarding, not identity.** The `createAdministrator` use case needs to update
   `installation_state` (owned by onboarding). Since onboarding depends on identity (allowed per
   architecture rules), the use case lives in onboarding and calls the identity repository.

2. **No role assignment.** Roles and permissions are seeded in CAP-017. The first user is created
   without a role. The setup session authenticates all setup operations. After setup completes,
   CAP-017 assigns the `administrator` role.

3. **Password min length = 8.** No specific business rule defines the minimum. 8 characters is the
   industry standard minimum. Max 72 matches the bcrypt limit (forward compatibility if we migrate).

4. **Duplicate email detection via D1 error.** The `users.email` column has `UNIQUE INDEX`. Inserting
   a duplicate throws a constraint violation. The use case catches this and maps to 409.

5. **`hashPassword` uses `crypto.getRandomValues` for salt.** This is explicitly allowed for the salt
   (it's not a domain ID). The `ids` generator is for UUIDs only.

## Open questions

(None.)
