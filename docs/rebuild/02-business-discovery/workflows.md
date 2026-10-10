# Workflows

Each workflow describes a sequence of states and transitions that achieve a business outcome. Workflows cross actor boundaries and may involve external systems.

## W-1. First-time installation

**Trigger:** "Deploy to Cloudflare" button on a public repo.

**Actors:** Operator.

**Steps:**

```text
1. Operator clicks "Deploy to Cloudflare" on the repo README.
   ↓
2. Cloudflare provisions D1, R2, KV, Queue, Secrets Store bindings.
   ↓
3. Workers Builds runs migrations + deploys Worker.
   ↓
4. Operator visits the Worker URL → redirected to /setup.
   ↓
5. Operator pastes INSTALLATION_TOKEN → /setup/claim binds a KV setup session.
   ↓
6. Operator runs /setup/preflight → sees binding status, schema version.
   ↓
7. Operator creates the first administrator at /setup/administrator.
   ↓
8. Operator enters a managed domain at /setup/domain.
   ↓
9. Operator opens Cloudflare dashboard (allowlisted link), enables Email Routing.
   ↓
10. Operator verifies the Worker email route at /setup/cloudflare/verify.
    ↓
11. Operator triggers /setup/inbound-smoke-test → a generated message arrives at the Worker.
    ↓
12. Operator enters Brevo API key at /setup/brevo → connection encrypted + health-checked.
    ↓
13. Operator triggers /setup/outbound-smoke-test → a message is sent via Brevo.
    ↓
14. Operator clicks /setup/complete → installation_state.status = 'complete'.
    ↓
15. From now on, only authenticated admins see /setup/* via a repair session.
```

**Failure handling:**

- Any step failure: retry that step; previous steps remain completed.
- Two tabs racing: optimistic concurrency on `installation_state.stateVersion`; the second tab gets 409.
- Lost setup session: re-claim via INSTALLATION_TOKEN.

**Completion condition:** `installation_state.status = 'complete'` AND `installation_state.completed_at IS NOT NULL`.

## W-2. User registration

**Trigger:** user has a valid registration key.

**Actors:** Invitee.

**Steps:**

```text
1. Invitee visits /register, enters email + password + registration key.
   ↓
2. Client validates (zod schema) → POST /api/v1/auth/register with Idempotency-Key.
   ↓
3. Worker validates email format, prefix length, password strength.
   ↓
4. Worker verifies the registration key (hash match, not expired, not exhausted).
   ↓
5. Worker hashes password (PBKDF2, ≥600k iterations).
   ↓
6. Worker inserts user row + increments key used_count + creates session.
   ↓
7. Worker returns 200 with access token + refresh token (in cookies).
   ↓
8. Client redirects to /inbox.
```

**Failure handling:**

- Invalid key: 401 INVALID_REGISTRATION_KEY.
- Email already exists: 409 EMAIL_ALREADY_REGISTERED.
- Key expired/exhausted: 401 REGISTRATION_KEY_INVALID.
- All state is rolled back via D1 batch if any step fails.

## W-3. Login

**Trigger:** user has credentials.

**Actors:** Member, Administrator.

**Steps:**

```text
1. User visits /login.
   ↓
2. User enters email + password.
   ↓
3. Client → POST /api/v1/auth/login.
   ↓
4. Worker normalizes email (trim, lowercase).
   ↓
5. Worker hashes password (PBKDF2) with stored salt + iterations.
   ↓
6. Worker compares hashes (constant-time).
   ↓
7. Worker creates session row + KV session record (capped at 10).
   ↓
8. Worker returns access token (15 min) + refresh token (30 days).
   ↓
9. Client stores refresh in httpOnly cookie, access in memory.
```

**Failure handling:**

- Wrong credentials: 401 INVALID_CREDENTIALS (no enumeration).
- Banned user: 403 USER_BANNED.
- Rate limit: 429 RATE_LIMIT_EXCEEDED.

## W-4. Receive mail

**Trigger:** Cloudflare Email Routing delivers a raw RFC 5322 message.

**Actors:** External sender.

**Steps:**

```text
1. Cloudflare parses MX + Email Routing rule, delivers raw bytes to Worker.
   ↓
2. Worker email() handler reads raw bytes once as ArrayBuffer.
   ↓
3. Worker parses MIME with PostalMime.
   ↓
4. Worker applies blocklist (subject/content/from).
   ↓
5. Worker resolves recipient by `mailboxes.address` (case-insensitive).
   ↓
6. Worker applies per-role policy (availDomain, banEmail).
   ↓
7. Worker uploads raw .eml to R2 under `messages/raw/{mailboxId}/{messageId}.eml`.
   ↓
8. Worker uploads attachments to R2 under `attachments/{uuid}.{ext}`.
   ↓
9. Worker inserts in one D1 batch:
   - messages (status='received', receivedAt=now)
   - message_recipients (to/cc/bcc)
   - message_attachments
   - mailbox_messages (for each mailbox reached)
   ↓
10. Worker emits audit event.
    ↓
11. (Phase 5) Worker enqueues notification job.
```

**Failure handling:**

- Unknown recipient + `unknown_recipient_policy=reject`: reject upstream (Cloudflare Email Routing returns SMTP 550).
- Unknown recipient + `store`: save with no `mailbox_messages` row.
- Blocklist hit: reject upstream.
- R2 upload succeeds + D1 insert fails: orphan object → scheduled cleanup.
- D1 insert succeeds + R2 fails: do not mark `received`; leave as `SAVING` → recovery cron.

**Completion condition:** `messages.status='received'` for the message, with at least one `mailbox_messages` row (unless unknown recipient).

## W-5. Compose + send

**Trigger:** user clicks Send in the compose drawer.

**Actors:** Member, Administrator.

**Steps:**

```text
1. User composes email in /compose (drawer or page).
   ↓
2. Client uploads attachments via presigned R2 PUT URLs.
   ↓
3. Client → POST /api/v1/messages/send with Idempotency-Key.
   ↓
4. Worker validates input (zod): recipients, subject, body, attachment references.
   ↓
5. Worker asserts `message.send` permission + mailbox `send` operation.
   ↓
6. Worker loads mailbox + domain.
   ↓
7. Worker partitions recipients into internal + external.
   ↓
8. Worker composes message:
   - In-Reply-To = parent.messageId (if reply)
   - References = parent.references + parent.messageId
   - signature = domain signature (if enabled)
   ↓
9. Worker writes in one D1 batch:
   - messages (status='queued' if external, 'sent' if internal-only)
   - message_recipients
   - mailbox_messages (sender in 'sent' folder, recipients in 'inbox' if internal)
   - message_attachments (consumes attachment_uploads)
   - outbound_jobs (if external)
   - idempotency_records (response cached)
   ↓
10. If external: Worker dispatches job to Cloudflare Queue.
    ↓
11. Worker returns 200 { messageId, status }.
```

**Completion condition:** the message row exists with `status` matching the case (queued or sent).

## W-6. Queue consumer → send to provider

**Trigger:** Cloudflare Queue delivers an `OutboundMailJob`.

**Actors:** Worker queue consumer, Mail provider.

**Steps:**

```text
1. Queue consumer receives batch.
   ↓
2. For each job: try to claim (compare-and-set pending→processing with lock_token + 60s TTL).
   ↓
3. If claim fails: skip (another consumer has it).
   ↓
4. If claim succeeds: load message + provider connection + decrypted credentials.
   ↓
5. Resolve provider from provider_key; select adapter from registry.
   ↓
6. Call adapter.send(payload) with canonical message ID as idempotency key.
   ↓
7. On success:
   - Update messages (providerKey, providerMessageId, status='sent', sentAt)
   - Update provider_message_state with link
   - Mark outbound_jobs (status='succeeded')
   - Emit audit event
   ↓
8. On retryable error:
   - Increment outbound_jobs.attempts
   - If attempts < max: re-enqueue with backoff
   - Else: mark outbound_jobs.status='failed' AND messages.status='failed'
   ↓
9. On terminal error:
   - Mark outbound_jobs.status='failed' AND messages.status='failed'
   - Sanitize error into messages.errorMessage
   - Emit audit event
```

**Failure handling:**

- Lock expires before completion: scheduled dispatcher recovers (status→pending).
- Queue submission fails: outbound_jobs.status remains 'pending'; scheduled dispatch retries.

**Completion condition:** `messages.status IN ('sent', 'delivered', 'failed')`.

## W-7. Provider webhook → status update

**Trigger:** Mail provider sends webhook.

**Actors:** Mail provider.

**Steps:**

```text
1. Provider POSTs webhook payload to /api/v1/webhooks/:providerKey/:connectionId.
   ↓
2. Worker resolves provider_connection by ID (without auth — provider-specific verification is the auth).
   ↓
3. Worker verifies signature using connection's encrypted secret.
   ↓
4. Worker computes event_key (deterministic per-event ID).
   ↓
5. Worker claims webhook_delivery (compare-and-set processing with lock_token + 60s TTL).
   ↓
6. If already succeeded: return 200 immediately.
   ↓
7. Worker resolves message by provider_message_id via provider_message_state.
   ↓
8. If message not found: enter import mode (acquire import lock, fetch from provider, insert message).
   ↓
9. Worker applies status via `applyStatusIfNewer` (event time + status rank).
   ↓
10. Worker updates outbound_jobs (succeeded or further retry).
    ↓
11. Worker inserts webhook_events audit row.
    ↓
12. Worker completes webhook_delivery.
```

**Failure handling:**

- Bad signature: 401 (no state change).
- Already-completed event: 200 immediately.
- Lock contention: 503 WEBHOOK_BUSY (provider retry).
- Provider sync race: import_lock ensures one consumer inserts the message.

**Completion condition:** `webhook_deliveries.processing_status='succeeded'` for the event.

## W-8. Mailbox sharing

**Trigger:** mailbox owner or admin adds another user.

**Actors:** Administrator, Member (owner).

**Steps:**

```text
1. Owner opens mailbox settings, adds member email + role.
   ↓
2. Client → POST /api/v1/mailboxes/:id/members.
   ↓
3. Worker validates email + role.
   ↓
4. Worker asserts `mailbox.share` permission OR owner-of-mailbox.
   ↓
5. Worker checks member user exists; if not, return 404.
   ↓
6. Worker inserts mailbox_members row.
   ↓
7. Worker emits audit event.
```

**Member-permission semantics:**

- `viewer`: read-only access.
- `sender`: read + send.
- `admin`: read + send + rename + manage members.

The owner is **not** stored in `mailbox_members`; ownership is on the `mailboxes.owner_user_id` column.

## W-9. Draft lifecycle

**Trigger:** user composes and saves a draft (server-authoritative).

**Actors:** Member, Administrator.

**Steps:**

```text
1. User composes → clicks "Save draft".
   ↓
2. Client → POST /api/v1/drafts (or PUT /api/v1/drafts/:id with If-Match).
   ↓
3. Worker inserts (or updates with optimistic concurrency) message row + mailbox_messages row in folder='drafts'.
   ↓
4. Worker consumes attachment_uploads if attachments referenced.
   ↓
5. Worker emits audit event.
   ↓
6. (Crash recovery) Local IndexedDB holds the working copy.
   ↓
7. User clicks "Send draft" → POST /api/v1/drafts/:id/send with If-Match.
   ↓
8. Worker validates version; transitions message to 'queued' (external) or 'sent' (internal).
   ↓
9. Worker moves mailbox_messages from 'drafts' to 'sent' (sender) + 'inbox' (internal recipients).
   ↓
10. Worker creates outbound_jobs if external.
    ↓
11. (Forbidden) PUT after send returns 409 DRAFT_ALREADY_SENT.
```

**Failure handling:**

- Version mismatch on save: 409 DRAFT_VERSION_CONFLICT; client re-fetches.
- Send attempt on already-sent draft: 409 DRAFT_ALREADY_SENT.

## W-10. Scheduled maintenance

**Trigger:** cron (`scheduled(c)`).

**Actors:** Worker.

**Cadence:**

| Job | Frequency |
|---|---|
| Outbound dispatcher recovery | Every minute |
| Maintenance backfills | Every minute while pending |
| Session cleanup | Daily |
| Idempotency cleanup | Daily |
| Upload cleanup | Hourly |
| Webhook cleanup | Daily |
| Orphan R2 cleanup | Daily |
| Analytics aggregation | Hourly |

Each job:

```text
1. Reads pending jobs from maintenance_jobs (cursor-based).
2. For each job: claim with lock_token + 5-min TTL.
3. Run handler (registered by job_key).
4. Update cursor_json on progress.
5. Mark completed or failed.
```

## W-11. Setup repair session

**Trigger:** an upgrade introduces a new setup step; admin opens `/setup/*` while authenticated.

**Actors:** Administrator.

**Steps:**

```text
1. Admin (already logged in) visits /setup/*.
   ↓
2. Middleware checks: installation_state has a new step not yet completed.
   ↓
3. If yes: bind a short-lived KV repair session.
   ↓
4. Admin completes only the new step.
   ↓
5. installation_state advanced by that step.
```

**Security:**

- Repair session requires authenticated admin.
- Repair session only enables steps that are pending in current `installationVersion`.
- Repair session is one-shot; destroyed after step completes.