# Module Boundaries

## Public surface per module

Every module exposes a single `index.ts` that re-exports the module's public types and use cases. Internal layout is private.

```typescript
// modules/messages/index.ts
export { SendMessage } from './application/send-message'
export { ListInbox, ListSent, ListDrafts, ListStarred, ListTrash, ListArchive } from './application/list-messages'
export { ReadMessage } from './application/read-message'
export { MarkRead, MarkUnread } from './application/mark-read'
export { DeleteMessage } from './application/delete-message'
export type { Message, MessageId, MessageStatus, MailboxMessage, MessageRecipient, MessageUserState } from './domain/types'
export { MessageRepository } from './infrastructure/message-repository'
export { MailboxMessageRepository } from './infrastructure/mailbox-message-repository'
```

No internal file is reachable from outside the module.

## Cross-module allowed calls

| From | To | Allowed? | How |
|---|---|:---:|---|
| `http/routes/*` | `modules/*/application/*` | ✓ | direct import |
| `modules/messages` | `modules/tenancy` | ✓ | interface from `contracts/` |
| `modules/outbound` | `modules/messages` | ✓ | use case interface |
| `modules/outbound` | `modules/tenancy` | ✓ | use case interface |
| `modules/inbound` | `modules/tenancy` | ✓ | use case interface |
| `modules/inbound` | `modules/messages` | ✓ | use case interface |
| `modules/messages` | `modules/inbound` | ✗ | reverse direction |
| `modules/messages` | `modules/outbound` | ✗ | reverse direction |
| `modules/admin` | `modules/messages` | ✓ | read-only via query |
| `modules/*` | `integrations/*` | ✓ | via `ProviderRegistry` interface |
| `integrations/*` | `modules/*` | ✗ | reverse direction |

## Composition root

```typescript
// src/app-context.ts
export function buildAppContext(env: Env, ctx: ExecutionContext): AppContext {
  // ...
  return {
    // Platform
    db, objectStore, cache, clock, ids, logger,
    // Identity
    users: new UserRepository(db),
    sessions: new SessionRepository(db, cache),
    // Tenancy
    mailboxes: new MailboxRepository(db),
    domains: new DomainRepository(db),
    signatures: new SignatureRepository(db),
    // Messages
    messages: new MessageRepository(db),
    mailboxMessages: new MailboxMessageRepository(db),
    messageUserState: new MessageUserStateRepository(db),
    // Attachments
    attachments: new AttachmentRepository(db, objectStore),
    uploads: new AttachmentUploadRepository(db),
    // Outbound
    outboundJobs: new OutboundJobRepository(db),
    providerConnections: new ProviderConnectionRepository(db),
    credentials: new EncryptedCredentialStore(env, db, cache),
    webhookDeliveries: new WebhookDeliveryRepository(db),
    providerMessageState: new ProviderMessageStateRepository(db),
    // Admin
    installation: new InstallationRepository(db, cache),
    keys: new RegistrationKeyRepository(db),
    roles: new RoleRepository(db),
    permissions: new PermissionRepository(db),
    audit: new AuditRepository(db),
    settings: new SystemSettingsRepository(db),
    maintenance: new MaintenanceRepository(db),
    // Integrations
    providers: buildProviderRegistry(),
  }
}
```

## Module dependency table

| Module | Depends on |
|---|---|
| `identity` | `platform/*`, `contracts/*` |
| `onboarding` | `identity`, `platform/*`, `contracts/*` |
| `tenancy` | `identity`, `platform/*`, `contracts/*` |
| `messages` | `tenancy`, `platform/*`, `contracts/*` |
| `inbound-mail` | `tenancy`, `messages`, `platform/*`, `contracts/*`, `email-core/*` |
| `outbound-mail` | `tenancy`, `messages`, `integrations/providers/*`, `platform/*`, `contracts/*`, `email-core/*` |
| `provider-sync` | `messages`, `integrations/providers/*`, `platform/*`, `contracts/*` |
| `attachments` | `messages`, `tenancy`, `platform/*`, `contracts/*` |
| `signatures` | `tenancy`, `platform/*`, `contracts/*` |
| `admin` | `identity`, `tenancy`, `messages`, `outbound-mail`, `platform/*`, `contracts/*` |
| `installation` | `identity`, `tenancy`, `admin`, `platform/*`, `contracts/*` |
| `maintenance` | `messages`, `tenancy`, `attachments`, `platform/*`, `contracts/*` |

**No cycles.** Each module's dependencies are unidirectional.