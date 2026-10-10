# Aggregates

See `../E-proposed-domain-model.md §E.3` for full entity definitions.

## Aggregate root inventory

| Aggregate root | Owning context | Lifecycle | Repository |
|---|---|---|---|
| `User` | Identity | Active → Suspended → Deleted | `UserRepository` |
| `Session` | Identity | Active → Expired → Revoked | `SessionRepository` |
| `InstallationState` | Onboarding | Pending → In progress → Complete | `InstallationRepository` |
| `RegistrationKey` | Onboarding | Active → Exhausted / Revoked / Expired | `RegistrationKeyRepository` |
| `ManagedDomain` | Tenancy | Active → Disabled | `DomainRepository` |
| `Mailbox` | Tenancy | Active → Disabled → Deleted | `MailboxRepository` |
| `MailboxMember` (under Mailbox) | Tenancy | Active → Removed | (via MailboxRepository) |
| `Message` | Messages | draft → queued → sending → sent → delivered (or terminal) | `MessageRepository` |
| `MessageRecipient` (under Message) | Messages | (no FSM) | (via MessageRepository) |
| `MailboxMessage` | Messages | Active → Trashed | `MailboxMessageRepository` |
| `MessageUserState` (under MailboxMessage) | Messages | Unread → Read; Star/Unstar | `MessageUserStateRepository` |
| `MessageAttachment` (under Message) | Messages | (no FSM) | (via MessageRepository) |
| `AttachmentUpload` | Attachments | Pending → Uploaded → Consumed/Expired | `AttachmentUploadRepository` |
| `OutboundJob` | Outbound Mail | Pending → Enqueued → Processing → Succeeded/Failed | `OutboundJobRepository` |
| `ProviderConnection` | Outbound Mail | Active → Disabled / Invalid | `ProviderConnectionRepository` |
| `WebhookDelivery` | Outbound Mail | Processing → Succeeded / Ignored / Failed | `WebhookDeliveryRepository` |
| `Role` | Administration | Active → Removed | `RoleRepository` |
| `MaintenanceJob` | Administration | Pending → Running → Completed / Failed | `MaintenanceRepository` |

## Aggregate consistency rules

1. **All writes within an aggregate are one D1 batch.** If a batch partially fails, the entire transaction rolls back.
2. **Cross-aggregate writes are sequenced** via use cases. Use cases own the orchestration; they may use multiple D1 batches if needed, but each batch must be independently consistent.
3. **Optimistic concurrency on state transitions** is enforced via `updated_at` (or `state_version` for installation).
4. **Aggregate identity is a UUID v4 string.** No integer IDs cross the public API.
5. **Soft delete is a state, not a separate aggregate.** `deleted_at` is set; the aggregate is hidden from default reads.

## Aggregate size guidelines

| Aggregate | Max entities | Reason |
|---|---|---|
| `Message` | Message + Recipients + Attachments + MailboxMessages + UserStates | Single send transaction |
| `Mailbox` | Mailbox + Members | Single share/rename transaction |
| `User` | User + default role | Single register transaction |

There is **no** aggregate that exceeds ~20 entities. Anything larger must be split.

## When an aggregate is NOT a thing

Some concepts look like aggregates but are not:

- **Draft** is a Message in `status='draft'` state. It is **not** a separate aggregate.
- **Star** is `message_user_state.is_starred`. It is **not** an aggregate.
- **Webhook Event** (audit) is a row in `webhook_events` for observability. It is **not** an aggregate root.
- **Audit Event** is a row in `audit_events` for observability. It is **not** an aggregate root.
- **Idempotency Record** is a row in `idempotency_records` for replay safety. It is **not** an aggregate root.

These are entities inside the aggregates that own them, or pure event-log records.