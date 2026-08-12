# Feature Decision Matrix

Every legacy feature is classified. Use this matrix during Phase 0 to confirm each decision.

## Decision legend

- **KEEP** — feature stays in new system, may rename.
- **REDESIGN** — feature stays but is rebuilt with cleaner structure.
- **SIMPLIFY** — feature stays but with less code.
- **REMOVE** — feature is dropped.
- **DEFER** — feature is kept in legacy for now; rebuilt in a later phase.
- **UNKNOWN** — needs more investigation.

## User-facing features

| Feature | Decision | New home | Phase |
|---|---|---|---|
| Register | KEEP | `modules/identity/auth/register` | 1 |
| Login (password) | REDESIGN (PBKDF2) | `modules/identity/auth/login` | 0/1 |
| Logout | KEEP | `modules/identity/auth/logout` | 1 |
| Refresh token rotation | KEEP | `modules/identity/auth/refresh` | 1 |
| Reset password | KEEP | `modules/identity/auth/reset-password` | 1 |
| Delete account | KEEP | `modules/identity/users/delete` | 1 |
| LinuxDo OAuth | DEFER | `modules/identity/oauth/linuxdo` | 5 |
| Multi-mailbox per user | KEEP | `modules/tenancy/mailboxes/*` | 1 |
| Mailbox sharing | KEEP | `modules/tenancy/mailbox-members/*` | 3 |
| Pin mailbox | KEEP | `modules/tenancy/mailboxes/pin` | 3 |
| Rename mailbox | KEEP | `modules/tenancy/mailboxes/rename` | 1 |
| Delete mailbox | KEEP | `modules/tenancy/mailboxes/delete` | 1 |
| Receive mail | REDESIGN (ArrayBuffer) | `modules/inbound-mail/handle-message` | 1 |
| Read inbox | KEEP | `modules/messages/list-inbox` | 1 |
| Read message detail | KEEP | `modules/messages/read` | 1 |
| Mark read | KEEP | `modules/messages/mark-read` | 1 |
| Soft-delete message | KEEP | `modules/messages/delete` | 1 |
| Compose + send | REDESIGN (use case + provider registry) | `modules/outbound/send-message` | 1 |
| Reply (threading) | KEEP | (in `send-message`) | 1 |
| Forward message | KEEP | `modules/outbound/forward-message` | 1 |
| Server drafts | REDESIGN (explicit `draft` state) | `modules/messages/drafts/*` | 3 |
| Local drafts (Dexie) | KEEP | `apps/web/src/db/` | 3 |
| Stars | KEEP | (in `message_user_state`) | 3 |
| Folders (sent/drafts/archive/trash) | KEEP | (in `mailbox_messages.folder`) | 3 |
| Attachment upload | REDESIGN (presigned + auth) | `modules/attachments/uploads/*` | 3 |
| Attachment download | KEEP | `modules/attachments/download` | 3 |
| Inline images | KEEP | (in `send-message`) | 3 |
| Signatures | DEFER | `modules/signatures/*` | 3 |
| Search | DEFER | `modules/messages/search` | 4 |
| Bulk admin operations | DEFER | `modules/admin/*/batch` | 4 |
| Provider back-sync | DEFER | `modules/provider-sync/*` | 4 |
| Custom R2 domain | KEEP | `system_settings.r2_public_domain` | 1 |
| Login background image | DEFER | `modules/admin/ui-settings` | 4 |
| Notice popups | DEFER | `modules/admin/notices` | 4 |
| Dark mode | KEEP | `apps/web/` (already implemented) | 0 |

## Admin features

| Feature | Decision | New home | Phase |
|---|---|---|---|
| Setup wizard | ADD | `modules/installation/*` | 0 |
| User management (CRUD) | KEEP | `modules/admin/users/*` | 1 |
| Role + permission management | KEEP | `modules/admin/roles/*` | 1 |
| Registration keys | KEEP | `modules/onboarding/registration-keys/*` | 1 |
| Signatures | DEFER | `modules/signatures/*` | 3 |
| System settings (read) | KEEP | `modules/admin/settings/*` | 1 |
| System settings (write) | KEEP | `modules/admin/settings/*` | 1 |
| Blocklist | KEEP | `modules/admin/settings/blocklist` | 1 |
| Webhook events log | KEEP | `modules/admin/webhook-events/*` | 1 |
| Audit log | ADD | `modules/admin/audit/*` | 1 |
| Analytics dashboard | DEFER | `modules/admin/analytics/*` | 4 |
| Maintenance jobs | ADD | `modules/maintenance/*` | 4 |
| Setup repair session | ADD | `modules/installation/repair` | 0 |
| Public admin token | REMOVE | — | 0 |
| `/test` route | REMOVE | — | 0 |

## Integrations

| Integration | Decision | New home | Phase |
|---|---|---|---|
| Cloudflare Email Routing (inbound) | KEEP | `entrypoints/inbound-email.ts` | 1 |
| Cloudflare Email binding (outbound) | DEFER | `integrations/providers/cf-sendmail` | 5 |
| Brevo (outbound + webhook) | KEEP | `integrations/providers/brevo/*` | 1 |
| Resend (outbound + webhook) | DEFER | `integrations/providers/resend/*` | 5 |
| Workers AI (code extraction) | DEFER | `integrations/ai-code-extract` | 5 |
| Telegram bot | DEFER | `integrations/telegram` | 5 |
| Cloudflare Turnstile | DEFER | `integrations/turnstile` | 5 |
| AWS S3 backend | DEFER | `platform/object-store.ts` | 5 |

## Storage

| Feature | Decision | New home | Phase |
|---|---|---|---|
| R2 (attachments) | KEEP | `platform/object-store.ts` | 1 |
| KV (sessions, settings cache, day counters, OAuth state, setup sessions) | KEEP | `platform/cache.ts` | 1 |
| D1 (canonical data) | KEEP | `platform/database.ts` | 1 |
| Secrets Store (encryption keys) | ADD | `platform/crypto.ts` | 0 |
| Cloudflare Queue (outbound jobs) | ADD | `entrypoints/queue.ts` | 1 |

## Cron / scheduled jobs

| Job | Decision | Phase |
|---|---|---|
| Outbound dispatcher recovery | ADD | 1 |
| Maintenance backfills | ADD | 4 |
| Session cleanup | ADD | 4 |
| Idempotency cleanup | ADD | 4 |
| Upload cleanup | ADD | 3 |
| Webhook cleanup | ADD | 4 |
| Orphan R2 cleanup | ADD | 4 |
| Analytics aggregation | DEFER | 4 |

## UNKNOWN items

| Item | Why unknown | Investigation needed |
|---|---|---|
| Whether real users depend on LinuxDo OAuth | Possible break-on-cutover | Audit legacy OAuth usage in last 90 days |
| Whether `/oss/*` is used | Could break screenshots / images | Check legacy access logs |
| Whether S3 backend is configured | Could add complexity | Audit `setting.s3_*` rows in production |
| Whether legacy settings.background image is used | Could break login UI | Inspect legacy Vue code + design |
| Whether any deployment uses `domainProviders` override | Could affect Brevo-only default | Check legacy setting rows |