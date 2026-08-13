# CAP-026 — Audit events on all state transitions

**Phase:** 1 · **Status:** In Progress

## Goal

Every state transition in the business loop writes an `audit_events` row. The events to cover: `setup.claim`, `setup.complete`, `mailbox.create`, `message.receive`, `message.send`, `webhook.delivered`.

## Scope

- **Audit event repository** (`modules/admin/audit-event-repository.ts`): `createAuditEvent` + `prepareCreateAuditEvent` (for batch inclusion).
- **Emit points** — one audit call added to each of these files:
  - `modules/onboarding/claim-setup.ts` → `setup.claim`
  - `modules/onboarding/complete-setup.ts` → `setup.complete`
  - `http/routes/mailboxes.ts` → `mailbox.create`
  - `entrypoints/inbound-email.ts` → `message.receive`
  - `http/routes/compose.ts` → `message.send`
  - `modules/outbound-mail/webhook-processor.ts` → `webhook.delivered`
- **Tests** — verify audit_events rows exist after each operation.

## audit_events table shape (migration 0001, already exists)

```sql
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  request_id TEXT,
  metadata TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
```

## Emit points

| Action | Resource Type | Resource ID | Actor | File |
|---|---|---|---|---|
| `setup.claim` | `system` | null | null | claim-setup.ts |
| `setup.complete` | `system` | null | first user | complete-setup.ts |
| `mailbox.create` | `mailbox` | mailbox id | userId | mailboxes.ts |
| `message.receive` | `message` | message id | null | inbound-email.ts |
| `message.send` | `message` | message id | userId | compose.ts |
| `webhook.delivered` | `message` | message id or null | null | webhook-processor.ts |

## Files

| Agent | Owns |
|---|---|
| implementer | `apps/worker/src/modules/admin/audit-event-repository.ts` (new) |
| implementer | `apps/worker/src/modules/admin/index.ts` (add exports) |
| implementer | `apps/worker/src/modules/onboarding/claim-setup.ts` (add audit emit) |
| implementer | `apps/worker/src/modules/onboarding/complete-setup.ts` (add audit emit) |
| implementer | `apps/worker/src/http/routes/mailboxes.ts` (add audit emit) |
| implementer | `apps/worker/src/entrypoints/inbound-email.ts` (add audit emit) |
| implementer | `apps/worker/src/http/routes/compose.ts` (add audit emit) |
| implementer | `apps/worker/src/modules/outbound-mail/webhook-processor.ts` (add audit emit) |
| implementer | `apps/worker/src/http/routes/audit-events.worker.test.ts` (new) |

## Acceptance criteria

- [ ] audit_events row written on setup.claim
- [ ] audit_events row written on setup.complete
- [ ] audit_events row written on mailbox.create
- [ ] audit_events row written on message.receive
- [ ] audit_events row written on message.send
- [ ] audit_events row written on webhook.delivered
- [ ] Quality gates pass

## Quality gates

```
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:worker && pnpm build && pnpm scaffold doctor
```
