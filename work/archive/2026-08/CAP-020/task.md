# CAP-020 — Mailbox creation and `mailboxes.assertCan` authorizer

**Phase:** 1 · **Status:** In Progress

## Goal

Authenticated users can create mailboxes on managed domains. The `assertCan(userId, mailboxId, op)` authorizer enforces the mailbox-scoped permission matrix.

## Scope

- **Migration** `0005_mailboxes.sql` — `mailboxes` + `mailbox_members` tables.
- **Tenancy module additions**: mailbox repository (create, findByAddress, findById, listByOwner) + `assertCan` authorizer.
- **`POST /api/v1/mailboxes`** — create mailbox (requires auth + `requirePermission('mailbox.create')`).
- **`GET /api/v1/mailboxes`** — list user's mailboxes (requires auth + `requirePermission('message.read')`).
- **Tests**.

## Migration

```sql
CREATE TABLE IF NOT EXISTS mailboxes (
  id            TEXT PRIMARY KEY,
  domain_id     TEXT NOT NULL REFERENCES managed_domains(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_part    TEXT NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'deleted')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS mailboxes_domain_local_unique ON mailboxes(domain_id, local_part COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS mailboxes_owner_idx ON mailboxes(owner_user_id);

CREATE TABLE IF NOT EXISTS mailbox_members (
  mailbox_id  TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('viewer', 'sender', 'admin')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (mailbox_id, user_id)
);
```

## assertCan authorizer

The authorizer checks the user's relationship to the mailbox (owner, member with specific role, or administrator role) and the operation:

```typescript
type MailboxOp = 'read' | 'send' | 'rename' | 'manage_members' | 'delete_message' | 'delete_mailbox';

export async function assertCan(db: Database, userId: string, mailboxId: string, op: MailboxOp): Promise<void> {
  // 1. Check if user is the owner
  const mailbox = await findMailboxById(db, mailboxId);
  if (!mailbox) throw new DomainError({ code: 'MAILBOX_NOT_FOUND', httpStatus: 404 });
  if (mailbox.ownerUserId === userId) return; // Owner can do everything
  // 2. Check if user has administrator role (global admin bypass)
  const isAdmin = await checkPermission(db, userId, 'role.manage');
  if (isAdmin && op !== 'delete_mailbox' && op !== 'delete_message') return;
  // 3. Check member role
  const member = await findMailboxMember(db, mailboxId, userId);
  if (!member) throw new DomainError({ code: 'MAILBOX_ACCESS_DENIED', httpStatus: 403 });
  // 4. Check permission matrix
  const allowed: Record<string, string[]> = {
    read: ['viewer', 'sender', 'admin'],
    send: ['sender', 'admin'],
  };
  if (allowed[op]?.includes(member.role)) return;
  throw new DomainError({ code: 'MAILBOX_ACCESS_DENIED', httpStatus: 403 });
}
```

## Route handlers

```typescript
// POST /api/v1/mailboxes — create
routes.post('/mailboxes', requirePermission('mailbox.create'), async (c) => {
  const userId = c.get('userId')!;
  const body = createMailboxRequestSchema.parse(await c.req.json());
  const result = await createMailbox({ db: c.env.DB, ...body, ownerUserId: userId }, { clock, ids });
  return c.json({ data: result });
});

// GET /api/v1/mailboxes — list
routes.get('/mailboxes', requirePermission('message.read'), async (c) => {
  const userId = c.get('userId')!;
  const result = await listMailboxes(c.env.DB, userId);
  return c.json({ data: result });
});
```

## Files

| Agent | Owns |
|---|---|
| implementer | `migrations/0005_mailboxes.sql` + verify |
| implementer | `apps/worker/src/database/schema/tenancy.ts` (add mailboxes) |
| implementer | `apps/worker/src/database/schema-version.ts` (→ '0005') |
| implementer | `apps/worker/src/modules/tenancy/mailbox-repository.ts` (new) |
| implementer | `apps/worker/src/modules/tenancy/authorizer.ts` (new — assertCan) |
| implementer | `apps/worker/src/modules/tenancy/index.ts` |
| implementer | `packages/contracts/src/index.ts` (createMailboxRequestSchema) |
| implementer | `packages/contracts/src/index.test.ts` |
| implementer | `packages/test-kit/src/migrationsDb.ts` (add 0005) |
| implementer | `apps/worker/src/http/routes/mailboxes.ts` (new) |
| implementer | `apps/worker/src/http/router.ts` (mount mailboxes routes) |
| implementer | `apps/worker/src/http/routes/mailboxes.worker.test.ts` (new) |

## Acceptance criteria

- [ ] Create mailbox → 200 with `{ id, address, displayName, status }`
- [ ] Owner is implicitly a member (R-MAILBOX-003)
- [ ] Address = `{localPart}@{domain.name}`, unique case-insensitive
- [ ] List returns only user's mailboxes
- [ ] `assertCan` correctly allows/denies per the permission matrix
- [ ] Non-authenticated → 401, non-permitted → 403
- [ ] Quality gates pass

## Quality gates

```
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:worker && pnpm build && pnpm scaffold doctor
```
