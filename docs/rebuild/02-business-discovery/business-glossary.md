# Business Glossary

Historical discovery vocabulary and role analysis. Current account creation,
mailbox grants and delivery behavior follow the [business rules](business-rules.md)
and [capability ledger](../capability-ledger.md#current-state). Retained invite,
transport and legacy-field descriptions are not deployment prerequisites.


This is the canonical vocabulary for the rebuild. Every term is defined as the **business concept**, not as the legacy code's variable or table name. Conflicts with the legacy vocabulary are flagged.

## Actors

| Term | Definition | Legacy mapping | Conflicts |
|---|---|---|---|
| **Operator** | The person who installs Unimailbox, owns the deployment, configures providers, and is the first administrator. | `setting.admin` (env var) | None |
| **Administrator** | A user with the `administrator` role. Manages users, roles, domains, settings. | `user.type=0` historically | Legacy has no `type=0` enum value; admin is granted by email-list bypass |
| **Member** | A user with the `member` role. Default role for invited users. | `role.name='普通用户'` / `role_id=1` | None |
| **Invitee** | A user who has not yet registered but holds a registration key. | `reg_key` row with `used_count < max_uses` | None |
| **External sender** | A person or system outside the deployment that sends mail to a managed mailbox. | (anyone not in `user` table) | None |
| **External recipient** | An email address not managed by the deployment that receives outbound mail. | (anyone not in `account` table) | None |

## Core entities

| Term | Definition | Legacy mapping | Conflicts |
|---|---|---|---|
| **User** | A person who can log in to Unimailbox. Owns mailboxes and has roles. | `user` table | Legacy: `user.type` is a role *id*, not a string. New: `users.default_role_id` FK. |
| **Mailbox** | An email address under a managed domain. Has an owner and zero or more members. | `account` table | **Conflict**: legacy calls mailboxes "accounts". New: rename to `mailbox`. |
| **Managed domain** | A domain for which Unimailbox accepts inbound mail and routes it to mailboxes. | `setting.managed_domains` (JSON array) | **Conflict**: legacy stores as JSON. New: `managed_domains` table. |
| **Message** | The canonical record of a sent or received email. Owned by one user, visible to N mailboxes. | `email` table | **Conflict**: legacy `email` mixes inbound/outbound/drafts and holds read/star state on the row. |
| **Mailbox message** | The relation between a message and a mailbox, plus folder assignment. | (implicit in `email.accountId`) | New: `mailbox_messages` table. |
| **Recipient** | An email address that should receive a message, with type (to/cc/bcc). | `email.recipient` + `email.cc` + `email.bcc` (JSON blobs) | **Conflict**: legacy uses JSON blobs in text columns. New: `message_recipients` table. |
| **Attachment** | A binary file attached to a message. Stored in R2. | `attachments` (legacy) / `att` table | New: `message_attachments` + `attachment_uploads` (two-table model with triggers). |
| **Draft** | A message in `messages.status='draft'` state, visible only to its creator. | `email` row with `type=SEND, status=SAVING` (de facto) | **Conflict**: legacy has no explicit draft concept. New: explicit. |
| **Outbound job** | A durable record that a message must be sent through a provider. | (none — provider call inline) | New: `outbound_jobs` table (durable outbox). |
| **Provider connection** | The encrypted credential + config that lets Unimailbox talk to a specific provider. | `setting.resend_tokens`, `setting.brevo_api_key` (env) | **Conflict**: legacy stores plaintext keys. New: encrypted. |
| **Provider** | An outbound email service (Brevo, Resend, Cloudflare Email binding, future). | inline switch in `email-service.send` | **Conflict**: legacy is not provider-neutral. New: `ProviderRegistry`. |
| **Webhook delivery** | A record of an inbound webhook event with idempotency locking. | `webhook_delivery` | Keep. |
| **Provider message state** | The mapping between a provider's message ID and our canonical message. | `provider_email_state` | New name: `provider_message_state`. |
| **Registration key** | A one-time or limited-use code that allows a user to register. | `reg_key` | Keep shape, hash code. |
| **Role** | A named bundle of permissions. Two system roles: `administrator`, `member`. | `role` + `role_perm` | Split into `roles`, `role_permissions`. |
| **Permission** | A verb on a resource: `message.send`, `mailbox.create`, etc. | `perm.perm_key` | Trim to canonical set. |
| **Audit event** | A record of an action that changed system state. | (none) | New: `audit_events` table. |
| **Maintenance job** | A cursor-based backfill that runs on a schedule. | (none) | New: `maintenance_jobs` table. |

## Lifecycle states

### Message

| State | Meaning | Legacy value | New value |
|---|---|---|---|
| Draft | Composing, not yet sent | `email.status=SAVING` + `type=SEND` | `messages.status='draft'` |
| Queued | Outbound job pending dispatch | (none — inline) | `messages.status='queued'` |
| Sending | Provider call in flight | (none) | `messages.status='sending'` |
| Sent | Provider accepted the message | `email.status=SENT` | `messages.status='sent'` |
| Delivered | Recipient confirmed delivery | `email.status=DELIVERED` | `messages.status='delivered'` |
| Delayed | Provider reported transient delay | `email.status=DELAYED` | `messages.status='delayed'` |
| Bounced | Provider reported bounce | `email.status=BOUNCED` | `messages.status='bounced'` |
| Complained | Recipient reported spam | `email.status=COMPLAINED` | `messages.status='complained'` |
| Failed | Terminal error | `email.status=FAILED` | `messages.status='failed'` |
| Received | Inbound, stored | `email.status=RECEIVE` | `messages.status='received'` |
| No recipient | Inbound, unknown mailbox | `email.status=NOONE` | `messages.status='received'` with no `mailbox_messages` |

### Outbound job

| State | Meaning | Legacy | New |
|---|---|---|---|
| Pending | Job exists, not yet dispatched | n/a | `outbound_jobs.status='pending'` |
| Enqueued | Job in Cloudflare Queue | n/a | `outbound_jobs.status='enqueued'` |
| Processing | Worker queue consumer claimed | n/a | `outbound_jobs.status='processing'` |
| Succeeded | Provider accepted | n/a | `outbound_jobs.status='succeeded'` |
| Failed | Terminal failure | n/a | `outbound_jobs.status='failed'` |

### User

| State | Legacy | New |
|---|---|---|
| Active | `user.status=0` | `users.status='active'` |
| Suspended | `user.status=1` | `users.status='suspended'` |
| Deleted | `user.isDel=1` | `users.status='deleted'` |

### Mailbox

| State | Legacy | New |
|---|---|---|
| Active | `account.status=0` (no real enum) | `mailboxes.status='active'` |
| Disabled | (no path) | `mailboxes.status='disabled'` |
| Deleted | `account.isDel=1` | `mailboxes.status='deleted'` |

### Installation

| State | Meaning | New |
|---|---|---|
| Pending | No setup yet | `installation_state.status='pending'` |
| In progress | Some steps done | `installation_state.status='in_progress'` |
| Complete | All steps done | `installation_state.status='complete'` |

## Operations / actions

### Inbound

| Term | Definition |
|---|---|
| **Receive** | Inbound mail from Cloudflare Email Routing, parsed and stored |
| **Reject** | Inbound mail refused at the Email Routing layer (Recipient not found, blocklist) |
| **Forward** | Re-send the inbound mail to another address (Telegram bot or email) |

### Outbound

| Term | Definition |
|---|---|
| **Compose** | Create a new draft or send directly |
| **Send** | Persist + dispatch to provider |
| **Reply** | Send with `In-Reply-To` and `References` headers |
| **Forward** | Send an existing message body to a new recipient |

### Mailbox

| Term | Definition |
|---|---|
| **Create mailbox** | Reserve an address under a managed domain |
| **Rename mailbox** | Change `display_name` (not address) |
| **Pin mailbox** | Move to top of account list |
| **Delete mailbox** | Soft-delete; cascade to messages, attachments |
| **Share mailbox** | Add a member with a role |
| **All-receive** | Toggle inbox to include all owned mailboxes (legacy only) |

### Administration

| Term | Definition |
|---|---|
| **Bootstrap** | First-time installation via setup wizard |
| **Configure provider** | Add/edit/disable a provider connection |
| **Issue registration key** | Create an invite code |
| **Revoke registration key** | Invalidate a key |
| **Reset send quota** | Reset a user's daily send counter (legacy only — dropped in rebuild) |

## Concepts that **must not** be carried over

| Legacy term | Why drop |
|---|---|
| `account` (mailbox) | Renamed to `mailbox` for clarity |
| `email` (message) | Split into 4 tables |
| `star` (separate table) | Becomes `message_user_state.is_starred` |
| `setting` (57-col god-object) | Split into 3+ tables |
| `unread` (boolean on `email`) | Becomes `message_user_state.is_read` |
| `isDel` (integer everywhere) | Becomes `deleted_at TIMESTAMP` |
| `super-admin` (email list) | Replaced by `administrator` role |
| `webhook_event` audit | Renamed `webhook_events` |
| `provider_email_state` | Renamed `provider_message_state` |
| `accountMemberConst.role.{VIEWER,SENDER,ADMIN}` (numeric) | String enum |
| `att.type.{ATT,EMBED}` (numeric) | String enum |
| `emailConst.type.{SEND,RECEIVE}` (numeric) | Derived from folder + creator |

## Concepts that are **deferred**, not removed

| Term | Defer to | Reason |
|---|---|---|
| Telegram bot config | Phase 5 | Not part of core loop |
| AI code extraction | Phase 5 | Optional |
| S3 backend | Phase 5 | R2-only for Phase 1 |
| OAuth (LinuxDo) | Phase 5 | Optional |
| Turnstile | Phase 5 | Optional |
| Per-role ban/avail policy | Phase 5 | Default allow |
| Public admin token | Removed | SQL injection, no need |
| `/test` route | Removed | Dev artifact |

## Concepts that are **new** in the rebuild

| Term | Definition |
|---|---|
| **Setup wizard** | First-time installation state machine (9 steps) |
| **Setup repair session** | Authenticated admin can re-enter setup for upgrade steps only |
| **Idempotency record** | `(actor, operation, key)` triple that returns the same response on replay |
| **Outbox pattern** | Send returns immediately with `queued`; queue consumer delivers |
| **Provider plugin** | `OutboundProviderAdapter` + `WebhookProviderAdapter` + `SyncProviderAdapter` interface |
| **Provider connection** | Encrypted credential + per-provider config |
| **Provider event rank** | Numeric status comparison for out-of-order webhook delivery |
| **Maintenance job** | Cursor-based backfill with `job_key` registered in code |
| **Audit event** | Action + actor + resource + request ID |
| **Application password** | (Future, POP3) Per-mailbox, revocable, long-lived credential |
