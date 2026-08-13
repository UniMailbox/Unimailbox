# CAP-011 — `POST /api/v1/setup/domain` — persist a managed domain as `active`

**Phase:** 1 · **Status:** In Progress · **Started:** 2026-08-13

## Goal

The operator provides a domain name. The system persists it as a `managed_domains` row with
`status='active'` and advances the installation step to `cloudflare-verify`. This introduces
the **tenancy module** (owns `managed_domains`, `mailboxes`, `mailbox_members`) and a new
migration for the `managed_domains` table.

## Architecture decision — new module edge

The setup domain step needs to: (1) create a domain (tenancy) and (2) advance the installation
step (onboarding). Neither module depends on the other per the current architecture rules. As
orchestrator, I approve **`onboarding → tenancy`** as a new allowed edge — the onboarding module
orchestrates the setup wizard, which includes creating domains. The use case lives in onboarding
and calls tenancy's repository, same pattern as CAP-010 (onboarding → identity).

## Scope

- **New migration** `migrations/0002_managed_domains.sql` — creates the `managed_domains` table
  with `id`, `name` (UNIQUE, COLLATE NOCASE), `status` ('active'|'disabled'), `outbound_connection_id`
  (nullable, no FK yet — provider_connections doesn't exist), timestamps. Plus `d1_migrations` tracking row.

- **Migration verify** `migrations/0002_managed_domains.verify.sql` — assertions for the new table.

- **Drizzle schema** `apps/worker/src/database/schema/tenancy.ts` (new) — typed schema for
  `managed_domains`. Add to `schema/index.ts`.

- **Tenancy module** (`modules/tenancy/`, new).
  - `domain-repository.ts` — `prepareCreateDomain` (returns `D1PreparedStatement` for batch),
    `createDomain` (convenience wrapper).
  - `index.ts` — exports.

- **`createDomainStep` use case** in `modules/onboarding/create-domain.ts` (new).
  - Calls tenancy's `prepareCreateDomain`.
  - Calls onboarding's `prepareUpdateInstallationStep` (step → 'cloudflare-verify').
  - Batches both in one D1 transaction.
  - Returns `{ domainId, name, status }`.

- **`POST /api/v1/setup/domain` route handler** in `http/routes/setup.ts`.
  - Session-protected.
  - Validates body with `setupDomainRequestSchema`.
  - Calls `createDomainStep`.
  - Returns `{ data: { domainId, name, status } }`.

- **Contracts** — `domainNameSchema` (validated domain name) + `setupDomainRequestSchema`.

- **Schema version bump** — `CURRENT_SCHEMA_VERSION` in `database/schema-version.ts` → `'0002'`.

- **Worker-pool tests**.

## Out of scope

- **Mailboxes / mailbox_members** — CAP-020.
- **Domain signatures** — Phase 3.
- **Cloudflare dashboard link / Email Routing verify** — CAP-012.
- **Outbound connection binding** — `outbound_connection_id` column exists but is nullable; populated in CAP-014.

## Business rules

| Rule ID | What it means for this slice |
|---|---|
| R-DATA-001 | Domain name stored case-insensitively (COLLATE NOCASE + zod `.toLowerCase()`). |
| ManagedDomain invariant | `name` is unique. A disabled domain cannot create mailboxes or send. New domains start `active`. |

## Acceptance criteria

- [ ] 1. `POST /api/v1/setup/domain` with a valid domain name + session returns 200 with `{"data":{"domainId":"<uuid>","name":"example.com","status":"active"}}`.
- [ ] 2. The `managed_domains` row exists in D1 with the correct name (lowercase), status='active'.
- [ ] 3. After creation, `GET /api/v1/setup/status` returns `currentStep: 'cloudflare-verify'`.
- [ ] 4. Duplicate domain name → 409.
- [ ] 5. Case-insensitive duplicate (`Example.COM` when `example.com` exists) → 409.
- [ ] 6. Invalid domain name (no dot, too short, special chars) → 400 VALIDATION_ERROR.
- [ ] 7. Without a valid session → 401.
- [ ] 8. `pnpm scaffold doctor` exits 0 (10/10) — including schema-version check matching `0002`.
- [ ] 9. `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:worker`, `pnpm build` all exit 0.

## File ownership

| Agent | Owns |
|---|---|
| implementer | `migrations/0002_managed_domains.sql` (new) |
| implementer | `migrations/0002_managed_domains.verify.sql` (new) |
| implementer | `apps/worker/src/database/schema/tenancy.ts` (new) |
| implementer | `apps/worker/src/database/schema/index.ts` |
| implementer | `apps/worker/src/database/schema-version.ts` |
| implementer | `packages/contracts/src/index.ts` (add schemas) |
| implementer | `packages/contracts/src/index.test.ts` (add tests) |
| implementer | `apps/worker/src/modules/tenancy/index.ts` (new) |
| implementer | `apps/worker/src/modules/tenancy/domain-repository.ts` (new) |
| implementer | `apps/worker/src/modules/onboarding/create-domain.ts` (new) |
| implementer | `apps/worker/src/modules/onboarding/index.ts` |
| implementer | `apps/worker/src/http/routes/setup.ts` |
| implementer | `apps/worker/src/http/routes/domain.worker.test.ts` (new) |

## Reading list

- `CLAUDE.md` and this task file
- `.claude/rules/architecture.md` — §Dependency direction, §Persistence ownership, §Forbidden
- `.claude/rules/coding.md` — §Data (D1 batch for atomic writes), §Structure
- `.claude/rules/testing.md` — §Mocking, §Determinism, §Quality gates
- `docs/rebuild/E-proposed-domain-model.md` lines 140-157 (ManagedDomain interface)
- `docs/rebuild/03-domain-design/aggregates.md` (ManagedDomain aggregate)
- Existing code:
  - `migrations/0001_initial.sql` (migration format + tracking convention — lines 220-232)
  - `migrations/0001_initial.verify.sql` (verify file format)
  - `apps/worker/src/database/schema/identity.ts` (Drizzle schema pattern)
  - `apps/worker/src/database/schema/onboarding.ts`
  - `apps/worker/src/database/schema/index.ts`
  - `apps/worker/src/database/schema-version.ts`
  - `apps/worker/src/modules/onboarding/create-administrator.ts` (use case + batch pattern)
  - `apps/worker/src/modules/onboarding/installation-state-repository.ts` (prepareUpdateInstallationStep)
  - `apps/worker/src/modules/identity/user-repository.ts` (repository + prepareCreate pattern)
  - `apps/worker/src/http/routes/setup.ts` (current setup routes)
  - `apps/worker/src/http/routes/administrator.worker.test.ts` (test pattern)
  - `packages/contracts/src/index.ts`
  - `packages/test-kit/src/seed.ts`
  - `scripts/doctor.ts` (schema-version check logic)

## Design guidance

### Migration (0002_managed_domains.sql)

```sql
-- 0002_managed_domains.sql — Tenancy: managed_domains (Phase 1)
CREATE TABLE IF NOT EXISTS managed_domains (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL COLLATE NOCASE,
  status                  TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  outbound_connection_id  TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS managed_domains_name_unique
  ON managed_domains(name COLLATE NOCASE);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0002_managed_domains.sql');
```

### Domain name schema (contracts)

```typescript
export const domainNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(253)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/,
    'Invalid domain name',
  );

export const setupDomainRequestSchema = z.object({
  name: domainNameSchema,
});
```

### Tenancy module — domain repository

```typescript
// modules/tenancy/domain-repository.ts
export function prepareCreateDomain(
  db: Database,
  input: { id: string; name: string; status: 'active' | 'disabled'; createdAt: string; updatedAt: string },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO managed_domains (id, name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(input.id, input.name, input.status, input.createdAt, input.updatedAt);
}
```

### Use case (onboarding/create-domain.ts)

Same pattern as create-administrator: batch domain insert + step update.

```typescript
export async function createDomainStep(
  input: { db: Database; name: string },
  deps: { clock: Clock; ids: IdGenerator },
): Promise<{ domainId: string; name: string; status: string }> {
  const domainId = deps.ids.uuid();
  const now = deps.clock.now().toISOString().slice(0, 19).replace('T', ' ');

  const insertDomain = prepareCreateDomain(input.db, {
    id: domainId, name: input.name, status: 'active', createdAt: now, updatedAt: now,
  });
  const advanceStep = prepareUpdateInstallationStep(input.db, 'cloudflare-verify', now);

  try {
    await input.db.batch([insertDomain, advanceStep]);
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE constraint failed: managed_domains.name')) {
      throw new DomainError({ code: 'DOMAIN_ALREADY_MANAGED', message: 'Domain is already managed', httpStatus: 409 });
    }
    throw err;
  }

  return { domainId, name: input.name, status: 'active' };
}
```

### Test approach

Same pattern as administrator tests: claim session → call endpoint → verify D1 row + step advancement.
For setup, the tests need the installation step at 'domain' before calling. Since the step isn't
enforced as a precondition yet (unlike the CAP-010 singularity guard for users), tests can call
the endpoint at any step. If you add a domain-existence guard (recommended), seed the step accordingly.

**Important:** Update the `schema-version` in `apps/worker/src/database/schema-version.ts` to `'0002'`.
The doctor's `schema-version` check compares this against the highest migration filename prefix.
The `migrationsDb()` helper in test-kit applies all migrations in the `migrations/` directory, so the
new migration will be picked up automatically.

## Decisions

1. **`onboarding → tenancy` edge approved** — onboarding orchestrates the setup wizard, which
   creates domains. Same pattern as `onboarding → identity` (CAP-010).
2. **Domain-existence guard** — recommended: check `SELECT 1 FROM managed_domains LIMIT 1` before
   insert, reject with 409 if a domain already exists. Setup creates exactly one domain.
3. **No FK on `outbound_connection_id`** — `provider_connections` table doesn't exist yet. Add FK
   in a later migration when the outbound module lands.

## Open questions

(None.)
