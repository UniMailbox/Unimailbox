# B. Current Business Capability Map

This is what the legacy system **actually does** — not what its folder structure claims. Each capability is annotated with the module(s) that implement it, the entities it touches, and any unusual behavior worth flagging.

## B.1 Identity & Tenancy

| Capability | Module(s) | Entities | Notes |
|---|---|---|---|
| Register with invite key | `login-service`, `reg-key-service` | `user`, `reg_key`, `setting`, `verify_record` | Turnstile-gated when `registerVerify=OPEN` or COUNT threshold hit. Email length ≤64, password 6–30. Prefix length gated by `minEmailPrefix`. |
| Login (password) | `login-service`, `security` | `user`, KV sessions | PBKDF2... wait, **single-round SHA-256(salt+pwd)** with non-constant-time compare. JWT with KV-backed session list capped at 10 tokens per user. |
| Login (LinuxDo OAuth) | `oauth-service` | `oauth`, `user` | linux.do fields (`trust_level`, `silenced`, `avatar_url`) leak into `oauth` table. Skips `registerVerify`. |
| Logout / token rotate | `login-service` | KV sessions | Tokens rotated on every refresh. |
| Reset password | `user-service`, `login-service` | `user` | Revokes all KV sessions on success. |
| Delete account (self) | `user-service` | `user`, KV sessions | Cascades oauth, sessions, emails. |

**Smell:** Two parallel auth paths (password + OAuth) with different password-stored columns (`password=null` for OAuth users). Password hashing is **not** PBKDF2/Argon2 despite `entity-const` and migration comments suggesting otherwise.

## B.2 Mailbox Management

| Capability | Module(s) | Entities | Notes |
|---|---|---|---|
| Create mailbox | `account-service`, `account-api` | `account`, `user`, `role` | Requires `addEmail=OPEN ∧ manyEmail=OPEN`. Turnstile if `addEmailVerify=OPEN`. Honors role's `account_count` cap. |
| Rename mailbox | `account-service` | `account` | ≤30 chars; perm `account:member:set` (or owner). |
| Pin / set-as-top | `account-service` | `account` | Re-sorts account list. |
| Delete mailbox | `account-service` | `account`, `email`, `att`, `account_member` | Cascade-deletes emails and memberships. |
| All-receive toggle | `account-service` | `account` | Closes siblings of same owner (turns off `all_receive` on others). |
| Share mailbox (member) | `account-member-service` | `account_member` | Roles: `viewer:1`, `sender:2`, `admin:3`. Cannot add self, cannot add owner. Self-removal allowed. |

**Smell:** `account.email` has `idx_account_email_nocase` unique index (good) but no enum `status` despite a `status INTEGER DEFAULT 0 NOT NULL` column. Role-numeric mapping duplicated in `accountMemberService.ROLE` and `account-service.list`.

## B.3 Inbound Mail

| Capability | Module(s) | Entities | Notes |
|---|---|---|---|
| Receive (Email Routing) | `email.js`, `email-service.receive` | `email`, `att`, `account` | `TextDecoder` chunked read of raw stream — loses binary integrity (real bytes should be `ArrayBuffer`). PostalMime parse. |
| Recipient resolution | `account-service.selectByEmailIncludeDel` | `account`, `user` | Hard-deleted accounts (`isDel=1`) still get matched by `selectByEmailIncludeDel`. |
| Blocklist | `setting.blackSubject/Content/From`, `email.js.checkBlock` | `setting` | Substring match on subject, HTML, and text. Substring-and-domain match on from. |
| Save email | `emailService.receive` | `email` | Status `SAVING`, then `RECEIVE` or `NOONE`. |
| Save attachments | `att-service.addAtt` | `att`, R2 | Filename hash + extension = R2 key. Errors swallowed. |
| AI extract verification code | `ai-service.extractCode` | `setting`, `email`, Workers AI | llama-3.1-8b-instruct. Triggered when `aiCode=OPEN`. |
| Telegram forward | `telegram-service.sendEmailToBot` | `email`, `setting`, Telegram API | Tokenized render. Triggered when `tgBotStatus=OPEN ∧ tgChatId` set. |
| Email forward | `message.forward(email)` | n/a | Cloudflare Email Routing forward API. Triggered when `forwardStatus=OPEN ∧ forwardEmail` set, optionally filtered by `ruleEmail` allowlist. |

**Smell:** `email.js` reads raw MIME as `TextDecoder` chunks — POP3/IMAP and forensic retention are impossible without a separate byte path. Status `SAVING → RECEIVE` is recovered by `emailService.completeReceiveAll` cron, but **the cron is daily** — a 24-hour stuck-SAVING window. `att-service.addAtt` is wrapped in try/catch with `console.error` — partial saves are silently allowed.

## B.4 Outbound Mail

| Capability | Module(s) | Entities | Notes |
|---|---|---|---|
| Compose + send | `email-service.send` | `email`, `att`, `user`, `role`, `setting`, Brevo/Resend/CF SDK | Provider pick: `domainProviders[domain]` override → CF → Resend → Brevo. |
| Send quota | `email-service.send`, `user-service` | `user`, `role` | `role.sendType` ∈ `count|day|ban|internal`. `internal` is **commented out** in code (`role.sendType === 'internal' && !allInternal` is dead). |
| Signature injection | `email-service.withSignature` | `signature` | Inserted before `<blockquote class="cmq-reply-quote">` on reply, else appended after `-- `. |
| Reply threading | `email-service.send` | `email` | `In-Reply-To = parent.messageId`; `References = parent.relation + parent.messageId` (concatenated with space). |
| Inline image rewriting | `att-service.toImageUrlHtml` | `att`, R2 | linkedom-based HTML parse, dedup, R2 fetch, max 50 inline. |
| Attachment partition | `attachment-email-utils.partitionEmailAttachments` | `att` | Splits into "uploaded" (R2 URL → link) and "provider" (inline base64). |
| Provider call (CF) | `email-service.sendByCloudflareEmail` | CF Email binding | CC/BCC merged into TO (CF binding does not support them). |
| Provider call (Resend) | `email-service.sendByResend` | Resend SDK | Supports CC/BCC. |
| Provider call (Brevo) | `email-service.sendByBrevo` | Brevo SDK | Inline images → R2 URL rewrite; attachments as base64. |
| On-site delivery | `email-service.HandleOnSiteEmail` | `email`, `account`, `role`, `att` | Pure-internal send still writes a copy per recipient mailbox. CC/BCC recipient resolution considers recipient's role `availDomain` / `banEmail`. |
| Save sent email | `email-service.send` | `email`, `att` | Single D1 insert after provider call. Save happens even on provider failure (`status=FAILED`). |
| Daily send counter | `email-service.send` | KV `send_day_count:YYYY-MM-DD` | 24h TTL, incremented only on success. |

**Smell:** Provider-specific code (`Brevo`, `Resend`, `CF`) lives inside `email-service` — adding a new provider means editing the orchestrator. `send` is 311 lines and does: provider selection, quota check, signature injection, attachment partition, inline-image rewrite, threading header build, provider call, response normalization, on-site delivery, KV day counter, DB insert, attachment save. **One function = three services.**

## B.5 Attachments

| Capability | Module(s) | Entities | Notes |
|---|---|---|---|
| Presigned R2 upload | `attachment-upload-service` | R2 | SigV4-signed PUT URL. 5-min TTL. |
| Validate upload | `attachment-upload-service.validateReferences` | R2 | `R2.head` to confirm object exists. |
| Direct attachment persist | `att-service.addAtt` | `att`, R2 | Hash-key dedup. |
| Inline image CID rewrite | `att-service.toImageUrlHtml` | `att`, `email`, R2 | linkedom DOM traversal. ≤50 inline images. |
| KV→R2 migration | `attachment-migration-service` | `att`, KV, R2 | One-shot, idempotent. |
| Backfill image URLs | `image-url-backfill-service` | `email`, R2 | Rewrites `{{domain}}` placeholders. |
| Public object serving | `r2-service.toObjResp`, `/static/`, `/attachments/` | R2 | Plain R2 GET through Worker. |

**Smell:** Storage backend fallback chain is `S3 > R2 > KV` chosen at runtime by `r2Service` — but KV is documented as the **fallback** for small attachments and creates a 25 MiB-per-D1-row hazard for POP3. `attachments.key` is a SHA-256 hash + extension — no namespace, no UUID.

## B.6 Administration

| Capability | Module(s) | Entities | Notes |
|---|---|---|---|
| User CRUD | `user-service`, `user-api` | `user`, `oauth`, `account`, `role` | 14 endpoints. |
| Role + permission tree | `role-service`, `perm-service` | `role`, `perm`, `role_perm` | Default role (id=1) cannot be deleted. |
| Registration keys | `reg-key-service` | `reg_key`, `role` | One-time codes, role-bound, expiry, history. |
| Signatures | `signature-service` | `signature` | Per-domain. Regex sanitizer. |
| System settings | `setting-service`, `setting-api` | `setting`, KV `setting:` | 57 columns. |
| Blacklist | `setting-service.setBlacklist`, `email.js.checkBlock` | `setting` | subject/content/from comma lists. |
| Website config (login bg, title, opacity) | `setting-service` | `setting`, R2 | Uploaded bg image stored in R2. |
| Background image upload | `setting-api`, `setting-service` | R2 | `/setting/setBackground`. |
| Webhook event log | `webhook-event-service` | `webhook_event` | 30-day retention. |
| Provider back-sync | `provider-sync-service`, `brevo-service`, `resend-service` | `email`, `provider_email_state`, `webhook_delivery` | Cursor-based. Idempotency locks. |
| Provider webhook ingest | `brevo-service`, `resend-service` | `email`, `webhook_delivery`, `provider_email_state` | svix-verified (Resend) or secret-header (Brevo). |
| Telegram bot config | `telegram-service`, `setting-api` | `setting` | `tg_bot_token`, `tg_chat_id`. |
| AI policy | `ai-service`, `setting-api` | `setting` | `aiCode`, `aiCodeFilter`. |
| Turnstile | `turnstile-service` | `setting` | Cloudflare siteverify. |
| OAuth (LinuxDo) | `oauth-service` | `oauth`, `user` | `connect.linux.do`. |
| ECharts analytics | `analysis-service` | D1 group-by, KV `analysis_echarts:` | Cron `*/30 * * * *` refresh. Daily cron runs the rest. |
| Public admin token | `public-service`, `public-api` | KV `public_key:`, `user`, `account` | External bulk user creation. **String-concatenated SQL — SQL injection vector.** |

**Smell:** `setting` table is the de facto configuration store **and** secret store **and** UI state store. Every admin capability reads from it. Migrations add columns; nothing removes them.

## B.7 Cross-cutting Capabilities

| Capability | Module(s) | Notes |
|---|---|---|
| Authorization | `security/security.js`, `security/user-context.js` | Hono middleware. JWT verify → KV session check → perm prefix match → admin email-list bypass. |
| Scheduled jobs | `index.js.scheduled` | Cron `*/30 * * * *` (analysis cache), `0 16 * * *` (daily: clear verify records, reset day-count, complete receive, clear orphan OAuth, refresh echarts). |
| KV usage | `kv-obj-service`, multiple | Sessions (`auth-uid:`), setting cache (`setting:`), day counters (`send_day_count:YYYY-MM-DD`), public token (`public_key:`), echarts cache (`analysis_echarts:`), attachments (fallback only). |
| R2 usage | `r2-service`, `attachment-upload-service` | Attachments, public attachment serving, login background, KV-fallback. |
| S3 usage | `s3-service` | Optional external S3 backend. Force-path-style configurable. |
| Cloudflare Email binding | `email/email.js` (inbound), `email-service.sendByCloudflareEmail` (outbound) | `c.env.email.send` for outbound. |
| Workers AI | `ai-service` | `c.env.ai.run('@cf/meta/llama-3.1-8b-instruct')`. |
| Migration runner | `init/init.js` | Sequential: `intDB → v1_1DB → ... → v3_8DB`. URL-guarded by `jwt_secret`. No checksums, no rollback. |

## B.8 Side-effect surface

External integrations in priority order (by reversibility of change):

| Side effect | Provider | Module(s) | Risk |
|---|---|---|---|
| D1 SQL | Cloudflare D1 | All services | Schema-coupled; 23 migrations in sequence. |
| R2 | Cloudflare R2 | `r2-service`, `att-service`, `setting-service` | Object keys derived from content hash; clean migration requires UUID-namespace version. |
| KV | Cloudflare KV | `kv-obj-service`, `security`, `setting-service`, `analysis-service` | Used as both session store and config cache. |
| Cloudflare Email Routing | CF Email | `email/email.js`, `email-service.sendByCloudflareEmail` | TCP inbound — cannot host POP3/IMAP. |
| Resend | Resend SDK | `resend-service`, `email-service.sendByResend` | API token in `setting.resendTokens` (JSON object). |
| Brevo | Brevo SDK | `brevo-service`, `email-service.sendByBrevo` | API key + webhook secret in `setting` plaintext. |
| Telegram | api.telegram.org | `telegram-service` | Bot token in `setting.tg_bot_token` plaintext. |
| Workers AI | CF AI binding | `ai-service` | Free 8B model. |
| Turnstile | CF siteverify | `turnstile-service` | Secret in `setting.secret_key` plaintext. |
| OAuth | linux.do | `oauth-service` | External fetch. |
| S3 (optional) | AWS S3 | `s3-service` | `s3_access_key`, `s3_secret_key` plaintext in `setting`. |

## B.9 What is *not* in the current system (genuine absences)

These are **missing capabilities** the rebuild blueprint claims but the legacy code does not implement:

- **Idempotency keys** on send — no `Idempotency-Key` header support, no replay store.
- **Provider-neutral outbound** — no registry pattern; every provider has its own switch in `email-service.send`.
- **Setup wizard** — installation is "edit `wrangler.toml` vars, hit `/api/init/:secret`".
- **Maintenance job table** — no `maintenance_jobs` table; migrations are ad-hoc ALTERs.
- **OAuth setup mode** — only LinuxDo user OAuth, no Cloudflare account OAuth.
- **Outbox + queue consumer** — single `email` row write is the entire durability story.
- **POP3/IMAP** — explicitly out of scope (see `doc/pop3-implementation-plan.md`).
- **Sandboxed HTML rendering for compose preview** — compose uses raw TinyMCE.
- **Real rich-text editor** — both Vue and React fall back to `document.execCommand` or TinyMCE-from-CDN.
- **TanStack Query / SWR** — manual `useState` + `useEffect` fetch loops in every view.
- **Tailwind/shadcn on the legacy Vue client** — Element Plus remains.

## B.9.1 A second web client (the rebuild removes this)

The legacy system runs **two web clients** in parallel:

- **`mail-vue/`** — Vue 3 + Element Plus + TinyMCE. 17 views, 14 API files, 10 Pinia stores. The official production client.
- **`mail-react/`** — React 19 + shadcn/ui + Tailwind. 16 of 17 views ported. The intended successor, in progress.

This is duplicated work: every API change must be reflected in both; both define their own routing, store shape, request layer, and i18n keys. The two clients share no contracts. Tests run against neither. The Vue build produces the static assets served by the Worker; the React build is not wired into production yet.

**The rebuild has exactly one client.** `mail-vue/` is **deleted** in Phase 0. The in-progress `mail-react/` package becomes `apps/web/` and is the sole user-facing surface. There is no Element Plus, no TinyMCE, no Vue runtime in the rebuild dependency tree.

## B.10 What the legacy system actually does well

The legacy is not worthless. These pieces work and should be preserved as-is or with minimal change:

- **Drizzle-based D1 access** — keeps SQL explicit and migration-friendly.
- **Hono on Workers** — already correctly used at the routing layer.
- **Status enum + state transitions** — `SAVING → RECEIVE → DELIVERED` is sound; we keep it.
- **Mailbox-level permission gating** — `account_member` with role checks is the right pattern.
- **Provider webhook idempotency** — `webhook_delivery` table with lock token is the right shape.
- **One-shot backfill services** — `attachment-migration`, `image-url-backfill` are well-bounded.
- **Schedule cron separation** — daily vs half-hourly cron is the right cadence split.
- **Soft-delete (`isDel`)** — recoverable for user delete; will be **kept** but consolidated under a single "lifecycle" column.

The rebuild is **not** a from-scratch rewrite. It is a **restructuring** of an existing body of working code into a clearer shape.
