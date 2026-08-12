# Domain Map

See `../E-proposed-domain-model.md` for the canonical domain model. This document is a condensed reference.

## Core domains

```text
Identity           ← owning aggregate: User
Tenancy           ← owning aggregate: Mailbox
Messages          ← owning aggregate: Message
Inbound Mail      ← process (no own aggregate)
Outbound Mail     ← owning aggregate: OutboundJob
Administration    ← owning aggregate: SystemSettings
Onboarding        ← owning aggregate: InstallationState
```

## Supporting domains

```text
Attachments       ← entity attached to Message (not an aggregate root)
Signatures        ← entity attached to ManagedDomain (deferred Phase 3)
Audit             ← cross-cutting event log
Provider Sync     ← process that back-fills Messages from provider APIs (deferred Phase 4)
Maintenance       ← process that runs cursor-based backfills (Phase 4)
```

## Subdomains per context

### Identity

```text
User                    (aggregate root)
Session                 (entity under User aggregate)
```

### Tenancy

```text
ManagedDomain           (aggregate root)
Mailbox                 (aggregate root)
MailboxMember           (entity under Mailbox aggregate)
Signature               (entity attached to ManagedDomain — deferred)
```

### Messages

```text
Message                 (aggregate root)
MessageRecipient        (entity under Message aggregate)
MailboxMessage          (entity linking Message ↔ Mailbox)
MessageUserState        (entity per-user read/star/delete)
MessageAttachment       (entity referencing R2 object)
AttachmentUpload        (aggregate root for upload lifecycle)
Draft                   (process — reuses Message with status='draft')
```

### Inbound Mail

```text
(no new aggregates — pure process over Email Routing events)
```

### Outbound Mail

```text
OutboundJob             (aggregate root)
ProviderConnection      (aggregate root)
EncryptedCredential     (entity under ProviderConnection)
WebhookDelivery         (entity for idempotency)
ProviderMessageState    (entity linking provider message id ↔ internal message)
IdempotencyRecord       (cross-cutting entity)
```

### Administration

```text
Role                    (aggregate root)
Permission              (reference data — closed set)
RolePermission          (junction)
UserRole                (junction)
SystemSettings          (singleton)
AuditEvent              (event log)
MaintenanceJob          (process state)
WebhookEvent            (audit log)
```

### Onboarding

```text
InstallationState       (singleton aggregate root)
RegistrationKey         (aggregate root)
```

## What is **not** a domain

- Vuex/Pinia stores are **UI state**, not domain.
- Zustand stores are **UI state**, not domain.
- Component props are **UI structure**, not domain.
- HTTP routes are **delivery**, not domain.

## Boundary rules

1. Aggregates own their consistency boundary.
2. Cross-aggregate operations are use cases.
3. Repositories never expose Drizzle types across module boundaries.
4. Domain types (`packages/contracts/domain/*`) are the **only** types crossing boundaries.
5. Providers expose interfaces in `packages/contracts/`; never import SDKs from `modules/`.