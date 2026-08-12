# C. Core Business Value Stream

The most important question is not "what features does the system have?" but "**what does the system do that a user would notice if it stopped working?**"

Answer: **one closed loop**.

```text
Operator installs deployment
       ↓
First admin is bootstrapped from a single shared installation token
       ↓
Admin claims a domain and an outbound provider
       ↓
Admin issues an invitation key
       ↓
Invited user registers → signs in
       ↓
User creates or is granted a mailbox
       ↓
External sender mails the mailbox → Email Routing delivers the raw MIME
       ↓
Worker parses MIME → stores canonical message + attachments
       ↓
User opens the inbox in the browser → reads the message → marks it read
       ↓
User replies → message goes through outbound queue → provider accepts it
       ↓
Status events update the canonical message
       ↓
User (and operator) can see the message in sent, search it, audit it
```

If any link in this chain breaks, **the system has failed at its purpose**. Every other feature (analytics, Telegram forwarding, AI code extraction, ECharts, signatures, attachments) is an additive improvement on top of this loop.

## Premise

This loop is the loop of the **new system**. The legacy system has roughly the same loop but with weaker security, no idempotency, no outbox, and provider-specific code branching. The new system closes the loop with the architecture defined in `05-target-architecture/`.

## C.1 Trigger / Actor / Output per step

| Step | Trigger | Actor | Input | Output | Side effects |
|---|---|---|---|---|---|
| 1. Install | "Deploy to Cloudflare" button | Operator | Public repo URL | Worker URL, D1 ID, R2 bucket, KV ID, Queue, Secrets | First D1 migration runs |
| 2. Bootstrap admin | First GET `/` on the Worker | Anonymous browser | `INSTALLATION_TOKEN` | Setup session in KV; redirected to `/setup/admin` | Audit event |
| 3. Claim domain | POST `/api/v1/setup/domain` | Admin (in setup session) | Domain string | `managed_domains` row + Email Routing rule on Worker | DNS records (manual or via OAuth) |
| 4. Connect provider | POST `/api/v1/setup/brevo` | Admin | Encrypted Brevo key | `provider_connection` row + health-check ping | Brevo API call |
| 5. Complete setup | POST `/api/v1/setup/complete` | Admin | Confirmation | `installation_state.completed_at` set | Setup session destroyed |
| 6. Issue invite key | POST `/api/v1/admin/registration-keys` | Admin | Count, role, expiry | `registration_keys` row | Audit event |
| 7. Register | POST `/api/v1/auth/register` | New user | Email, password, key | `user` row, `sessions` row, refresh token | Email loop |
| 8. Create mailbox | POST `/api/v1/mailboxes` | User | Domain, local-part | `mailbox` row (owner=current user) | Loop detection on duplicates |
| 9. Receive mail | Email Routing POSTs raw MIME | External sender | Raw RFC 5322 bytes | `message` row + `message_attachments` rows + R2 objects | Read-state seed, audit, sidecar jobs |
| 10. Read mail | GET `/api/v1/messages/:id` | User | Message ID | Message DTO with body, recipients, attachments | `message_user_state.is_read` lazy-init |
| 11. Reply | POST `/api/v1/messages/send` (with `parentMessageId`) | User | Mailbox ID, recipients, body | New `message` row, `outbound_jobs` row | Queue dispatch → provider |
| 12. Send | Worker queue consumer | Worker | `outbound_job` payload | Provider API call | `messages.status` updated |
| 13. Status update | Webhook POST | Provider | Event payload | `messages.status` updated to `delivered/delayed/bounced/failed` | Webhook audit row |

## C.2 Completion condition

The loop is complete when:

1. The admin's setup state is `COMPLETE`.
3. An invited user can register and log in without admin intervention.
5. A real external email to the user's mailbox appears in their inbox within 60 seconds.
7. The user can reply to that email and the recipient receives it within 60 seconds.
8. The status of the sent message transitions through `queued → sent → delivered` (or terminal failure).
9. The admin can see the user in the user list, the message in the all-mail search, and the audit trail in the webhook log.

Every other capability (drafts, stars, sharing, signatures, attachments, forwarding, analytics) is an **extension** to this loop and **must not** be required for the loop to close.

## C.3 Failure-handling expectations

For each link:

| Failure | Expected behavior |
|---|---|
| Setup `INSTALLATION_TOKEN` mismatch | `/setup/claim` returns 401 + structured error |
| Domain already claimed | 409 `DOMAIN_ALREADY_CLAIMED` |
| Provider health check fails | Setup step refuses to advance; admin retries |
| Recipient not found on inbound | `unknown_recipient_policy` semantics; explicit `reject` or `store` |
| MIME parsing fails | Mark as `FAILED` with sanitized reason; never lose raw bytes |
| Provider rejects outbound | `email.status = FAILED`, error JSON |
| Webhook arrives for unknown message | `webhook_delivery.ignored`; recovered on next sync run |
| DB write fails after provider accepts | Outbox row + scheduled recovery retry |
| Worker is killed mid-send | Scheduled dispatcher recovers (lock TTL + cursor) |

## C.4 Audit & observability expectations

Every step in the loop must be observable:

- Every state transition writes an `audit_events` row.
- Every side effect (provider call, R2 upload, webhook ingest) emits a structured log event.
- A failing step is recoverable without data loss.

## C.5 What is *not* in the value stream

The following features are **adjacent**, not part of the loop:

- Telegram forwarding
- AI verification-code extraction
- S3 backend
- ECharts dashboard
- Public admin token (removed)
- OAuth (LinuxDo)
- Turnstile
- Analytics cache (30-min cron)
- Signature sanitizer (HTML regex)
- Per-role ban-email and avail-domain policies (acceptable default: any authenticated user can send from any mailbox they own)
- Registration keys (acceptable default: admin creates user directly)

These are **deferred** to later phases. They are valuable, but the loop closes without them.