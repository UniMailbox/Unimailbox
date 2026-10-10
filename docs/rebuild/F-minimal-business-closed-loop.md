# F. Minimal Business Closed Loop

This is the **smallest end-to-end slice** that proves the rebuild works. Every capability listed here is required to demonstrate the system delivers value. Anything not listed here is explicitly **out of scope** for Phase 1.

## Premise

The new system is built in a fresh repository from this specification. It runs on its own bindings (D1, R2, KV, Queue, Secrets Store) on a preview route. The legacy system continues running on its own route during Phase 0–3. The new system is not derived from the legacy code; only the business facts in `02-business-discovery/` carry over.

## F.1 The slice

```text
1. Operator creates a new cloud account (or uses an existing one).
   ↓
2. Operator clicks "Deploy to Cloudflare" on the new repo README.
   ↓
3. Cloudflare provisions D1, R2, KV, Queue, Secrets Store bindings.
   ↓
4. Workers Builds runs migrations + deploys the Worker.
   ↓
5. Operator visits the Worker URL → redirected to /setup.
   ↓
6. Operator pastes INSTALLATION_TOKEN → /setup/claim binds a setup session.
   ↓
7. Operator completes /setup/preflight → bindings + schema verified.
   ↓
8. Operator creates the first administrator.
   ↓
9. Operator adds a managed domain (manual DNS note shown).
   ↓
10. Operator opens Cloudflare dashboard (allowlisted link), enables Email Routing.
    ↓
11. Operator verifies the Worker email route at /setup/cloudflare/verify.
    ↓
12. Operator triggers /setup/inbound-smoke-test → a generated message arrives at the Worker.
    ↓
13. Operator enters Brevo API key at /setup/brevo → connection encrypted + health-checked.
    ↓
14. Operator triggers /setup/outbound-smoke-test → a message is sent via Brevo.
    ↓
15. Operator clicks /setup/complete → installation_state.status = 'complete'.
    ↓
16. Admin issues a registration key via /admin/invite-codes.
    ↓
17. A new user registers with that key and lands on /inbox.
    ↓
18. The user creates a mailbox.
    ↓
19. An external sender mails the mailbox.
    ↓
20. Worker parses MIME → Message + MailboxMessage rows exist in D1.
    ↓
21. User opens /inbox → sees the message.
    ↓
22. User opens the message → reads it (isRead=true).
    ↓
23. User clicks Reply → compose drawer opens with quoted text.
    ↓
24. User sends → OutboundJob created → queue consumer calls Brevo.
    ↓
25. Brevo accepts → Message.status = 'sent'.
    ↓
26. Webhook arrives → Message.status = 'delivered'.
    ↓
27. Admin opens /admin/webhook-events → sees the delivery event.
```

**Twenty-seven steps. Two actors. One real email round-trip.**

## F.2 Capability ledger (Phase 1 only)

| Capability | New module | Status |
|---|---|---|
| Deploy to Cloudflare | `infra/deploy-button` | Required |
| One-time setup wizard | `modules/installation/*` | Required |
| Setup-state machine | `InstallationState` aggregate | Required |
| Bindings preflight | `modules/installation/preflight` | Required |
| First administrator | `modules/identity/register-admin` | Required |
| Managed domain claim | `modules/tenancy/domains/create` | Required |
| Cloudflare Email Routing link | `modules/tenancy/email-routing` | Required |
| Inbound smoke test | `modules/inbound/smoke-test` | Required |
| Registration key CRUD | `modules/onboarding/registration-keys` | Required |
| User register | `modules/identity/register` | Required |
| User login (password) | `modules/identity/login` | Required |
| User logout | `modules/identity/logout` | Required |
| Session refresh | `modules/identity/refresh` | Required |
| Authn middleware | `http/middleware/authn` | Required |
| Perm middleware | `http/middleware/authz` | Required |
| Create mailbox | `modules/tenancy/mailboxes/create` | Required |
| List mailboxes | `modules/tenancy/mailboxes/list` | Required |
| List inbox | `modules/messages/list-inbox` | Required |
| Read message | `modules/messages/read` | Required |
| Inbound mail handler | `modules/inbound/handle-message` | Required |
| Inbound MIME parser | `email-core/parse-mime` | Required |
| Compose + send | `modules/outbound/send-message` | Required |
| Reply (threading) | `modules/outbound/send-message` | Required |
| Provider registry (Brevo only) | `modules/outbound/registry` | Required |
| Outbound queue + consumer | `modules/outbound/dispatch` + `entrypoints/queue` | Required |
| Webhook ingest (Brevo) | `modules/outbound/apply-webhook-event` | Required |
| Webhook delivery idempotency | `modules/outbound/webhook-delivery` | Required |
| Webhook audit log | `modules/admin/webhook-events` | Required |
| Audit events | `modules/admin/audit` | Required |
| HTTP router | `http/router` | Required |
| Error model | `platform/errors` | Required |
| Settings (minimal) | `modules/admin/settings` | Required (read-only) |
| React web client | `apps/web/` | Required |

## F.3 What is **not** in Phase 1

| Feature | Defer to |
|---|---|
| Mailbox sharing | Phase 3 |
| Server drafts | Phase 3 |
| Stars | Phase 3 |
| Sent / drafts / archive / trash folders | Phase 3 |
| Attachments (full) | Phase 3 |
| Attachment direct upload | Phase 3 |
| Inline images (CID) | Phase 3 |
| Signature | Phase 3 |
| Search | Phase 4 |
| Bulk operations (admin) | Phase 4 |
| Provider sync (back-import from Brevo) | Phase 4 |
| Provider switch (Resend, CF) | Phase 5 |
| Telegram forwarding | Phase 5 |
| AI code extraction | Phase 5 |
| S3 backend | Phase 5 (or removed) |
| OAuth (LinuxDo or other) | Phase 5 |
| Turnstile | Phase 5 |
| ECharts analytics | Phase 4 |
| Login background customization | Phase 4 |
| Notice popups | Phase 4 |
| Per-role quota / ban / domain policy | Phase 5 |
| Setup repair session | Phase 0 |
| Maintenance jobs (cron) | Phase 4 |
| Cursor pagination | Phase 2 |
| Data import tool | Phase 4 |

## F.4 Vertical-slice acceptance criteria for Phase 1

Phase 1 is "done" when **all** of the following pass on a fresh cloud account with **zero manual intervention** beyond the deploy button:

```text
[x] Worker deploys to a fresh cloud account with no .env edits.
[x] D1, R2, KV, Queue bindings are auto-provisioned.
[x] First GET / redirects to /setup.
[x] /setup/claim accepts the INSTALLATION_TOKEN and binds the browser.
[x] /setup/preflight reports each binding present + schema version.
[x] /setup/administrator creates the first user with a PBKDF2 password.
[x] /setup/domain accepts a domain name and persists it as 'active'.
[x] /setup/cloudflare/dashboard-link opens an allowlisted dashboard URL.
[x] /setup/cloudflare/verify confirms Email Routing is enabled.
[x] /setup/inbound-smoke-test succeeds with a generated message.
[x] /setup/brevo accepts an API key (encrypted at rest) and verifies the sender.
[x] /setup/outbound-smoke-test sends a real message and confirms provider ID.
[x] /setup/complete flips installation_state to status='complete'.
[x] A non-setup GET / now returns the React app shell.
[x] Admin issues a registration key via /admin/invite-codes.
[x] A new user registers with that key and lands on /inbox.
[x] The user creates a mailbox.
[x] An external sender's email arrives in the user's inbox within 60s.
[x] The user reads the message and isRead=true persists.
[x] The user replies; the reply appears in the recipient's mailbox within 60s.
[x] The Brevo webhook advances the message to 'delivered'.
[x] The admin opens /admin/webhook-events and sees the delivery event.
[x] audit_events rows exist for: setup.claim, setup.complete, mailbox.create,
    message.receive, message.send, webhook.delivered.
[x] pnpm test:unit passes (vitest).
[x] pnpm test:worker passes (cloudflare pool).
[x] pnpm scaffold doctor passes.
[x] No use case imports a provider SDK directly.
[x] No provider-specific code outside the integrations package.
[x] The legacy system is not modified by this deployment.
```

If any of these boxes does not check, Phase 1 is not done. We do not advance.

## F.5 Why this is "minimum"

Every step in §F.1 is **required** for the system to deliver business value:

- Without (1)–(15), the system cannot be installed.
- Without (16)–(18), no one can use it.
- Without (19), there is no address to receive at.
- Without (20)–(22), the inbox never populates.
- Without (23), read state is unobservable.
- Without (24)–(26), the user cannot reply.
- Without (27), delivery is unverifiable.
- Without (28), the admin cannot audit.

Remove any one of these and the loop is broken. We refuse to start Phase 2 until every step in §F.1 is verifiable end-to-end.