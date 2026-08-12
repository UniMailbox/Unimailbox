# Business Fact Catalog

A business fact is a statement that the system **must** honor. Each fact has evidence (where we saw it) and a confidence rating (High = explicit in multiple places, Medium = explicit in one place, Low = inferred from context).

## Authentication & identity

| ID | Fact | Evidence | Confidence |
|---|---|---|---|
| BF-001 | A user must authenticate with email + password to use the system | `login-service`, `security/security.js`, `/login` UI | High |
| BF-002 | Passwords are stored hashed, never plaintext | `user.password` (sha256 + salt) | High but **hash is weak** |
| BF-003 | A user can have at most 10 active sessions at a time (FIFO eviction) | `login-service` KV token list cap | High |
| BF-004 | Refresh tokens are rotated on every refresh | `login-service.refresh` | High |
| BF-005 | Sessions are revoked when password is reset | `user-service.resetPassword` | High |
| BF-006 | Email registration requires a registration key when `setting.regKey=OPEN` | `login-service.register` | High |
| BF-007 | Registration can be disabled globally | `setting.register` | High |
| BF-008 | A registered user can be banned by admin | `user-service.ban` | High |
| BF-009 | A banned user is force-logged-out | `user-service.ban` → KV session purge | High |
| BF-010 | Self-deletion is irreversible (soft-delete with cascade) | `user-service.physicsDeleteUserIds` | High |
| BF-011 | LinuxDo OAuth is a secondary auth path (skips Turnstile) | `oauth-service.linuxDo` | Medium |
| BF-012 | OAuth users have `password=null` in legacy (no password set) | `oauth-service` | High |
| BF-013 | (UNRESOLVED) OAuth users must register a password to use the rebuild | decision pending | Low |

## Mailbox

| ID | Fact | Evidence | Confidence |
|---|---|---|---|
| BF-014 | A mailbox is owned by exactly one user | `account.userId` | High |
| BF-015 | A mailbox address is unique case-insensitively under a managed domain | `idx_account_email_nocase` | High |
| BF-016 | Mailbox creation requires `account:add` permission | `account-service.add` | High |
| BF-017 | Mailbox creation is gated by global `addEmail=OPEN ∧ manyEmail=OPEN` | `account-service.add` | High |
| BF-018 | Mailbox creation may require Turnstile | `setting.addEmailVerify` | Medium |
| BF-019 | A role can cap the number of mailboxes per user | `role.account_count` | High |
| BF-020 | A mailbox can be shared with members of three roles: viewer, sender, admin | `accountMemberConst.role` | High |
| BF-021 | The owner cannot be added as a member | `account-member-service.add` | High |
| BF-022 | A member cannot add themselves | `account-member-service.add` | High |
| BF-023 | A member can remove themselves (no perm required) | `account-member-service.remove` | High |
| BF-024 | An admin role on a mailbox can rename + manage members + send + read | `account-member-service.can(op)` | High |
| BF-025 | A viewer can only read | same | High |
| BF-026 | A sender can read + send | same | High |
| BF-027 | Only the owner can delete a mailbox | `account-service.delete` | High |
| BF-028 | Deleting a mailbox cascade-deletes its messages and attachments | `account-service.physicsDeleteByAccountId` | High |
| BF-029 | Mailbox display name ≤ 30 chars | `account-service.setName` | High |
| BF-030 | A mailbox can be pinned to top of list | `account-service.setAsTop` | High |
| BF-031 | (UNRESOLVED) "All-receive" toggle (inbox shows all owned mailboxes) is legacy-only | rebuild blueprint drops | Low |

## Inbound

| ID | Fact | Evidence | Confidence |
|---|---|---|---|
| BF-032 | Inbound mail is received via Cloudflare Email Routing | `email/email.js` | High |
| BF-033 | Inbound mail is parsed with PostalMime | `email/email.js` | High |
| BF-034 | Raw MIME bytes are read as chunked TextDecoder — **binary integrity is lost** | `email/email.js` lines 42-49 | High (smell) |
| BF-035 | The recipient is matched against the `account` table by `account.email` | `account-service.selectByEmailIncludeDel` | High |
| BF-036 | Blocklists (subject/content/from) are comma-separated strings in `setting` | `email.js.checkBlock` | High |
| BF-037 | Blocklist match is substring (subject/content) or exact-or-domain (from) | `email.js.checkBlock` | High |
| BF-038 | When recipient is unknown and `noRecipient=CLOSE`, the message is rejected upstream | `email.js` `message.setReject` | High |
| BF-039 | When recipient is unknown and `noRecipient=OPEN`, the message is stored with status `NOONE` | `email-service.completeReceive` | High |
| BF-040 | Inbound messages pass through role-based policy: `availDomain` + `banEmail` | `email.js` lines 76-86 | High |
| BF-041 | If recipient's role rejects the sender (`banEmail`), the message is rejected | same | High |
| BF-042 | If recipient's role lacks `availDomain` for the address, the message is rejected | same | High |
| BF-043 | The AI verification-code extractor runs only when `aiCode=OPEN ∧ sender matches aiCodeFilter` | `ai-service.extractCode` | High |
| BF-044 | The Telegram bot forward runs only when `tgBotStatus=OPEN ∧ tgChatId` set | `telegram-service.sendEmailToBot` | High |
| BF-045 | The email forward runs only when `forwardStatus=OPEN ∧ forwardEmail` set | `email.js` `message.forward` | High |
| BF-046 | A daily cron recovers stuck `SAVING` messages | `email-service.completeReceiveAll` | High |
| BF-047 | (REBUILD CHANGE) Raw MIME bytes will be read once as `ArrayBuffer` | rebuild blueprint | High |

## Outbound

| ID | Fact | Evidence | Confidence |
|---|---|---|---|
| BF-048 | Outbound mail requires `email:send` permission | `security/security.js` | High |
| BF-049 | Outbound mail requires `account:member:set` or ownership of the sending mailbox | `account-member-service.can('send')` | High |
| BF-050 | Outbound mail can be disabled globally | `setting.send` | High |
| BF-051 | Provider selection: `domainProviders[domain]` override → CF → Resend → Brevo | `email-service.pickProvider` | High |
| BF-052 | A message with at least one external recipient requires a configured provider | `email-service.send` | High |
| BF-053 | Internal-only messages are stored without calling any provider | `email-service.HandleOnSiteEmail` | High |
| BF-054 | A role can cap send count (per-day or total) | `role.sendType` + `role.sendCount` | High |
| BF-055 | A banned sender role (`sendType='ban'`) cannot send — **but this is currently commented out** | `email-service.send` lines 267-278 | High (smell: dead code) |
| BF-056 | `sendType='internal'` only allows internal recipients — also commented out | same | High (smell) |
| BF-057 | Cloudflare Email binding does NOT support CC/BCC; merged into TO | `email-service.sendByCloudflareEmail` | High |
| BF-058 | Resend SDK supports CC/BCC | `email-service.sendByResend` | High |
| BF-059 | Brevo SDK supports CC/BCC; inline images rewritten to R2 URLs | `email-service.sendByBrevo` | High |
| BF-060 | Signature is injected per-domain (per `account.email` domain) | `email-service.withSignature` | High |
| BF-061 | Signature separator is `-- ` per RFC 3676 | `email-service.withSignature` | High |
| BF-062 | On reply, signature is inserted before the `<blockquote class="cmq-reply-quote">` | `email-service.withSignature` | High |
| BF-063 | `In-Reply-To` = parent message's `Message-ID` | `email-service.send` | High |
| BF-064 | `References` = parent's `References` + parent's `Message-ID` (concatenated) | `email-service.send` | High |
| BF-065 | Maximum 10 attachments per message | `email-service.send` | High |
| BF-066 | Maximum 50 inline images per message | `att-service.MAX_INLINE_IMAGES` | High |
| BF-067 | Maximum 64 MiB per attachment | `attachment-email-utils.findInvalidAttachment` | High |
| BF-068 | On-site delivery writes a per-recipient `email` row with `type=RECEIVE` | `email-service.HandleOnSiteEmail` | High |
| BF-069 | CC/BCC on-site recipients do not affect sender status; only TO bounces cause sender `BOUNCED` | same | High |
| BF-070 | Provider failure is stored as `email.status=FAILED`, error in `email.message` | `email-service.send` | High |
| BF-071 | Daily send counter is incremented only on success | `email-service.send` | High |
| BF-072 | (REBUILD CHANGE) Send will be idempotent (`Idempotency-Key` header) | rebuild blueprint | High |
| BF-073 | (REBUILD CHANGE) Send returns `queued` or `sent`; queue consumer calls provider | rebuild blueprint | High |
| BF-074 | (REBUILD CHANGE) Provider selection is via `ProviderRegistry`, not inline `if/else` | rebuild blueprint | High |

## Attachments

| ID | Fact | Evidence | Confidence |
|---|---|---|---|
| BF-075 | Attachments are stored in R2 (preferred) or KV (fallback) | `r2-service`, `kv-obj-service` | High |
| BF-076 | S3 is supported as alternative to R2 | `s3-service` | High |
| BF-077 | Attachment R2 key = SHA-256(content) + extension | `att-service.addAtt` | High |
| BF-078 | Direct upload uses presigned R2 PUT URLs with 5-min TTL | `attachment-upload-service` | High |
| BF-079 | Inline images use Content-ID with format `<id>` (RFC 2392) | `email-service.imgReplace` | High |
| BF-080 | Inline images are rewritten to public R2 URLs (`{{domain}}` placeholder → `r2_domain`) | `email-service.imgReplace` | High |
| BF-081 | Attachments are served via `/attachments/:key` public route | `r2-service.toObjResp` | High |
| BF-082 | (REBUILD CHANGE) Attachments will be authorized per-message | rebuild blueprint | High |
| BF-083 | (REBUILD CHANGE) Direct upload requires `attachment_uploads` row in `uploaded` status before consumption | rebuild blueprint | High |

## Provider integration

| ID | Fact | Evidence | Confidence |
|---|---|---|---|
| BF-084 | Brevo is a supported outbound provider | `email-service.sendByBrevo` | High |
| BF-085 | Brevo webhook signature uses a header secret (configurable per-deployment) | `brevo-service` | High |
| BF-086 | Resend is a supported outbound provider | `email-service.sendByResend` | High |
| BF-087 | Resend webhooks are verified via svix | `resend-service` | High |
| BF-088 | Cloudflare Email binding is supported when `c.env.email` is configured | `email-service.sendByCloudflareEmail` | High |
| BF-089 | Webhook delivery idempotency uses `webhook_delivery` with lock_token + 60s TTL | `provider-webhook-state-service` | High |
| BF-090 | Provider back-sync fetches status for known messages + imports unknown ones | `provider-sync-service` | High |
| BF-091 | Webhook events are logged to `webhook_event` with 30-day retention | `webhook-event-service` | High |
| BF-092 | (REBUILD CHANGE) Provider is selected via `ProviderRegistry` and never branched on in use cases | rebuild blueprint | High |

## Settings & administration

| ID | Fact | Evidence | Confidence |
|---|---|---|---|
| BF-093 | Settings are stored in a 57-column `setting` row (singleton) | `setting-service`, `entity/setting.js` | High |
| BF-094 | Settings cache is mirrored to KV with key `setting:` | `setting-service.refresh` | High |
| BF-095 | An admin is identified by email address (hardcoded list) | `settingService.isAdmin` | High |
| BF-096 | Roles have a perm tree with `type=BUTTON` leaf nodes | `perm-service.tree` | High |
| BF-097 | The default role (id=1, name='普通用户') cannot be deleted | `role-service.delete` | High |
| BF-098 | Deleting a role reassigns its users to the default role | `role-service.delete` | High |
| BF-099 | Per-role ban list (`banEmail`) supports exact email, domain (`@x.com`), or `*` | `role-service.isBanEmail` | High |
| BF-100 | Per-role available domain list (`availDomain`) supports `@domain` patterns; empty = allow all | `role-service.hasAvailDomainPerm` | High |
| BF-101 | ECharts analytics runs every 30 minutes (cron `*/30 * * * *`) | `analysis-service.refreshEchartsCache` | High |
| BF-102 | Daily cron runs `0 16 * * *` (Asia/Shanghai midnight) and does: clear verify records, reset day-count, complete receive, clear orphan OAuth, refresh echarts | `index.js.scheduled` | High |
| BF-103 | A public admin token (KV `public_key:`) allows unauthenticated bulk operations | `public-service`, `security.js` exclude `/public` | High (smell) |
| BF-104 | (REBUILD CHANGE) Public admin token is removed; SQL injection vector eliminated | rebuild blueprint | High |
| BF-105 | (REBUILD CHANGE) Admin identity is role-based, not email list | rebuild blueprint | High |
| BF-106 | (REBUILD CHANGE) All settings split into typed tables + Secrets Store | rebuild blueprint | High |

## Auth model

| ID | Fact | Evidence | Confidence |
|---|---|---|---|
| BF-107 | JWT is verified + KV session is checked on every protected request | `security/security.js` | High |
| BF-108 | Permission checks use path-prefix matching against a hardcoded `requirePerms[]` list | `security/security.js` | High (smell) |
| BF-109 | Permission keys are mapped to route prefixes in a hardcoded `premKey` table | `security/security.js` | High (smell) |
| BF-110 | (REBUILD CHANGE) Permissions are exact-route match, not prefix | rebuild blueprint | High |
| BF-111 | (REBUILD CHANGE) Permission sets consulted on every request, not from stale KV snapshot | rebuild blueprint | High |
| BF-112 | (REBUILD CHANGE) JWT must include `exp` claim | rebuild blueprint | High |

## Workflows

| ID | Fact | Evidence | Confidence |
|---|---|---|---|
| BF-113 | The complete setup is one-shot: install → admin → domain → inbound smoke test → brevo → outbound smoke test → complete | rebuild blueprint | High |
| BF-114 | A setup wizard session is short-lived in KV and one-time-use | rebuild blueprint | High |
| BF-115 | Maintenance jobs are cursor-based, idempotent, and registered by `job_key` | rebuild blueprint | High |
| BF-116 | Outbound send is durable: `outbound_jobs` row + queue consumer + scheduled recovery | rebuild blueprint | High |
| BF-117 | Idempotency keys are required on all mutating endpoints | rebuild blueprint | High |
