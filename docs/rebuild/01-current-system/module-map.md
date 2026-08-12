# 02 — Module Map

This is a per-module responsibility statement for the legacy system. Read together with `01-current-system/repository-map.md`.

## A. Worker backend

### A.1 Identity

| File | Responsibility |
|---|---|
| `service/login-service.js` | Register / login / refresh / logout / reset password / OAuth bind |
| `service/oauth-service.js` | LinuxDo OAuth (token exchange, profile fetch, bind) |
| `service/user-service.js` | User CRUD, ban, status, role, password, send count, restore |
| `service/verify-record-service.js` | IP-based attempt counter (Turnstile threshold) |
| `service/turnstile-service.js` | Cloudflare siteverify |

**Smells:** password hashing is single-round SHA-256 (non-constant-time compare); no PBKDF2/Argon2. KV session list capped at 10 tokens. JWT has no required `exp`.

### A.2 Tenancy

| File | Responsibility |
|---|---|
| `service/account-service.js` | Mailbox CRUD, sort, top, all-receive toggle, cascade delete |
| `service/account-member-service.js` | Membership CRUD + `can(op)` gate |

**Smells:** `account` conflates mailbox and owner. Role enum duplicated between service and account list.

### A.3 Messages

| File | Responsibility |
|---|---|
| `service/email-service.js` | Send / receive / list / delete / latest / on-site delivery / inline image rewrite / attachment partition |
| `service/att-service.js` | Attachment persist, dedup, inline CID rewriting, R2 fetch |
| `service/star-service.js` | Star/unstar |

**Smells:** `email-service.send` is 311 lines, owns provider selection + quota + signature + partition + threading + on-site + KV counter + DB write. Three services in one function.

### A.4 Inbound mail

| File | Responsibility |
|---|---|
| `email/email.js` | Cloudflare Email Routing handler |
| `service/email-service.receive` | Insert message row |

**Smells:** raw bytes decoded via `TextDecoder` chunks, breaking binary integrity.

### A.5 Outbound mail

| File | Responsibility |
|---|---|
| `service/email-service.sendByCloudflareEmail` | CF Email binding |
| `service/email-service.sendByResend` | Resend SDK |
| `service/email-service.sendByBrevo` | Brevo SDK |

**Smells:** provider SDK imports live in `email-service`; no registry.

### A.6 Provider integration

| File | Responsibility |
|---|---|
| `service/brevo-service.js` | Brevo webhook ingest + sync |
| `service/resend-service.js` | Resend webhook ingest + sync |
| `service/provider-sync-service.js` | Cross-provider sync orchestrator |
| `service/provider-webhook-state-service.js` | Webhook dedup + status FSM |

### A.7 Attachments

| File | Responsibility |
|---|---|
| `service/att-service.js` | Persist + dedup + inline rewrite |
| `service/attachment-upload-service.js` | Presigned R2 PUT |
| `service/attachment-migration-service.js` | KV→R2 one-shot migration |
| `service/image-url-backfill-service.js` | Backfill `{{domain}}` placeholders |
| `service/r2-service.js` | R2 facade (put/get/head/delete) |
| `service/s3-service.js` | S3 facade |
| `service/kv-obj-service.js` | Object serving via KV fallback |

### A.8 Administration

| File | Responsibility |
|---|---|
| `service/setting-service.js` | 57-column setting CRUD + KV cache + R2 background |
| `service/role-service.js` | Role CRUD + ban/avail/send policy |
| `service/perm-service.js` | Permission tree |
| `service/reg-key-service.js` | Invite-code CRUD |
| `service/signature-service.js` | Per-domain signature + sanitizer |
| `service/super-admin-service.js` | Admin email list |
| `service/webhook-event-service.js` | Webhook audit log |

### A.9 Audit / analytics

| File | Responsibility |
|---|---|
| `service/analysis-service.js` | ECharts dashboard aggregation |
| `service/ai-service.js` | Workers AI code extraction |
| `service/telegram-service.js` | Telegram bot forwarding |
| `service/public-service.js` | Public admin token API (bulk user create) |

**Smells:** `public-service.addUser` is the SQL-injection vector. No audit log.

### A.10 Security & middleware

| File | Responsibility |
|---|---|
| `security/security.js` | Global JWT + KV session + perm middleware |
| `security/user-context.js` | Sets `user` on context |
| `hono/hono.js` | CORS + global error handler |
| `hono/webs.js` | Route composition |

### A.11 Bootstrap

| File | Responsibility |
|---|---|
| `init/init.js` | Sequential migration runner (`/api/init/:secret`) |

**Smells:** 23 migrations in one file, hardcoded INSERTs.

## B. Frontend — Vue (mail-vue)

### B.1 Auth & shell

| File | Responsibility |
|---|---|
| `layout/index.vue` | App shell |
| `layout/main/index.vue` | Main content + account panel |
| `layout/aside/index.vue` | Sidebar nav |
| `layout/header/index.vue` | Header + dark toggle |
| `layout/write/index.vue` | Compose drawer (fullscreen) |
| `layout/account/index.vue` | Mailbox switcher |
| `views/login/index.vue` | Login/register/LinuxDo/Turnstile |

### B.2 Inbox / message

| File | Responsibility |
|---|---|
| `views/email/index.vue` | Inbox list |
| `views/content/index.vue` | Message detail |
| `views/send/index.vue` | Sent list |
| `views/draft/index.vue` | Draft list (Dexie) |
| `views/star/index.vue` | Starred list |
| `components/email-scroll/*` | Virtualized list |
| `components/tiny-editor/*` | TinyMCE wrapper |

### B.3 Settings & mailbox

| File | Responsibility |
|---|---|
| `views/setting/index.vue` | Personal profile |
| `views/my-mailbox/index.vue` | Mailbox management |
| `views/signature/index.vue` | Per-domain signature |

### B.4 Admin

| File | Responsibility |
|---|---|
| `views/all-email/index.vue` | Cross-user mail |
| `views/analysis/index.vue` | ECharts dashboard |
| `views/user/index.vue` | User management |
| `views/role/index.vue` | Roles + perm tree |
| `views/reg-key/index.vue` | Invite codes |
| `views/sys-setting/index.vue` | System settings (1700 lines) |
| `views/webhook-event/index.vue` | Webhook log |

### B.5 State / API / utility

| File | Responsibility |
|---|---|
| `store/account.ts`, `user.ts`, `email.ts`, `ui.ts`, `setting.ts`, `writer.ts`, `draft.ts`, `send.ts`, `role.ts`, `signature.ts` | Pinia stores |
| `router/index.js` | Routes |
| `perm/perm.js` | `v-perm` directive + route gate |
| `request/*` (14 files) | API client |
| `axios/index.js` | Axios instance + interceptors |
| `i18n/en.js`, `zh.js` | Translations |
| `db/db.js` | Dexie schema |
| `init/init.js` | Bootstrap |
| `echarts/index.js` | ECharts helpers |

## C. Frontend — React (mail-react)

Mirror of mail-vue with same views (minus `webhook-event`) + same store-as-event-bus pattern. Layout uses shadcn/ui Sheet for compose. Components/ui/ has 25 Radix primitives. Stores in `src/store/` (Zustand) including the dead `useSendStore`.

`components/tiptap-editor/index.tsx` is misnamed — uses `document.execCommand`, not Tiptap.

`src/db/db.ts` declares Dexie `mail_${email}` with `draft` + `att` object stores, scoped per user.

`src/i18n/en.ts` (418 lines) and `zh.ts` (419 lines), flat namespace.
