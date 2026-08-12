# E. Proposed Domain Model

This is **not** a faithful copy of the legacy schema. It is a redesign driven by the business facts extracted in §B, the value stream in §C, and the architectural problems in §D.

## E.1 Bounded contexts

The system is one product with six bounded contexts. They are not separate services; they are **modules** inside one modular-monolith Worker.

```text
Identity              ─ manages the people who log in
Onboarding            ─ manages first-run setup and invitation
Tenancy               ─ manages domains, mailboxes, members
Messages              ─ manages canonical message graph + folders
Inbound Mail          ─ manages the receive pipeline
Outbound Mail         ─ manages the send pipeline
Administration        ─ manages settings, roles, audit, integrations
```

Some legacy concepts cross contexts; we assign each to one.

## E.2 Context map

```text
Identity ◀──▶ Tenancy (user is owner of mailbox)
Identity ◀──▶ Administration (user has roles)
Onboarding ─▶ Identity (first admin)
Onboarding ─▶ Tenancy (managed domain claim)
Tenancy ◀──▶ Inbound Mail (mailbox lookup)
Tenancy ◀──▶ Outbound Mail (sender mailbox check)
Inbound Mail ─▶ Messages (store canonical message)
Outbound Mail ─▶ Messages (compose + track)
Messages ─▶ Inbound Mail (reply threading lookup)
Administration ─▶ all (system settings)
```

## E.3 Domain types

### E.3.1 Identity context

#### `User`

```typescript
interface User {
  id: UserId                      // UUID v4
  email: EmailAddress             // normalized lowercase, unique
  passwordHash: PasswordHash      // PBKDF2-SHA256, ≥600k iterations
  passwordSalt: Bytes             // ≥16 bytes
  passwordAlgorithm: string       // 'pbkdf2-sha256'
  passwordIterations: number      // 600_000
  status: 'active' | 'suspended' | 'deleted'
  displayName: string
  createdAt: DateTime
  updatedAt: DateTime
  deletedAt: DateTime | null
}
```

**Aggregate root:** User. Repository owns user + session lifecycle.

**Invariants:**
- `email` is unique case-insensitively
- `passwordHash` is never returned through any API
- `status='deleted'` is irreversible; soft delete only

#### `Session`

```typescript
interface Session {
  id: SessionId                   // UUID v4
  userId: UserId
  refreshTokenHash: Bytes         // SHA-256 of refresh token
  expiresAt: DateTime
  revokedAt: DateTime | null
  ipAddress: string | null
  userAgent: string | null
  createdAt: DateTime
}
```

**Invariants:**
- Refresh tokens are stored only as SHA-256 hash
- `expiresAt` ≤ 30 days from `createdAt`
- Rotated on every refresh
- Revoked on logout, password change, suspension

### E.3.2 Onboarding context

#### `InstallationState`

```typescript
interface InstallationState {
  id: 1                           // singleton row
  installationVersion: number      // increments on schema upgrade
  stateVersion: number            // optimistic-concurrency token
  status: 'pending' | 'in_progress' | 'complete'
  currentStep: InstallationStep
  completedSteps: InstallationStep[]
  cloudflareAccountId: string | null
  cloudflareZoneId: string | null
  cloudflareCredentialId: string | null
  claimedAt: DateTime | null
  completedAt: DateTime | null
  updatedAt: DateTime
}

type InstallationStep =
  | 'claim'
  | 'preflight'
  | 'administrator'
  | 'cloudflare'
  | 'domain'
  | 'inbound_smoke_test'
  | 'brevo'
  | 'outbound_smoke_test'
  | 'complete'
```

**Invariants:**
- Steps advance only in declared order
- `stateVersion` increments on every transition
- A second setup session cannot advance the same step concurrently (CAS on `stateVersion`)
- Setup routes are gated after `status='complete'`

#### `RegistrationKey`

```typescript
interface RegistrationKey {
  id: RegistrationKeyId           // UUID v4
  codeHash: Bytes                 // SHA-256(code + server pepper)
  roleId: RoleId | null
  maxUses: number
  usedCount: number
  expiresAt: DateTime | null
  revokedAt: DateTime | null
  createdByUserId: UserId
  createdAt: DateTime
}
```

### E.3.3 Tenancy context

#### `ManagedDomain`

```typescript
interface ManagedDomain {
  id: DomainId                    // UUID v4
  name: DomainName                // unique, case-insensitive
  status: 'active' | 'disabled'
  outboundConnectionId: ProviderConnectionId | null
  createdAt: DateTime
  updatedAt: DateTime
}
```

**Invariants:**
- `name` is unique case-insensitively
- A disabled domain cannot create new mailboxes or send

#### `Signature`

```typescript
interface Signature {
  id: SignatureId
  domainId: DomainId              // one per domain
  htmlContent: string             // sanitized
  textContent: string
  isEnabled: boolean
  createdAt: DateTime
  updatedAt: DateTime
}
```

#### `Mailbox`

```typescript
interface Mailbox {
  id: MailboxId                   // UUID v4
  domainId: DomainId
  ownerUserId: UserId             // owner is a single user; not a relationship column
  address: EmailAddress           // unique case-insensitive
  displayName: string
  status: 'active' | 'disabled' | 'deleted'
  createdAt: DateTime
  updatedAt: DateTime
  deletedAt: DateTime | null
}
```

**Aggregate root:** Mailbox. Owner is a single FK. Members live in a separate junction table.

#### `MailboxMember`

```typescript
interface MailboxMember {
  mailboxId: MailboxId
  userId: UserId
  role: 'viewer' | 'sender' | 'admin'
  createdAt: DateTime
  updatedAt: DateTime
}
```

**Authorization matrix:**

| Operation | owner | viewer | sender | admin |
|---|:---:|:---:|:---:|:---:|
| read | ✓ | ✓ | ✓ | ✓ |
| send | ✓ | ✗ | ✓ | ✓ |
| rename | ✓ | ✗ | ✗ | ✓ |
| manage members | ✓ | ✗ | ✗ | ✓ |
| delete message | ✓ | ✗ | ✗ | ✗ |
| delete mailbox | ✓ | ✗ | ✗ | ✗ |

### E.3.4 Messages context

#### `Message` (canonical)

```typescript
interface Message {
  id: MessageId                   // UUID v4
  threadId: ThreadId | null
  fromAddress: EmailAddress
  fromName: string
  subject: string
  htmlBody: string
  textBody: string
  messageIdHeader: string | null  // RFC 5322 Message-ID
  inReplyToHeader: string | null
  referencesHeader: string        // RFC 5322 References
  status: MessageStatus
  errorCode: string | null
  errorMessage: string | null
  rawObjectKey: string | null     // R2 path for original MIME (POP3 use)
  createdByUserId: UserId | null  // null for inbound
  receivedAt: DateTime | null
  sentAt: DateTime | null
  createdAt: DateTime
  updatedAt: DateTime
}

type MessageStatus =
  | 'draft'
  | 'queued'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'delayed'
  | 'bounced'
  | 'complained'
  | 'failed'
  | 'received'
```

**Why split `Message` from `Email`:** the legacy `email` table held type, status, recipient, sender, attachments, soft-delete, and provider metadata in one row. The split is:

- `Message`: canonical content (From, subject, body, threading, status)
- `MessageRecipient`: TO/CC/BCC separately
- `MailboxMessage`: which mailbox sees this message, in which folder, with which per-user read/star/delete state
- `MessageAttachment`: metadata (filename, mime, size, disposition, contentId)
- `OutboundJob`: delivery state, durable outbox

#### `MessageRecipient`

```typescript
interface MessageRecipient {
  id: MessageRecipientId
  messageId: MessageId
  type: 'to' | 'cc' | 'bcc'
  address: EmailAddress
  displayName: string
}
```

#### `MailboxMessage`

```typescript
interface MailboxMessage {
  id: MailboxMessageId
  mailboxId: MailboxId
  messageId: MessageId
  folder: 'inbox' | 'sent' | 'drafts' | 'archive' | 'trash'
  createdAt: DateTime
}
```

Unique constraint on `(mailboxId, messageId, folder)`.

#### `MessageUserState`

```typescript
interface MessageUserState {
  mailboxMessageId: MailboxMessageId
  userId: UserId
  isRead: boolean
  isStarred: boolean
  deletedAt: DateTime | null
  updatedAt: DateTime
}
```

**Why per-user state:** a shared mailbox can have multiple members with different read/star state. The legacy code uses `email.unread` (boolean) on the canonical row, which conflates mailbox-level and user-level read state. **Per-user state is the right granularity.**

#### `MessageAttachment`

```typescript
interface MessageAttachment {
  id: MessageAttachmentId
  messageId: MessageId
  uploadId: AttachmentUploadId | null
  objectKey: string               // R2 path: attachments/{uuid}.{ext}
  filename: string | null
  mimeType: string
  sizeBytes: number
  disposition: 'attachment' | 'inline'
  contentId: string | null        // for inline images
  sha256: string | null
  createdAt: DateTime
}
```

#### `AttachmentUpload`

```typescript
interface AttachmentUpload {
  id: AttachmentUploadId          // UUID v4
  userId: UserId                  // owner of the upload slot
  objectKey: string               // randomly generated
  filename: string
  mimeType: string
  sizeBytes: number
  disposition: 'attachment' | 'inline'
  status: 'pending' | 'uploaded' | 'consumed' | 'expired'
  expiresAt: DateTime
  consumedAt: DateTime | null
  createdAt: DateTime
}
```

Triggers:

```sql
-- BEFORE INSERT on message_attachments:
--   verify upload_id belongs to message.created_by_user_id,
--   upload.status = 'uploaded',
--   upload.expires_at > CURRENT_TIMESTAMP,
--   upload.object_key = NEW.object_key,
--   upload.size_bytes = NEW.size_bytes.
--   If any check fails: ABORT 'invalid attachment upload'.

-- AFTER INSERT on message_attachments:
--   UPDATE attachment_uploads SET status = 'consumed' WHERE id = NEW.upload_id.
```

### E.3.5 Inbound Mail context

No new entity. Inbound mail **is** a transition that creates `Message`, `MessageRecipient`, `MailboxMessage`, `MessageAttachment` rows. The pipeline:

```
Email Routing event
   → read raw bytes once (ArrayBuffer)
   → parse MIME (PostalMime)
   → apply blocklists (subject, from, content)
   → resolve recipient mailbox (Tenancy)
   → upload raw message + attachments to R2
   → in one D1 batch:
        insert Message (status='received', receivedAt=now)
        insert MessageRecipient (per to/cc/bcc)
        insert MessageAttachment (per attachment)
        insert MailboxMessage for each mailbox reached
        seed MessageUserState lazily on first read
   → emit audit event
   → schedule notification job (Phase 5)
```

**Invariants:**

- Raw bytes are read once; never re-decoded from chunks.
- Recipient mailbox is resolved by Tenancy context (managed-domain + mailbox address).
- Unknown recipient policy: `reject` (Email Routing rejects upstream) or `store` (saved with status='received' but no MailboxMessage row).
- Blocklist is configured at system level (Administration context).

### E.3.6 Outbound Mail context

#### `OutboundJob`

```typescript
interface OutboundJob {
  id: OutboundJobId               // UUID v4
  messageId: MessageId            // UNIQUE — one job per message
  status: 'pending' | 'enqueued' | 'processing' | 'succeeded' | 'failed'
  attempts: number
  availableAt: DateTime           // for backoff
  lockToken: string | null
  lockExpiresAt: number | null    // Unix epoch ms
  lastError: string | null
  createdAt: DateTime
  updatedAt: DateTime
  completedAt: DateTime | null
}
```

Index: `(status, availableAt)` for the dispatch recovery cron.

**Why this exists:** legacy `email.status = SAVING/QUEUED/SENDING/...` plus inline provider call from the request handler. New design: the request handler enqueues an `OutboundJob` and returns `queued`. A queue consumer (Worker queue entrypoint) processes jobs through the provider. Failures are recovered by a scheduled dispatcher.

#### `ProviderConnection`

```typescript
interface ProviderConnection {
  id: ProviderConnectionId        // UUID v4
  providerKey: ProviderKey        // 'brevo' | 'resend' | 'cf-sendmail' | ...
  label: string                   // human-friendly name
  credentialId: EncryptedCredentialId
  status: 'active' | 'disabled' | 'invalid'
  configJson: Record<string, unknown>
  lastHealthCheckAt: DateTime | null
  lastHealthError: string | null
  createdAt: DateTime
  updatedAt: DateTime
}
```

#### `EncryptedCredential`

```typescript
interface EncryptedCredential {
  id: EncryptedCredentialId
  encryptedPayload: Bytes         // AES-GCM ciphertext
  encryptionVersion: number       // 1
  createdAt: DateTime
  updatedAt: DateTime
}
```

#### `OutboundProviderAdapter` (interface, not entity)

```typescript
interface OutboundProviderAdapter {
  readonly key: ProviderKey
  validateConnection(ctx: ProviderRuntimeContext): Promise<void>
  send(ctx: ProviderRuntimeContext, msg: SendProviderMessage): Promise<ProviderSendResult>
}
```

#### `WebhookProviderAdapter`

```typescript
interface WebhookProviderAdapter {
  readonly key: ProviderKey
  verifyWebhook(req: ProviderWebhookRequest, ctx: ProviderRuntimeContext): Promise<ProviderEvent>
}
```

#### `WebhookDelivery` (idempotency layer)

```typescript
interface WebhookDelivery {
  providerConnectionId: ProviderConnectionId
  providerKey: ProviderKey
  eventKey: string                // deterministic per-event ID
  eventTime: number               // Unix ms
  processingStatus: 'processing' | 'succeeded' | 'ignored' | 'failed'
  attempts: number
  lockToken: string | null
  lockExpiresAt: number | null
  errorMessage: string | null
  createdAt: DateTime
  updatedAt: DateTime
}
```

Primary key: `(providerConnectionId, eventKey)`.

#### `ProviderMessageState`

```typescript
interface ProviderMessageState {
  providerConnectionId: ProviderConnectionId
  providerKey: ProviderKey
  providerMessageId: string
  messageId: MessageId | null    // nullable until import
  statusEventTime: number | null
  statusRank: number              // 0..N per `statusRank` map
  importLockToken: string | null
  importLockExpiresAt: number | null
  updatedAt: DateTime
}
```

#### `IdempotencyRecord`

```typescript
interface IdempotencyRecord {
  id: IdempotencyRecordId
  actorUserId: UserId
  operation: string               // e.g. 'message.send'
  idempotencyKey: string
  requestHash: string
  resourceId: string | null
  responseStatus: number
  responseJson: string
  expiresAt: DateTime
  createdAt: DateTime
}

UNIQUE (actorUserId, operation, idempotencyKey)
```

### E.3.7 Administration context

#### `Role`, `Permission`, `RolePermission`, `UserRole`

```typescript
interface Role {
  id: RoleId
  name: string
  description: string
  isSystem: boolean
  createdAt: DateTime
  updatedAt: DateTime
}

interface Permission {
  key: PermissionKey              // PRIMARY KEY
  description: string
}

interface RolePermission {
  roleId: RoleId
  permissionKey: PermissionKey
}

interface UserRole {
  userId: UserId
  roleId: RoleId
}
```

**Permission keys (closed enum):**

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

Two system roles seed:

- `administrator` — all keys
- `member` — `message.read`, `message.send`, `message.delete`, `mailbox.create`, `mailbox.manage`, `mailbox.share`

#### `SystemSettings`

```typescript
interface SystemSettings {
  id: 1                           // singleton
  siteTitle: string
  registrationEnabled: boolean
  inviteRequired: boolean
  inboundEnabled: boolean
  outboundEnabled: boolean
  unknownRecipientPolicy: 'reject' | 'store'
  maxMailboxesPerUser: number     // 10
  maxAttachmentsPerMessage: number // 10
  maxAttachmentBytes: number      // 64 MiB
  senderBlocklistJson: string[]   // JSON array
  subjectBlocklistJson: string[]
  contentBlocklistJson: string[]
  createdAt: DateTime
  updatedAt: DateTime
}
```

**Note:** `senderBlocklistJson`, `subjectBlocklistJson`, `contentBlocklistJson` are kept as JSON for now (a future phase may normalize them into a `BlocklistEntry` table).

#### `AuditEvent`

```typescript
interface AuditEvent {
  id: AuditEventId
  actorUserId: UserId | null
  action: string                  // e.g. 'mailbox.create', 'message.send'
  resourceType: string
  resourceId: string | null
  requestId: string
  ipAddress: string | null
  metadataJson: Record<string, unknown>
  createdAt: DateTime
}
```

Index: `(resourceType, resourceId, createdAt DESC)` and `(actorUserId, createdAt DESC)`.

#### `MaintenanceJob`

```typescript
interface MaintenanceJob {
  id: MaintenanceJobId
  jobKey: string                  // UNIQUE — registered handler key
  migrationName: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  cursorJson: Record<string, unknown>
  attempts: number
  lockToken: string | null
  lockExpiresAt: number | null
  lastError: string | null
  createdAt: DateTime
  updatedAt: DateTime
  completedAt: DateTime | null
}
```

## E.4 State machines

### E.4.1 Message status

```text
                       ┌─────────────────────────────────────────┐
                       │                                         │
                       ▼                                         │
              ┌──────────────┐                                  │
              │    draft     │                                  │
              └──────┬───────┘                                  │
                     │                                          │
                     │ send()                                   │
                     ▼                                          │
              ┌──────────────┐                                  │
              │    queued    │                                  │
              └──────┬───────┘                                  │
                     │                                          │
                     │ consumer claim                           │
                     ▼                                          │
              ┌──────────────┐                                  │
              │   sending    │                                  │
              └──────┬───────┘                                  │
                     │                                          │
        ┌────────────┼─────────────┬─────────────┐             │
        │            │             │             │             │
        │            │             │             │             │
        ▼            ▼             ▼             ▼             ▼
   ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐   ┌─────────┐
   │  sent   │  │ delayed │  │ failed  │  │ bounced │   │complained│
   └────┬────┘  └────┬────┘  └─────────┘  └─────────┘   └─────────┘
        │            │
        │ webhook    │ retry
        ▼            ▼
   ┌──────────┐  (loop back to queued)
   │ delivered│
   └──────────┘
```

Webhook status rank (higher = newer wins on tie):

```text
draft:      0
queued:    10
sending:   20
sent:      30
delayed:   40
delivered: 50
bounced:   60
failed:    60
complained:70
received: 100
```

**Invariants:**

- `received` is only set by the inbound pipeline; never by an outbound event.
- `draft → queued` is the only path from draft to sent.
- `failed` is terminal; re-send creates a new draft.
- Webhook status is applied only if `eventTime` is newer OR `(eventTime == stored AND newRank >= storedRank)`.

### E.4.2 OutboundJob status

```text
            ┌─────────┐
            │ pending │
            └────┬────┘
                 │ dispatch
                 ▼
            ┌─────────┐
            │enqueued │
            └────┬────┘
                 │ consumer claim
                 ▼
            ┌─────────┐
            │processing│
            └────┬────┘
                 │
       ┌─────────┼─────────┐
       │         │         │
       ▼         ▼         ▼
   succeeded  failed    (lock expired)
       │         │         │
       │         │         └──→ back to pending (next scheduled dispatch)
       │         │
       ▼         ▼ (after attempt limit)
      done    failed (terminal)
```

### E.4.3 User status

```text
  ┌────────┐
  │ active │
  └───┬────┘
      │
      ├──admin action──▶ suspended
      │                       │
      │                       ├──admin action──▶ active (restored)
      │                       │
      │                       └──user action──▶ (logout forced)
      │
      └──user action──▶ deleted (irreversible)
```

### E.4.4 Mailbox status

```text
  ┌────────┐
  │ active │
  └───┬────┘
      │
      ├──admin──▶ disabled
      │              │
      │              └──admin──▶ active (re-enabled)
      │
      └──owner──▶ deleted (cascade: messages, attachments)
```

### E.4.5 Installation status

Strictly ordered (re-entry allowed if `stateVersion` unchanged):

```text
claim → preflight → administrator → cloudflare → domain
     → inbound_smoke_test → brevo → outbound_smoke_test → complete
```

## E.5 Authorization policy

Two layers:

1. **Global permission** (`RolePermission`) — gates routes by `PermissionKey`.
2. **Mailbox authorization** (`MailboxMember.role`) — gates mailbox-scoped actions.

Both must pass. Authorization is computed at use-case entry, never in repository methods. Authorization results are not cached longer than the request.

```typescript
class MailboxAuthorizer {
  async assertCan(actor: UserId, mailboxId: MailboxId, op: MailboxOperation): Promise<void>
}

async function sendMessage(ctx: AppContext, actor: UserId, input: SendMessageInput): Promise<...> {
  await assertPermission(ctx, actor, 'message.send')
  await ctx.mailboxes.assertCan(actor, input.mailboxId, 'send')
  // ... rest of use case
}
```

## E.6 Source-of-truth table

| Data | Source of Truth | Why |
|---|---|---|
| Identity (password hash, sessions) | Local D1 + KV | Self-contained |
| Mailbox membership | Local D1 | Self-contained |
| Message canonical content | Local D1 | Self-contained |
| Message delivery status | Local D1 | Aggregated from provider events |
| Provider credentials | Encrypted in D1 + Secrets Store binding | Encryption keys never leave Cloudflare |
| Raw MIME | R2 | Object storage |
| Attachment bytes | R2 | Object storage |
| Webhook idempotency | Local D1 | Required for correctness |
| Outbound jobs | Local D1 + Worker Queue | Durable outbox pattern |
| Analysis cache | Local D1 + KV cache | Read-side optimization |
| OAuth state | KV (short TTL) | One-time consumption |
| Setup session | KV (short TTL) | One-time consumption |

## E.7 What we explicitly **do not** model

These appear in the legacy system but are **not** part of the business domain:

- **Starred/Read/Deleted as separate entities** — they are **state on** `MailboxMessage` + `MessageUserState`.
- **Forwarding rule as a stored entity** — deferred. The legacy `forwardEmail` + `ruleEmail` is **deferred** to Phase 5.
- **Telegram binding as an entity** — deferred. The legacy `tg_bot_token` + `tg_chat_id` is **deferred** to Phase 5.
- **AI policy as an entity** — deferred. The legacy `aiCode` + `aiCodeFilter` is **deferred** to Phase 5.
- **S3 backend configuration** — deferred. R2-only for the rebuild.
- **OAuth provider entities** — deferred. The legacy LinuxDo OAuth is **removed** in the rebuild (the spec allows but does not require it).
- **Turnstile / captcha** — deferred. The first release disables public registration; admins create users directly.
- **Login background, opacity, notice copy** — UI state, lives in `SystemSettings` as plain text fields.
- **Public admin API** — removed.
- **`/test` route** — removed.
