# CAP-017 — Roles + permissions seed; `requirePermission` middleware

**Phase:** 1 · **Status:** In Progress · **Started:** 2026-08-13

## Goal

Seed the roles and permissions tables, assign the `administrator` role to the first user, and
implement the `requirePermission(key)` middleware. Introduces the **admin module** (owns roles,
permissions, role_permissions, user_roles, audit_events, maintenance_jobs).

The middleware is defined but not wired to any route until CAP-019 adds authentication (it reads
`c.get('userId')` which the auth middleware will set).

## Scope

- **`PermissionKey` type + `permissionKeySchema`** in contracts — closed enum of 20 keys.

- **Admin module** (`modules/admin/`):
  - `permission-repository.ts` — `checkPermission(db, userId, key)`, `getUserRoleIds(db, userId)`.
  - `seed-repository.ts` — `seedRolesAndPermissions(db, timestamp)`, `assignRole(db, userId, roleId, timestamp)`.
  - `index.ts` — exports.

- **`requirePermission(key)` middleware** (`http/middleware/authz.ts`):
  - Reads `userId` from Hono context (`c.get('userId')`).
  - If no userId → 401 AUTHENTICATION_REQUIRED.
  - Queries permissions via admin module.
  - If missing → 403 PERMISSION_DENIED.
  - If present → `next()`.

- **Seeding integration** — modify `completeSetup` to call `seedRolesAndPermissions` +
  `assignRole(firstUser, 'administrator')` when flipping status to 'complete'.

- **Worker-pool tests** — seed correctness, permission check, middleware behavior.

## Permission keys (20 total, from security.md)

```
message.read, message.send, message.delete
mailbox.create, mailbox.manage, mailbox.share
user.read, user.manage
role.read, role.manage
domain.read, domain.manage
signature.read, signature.manage
settings.read, settings.manage
provider.sync
webhook_event.read, webhook_event.delete
analytics.read
```

## Seed roles (from security.md)

- `administrator` = ALL 20 permissions
- `member` = `message.{read,send,delete}`, `mailbox.{create,manage}`

## Design — deterministic IDs

Use the permission key as the permission ID (e.g., `'message.read'`) and the role name as the
role ID (e.g., `'administrator'`). This makes seeding idempotent via `INSERT OR IGNORE` and
simplifies the role_permissions mapping. System rows are not user-facing aggregates — the UUID
identity rule applies to domain entities, not to seed data.

## Acceptance criteria

- [ ] 1. After `seedRolesAndPermissions`, all 20 permissions exist in the `permissions` table.
- [ ] 2. The `administrator` role exists with all 20 permissions mapped in `role_permissions`.
- [ ] 3. The `member` role exists with 5 permissions (message.{read,send,delete}, mailbox.{create,manage}).
- [ ] 4. After setup completion, the first user has the `administrator` role in `user_roles`.
- [ ] 5. `checkPermission(db, adminUserId, 'message.read')` returns true.
- [ ] 6. `checkPermission(db, adminUserId, 'nonexistent.key')` returns false.
- [ ] 7. `requirePermission('message.read')` without userId in context → 401.
- [ ] 8. `requirePermission('message.read')` with userId that has the permission → passes through.
- [ ] 9. `requirePermission('role.manage')` with userId that has only `member` role → 403.
- [ ] 10. `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:worker`, `pnpm build` all exit 0.
- [ ] 11. `pnpm scaffold doctor` exits 0 (10/10).

## File ownership

| Agent | Owns |
|---|---|
| implementer | `packages/contracts/src/index.ts` (add permissionKeySchema) |
| implementer | `packages/contracts/src/index.test.ts` |
| implementer | `apps/worker/src/modules/admin/index.ts` (new) |
| implementer | `apps/worker/src/modules/admin/permission-repository.ts` (new) |
| implementer | `apps/worker/src/modules/admin/seed-repository.ts` (new) |
| implementer | `apps/worker/src/http/middleware/authz.ts` (new) |
| implementer | `apps/worker/src/modules/onboarding/complete-setup.ts` (modify — add seeding) |
| implementer | `apps/worker/src/modules/onboarding/index.ts` |
| implementer | `apps/worker/src/modules/identity/user-repository.ts` — may need `getUserCount` or reuse `getFirstUser` |
| implementer | `scripts/doctor.ts` (ALLOWED: add admin module) |
| implementer | `apps/worker/src/modules/admin/admin.worker.test.ts` (new) |

## Reading list

- `work/active/CAP-017-roles-permissions/task.md` (this file)
- `.claude/rules/security.md` — §Authorization (PermissionKey enum, seed roles, requirePermission)
- `.claude/rules/architecture.md` — §Dependency direction (admin module deps), §Persistence ownership
- `migrations/0001_initial.sql` lines 131-175 (permissions, roles, role_permissions, user_roles DDL)
- `apps/worker/src/database/schema/admin.ts` (Drizzle typing)
- `apps/worker/src/modules/onboarding/complete-setup.ts` (where seeding is added)
- `apps/worker/src/modules/identity/user-repository.ts` (getFirstUser)
- `apps/worker/src/http/middleware/setup-session.ts` (middleware pattern)
- `apps/worker/src/http/middleware/error.ts` (how DomainError maps to status)
- `packages/contracts/src/index.ts`
- `scripts/doctor.ts` (ALLOWED set)

## Design guidance

### PermissionKey contract

```typescript
export const permissionKeySchema = z.enum([
  'message.read', 'message.send', 'message.delete',
  'mailbox.create', 'mailbox.manage', 'mailbox.share',
  'user.read', 'user.manage',
  'role.read', 'role.manage',
  'domain.read', 'domain.manage',
  'signature.read', 'signature.manage',
  'settings.read', 'settings.manage',
  'provider.sync',
  'webhook_event.read', 'webhook_event.delete',
  'analytics.read',
]);
export type PermissionKey = z.infer<typeof permissionKeySchema>;
```

### Seed repository

```typescript
const ALL_PERMISSIONS: ReadonlyArray<{ key: PermissionKey; description: string }> = [
  { key: 'message.read', description: 'Read messages' },
  // ... all 20
];

const ROLE_PERMISSIONS: ReadonlyArray<{ role: string; permissions: PermissionKey[] }> = [
  { role: 'administrator', permissions: ALL_PERMISSIONS.map(p => p.key) },
  { role: 'member', permissions: ['message.read', 'message.send', 'message.delete', 'mailbox.create', 'mailbox.manage'] },
];

export async function seedRolesAndPermissions(db: Database, timestamp: string): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  // Permissions — ID = key (deterministic for idempotent seeding)
  for (const perm of ALL_PERMISSIONS) {
    stmts.push(db.prepare(
      'INSERT OR IGNORE INTO permissions (id, key, description, created_at) VALUES (?, ?, ?, ?)'
    ).bind(perm.key, perm.key, perm.description, timestamp));
  }
  // Roles — ID = name (deterministic)
  stmts.push(db.prepare(
    'INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at) VALUES (?, ?, ?, 1, ?)'
  ).bind('administrator', 'administrator', 'Full system access', timestamp));
  stmts.push(db.prepare(
    'INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at) VALUES (?, ?, ?, 1, ?)'
  ).bind('member', 'member', 'Standard user', timestamp));
  // Role-permission mappings
  for (const rp of ROLE_PERMISSIONS) {
    for (const perm of rp.permissions) {
      stmts.push(db.prepare(
        'INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES (?, ?, ?)'
      ).bind(rp.role, perm, timestamp));
    }
  }
  await db.batch(stmts);
}

export async function assignRole(db: Database, userId: string, roleId: string, timestamp: string): Promise<void> {
  await db.prepare(
    'INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_at) VALUES (?, ?, ?)'
  ).bind(userId, roleId, timestamp).run();
}
```

### Permission check repository

```typescript
export async function checkPermission(db: Database, userId: string, permissionKey: string): Promise<boolean> {
  const result = await db.prepare(
    `SELECT 1 FROM user_roles ur
     JOIN role_permissions rp ON ur.role_id = rp.role_id
     JOIN permissions p ON rp.permission_id = p.id
     WHERE ur.user_id = ? AND p.key = ?
     LIMIT 1`
  ).bind(userId, permissionKey).first();
  return !!result;
}
```

### requirePermission middleware

```typescript
import type { MiddlewareHandler } from 'hono';
import type { PermissionKey } from '@unimailbox/contracts';
import type { AppEnv } from '../../platform/env';
import { DomainError } from '../../platform/errors';
import { checkPermission } from '../../modules/admin';

export function requirePermission(key: PermissionKey): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const userId = c.get('userId');
    if (!userId || typeof userId !== 'string') {
      throw new DomainError({
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication required',
        httpStatus: 401,
      });
    }
    const hasPermission = await checkPermission(c.env.DB, userId, key);
    if (!hasPermission) {
      throw new DomainError({
        code: 'PERMISSION_DENIED',
        message: `Permission denied: ${key}`,
        httpStatus: 403,
      });
    }
    await next();
  };
}
```

### completeSetup modification

Add seeding to the existing `completeSetup` use case:

```typescript
export async function completeSetup(input: { db: Database }, deps: { clock: Clock }): Promise<{ status: 'complete' }> {
  const now = deps.clock.now().toISOString().slice(0, 19).replace('T', ' ');

  // Seed roles and permissions
  await seedRolesAndPermissions(input.db, now);

  // Assign administrator role to the first user
  const admin = await getFirstUser(input.db);
  if (admin) {
    await assignRole(input.db, admin.id, 'administrator', now);
  }

  // Flip status
  await input.db.prepare(
    'UPDATE installation_state SET status = ?, current_step = ?, updated_at = ? WHERE id = 1'
  ).bind('complete', 'complete', now).run();

  return { status: 'complete' };
}
```

Note: the seeding + role assignment + status flip could be a single D1 batch. But the
seeding generates ~25 statements (20 permissions + 2 roles + 25 role_permissions), which
is a lot. D1 batch has a statement limit. If it fails, split into two batches:
1. seedRolesAndPermissions (idempotent)
2. assignRole + status flip

### Test approach

Worker-pool tests:
1. Call `seedRolesAndPermissions` directly → verify all 20 permissions, 2 roles, 25 role_permissions exist
2. Assign admin role → verify user_roles row exists
3. `checkPermission` for various keys → true/false
4. Setup completion flow (via SELF.fetch POST /complete) → verify roles seeded + admin assigned
5. `requirePermission` middleware: create a test route, verify 401 without userId, 403 without permission

For the middleware test, add a temporary test route in the test setup (not in production code):
```typescript
// In test only — use SELF.fetch with a custom header to simulate auth
```

Or test `checkPermission` directly and trust the middleware to call it correctly.

## Decisions

1. **Deterministic IDs** for permissions (key = id) and roles (name = id). System seed data,
   not domain aggregates. Makes idempotent seeding trivial.
2. **Seeding during setup completion** — when the operator clicks "Complete", the system seeds
   roles/permissions and assigns the admin. This happens before the status flip.
3. **`requirePermission` reads `c.get('userId')`** — set by future auth middleware (CAP-019).
   Without auth, it always returns 401. This is correct — no route uses it until CAP-019.
4. **Admin module introduced** — owns permission/role repositories. Minimal for CAP-017; expands
   with audit events (CAP-026) and admin UI (CAP-025).

## Open questions

(None.)
