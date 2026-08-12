# I. Legacy → New Mapping

## Purpose of this document

The rebuild lives in a **new repository**. No code is copied from the legacy system. This document maps every legacy module, file, table, and column to one of:

- **MIGRATE** — keep the business meaning; rebuild the implementation in the new repo.
- **RENAME** — same concept, new name.
- **MERGE** — combine with another legacy concept.
- **SPLIT** — break apart into multiple new entities.
- **REMOVE** — drop from the new system.
- **DEFER** — keep in legacy for now; do not port until later phase in the new repo.
- **UNKNOWN** — needs investigation.

The new repo's `docs/capability-ledger.md` is the live tracker; this document is the input.

## I.1 Module mapping (worker)

| Legacy module | Action | New home | Notes |
|---|---|---|---|
| `service/email-service.js` | SPLIT | `modules/messages/*`, `modules/inbound-mail/*`, `modules/outbound-mail/*`, `modules/attachments/*` | 311-line `send` becomes 5 use cases |
| `service/account-service.js` | RENAME | `modules/tenancy/mailboxes/*` | `account` becomes `Mailbox` |
| `service/account-member-service.js` | MIGRATE | `modules/tenancy/mailbox-members/*` | Same logic, new entity names |
| `service/user-service.js` | MIGRATE | `modules/identity/users/*` | PBKDF2 rewrite |
| `service/role-service.js` | MIGRATE | `modules/admin/roles/*` | Drop ban/avail policy for Phase 1 |
| `service/perm-service.js` | MIGRATE | `modules/admin/permissions/*` | Trim keys to canonical set |
| `service/setting-service.js` | SPLIT | `modules/admin/settings/*`, `modules/admin/secrets/*` | Split god-object |
| `service/att-service.js` | SPLIT | `modules/attachments/*` | 170-line function split |
| `service/attachment-upload-service.js` | MIGRATE | `modules/attachments/uploads/*` | Keep presign logic |
| `service/attachment-migration-service.js` | MIGRATE | `scripts/migrate-from-legacy/attachments` | One-shot batch in Phase 4 |
| `service/image-url-backfill-service.js` | MIGRATE | `modules/maintenance/image-url-backfill` | One-shot maintenance job |
| `service/login-service.js` | MIGRATE | `modules/identity/auth/*` | PBKDF2, refresh rotation |
| `service/oauth-service.js` | DEFER | `modules/identity/oauth/linuxdo` (Phase 5) | LinuxDo only |
| `service/reg-key-service.js` | MIGRATE | `modules/onboarding/registration-keys/*` | Hash code, store hash only |
| `service/signature-service.js` | DEFER | `modules/signatures/*` (Phase 3) | HTML sanitizer rewrite |
| `service/star-service.js` | DEFER | `modules/messages/star` (Phase 3) | Per-user state |
| `service/super-admin-service.js` | REMOVE | n/a | Admin email list replaced by Role-based check |
| `service/telegram-service.js` | DEFER | `modules/integrations/telegram` (Phase 5) | |
| `service/turnstile-service.js` | DEFER | `modules/integrations/turnstile` (Phase 5) | |
| `service/brevo-service.js` | MIGRATE | `integrations/providers/brevo/*` | Provider plugin pattern |
| `service/resend-service.js` | DEFER | `integrations/providers/resend/*` (Phase 5) | |
| `service/provider-sync-service.js` | DEFER | `modules/provider-sync/*` (Phase 4) | |
| `service/provider-webhook-state-service.js` | MIGRATE | `modules/outbound-mail/webhook-delivery/*` | Keep idempotency shape |
| `service/ai-service.js` | DEFER | `modules/integrations/ai-code-extract` (Phase 5) | |
| `service/analysis-service.js` | DEFER | `modules/admin/analytics/*` (Phase 4) | Simpler counters |
| `service/r2-service.js` | RENAME | `platform/object-store.ts` | R2 + S3 facade |
| `service/s3-service.js` | DEFER | `platform/object-store.ts` (Phase 5) | |
| `service/kv-obj-service.js` | RENAME | `platform/cache.ts` | |
| `service/public-service.js` | REMOVE | n/a | SQL injection + no business need |
| `service/verify-record-service.js` | DEFER | `modules/onboarding/turnstile-challenge` (Phase 5) | |
| `service/webhook-event-service.js` | MIGRATE | `modules/admin/webhook-events/*` | Same shape |
| `api/email-api.js` | MIGRATE | `http/routes/messages/*` | |
| `api/account-api.js` | MIGRATE | `http/routes/mailboxes/*` | |
| `api/admin-account-api.js` | MIGRATE | `http/routes/admin/mailboxes/*` | |
| `api/my-api.js` | MIGRATE | `http/routes/me/*` | |
| `api/login-api.js` | MIGRATE | `http/routes/auth/*` | |
| `api/reg-key-api.js` | MIGRATE | `http/routes/admin/registration-keys/*` | |
| `api/role-api.js` | MIGRATE | `http/routes/admin/roles/*` | |
| `api/user-api.js` | MIGRATE | `http/routes/admin/users/*` | |
| `api/setting-api.js` | MIGRATE | `http/routes/admin/settings/*` | |
| `api/signature-api.js` | DEFER | `http/routes/signatures/*` (Phase 3) | |
| `api/star-api.js` | DEFER | `http/routes/messages/star` (Phase 3) | |
| `api/public-api.js` | REMOVE | n/a | |
| `api/oauth-api.js` | DEFER | `http/routes/auth/oauth/*` (Phase 5) | |
| `api/r2-api.js` | MIGRATE | `http/routes/attachments/*` | |
| `api/brevo-api.js` | MIGRATE | `http/routes/webhooks/brevo/*` | |
| `api/resend-api.js` | DEFER | `http/routes/webhooks/resend/*` (Phase 5) | |
| `api/all-email-api.js` | MIGRATE | `http/routes/admin/messages/*` | |
| `api/analysis-api.js` | DEFER | `http/routes/admin/analytics` (Phase 4) | |
| `api/telegram-api.js` | DEFER | `http/routes/integrations/telegram` (Phase 5) | |
| `api/test-api.js` | REMOVE | n/a | Empty file |
| `api/webhook-event-api.js` | MIGRATE | `http/routes/admin/webhook-events/*` | |
| `api/init-api.js` | REMOVE | n/a | Replaced by `/setup/*` |
| `email/email.js` | MIGRATE | `modules/inbound-mail/entry.ts` | Read raw bytes as ArrayBuffer |
| `init/init.js` | REMOVE | n/a | Wrangler migrations replace |
| `security/security.js` | MIGRATE | `http/middleware/authn.ts`, `http/middleware/authz.ts` | |
| `security/user-context.js` | MIGRATE | `http/middleware/principal.ts` | |
| `utils/email-utils.js` | MIGRATE | `packages/email-core/addressing.ts` | Pure functions |
| `utils/brevo-email-utils.js` | MIGRATE | `integrations/providers/brevo/email-content.ts` | |
| `utils/email-id-utils.js` | MIGRATE | `packages/email-core/threading.ts` | |
| `utils/crypto-utils.js` | MIGRATE | `platform/crypto.ts` | PBKDF2 |
| `utils/jwt-utils.js` | MIGRATE | `platform/auth-tokens.ts` | Add `exp` |
| `utils/r2-presign-utils.js` | MIGRATE | `platform/object-store.ts#presignPut` | |
| `utils/d1-schema-utils.js` | REMOVE | n/a | Use Drizzle + Wrangler migrations |
| `utils/file-utils.js` | MIGRATE | `packages/email-core/parsing.ts` | |
| `utils/domain-uitls.js` | RENAME | `packages/email-core/domain.ts` | Fix typo |
| `utils/date-uitil.js` | RENAME | `platform/clock.ts` | Fix typo |
| `utils/req-utils.js` | MIGRATE | `http/middleware/*` | |
| `utils/time-utils.js` | MERGE | `platform/clock.ts` | |
| `utils/verify-utils.js` | DEFER | `modules/onboarding/turnstile` (Phase 5) | |
| `utils/provider-webhook-utils.js` | MIGRATE | `modules/outbound-mail/webhook-delivery/utils.ts` | |
| `utils/attachment-email-utils.js` | MIGRATE | `modules/attachments/email-utils.ts` | |
| `entity/*.js` | MIGRATE | `modules/*/domain/entities.ts` | Drizzle, TypeScript |
| `model/result.js` | MIGRATE | `http/responses.ts` | Typed envelope |
| `error/biz-error.js` | RENAME | `platform/errors.ts` | `DomainError` |
| `const/entity-const.js` | SPLIT | per-module enums in TS | |
| `const/constant.js` | MIGRATE | `platform/constants.ts` | |
| `const/attachment-const.js` | MIGRATE | `modules/attachments/constants.ts` | |
| `const/kv-const.js` | MIGRATE | `platform/cache-keys.ts` | |
| `hono/hono.js` | MIGRATE | `http/app.ts` | |
| `hono/webs.js` | MIGRATE | `http/router.ts` | |
| `template/email-html.js` | MIGRATE | `modules/outbound-mail/templates/*` | |
| `template/email-msg.js` | MIGRATE | `modules/outbound-mail/templates/*` | |
| `template/email-text.js` | MIGRATE | `modules/outbound-mail/templates/*` | |
| `dao/analysis-dao.js` | MIGRATE | `modules/admin/analytics/repository.ts` | |
| `service/email-service.js::HandleOnSiteEmail` | SPLIT | `modules/outbound-mail/on-site-delivery.ts` | Own use case |
| `service/email-service.js::withSignature` | DEFER | `modules/signatures/*` (Phase 3) | |

## I.2 Database table mapping

| Legacy table | Action | New table(s) | Notes |
|---|---|---|---|
| `email` | SPLIT | `messages`, `mailbox_messages`, `message_recipients`, `message_user_state`, `outbound_jobs` | `email.type` becomes message type; status split |
| `account` | RENAME | `mailboxes` | `account_id` → `mailbox_id` |
| `user` | MIGRATE | `users` | New ID type (UUID v4) |
| `att`/`attachments` | RENAME | `message_attachments` + `attachment_uploads` | Two-table model with triggers |
| `star` | DEFER | `message_user_state.is_starred` (Phase 3) | Boolean flag, not separate table |
| `account_member` | RENAME | `mailbox_members` | New ID types |
| `oauth` | MIGRATE | `oauth_accounts` | Drop linux.do-specific columns |
| `reg_key` | RENAME | `registration_keys` | Hash code, drop plaintext `code` |
| `perm` | MIGRATE | `permissions`, `roles`, `role_permissions`, `user_roles` | Split into 4 tables |
| `role` | MIGRATE | `roles` | Drop ban/avail for Phase 1 |
| `role_perm` | RENAME | `role_permissions` | Junction with composite PK |
| `signature` | DEFER | `domain_signatures` (Phase 3) | |
| `setting` (57 cols) | SPLIT | `system_settings`, `encrypted_credentials`, `installation_state` (partial) | God-object eliminated |
| `verify_record` | DEFER | `verification_records` (Phase 5) | |
| `webhook_event` | RENAME | `webhook_events` | New ID type |
| `provider_email_state` | RENAME | `provider_message_state` | Same shape, new name |
| `webhook_delivery` | MIGRATE | `webhook_deliveries` | Same shape |

### Column-level mapping for `email` (the highest-blast-radius split)

| Legacy column | Action | New column | Notes |
|---|---|---|---|
| `email_id` | RENAME | `messages.id` | UUID v4 |
| `send_email` | RENAME | `messages.from_address` | |
| `name` | MERGE | `messages.from_name` | |
| `account_id` | RENAME | `messages.sender_mailbox_id` | nullable for inbound |
| `user_id` | RENAME | `messages.created_by_user_id` | nullable for inbound |
| `subject` | MIGRATE | `messages.subject` | |
| `content` | MIGRATE | `messages.html_body` | |
| `text` | MIGRATE | `messages.text_body` | |
| `cc` | SPLIT | `message_recipients` rows (type='cc') | Proper relational |
| `bcc` | SPLIT | `message_recipients` rows (type='bcc') | |
| `recipient` | SPLIT | `message_recipients` rows (type='to') | |
| `to_email` | DERIVE | from `message_recipients` | Computed, not stored |
| `to_name` | DERIVE | from `message_recipients` | Computed, not stored |
| `in_reply_to` | RENAME | `messages.in_reply_to_header` | |
| `relation` | RENAME | `messages.references_header` | |
| `message_id` | RENAME | `messages.message_id_header` | |
| `type` | DERIVE | from `mailbox_messages.folder` + `messages.created_by_user_id` | |
| `status` | MIGRATE | `messages.status` | Same enum values |
| `resend_email_id` | RENAME | `provider_message_state.provider_message_id` | Side-table |
| `provider` | MIGRATE | `provider_message_state.provider_key` | Side-table |
| `message` | RENAME | `messages.error_message` | |
| `unread` | MIGRATE | `message_user_state.is_read` | Per-user |
| `create_time` | RENAME | `messages.created_at` | |
| `is_del` | RENAME | `messages.deleted_at` | Timestamp not int |
| `code` | REMOVE | n/a | Was AI-extracted code, deferred to Phase 5 |

### Column-level mapping for `account` → `mailboxes`

| Legacy | New |
|---|---|
| `account_id` | `mailboxes.id` (UUID v4) |
| `email` | `mailboxes.address` (unique case-insensitive) |
| `name` | `mailboxes.display_name` |
| `status` | `mailboxes.status` (active/disabled/deleted) |
| `latest_email_time` | `mailboxes.latest_received_at` (denormalized counter, optional) |
| `create_time` | `mailboxes.created_at` |
| `user_id` | `mailboxes.owner_user_id` |
| `all_receive` | REMOVE | Per-mailbox inbox toggle belongs to `MessageUserState` semantics |
| `sort` | `mailboxes.sort_order` (renamed) |
| `is_del` | `mailboxes.deleted_at` |

### Column-level mapping for `user` → `users`

| Legacy | New |
|---|---|
| `user_id` | `users.id` (UUID v4) |
| `email` | `users.email` (unique case-insensitive) |
| `type` | `users.default_role_id` (FK) |
| `password` (sha256 + salt) | `users.password_hash` (PBKDF2) + `users.password_salt` + `users.password_algorithm` + `users.password_iterations` |
| `status` | `users.status` (active/suspended/deleted) |
| `create_time` | `users.created_at` |
| `active_time` | `users.last_active_at` |
| `create_ip`/`active_ip` | REMOVE | Privacy |
| `os`/`browser`/`device` | REMOVE | Not needed |
| `sort` | REMOVE | |
| `send_count` | REMOVE | Per-day counter; live-computed |
| `reg_key_id` | `users.consumed_registration_key_id` (FK) | |
| `is_del` | `users.deleted_at` |

### Column-level mapping for `setting` → split

The 57-column `setting` table splits across:

- `system_settings`: registration policy, inbound/outbound switches, attachment limits, blocklist policy.
- `encrypted_credentials`: API keys (Brevo, Resend, S3, Turnstile, Telegram bot token), encrypted payload.
- `installation_state`: partially (setup-step state lives here).

Specific mappings:

| Legacy column | New home | Notes |
|---|---|---|
| `register` | `system_settings.registration_enabled` | boolean |
| `receive` | `system_settings.inbound_enabled` | boolean |
| `send` | `system_settings.outbound_enabled` | boolean |
| `add_email` | REMOVE | Mailbox-create permission is global perm |
| `many_email` | REMOVE | Multi-mailbox is default |
| `title` | `system_settings.site_title` | |
| `auto_refresh` | REMOVE | UI-specific; default to sensible value |
| `register_verify` | DEFER | Phase 5 |
| `add_email_verify` | DEFER | Phase 5 |
| `tg_bot_token` | DEFER → `encrypted_credentials` (Phase 5) | |
| `tg_chat_id` | DEFER (Phase 5) | |
| `tg_bot_status` | DEFER (Phase 5) | |
| `forward_email` | DEFER (Phase 5) | |
| `forward_status` | DEFER (Phase 5) | |
| `rule_email` | DEFER (Phase 5) | |
| `rule_type` | DEFER (Phase 5) | |
| `black_subject` | `system_settings.subject_blocklist_json` | JSON array |
| `black_content` | `system_settings.content_blocklist_json` | JSON array |
| `black_from` | `system_settings.sender_blocklist_json` | JSON array |
| `ai_code` | DEFER (Phase 5) | |
| `ai_code_filter` | DEFER (Phase 5) | |
| `email_prefix_filter` | DEFER (Phase 5) | |
| `min_email_prefix` | DEFER (Phase 5) | |
| `site_key` | DEFER → `encrypted_credentials` (Phase 5) | |
| `secret_key` | DEFER → `encrypted_credentials` (Phase 5) | |
| `background` | DEFER (Phase 4) | |
| `login_opacity` | DEFER (Phase 4) | |
| `resend_tokens` | DEFER → `encrypted_credentials` (Phase 5) | |
| `r2_domain` | `system_settings.r2_public_domain` | |
| `r2` (binding) | env binding `ATTACHMENTS` | Not a setting |
| `kv_storage` | REMOVE | Use R2 by default |
| `force_path_style` | DEFER (Phase 5) | |
| `custom_domain` | DEFER (Phase 5) | |
| `tg_msg_to` / `tg_msg_from` / `tg_msg_text` | DEFER (Phase 5) | |
| `bucket` / `region` / `endpoint` / `s3_access_key` / `s3_secret_key` | DEFER → `encrypted_credentials` (Phase 5) | |
| `notice_*` | DEFER (Phase 4) | |
| `no_recipient` | `system_settings.unknown_recipient_policy` ('reject' | 'store') | |
| `reg_key` | REMOVE | Always invite-required |
| `reg_verify_count` / `add_verify_count` | DEFER (Phase 5) | |
| `login_domain` | REMOVE | Not needed |
| `domain` (env) | `managed_domains` table | First release = manual setup |
| `admin` (env) | `users.default_role='administrator'` for first user | Setup wizard creates first admin |
| `jwt_secret` (env) | `AUTH_SIGNING_KEY` + `CREDENTIAL_ENCRYPTION_KEY` | |
| `managed_domains` (col) | `managed_domains` table | First release |
| `admin_email` / `admin_emails` | REMOVE | Role-based admin |
| `domain_providers` | `provider_connections` table | First release = Brevo only |
| `brevo_webhook_secret` | `encrypted_credentials` (Phase 1) | |
| `brevo_api_key` (env) | `encrypted_credentials` (Phase 1) | |

## I.3 Permission key mapping

| Legacy perm key | Action | New perm key |
|---|---|---|
| `email:delete` | RENAME | `message.delete` |
| `email:send` | RENAME | `message.send` |
| `email:sync` | RENAME | `provider.sync` |
| `account:add` | RENAME | `mailbox.create` |
| `account:query` | RENAME | `mailbox.read` (implicit on authenticated) |
| `account:delete` | MERGE | `mailbox.manage` |
| `account:member:query` | MERGE | `mailbox.share` |
| `account:member:set` | RENAME | `mailbox.share` |
| `admin:account:add` | RENAME | `domain.manage` |
| `admin:account:rename` | MERGE | `mailbox.manage` |
| `admin:account:delete` | MERGE | `mailbox.manage` |
| `my:delete` | RENAME | `account.delete` |
| `role:add` | RENAME | `role.manage` |
| `role:set` | MERGE | `role.manage` |
| `role:query` | RENAME | `role.read` |
| `role:delete` | MERGE | `role.manage` |
| `user:query` | RENAME | `user.read` |
| `user:add` | RENAME | `user.manage` |
| `user:reset-send` | REMOVE | Per-day quota dropped |
| `user:set-pwd` | MERGE | `user.manage` |
| `user:set-status` | MERGE | `user.manage` |
| `user:set-type` | MERGE | `user.manage` |
| `user:delete` | MERGE | `user.manage` |
| `user:star` | REMOVE | Dead perm |
| `all-email:query` | RENAME | `message.read` (with admin scope) |
| `all-email:delete` | RENAME | `message.delete` (with admin scope) |
| `setting:query` | RENAME | `settings.read` |
| `setting:set` | RENAME | `settings.manage` |
| `setting:clean` | REMOVE | Migration artifact |
| `seting:clear` | REMOVE | Typo, dead |
| `sys-email:query` | REMOVE | Renamed in v1.5 |
| `sys-email:delete` | REMOVE | Renamed in v1.5 |
| `analysis:query` | RENAME | `analytics.read` |
| `reg-key:add` | RENAME | `invite-code.create` |
| `reg-key:query` | RENAME | `invite-code.read` |
| `reg-key:delete` | RENAME | `invite-code.delete` |
| `signature:query` | RENAME | `signature.read` |
| `signature:set` | RENAME | `signature.manage` |
| `webhook-event:query` | RENAME | `webhook_event.read` |
| `webhook-event:clear` | RENAME | `webhook_event.delete` |

## I.4 Frontend route mapping

| Legacy route (Vue) | New route | Notes |
|---|---|---|
| `/` (redirect → /inbox) | `/` | |
| `/inbox` | `/inbox` | |
| `/message` | `/message` | |
| `/settings` | `/settings` | |
| `/starred` | `/starred` | (Phase 3) |
| `/settings/my-mailboxes` | `/settings/my-mailboxes` | |
| `/webhook-event` | `/admin/webhook-events` | Rename |
| `/login` | `/login` | |
| `/test` | n/a | REMOVED |
| n/a | `/setup/*` | ADD (Phase 0) |
| n/a | `/admin/users` | ADD (Phase 1) |
| n/a | `/admin/roles` | ADD (Phase 1) |
| n/a | `/admin/settings` | ADD (Phase 1) |
| n/a | `/admin/audit-events` | ADD (Phase 4) |
| n/a | `/admin/analytics` | ADD (Phase 4) |
| `/sent` | `/sent` | ADD (Phase 1) |
| `/drafts` | `/drafts` | ADD (Phase 3) |
| `/all-users` | `/admin/users` | |
| `/role` | `/admin/roles` | |
| `/system-setting` | `/admin/settings` | |
| `/signatures` | `/admin/signatures` | (Phase 3) |
| `/invite-code` | `/admin/invite-codes` | |
| `/all-mail` | `/admin/messages` | |
| `/analysis` | `/admin/analytics` | (Phase 4) |

The new client implements each of these routes in the new repo from scratch. There is no Vue-to-React port.

## I.5 Component / library mapping

| Legacy library | New library |
|---|---|
| Element Plus | shadcn/ui (Radix + Tailwind) |
| TinyMCE | Tiptap |
| Pinia (store-as-event-bus) | Zustand (UI state only) + TanStack Query (server state) |
| Vue Router 4 | React Router 7 |
| `vue-i18n` | `react-i18next` |
| `v-perm` directive | `usePermission` hook + `<Can>` component |
| `axios` (manual interceptors) | TanStack Query (built-in) + thin axios wrapper for mutations |
| Dexie (per-user DB) | Dexie (per-user DB) |
| `compressorjs` (image) | Deferred (Phase 5) |
| `nprogress` | TanStack Query loading state |
| `@iconify/vue` | `@iconify/react` |
| `localStorage` token | httpOnly cookie for refresh; access token in memory |
| TinyMCE-from-CDN | Tiptap npm package |

## I.6 What gets **deleted**

These are explicitly **not** built in the new repo:

- `public-api.js`, `public-service.js` (SQL injection + no business need)
- `init-api.js`, `init/init.js` (replaced by `/setup/*` + Wrangler migrations)
- `test-api.js` (empty file)
- `/test` route (Vue + React)
- `super-admin-service.js` (admin email list replaced by role-based check)
- `entity/verify-record.js`'s misnamed `email` export
- `utils/d1-schema-utils.js` (replaced by Drizzle migrations)
- `entity/setting.js` (split into multiple files)
- All numeric column defaults that hold JSON: replaced by typed columns
- All `startsWith` permission checks: replaced by exact-route matching
- The legacy `mail-vue/` directory (not copied; not ported)
- The legacy `mail-react/` package's `tiptap-editor/index.tsx` execCommand stub (a fresh Tiptap instance is built)
- The legacy `mail-react/` store-as-event-bus pattern (`useEmailStore.deleteIds`, `cancelStarEmailId`, `addStarEmailId` — replaced with TanStack Query invalidation)

## I.6.1 Why we don't port Vue or React from this folder

The new client is built **fresh** in the new repo. It uses:

- The same design tokens (OKLCH palette, Geist font, mono numerics) defined in `DESIGN.md`.
- The same feature boundaries (setup, auth, inbox, compose, mailboxes, admin).
- TanStack Query + Zustand + React Hook Form + Dexie + Tiptap as the standard stack.

We do **not** port the existing `mail-react/` source files. Reasons:

- The package has known issues (`tiptap-editor` is execCommand stub; store-as-event-bus hack; dead `useSendStore.deleteId`; missing `webhook-event` view).
- It depends on the legacy D1 contract, which the new system breaks.
- Its Element Plus-style admin pages need rework anyway.
- Starting from a clean architecture with shared contracts in `packages/contracts/` produces a more consistent implementation.

## I.7 What stays **unchanged** (as design patterns)

These architectural patterns from the legacy system are correct and worth carrying forward:

- Drizzle ORM usage pattern (already idiomatic).
- Hono router pattern (already idiomatic).
- D1 migrations + idempotency shape for webhooks (already correct).
- Per-mailbox authorization pattern (sound, just renamed).
- Soft-delete semantics (kept; consolidated under `deleted_at`).
- Use of `c.env` bindings (Hono + Workers pattern).
- Schema migrations via Drizzle (Wrangler-compatible).

## I.8 UNKNOWN items

| Item | Question | Suggested owner | Phase |
|---|---|---|---|
| Existing legacy attachments (R2 keys) — are they all under `attachments/`? Or also in KV (fallback)? | Do we need a dual-read path during migration? | Phase 4 migration script | 4 |
| Existing legacy OAuth users — do we keep their `password=null` login? | Phase 5 work item or REMOVE | TBD | 5 |
| Are there deployments running mail-vue with custom admin layouts we can't see? | Discover before cutover | TBD | Pre-Phase 4 |
| What is the actual daily mail volume per deployment? | Capacity test design | TBD | Phase 6 |
| Are admin emails hardcoded into wrangler.toml in real deployments? | May affect setup wizard scope | TBD | Phase 0 |
| Does anyone depend on `/oss/*` static file serving? | Could be REMOVE or KEEP | TBD | Pre-Phase 0 |