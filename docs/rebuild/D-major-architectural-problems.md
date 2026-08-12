# D. Major Architectural Problems

The legacy system works. It is also full of problems that are **not worth carrying forward**. This document classifies them and prescribes an action per problem. The actions are applied **in the new repository**, not in this folder — the legacy system is not modified.

> **Rule applied:** a problem is **REMOVE** if it can be eliminated without changing business capability. It is **REDESIGN** if the legacy structure prevents the business from working at the next level of scale. It is **SIMPLIFY** if the legacy version does the same job but with more code than needed. It is **KEEP** if it is sound.

## D.1 Security-critical

### D.1.1 Single-round SHA-256 password hashing (`user-service`)  — **REDESIGN**

```text
password = sha256(salt + password)  // no PBKDF2, no constant-time compare
```

- 8-byte hex salt (default) — too short
- No iterations — single SHA-256 is GPU-crackable
- `user.password === computedHash` non-constant-time

**Why it matters:** the system stores user passwords for invited users, who often re-use passwords. A leak is catastrophic.

**Action:** PBKDF2-SHA256, ≥600k iterations, 16-byte salt, `crypto.subtle.timingSafeEqual`. Store algorithm + iteration count alongside hash.

### D.1.2 SQL injection in `public-service.addUser`  — **REMOVE**

Direct string concatenation of `email`, `password`, `salt`, `createIp`, `os` into a prepared statement string. Anyone with the public token can execute arbitrary SQL.

**Action:** delete `public-service` / `public-api` entirely. There is no demonstrated business need for an external bulk-user API.

### D.1.3 Plaintext secrets in `setting` table  — **REDESIGN**

`setting` columns store:

- `s3_access_key`, `s3_secret_key` (S3)
- `secret_key` (Turnstile)
- `tg_bot_token` (Telegram)
- `resend_tokens` (JSON; Resend keys)
- `brevo_webhook_secret` (Brevo)

Anyone with `setting:query` perm (any admin) can read all secrets.

**Action:** migrate secret storage to a `secrets_store` table backed by Cloudflare Secrets Store binding. `setting` keeps only references by ID; secrets never cross D1 rows.

### D.1.4 Prefix-based auth matching  — **REDESIGN**

```js
path.startsWith('/oss')        // matches /ossXYZ, /ostrich, ...
path.startsWith('/init')       // matches /init/anything
path.startsWith('/oauth')      // matches /oauth-foo
```

`/role/setDefault` is matched by `/role/set` (intentional but fragile).

**Action:** exact-route matching with a typed `PermissionRequirement` enum. No string prefixes.

### D.1.5 Two parallel sources of authorization truth  — **REMOVE**

`security.js` `requirePerms[]` is a hardcoded list of API paths. `perm.perm_key` table is the canonical permission catalog. The two already diverge (`/allEmail/get` is perm-mapped but not in `requirePerms`; `/allEmail/sync` is in `requirePerms` but unmapped).

**Action:** single source. Permission keys map to operations; operations map to routes in one place.

### D.1.6 `authInfo` is a stale KV snapshot  — **REDESIGN**

```js
c.set('user', authInfo.user)  // user object frozen at login time
```

If admin bans a user, the user's permissions persist until next login.

**Action:** permission checks consult the DB on every request (or use a short-TTL cached permission set, max 5 minutes).

### D.1.7 JWT without mandatory `exp`  — **REMOVE**

The JWT itself has no required expiration claim. Only KV TTL protects the session. A token leaked from logs stays valid until KV TTL (30 days).

**Action:** JWT must have `exp`; verify it on every request.

### D.1.8 Open or weakly-guarded endpoints  — **REMOVE**

- `/oss/*` — no auth; static files served by R2 fallback
- `/init/:secret` — full migration runner, secret in URL
- `/test/*` — ships to production
- `/telegram/getEmail/:token` — long-lived signed URL with no rotation

**Action:** delete `/test/*`. Gate `/oss/*` on a session if static files are sensitive. Move setup to a KV-backed setup session, not a URL-secret.

## D.2 Domain leakage

### D.2.1 `email-service.send` is three services in one  — **REDESIGN**

`send` orchestrates provider selection, quota, signature, attachment partition, inline-image rewrite, threading header build, provider call, response normalization, on-site delivery, KV day-counter, DB insert, attachment save. 311 lines.

**Action:** split into `ComposeMessage`, `SendMessage`, `OnSiteDeliver`, `TrackSendOutcome`. Use case orchestrates.

### D.2.2 Provider SDKs leak into `email-service`  — **REDESIGN**

`BrevoClient`, `Resend`, `c.env.email.send` are imported directly in `email-service`. Adding a provider means editing the orchestrator.

**Action:** `ProviderRegistry` with `OutboundProviderAdapter` interface. Application use cases call `provider.send(payload)`, never `brevoClient.sendTransacEmail`.

### D.2.3 linux.do fields leak into `oauth` table  — **REMOVE**

`oauth` table stores `trust_level`, `silenced`, `avatar_url` — values that are specific to the LinuxDo provider.

**Action:** strip to `(identity_provider, provider_user_id, profile_json)`. Provider-specific data goes in `profile_json`.

### D.2.4 Brevo error-message regex in Resend code path  — **REMOVE**

A Brevo-shaped error message regex is matched inside the Resend error path.

**Action:** delete the cross-pollination. Each adapter classifies its own errors.

### D.2.5 `setting` god-object  — **REDESIGN**

57 columns in a single row with no primary key. Reads happen on every request; writes happen anywhere.

**Action:** split into `system_settings` (boolean toggles), `secrets_store` (encrypted credentials), `integration_settings` (provider-connection configuration), `ui_settings` (title, background, notice copy).

### D.2.6 `att-service.toImageUrlHtml` mixes 5 concerns  — **REDESIGN**

A 170-line function parses HTML, dedups, fetches from R2, checks sizes, and normalizes MIME.

**Action:** split into `parseHtmlImages`, `resolveImageSources`, `deduplicateImages`. Each ≤ 30 lines.

## D.3 Schema & data

### D.3.1 Type-default mismatches  — **REMOVE**

- `att.status` text with default `'0'`
- `user.sort` and `user.sendCount` text columns with numeric defaults
- `verify_record.ip` **integer** with default `''`
- `setting.loginOpacity` **integer** with default `0.88` (truncates to 0)

**Action:** delete and recreate columns in a clean schema (Phase 0 migration).

### D.3.2 Schema drift  — **REMOVE**

- `settingConst.kvStorage` and `authRefresh` have no backing column
- `account.status` and `user.type` columns exist but no enum object
- `webhook_event.status` nullable with no default while `email.status` defaults to 0

**Action:** the new schema is authoritative. Constants match columns 1:1.

### D.3.3 Hand-rolled runtime migrations  — **REDESIGN**

23 sequential functions (`intDB → v3_8DB`) with `addColumnIfMissing`, `columnExists`, `runIdempotentMigrationStatements`. INSERT-OR-IGNORE race windows.

**Action:** Wrangler migrations + Drizzle. One migration authority. Each migration has metadata + verification fixture. (Already specified in `doc/rebuild-blueprint.md` §16.2.)

### D.3.4 JSON-in-text columns  — **REDESIGN**

`email.recipient` (JSON array of `{address, name}`), `email.code`, `email.relation`, `email.cc`, `email.bcc`, `setting.resendTokens` (JSON object), `setting.domainProviders` (JSON object), `setting.managedDomains` (JSON array), `setting.adminEmails` (JSON array), `role.banEmail` (comma-joined), `role.availDomain` (comma-joined with `@`-prefixed domains).

**Action:** proper relational columns. `message_recipients` table. `provider_connections` table. Enum-typed columns.

### D.3.5 Soft-delete as `isDel INTEGER` everywhere  — **SIMPLIFY**

Every table has `isDel INTEGER DEFAULT 0`. No consistency on what soft-deleted means (some queries `isDel=NORMAL`, others `isDel=0`, some include-del queries exist for account lookup).

**Action:** explicit `deleted_at TIMESTAMP NULL` per table. Repository methods named `findIncludingDeleted` if the use case needs it.

## D.4 Historical / accidental complexity

### D.4.1 23 sequential migration steps in one file  — **REMOVE**

`init.js` contains 23 `v*DB` methods, each adding columns, indexes, and INSERT statements. The README's init script also runs the file. Each step has its own try/catch and `console.warn` fallbacks.

**Action:** Wrangler migrations directory (`migrations/NNNN_*.sql`). Each migration has a paired verification file.

### D.4.2 `test-api.js` is zero bytes  — **REMOVE**

Empty file still wired into the API surface.

**Action:** delete file; ensure no imports.

### D.4.3 `pnpm test` actually deploys  — **REDESIGN**

```json
"test": "wrangler deploy --config wrangler-test.toml"
```

There is **no** unit test command in `package.json`. Vitest is a devDep but never wired into the npm scripts.

**Action:** separate scripts: `test:unit`, `test:worker`, `test:integration`, `test:e2e`. None deploy.

### D.4.4 Member-role maps duplicated  — **REMOVE**

`accountMemberService.ROLE` (`{VIEWER:1, SENDER:2, ADMIN:3}`) plus `account-service.list` hardcoded `1/2/3 → viewer/sender/admin`. Two sources of truth.

**Action:** one enum. Use string values in code; integers only in DB.

### D.4.5 Typos baked into the codebase  — **REMOVE**

- `utils/domain-uitls.js`
- `utils/date-uitil.js`
- column `rege_key_id`
- permission key `seting:clear`

**Action:** clean naming during Phase 0 schema reset.

### D.4.6 `entity/verify-record.js` exports table as `email`  — **REMOVE**

Mislabeled export.

**Action:** delete and recreate entity module with correct name.

### D.4.7 Day-boundary logic reimplemented per service  — **SIMPLIFY**

`Asia/Shanghai` "today" logic reimplemented in every service that needs it (login-service, email-service, user-service).

**Action:** single `Clock` abstraction in `platform/clock.ts`. Inject everywhere.

### D.4.8 Dead state  — **REMOVE**

- `brevo-service.updated` counter
- `image-url-backfill-service.skipped` counter
- `useSendStore.deleteId` (no view consumes it)

**Action:** delete during Phase 0 cleanup.

### D.4.9 `/test` route ships to production  — **REMOVE**

The Vue and React clients both ship a `/test` route placeholder.

**Action:** exclude from production build via route registry.

### D.4.10 Errors swallowed to `console.error`  — **REDESIGN**

Telegram send, retention prune, attachment add — all silently log.

**Action:** structured error events. Idempotent retry where the action is recoverable.

## D.5 Wrong boundaries

### D.5.1 Modules mapped to pages  — **REDESIGN**

21 `api-*.js` files mirror the Vue page tree (`email-api`, `account-api`, `my-api`, `setting-api`, ...). Frontend-driven decomposition.

**Action:** modules mapped to **business capabilities**: `identity`, `mailboxes`, `messages`, `attachments`, `inbound-mail`, `outbound-mail`, `admin`. API routes group by capability, not page.

### D.5.2 `email` table holds inbound + outbound + drafts  — **REDESIGN**

`email.type` ∈ `{SEND, RECEIVE}` is the only split. `status` doubles as delivery status (sent, delivered, bounced) and lifecycle status (saving, noone, failed). Drafts are `type=SEND, status=SAVING` (de facto).

**Action:** `messages` (canonical), `mailbox_messages` (folder + read state), `outbound_jobs` (delivery state). Three tables.

### D.5.3 `account` is both mailbox and address  — **REDESIGN**

`account` table conflates mailbox metadata (`email`, `name`, `latest_email_time`) with mailbox ownership (`userId`). The relationship "user owns mailbox" is denormalized into `account.userId`.

**Action:** `mailboxes` table. Mailbox-member junction table for shared access.

### D.5.4 Frontend contains DB-shaped strings  — **REMOVE**

`mail-react/store/email.ts` carries raw `email.emailId`, `email.accountId`. Vue templates use `emailId` directly from server JSON.

**Action:** feature types in `packages/contracts`. Components consume types, not raw DTOs.

### D.5.5 Shared `/public` route prefix  — **REMOVE**

`/public/*` is gated by a single shared token. All admin operations available via this token.

**Action:** delete the public API. Bulk operations go through admin endpoints with rate limits.

## D.6 Premature or missing abstractions

### D.6.1 No provider registry  — **ADD (single registry)**

Already specified in `doc/rebuild-blueprint.md` §9.2. **Keep.**

### D.6.2 No idempotency layer  — **ADD (durable)**

Already specified in §6, §10.8. **Keep.**

### D.6.3 No outbox + queue  — **ADD (durable)**

Already specified in §6, §10.9-10.10. **Keep.**

### D.6.4 No setup wizard  — **ADD (single-pass)**

Already specified in §3.4. **Keep.**

### D.6.5 No maintenance jobs  — **ADD (cursor-based)**

Already specified in §6. **Keep.**

### D.6.6 No setup-failure repair session  — **ADD**

Already specified in §11.1. **Keep.**

### D.6.7 Notification subsystem  — **DEFER**

Email notifications (welcome, password reset, sent confirmations) are **deferred** to a later phase. The legacy system has none; we don't need them on day one.

### D.6.8 Plugin system  — **DEFER**

The legacy system has no plugin system. We don't need one either. The provider registry is the only "plugin" surface, and it has a clear, fixed interface.

### D.6.9 Event bus  — **DEFER**

The legacy code uses Pinia/Zustand stores as cross-component event buses (e.g., `useEmailStore.deleteIds`, `cancelStarEmailId`, `addStarEmailId`). We replace this with explicit component props and TanStack Query invalidation. **No event bus in the new system.**

## D.7 Summary table

| # | Problem | Action | Phase |
|---|---|---|---|
| D.1.1 | Weak password hashing | REDESIGN | 0 |
| D.1.2 | SQL injection in public-service | REMOVE | 0 |
| D.1.3 | Plaintext secrets | REDESIGN | 0 |
| D.1.4 | Prefix auth | REDESIGN | 0 |
| D.1.5 | Two auth sources | REMOVE | 0 |
| D.1.6 | Stale KV user snapshot | REDESIGN | 2 |
| D.1.7 | JWT without `exp` | REMOVE | 0 |
| D.1.8 | Open endpoints | REMOVE | 0 |
| D.2.1 | `send` is 3 services | REDESIGN | 2 |
| D.2.2 | Provider SDKs in email-service | REDESIGN | 2 |
| D.2.3 | linux.do fields in `oauth` | REMOVE | 3 |
| D.2.4 | Cross-provider regex | REMOVE | 2 |
| D.2.5 | `setting` god-object | REDESIGN | 0 |
| D.2.6 | `toImageUrlHtml` 170 lines | REDESIGN | 3 |
| D.3.1 | Type-default mismatches | REMOVE | 0 |
| D.3.2 | Schema drift | REMOVE | 0 |
| D.3.3 | Hand-rolled migrations | REDESIGN | 0 |
| D.3.4 | JSON in text columns | REDESIGN | 0 |
| D.3.5 | Inconsistent soft-delete | SIMPLIFY | 0 |
| D.4.1 | 23 migrations in one file | REMOVE | 0 |
| D.4.2 | Empty `test-api.js` | REMOVE | 0 |
| D.4.3 | `pnpm test` deploys | REDESIGN | 0 |
| D.4.4 | Duplicate member-role maps | REMOVE | 1 |
| D.4.5 | Filename/column typos | REMOVE | 0 |
| D.4.6 | `verify-record` exports as `email` | REMOVE | 0 |
| D.4.7 | Day-boundary logic duplicated | SIMPLIFY | 0 |
| D.4.8 | Dead counters | REMOVE | 0 |
| D.4.9 | `/test` ships to prod | REMOVE | 0 |
| D.4.10 | Errors swallowed | REDESIGN | 2 |
| D.5.1 | Page-mirrored APIs | REDESIGN | 0 |
| D.5.2 | `email` is 3 tables | REDESIGN | 0 |
| D.5.3 | `account` is 2 things | REDESIGN | 0 |
| D.5.4 | Frontend holds DB strings | REMOVE | 1 |
| D.5.5 | `/public` route prefix | REMOVE | 0 |
| D.6.1 | Provider registry | ADD | 2 |
| D.6.2 | Idempotency | ADD | 2 |
| D.6.3 | Outbox + queue | ADD | 2 |
| D.6.4 | Setup wizard | ADD | 0 |
| D.6.5 | Maintenance jobs | ADD | 4 |
| D.6.6 | Setup repair session | ADD | 0 |
| D.6.7 | Notifications | DEFER | 5 |
| D.6.8 | Plugin system | DEFER | — |
| D.6.9 | Event bus | DEFER | — |

Total of **41 problems identified**, mapped to the phase where each is resolved.
