# Actors

Historical discovery vocabulary and role analysis. Current account creation,
mailbox grants and delivery behavior follow the [business rules](business-rules.md)
and [capability ledger](../capability-ledger.md#current-state). Retained invite,
transport and legacy-field descriptions are not deployment prerequisites.


An actor is a **role played by a human or system** when interacting with Unimailbox. Each actor has a goal, a set of permissions, and a set of responsibilities.

## A1. Operator

**Definition:** the person who deploys Unimailbox, owns the deployment, and is the first administrator.

**Goal:** install Unimailbox once, configure providers, invite users, run the system indefinitely.

**Permissions:** all permissions (administrator role).

**Responsibilities:**

- Bootstraps the installation via the setup wizard.
- Configures Brevo (or Resend, or CF Email binding) as the outbound provider.
- Manages managed domains.
- Issues registration keys.
- Reviews audit events.
- Recovers from incidents using the operator runbook.
- Manages provider connections.

**Anti-goals:** does not send personal mail. Does not act as a regular user.

## A2. Administrator

**Definition:** a user with the `administrator` role.

**Goal:** keep the deployment healthy; assist users; manage mailboxes, signatures, settings, integrations.

**Permissions:** all permissions (same as Operator, but acquired through the role, not through being the operator).

**Responsibilities:**

- Issues registration keys.
- Manages users (suspend, restore, delete, change role).
- Manages roles and permission assignments.
- Configures signatures.
- Configures settings (blocklists, registration policy, attachment limits).
- Reviews webhook events and audit logs.

**Difference from Operator:** the Operator is the **first** administrator and the one who runs setup. After setup, more administrators can be granted the role. From a permission standpoint, they are identical.

## A3. Member (regular user)

**Definition:** a user with the `member` role.

**Goal:** manage their mailboxes, read and send mail, save drafts, attach files.

**Permissions:**

- `message.read`, `message.send`, `message.delete`
- `mailbox.create`, `mailbox.manage` (own mailbox)
- `mailbox.share` (own mailbox)

**Responsibilities:**

- Registers with an invite key.
- Logs in.
- Creates mailboxes.
- Reads incoming mail.
- Composes and sends mail.
- Attaches files.
- Manages personal settings.

## A4. Invitee

**Definition:** a person who holds a registration key but has not yet registered.

**Goal:** register to become a member.

**Permissions:** none in the system. Holds only an unconsumed registration key.

**Responsibilities:** use the key before it expires; provide a valid email + password.

## A5. External sender

**Definition:** a person or system outside the deployment that sends mail to a managed mailbox.

**Goal:** deliver mail to a Unimailbox address.

**Permissions:** none in the system.

**System interaction:** SMTP → Cloudflare Email Routing → Worker inbound handler. Blocked by recipient blocklist, per-role ban, and unknown-recipient policy.

## A6. External recipient

**Definition:** an email address outside the deployment that receives mail from a member.

**Goal:** receive mail from a Unimailbox user.

**Permissions:** none.

**System interaction:** outbound message → provider API → SMTP → recipient's inbox. May bounce, complain, or defer; webhook events update the canonical message status.

## A7. Mail client (IMAP/POP3)

**Definition:** a third-party mail client (Thunderbird, Apple Mail, Outlook) connecting to a Unimailbox mailbox via POP3.

**Status:** **out of scope** for Phase 1–6 of the rebuild. See `doc/pop3-implementation-plan.md` for the separate workstream.

**Goal:** download mail from a mailbox to the user's local machine.

**Permissions:** requires an application-specific password (per-mailbox, revocable) — not yet implemented.

## A8. Mail provider

**Definition:** a third-party email delivery service (Brevo, Resend, Cloudflare Email binding).

**Goal:** deliver mail to recipients.

**System interaction:**

- Outbound: Worker queue consumer calls provider API.
- Inbound: Provider webhooks call Worker webhook route.
- Back-sync: Worker pulls status updates from provider API on schedule.

**Permissions:** restricted to its connection's encrypted credentials + per-provider config.

## A9. Cloudflare

**Definition:** the platform that hosts Unimailbox.

**Goal:** run the Worker; bind D1, R2, KV, Queue, Secrets Store; route Email Routing.

**System interaction:**

- `fetch(req)` — HTTP request to Worker.
- `email(message)` — Email Routing deliver to Worker.
- `scheduled(c)` — Cron trigger.
- `queue(batch)` — Outbound job delivery.
- D1, R2, KV bindings — Worker reads/writes.

## A10. Anonymous browser (visitor)

**Definition:** a user who has not logged in.

**Goal:** typically, log in or register.

**Permissions:** public routes only.

**Routes accessible:** `/login`, `/register`, `/setup/*` (during first install), `/health`.

**Not accessible:** anything requiring authentication.

---

## Actor matrix

| Actor | Routes accessible | API access | Special capabilities |
|---|---|---|---|
| Operator | All + `/setup/*` | All | First-run setup |
| Administrator | All except `/setup/*` after complete | All | Manage users + roles + settings |
| Member | `/inbox`, `/settings`, `/admin/invite-codes` (if perm) | Mailbox + message APIs | Send mail, share mailbox |
| Invitee | `/register`, `/login` | Registration API | Consume registration key |
| External sender | n/a | (calls Email Routing) | Send mail to managed addresses |
| External recipient | n/a | n/a | Receives mail |
| Mail client (POP3) | n/a | POP3 (Phase 7+) | Download mail |
| Mail provider | n/a | Webhook + REST | Send + sync status |
| Cloudflare | n/a | Bindings + entrypoints | Host Worker + storage |
| Anonymous browser | `/login`, `/register`, `/setup/*`, `/health` | Auth endpoints | None |

## Role → Actor mapping

| Role | Actor |
|---|---|
| `administrator` | Operator, Administrator |
| `member` | Member |
| (no role) | Anonymous browser |

There are **two** real roles in the system today. Future roles (Phase 5+) may add more, but the blueprint does not require them.