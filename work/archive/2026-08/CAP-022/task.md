# CAP-022 — Inbox list + read message; isRead persists per user

**Phase:** 1 · **Status:** In Progress

## Goal

An authenticated user can list messages in a mailbox they have access to, read a single message with its recipients, and mark a message as read. The `isRead` state persists per user (R-MESSAGE-005).

## Scope

- **Message read repository** (`modules/messages/message-read-repository.ts`): `listMessagesByMailbox`, `getMessageDetail`, `markMessageAsRead`.
- **Routes** (`http/routes/messages.ts`): `GET /api/v1/mailboxes/:mailboxId/messages` (list with cursor), `GET /api/v1/mailboxes/:mailboxId/messages/:messageId` (detail), `PATCH /api/v1/mailboxes/:mailboxId/messages/:messageId/read` (mark read).
- **Contracts** (`packages/contracts/src/index.ts`): response schemas for message list item and message detail.
- **Router** (`http/router.ts`): mount message routes.
- **Tests** (`http/routes/messages.worker.test.ts`): list, detail, mark-read, authz (owner allowed, viewer read-only, IDOR blocked).

## Authorization pattern

Two layers, both must pass (R-AUTHZ-003):
1. Global: `requirePermission('message.read')` on every route.
2. Mailbox-scoped: `assertCan(db, userId, mailboxId, 'read')` in the handler.

For `assertCan`, pass `isAdmin = await checkPermission(db, userId, 'role.manage')` so administrators get the admin bypass.

## Cursor pagination

Phase 1 uses a simple base64 cursor encoding `(created_at, id)`. HMAC signing is CAP-034 (Phase 2). The cursor is opaque to the client. Query:

```sql
SELECT m.*, mm.is_read, mm.is_starred, mm.folder
FROM mailbox_messages mm
JOIN messages m ON mm.message_id = m.id
WHERE mm.mailbox_id = ?
  AND (? IS NULL OR (m.created_at < ? OR (m.created_at = ? AND m.id < ?)))
ORDER BY m.created_at DESC, m.id DESC
LIMIT ?
```

Response: `{ data: { items: [...], nextCursor: string | null } }`.

## Files

| Agent | Owns |
|---|---|
| implementer | `apps/worker/src/modules/messages/message-read-repository.ts` (new) |
| implementer | `apps/worker/src/modules/messages/index.ts` (add exports) |
| implementer | `apps/worker/src/http/routes/messages.ts` (new) |
| implementer | `apps/worker/src/http/router.ts` (mount message routes) |
| implementer | `packages/contracts/src/index.ts` (message response schemas) |
| implementer | `packages/contracts/src/index.test.ts` (schema tests) |
| implementer | `apps/worker/src/http/routes/messages.worker.test.ts` (new) |

## Acceptance criteria

- [ ] GET list returns messages in a mailbox the user owns, cursor-paginated, newest first
- [ ] GET detail returns message with from, subject, bodies, recipients
- [ ] PATCH read marks message as read for the requesting user (per-user state)
- [ ] isRead persists per user — user A marking read does not affect user B
- [ ] IDOR: user cannot read another user's mailbox by ID (assertCan blocks)
- [ ] Viewer role can read but the mailbox owner can also read
- [ ] Empty mailbox → `{ items: [], nextCursor: null }`
- [ ] Cursor pagination works across page boundary
- [ ] Quality gates pass

## Quality gates

```
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:worker && pnpm build && pnpm scaffold doctor
```
