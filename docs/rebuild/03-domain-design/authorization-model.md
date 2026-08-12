# Authorization Model

See `../E-proposed-domain-model.md §E.5` and `../D-major-architectural-problems.md §D.1.4–D.1.6`.

## Two layers

1. **Global permission** — gates routes by `PermissionKey`. Enforced by middleware.
2. **Mailbox authorization** — gates mailbox-scoped actions. Enforced in use cases via `MailboxAuthorizer`.

Both must pass. There is no implicit bypass.

## Permission keys (closed enum)

```text
message.read
message.send
message.delete
mailbox.create
mailbox.manage
mailbox.share
user.read
user.manage
role.read
role.manage
domain.read
domain.manage
signature.read
signature.manage
settings.read
settings.manage
provider.sync
webhook_event.read
webhook_event.delete
analytics.read
```

## System roles (seed)

| Role | Granted permissions |
|---|---|
| `administrator` | all |
| `member` | `message.read`, `message.send`, `message.delete`, `mailbox.create`, `mailbox.manage`, `mailbox.share` |

The first administrator is created by the setup wizard. The default `member` role is created by the initial migration.

## Mailbox operations

| Operation | Owner | viewer | sender | admin |
|---|:---:|:---:|:---:|:---:|
| read | ✓ | ✓ | ✓ | ✓ |
| send | ✓ | ✗ | ✓ | ✓ |
| rename | ✓ | ✗ | ✗ | ✓ |
| manage_members | ✓ | ✗ | ✗ | ✓ |
| delete_message | ✓ | ✗ | ✗ | ✗ |
| delete_mailbox | ✓ | ✗ | ✗ | ✗ |

## Enforcement code (sketch)

```typescript
async function sendMessage(
  ctx: AppContext,
  principal: Principal,
  input: SendMessageInput,
): Promise<...> {
  // Global layer: requires message.send permission
  await assertPermission(ctx, principal, 'message.send')

  // Mailbox layer: requires 'send' operation on this mailbox
  await ctx.mailboxes.assertCan(principal.userId, input.mailboxId, 'send')

  // ... rest of use case
}
```

## Comparison to legacy

| Legacy | New |
|---|---|
| Prefix-matched routes (`/email/send` covers `/email/sendXYZ`) | Exact route matching (`POST /api/v1/messages/send`) |
| Hardcoded `requirePerms[]` list + `premKey` table (two sources) | Single source: `RolePermission` table → `PermissionKey` → exact route |
| Admin bypass by hardcoded email list | Admin = user with `administrator` role |
| Stale KV snapshot (`authInfo.user` frozen at login) | DB lookup on every request; cache TTL ≤ 5 min |
| Perm-key string with typo (`seting:clear`) | Canonical enum, no free strings |

## Where authorization is checked

- **Route entry**: `requirePermission(key)` middleware.
- **Use case entry**: `mailboxes.assertCan(userId, mailboxId, op)`.
- **Repository entry**: no authorization. Repositories are trusted.
- **Service helpers**: no authorization. They are pure.

Authorization is **always** at the use-case boundary, not in repositories or services.

## Where authorization is **not** checked

- `AttachmentRepository` does not check "can this user read this attachment?". The use case does.
- `MessageRepository.findById` does not check "can this user see this message?". The use case does.
- `WebhookDeliveryRepository.claim` does not check "is this webhook from a valid provider?". The route handler does.

This keeps repositories thin and testable.