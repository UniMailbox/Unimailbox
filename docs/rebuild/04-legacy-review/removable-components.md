# Removable Components

A precise list of every legacy component that should be **deleted** in the rebuild, with the reason and the phase when deletion happens.

## Critical (Phase 0 — delete immediately)

| Component | Reason |
|---|---|
| **`mail-vue/` (entire directory)** | The Vue client is replaced by `mail-react/`. We do not maintain two web clients. Delete the directory; remove Element Plus, TinyMCE, Pinia, vue-i18n from any docs; point `wrangler.toml [assets]` at `mail-react/dist`. |
| `service/public-service.js` | SQL injection in `addUser`; no business need |
| `api/public-api.js` | Wraps the above; same risk |
| `api/init-api.js` | Replaced by `/setup/*` |
| `init/init.js` | Replaced by Wrangler migrations |
| `api/test-api.js` | Empty file |
| `/test` route (mail-vue + mail-react) | Dev artifact |
| `utils/d1-schema-utils.js` | Replaced by Drizzle migrations |
| `entity/setting.js` | 57-column god-object; replaced by split tables |
| `service/super-admin-service.js` | Admin email list replaced by role |
| `seting:clear` perm key | Typo, dead |
| `setting:clean` perm key | Migration artifact |
| `sys-email:query`, `sys-email:delete` | Renamed in v1.5; legacy has both |
| `user:star` perm | Dead |
| `rege_key_id` column typo | Renamed in Drizzle entity to `reg_key_id` |
| `verify-record.js` entity exports `email` table | Mislabeled |

## Dead state (Phase 0)

| Component | Reason |
|---|---|
| `brevo-service.updated` counter | Never read |
| `image-url-backfill-service.skipped` counter | Never read |
| `mail-react/useSendStore.deleteId` | No view consumes it |
| `commented out` send gating in `email-service.send` (ban + internal) | Was disabled; remove for clarity |

## File-name / naming typos (Phase 0)

| Legacy | Correct |
|---|---|
| `utils/domain-uitls.js` | `domain.ts` |
| `utils/date-uitil.js` | `clock.ts` |
| `entity/reg-key.js` column `rege_key_id` | `reg_key_id` (already correct in Drizzle) |
| `request/ouath.js` (Vue) | `oauth.ts` |

## Vendor-specific (Phase 5 — defer)

These are not removed; they are deferred to later phases and never part of Phase 1.

| Component | Phase |
|---|---|
| `service/oauth-service.js` (LinuxDo) | 5 |
| `service/turnstile-service.js` | 5 |
| `service/telegram-service.js` | 5 |
| `service/ai-service.js` | 5 |
| `service/s3-service.js` (S3 backend) | 5 |
| `service/resend-service.js` (Resend provider) | 5 |

## Frontend removals

| Component | Reason |
|---|---|
| `mail-vue/` (entire directory) | Vue client is replaced by `mail-react/`; not archived, not maintained in parallel |
| `mail-vue/src/views/test/` | (subsumed by directory deletion) |
| `mail-react/src/views/test/` | Dev artifact |
| `mail-react/src/store/send.ts` `deleteId` | Dead |
| `mail-react/src/store/email.ts` `addStarEmailId`, `cancelStarEmailId` | Replace with TanStack Query invalidation |

## Database columns to delete

These exist in legacy but should not exist in the rebuild schema:

| Table | Column | Reason |
|---|---|---|
| `email` | `code` | Was AI-extracted code; defer to Phase 5 |
| `email` | `unread` | Becomes `message_user_state.is_read` |
| `email` | `is_del` | Becomes `deleted_at` |
| `email` | `type` | Derived from `mailbox_messages.folder` |
| `email` | `resendEmailId` | Becomes `provider_message_state.provider_message_id` |
| `email` | `provider` | Becomes `provider_message_state.provider_key` |
| `email` | `to_email`, `to_name` | Derived from `message_recipients` |
| `email` | `recipient`, `cc`, `bcc` | Becomes `message_recipients` |
| `account` | `all_receive` | Mailbox-level toggle removed |
| `account` | `is_del` | Becomes `deleted_at` |
| `user` | `password`, `salt` | Becomes `password_hash`, `password_salt`, etc. |
| `user` | `create_ip`, `active_ip`, `os`, `browser`, `device` | Privacy; not needed |
| `user` | `sort`, `send_count` | Computed; not stored |
| `user` | `is_del` | Becomes `deleted_at` |
| `role` | `avail_domain`, `ban_email`, `ban_email_type`, `send_type`, `send_count`, `account_count` | Per-role policy deferred to Phase 5 |
| `setting` (entire table) | (all 57 columns) | Split into typed tables |
| `attachments` | `status` (numeric enum) | Becomes string |
| `attachments` | `type` (numeric enum) | Becomes string |

## What we do **not** remove

- The **concept** of webhook delivery idempotency — keep the shape, rename.
- The **concept** of registration keys — keep the shape, hash the code.
- The **concept** of roles + permissions — keep, trim key set.
- The **concept** of mailbox membership — keep, with proper IDs.
- The **concept** of blocklist — keep, normalize into `system_settings`.
- The **concept** of attachment uploads — keep, add proper auth.