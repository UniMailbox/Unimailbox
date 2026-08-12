# Legacy → New Mapping (Reference)

The full table is in `../I-legacy-new-mapping.md`. This document is a quick-reference summary.

## Top 25 most-used legacy modules and where they go

| Legacy | Decision | New |
|---|---|---|
| `service/email-service.js` | SPLIT | 5 use cases in `modules/messages/`, `modules/inbound-mail/`, `modules/outbound-mail/`, `modules/attachments/` |
| `service/account-service.js` | RENAME | `modules/tenancy/mailboxes/*` |
| `service/account-member-service.js` | MIGRATE | `modules/tenancy/mailbox-members/*` |
| `service/user-service.js` | MIGRATE | `modules/identity/users/*` |
| `service/login-service.js` | MIGRATE | `modules/identity/auth/*` |
| `service/setting-service.js` | SPLIT | `modules/admin/settings/*` + `modules/admin/secrets/*` |
| `service/role-service.js` | MIGRATE | `modules/admin/roles/*` |
| `service/perm-service.js` | MIGRATE | `modules/admin/permissions/*` |
| `service/reg-key-service.js` | MIGRATE | `modules/onboarding/registration-keys/*` |
| `service/att-service.js` | SPLIT | `modules/attachments/*` |
| `service/attachment-upload-service.js` | MIGRATE | `modules/attachments/uploads/*` |
| `service/brevo-service.js` | MIGRATE | `integrations/providers/brevo/*` |
| `service/resend-service.js` | DEFER | `integrations/providers/resend/*` (Phase 5) |
| `service/provider-webhook-state-service.js` | MIGRATE | `modules/outbound-mail/webhook-delivery/*` |
| `service/provider-sync-service.js` | DEFER | `modules/provider-sync/*` (Phase 4) |
| `service/webhook-event-service.js` | MIGRATE | `modules/admin/webhook-events/*` |
| `service/analysis-service.js` | DEFER | `modules/admin/analytics/*` (Phase 4) |
| `service/ai-service.js` | DEFER | `modules/integrations/ai-code-extract` (Phase 5) |
| `service/telegram-service.js` | DEFER | `modules/integrations/telegram` (Phase 5) |
| `service/turnstile-service.js` | DEFER | `modules/integrations/turnstile` (Phase 5) |
| `service/oauth-service.js` | DEFER | `modules/identity/oauth/linuxdo` (Phase 5) |
| `service/signature-service.js` | DEFER | `modules/signatures/*` (Phase 3) |
| `service/star-service.js` | DEFER | `modules/messages/star` (Phase 3) |
| `service/r2-service.js` | RENAME | `platform/object-store.ts` |
| `service/kv-obj-service.js` | RENAME | `platform/cache.ts` |

## Files explicitly removed

| Legacy | Reason |
|---|---|
| `service/public-service.js` | SQL injection + no business need |
| `service/super-admin-service.js` | Replaced by role-based admin |
| `api/public-api.js` | SQL injection + no business need |
| `api/test-api.js` | Empty file |
| `api/init-api.js` | Replaced by `/setup/*` + Wrangler migrations |
| `init/init.js` | Replaced by Wrangler migrations |
| `utils/d1-schema-utils.js` | Replaced by Drizzle migrations |
| `entity/setting.js` | Split into multiple files |

## Files renamed

| Legacy | New |
|---|---|
| `email/email.js` | `modules/inbound-mail/entry.ts` |
| `security/security.js` | `http/middleware/authn.ts` + `authz.ts` |
| `hono/hono.js` | `http/app.ts` |
| `hono/webs.js` | `http/router.ts` |
| `utils/domain-uitls.js` | `packages/email-core/domain.ts` |
| `utils/date-uitil.js` | `platform/clock.ts` |
| `error/biz-error.js` | `platform/errors.ts` |

## Database tables: top 10 mappings

| Legacy | New |
|---|---|
| `email` | `messages` + `mailbox_messages` + `message_recipients` + `message_user_state` + `outbound_jobs` |
| `account` | `mailboxes` |
| `user` | `users` |
| `att` / `attachments` | `message_attachments` + `attachment_uploads` |
| `star` | `message_user_state.is_starred` |
| `account_member` | `mailbox_members` |
| `perm` | `permissions` + `roles` + `role_permissions` + `user_roles` |
| `role` | `roles` |
| `setting` | `system_settings` + `encrypted_credentials` + (partial) `installation_state` |
| `webhook_event` | `webhook_events` |