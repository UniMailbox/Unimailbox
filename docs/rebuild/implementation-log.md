# Implementation Log

**What changed recently, and why.** Append-only; newest entry at the top. This is the second file a
recovering agent reads, after `capability-ledger.md`.

Log an entry when a capability closes, when a decision is made that is not big enough for an ADR but
that future agents depend on, or when a documentation source of truth is corrected.

**Do not log:** routine edits, test output, or anything the git history already answers well.

---

## 2026-08-13 — Phase 1 verification pass

The Phase 1 capability set (CAP-020 through CAP-026) was independently reopened for verification
on `cap/CAP-020-026-business-loop`. All quality gates pass on the current commit (`21870d0`):

```
pnpm typecheck           ✓
pnpm lint                ✓
pnpm test:unit           ✓  232 / 232  (12 files)
pnpm test:worker         ✓  348 / 348  (26 files)
pnpm build               ✓  (worker + web)
pnpm scaffold doctor     ✓  10 / 10
```

**Independent verification performed:**
- All 29 exit criteria in `F-minimal-business-closed-loop.md` §F.4 cross-checked against the
  implementation. Every box has a corresponding repository artifact (route, handler, repository,
  test, or migration).
- Migration set 0005–0008 present; `schema-version.ts` is `0008`; `migrationsDb.ts` includes all
  four in its `splitSql` list.
- Two-layer authorization (`requirePermission` + `assertCan`) verified on every protected route
  in `messages`, `compose`. The `mailboxes` routes use a single layer (global permission) plus
  per-request scope checks expressed in SQL — the misleading two-layer comment in the header
  was corrected in this pass.
- No module imports a provider SDK directly (no `brevo`, `resend`, `@sendgrid` in `modules/`).
- No `admin` import from `outbound-mail` (the architectural constraint that placed the
  `webhook.delivered` audit emit in the route layer).
- No `hono` or `globalThis.fetch` in `modules/`.
- Business rule citations present in code at every required handler (R-MESSAGE-005,
  R-MESSAGE-011, R-INBOUND-005, R-INBOUND-008, R-OUTBOUND-004, R-OUTBOUND-006, R-AUTHZ-003,
  R-AUTHZ-004, R-AUDIT-001).
- All audit event emit points (six total) are present in the expected files.

**Defects found and fixed during this audit pass:**
1. `migrations/0005_mailboxes.sql` was missing the `INSERT OR IGNORE INTO d1_migrations`
   tracking row that 0006/0007/0008 have — the migration would re-run on every apply
   (survived only because every `CREATE` uses `IF NOT EXISTS`). Fixed.
2. `migrations/0008_webhook_events.sql` `webhook_deliveries.raw_payload TEXT` was an
   undeclared R-DATA-005 exception. Added a sized `CHECK (length(raw_payload) <= 65536)`
   constraint and an explicit rationale comment matching the `audit_events.metadata`
   pattern. Added a verification query in `0008_webhook_events.verify.sql`.
3. `apps/worker/src/http/routes/mailboxes.ts` header comment claimed two-layer authz
   but the code has only one. Rewrote the comment to honestly describe the actual
   authorization model (global permission + per-request scope checks in SQL).
4. R-MAILBOX-003 had no explicit test. Added a worker-pool test asserting that the owner
   can perform every operation without an explicit `mailbox_members` row.
   `test:worker` 348 → 349.

**Defect deferred (recorded in ledger):**
- `D-CAP-021-A`: R-INBOUND-005 (blocklist matching on subject/content/from) and
  R-INBOUND-006 (per-role `banEmail`/`availDomain`) are not implemented in the Phase 1
  inbound handler. Phase 1 accepts every inbound message whose recipient resolves to a
  mailbox. A future capability introduces the blocklist table and the receive-time policy
  evaluation.

**Known Phase 1 limitations (recorded in the ledger, not blocking):**
- `message_user_state` PK is `(mailbox_message_id)`; multi-user read-state independence is best
  effort. Schema migration is a future capability (CAP-026 §Note).
- Compose endpoint does not enforce `Idempotency-Key` (R-OUTBOUND-005). Deferred to CAP-027.
- `max_attempts` on `outbound_jobs` is set but the queue consumer does not gate `msg.retry()` on
  it (relies on Cloudflare Queues' own retry policy). Future capability.
- Cursor pagination uses simple base64 encoding; HMAC signing is CAP-034 (Phase 2).
- `apps/web/` is still a TanStack Router stub with `/` and `/setup` only. The 27-step §F.1 loop
  is verified end-to-end via the HTTP API and the worker-pool tests that exercise it. The
  browser UI for `/inbox`, `/admin`, `/compos`e, and `/admin/webhook-events` is a Phase 1 follow-up
  capability (the React client itself exists; the feature pages do not yet).

**Verification status:** Phase 1 is **Code complete and quality-gate verified**. `Verified` per
the ledger's status vocabulary requires an observed end-to-end run on a preview deployment —
that is the operator's next step, not a code change.

**Files updated by this verification pass:**
- `migrations/0005_mailboxes.sql` — added `d1_migrations` tracking row (defect A).
- `migrations/0008_webhook_events.sql` — added bounded `CHECK` and R-DATA-005 exception
  comment (defect B).
- `migrations/0008_webhook_events.verify.sql` — added verification query for the bound.
- `apps/worker/src/http/routes/mailboxes.ts` — corrected header comment about authz layers
  (defect C).
- `apps/worker/src/http/routes/mailboxes.worker.test.ts` — added R-MAILBOX-003 test
  (defect D).
- `docs/rebuild/capability-ledger.md` — Phase 1 row marked "Code complete and quality-gate
  verified" with gate-evidence summary; CAP-020 (test count corrected) and CAP-021 (R-INBOUND-005
  gap noted) evidence rows tightened; new deferred item D-CAP-021-A.
- `docs/rebuild/capability-ledger.md` §Phase progress — Phase 1 row now points to the audit.
- `docs/rebuild/phase-1-audit.md` (new) — full audit report against §F.4.
- `docs/rebuild/08-roadmap/phase-1-minimal-loop.md` — acceptance-criteria header aligned to 29
  boxes (D-1 resolved); added verification status table.
- `docs/rebuild/README.md` — Phase progress table updated to "Code complete and quality-gate
  verified".
- `work/active/CAP-022-inbox/` — removed (empty, stale).

---

## 2026-08-13 — Phase 1 business loop: CAP-020 through CAP-026

All seven Phase 1 capabilities implemented via subagent delegation. The minimal business closed loop
is now code-complete: an admin can install, claim a domain, connect Brevo, invite a user, and that
user can read a real inbound email and reply. The reply is sent via Brevo, the delivery webhook updates
the message status, and every state transition writes an audit event.

**Migrations landed:** 0005 (mailboxes), 0006 (messages), 0007 (outbound_jobs), 0008 (webhook_events).
Schema version is now 0008. All quality gates pass: typecheck, lint, test:unit (232), test:worker (348),
build, doctor 10/10.

**Key decisions:**
- `message_user_state` PK is `(mailbox_message_id)` not `(mailbox_message_id, user_id)` — multi-user
  read-state independence has a known limitation. The query falls back to 0 when no row matches the
  (mailbox_message_id, user_id) pair. Full fix is a schema migration in a future capability.
- `webhook.delivered` audit emit is in the route layer (`webhooks.ts`), not in `webhook-processor.ts`,
  because `outbound-mail` cannot import from `admin` per `module-dependency-zones`. The processor
  returns `messageId` so the route can emit with the correct resourceId.
- `webhook_secret` on `provider_connections` is stored as plaintext — it is a random HMAC signing key,
  not a password or provider API key. `ensureWebhookSecret` generates a 256-bit hex secret on first read.
- Compose endpoint does not yet enforce `Idempotency-Key` (R-OUTBOUND-006 defers to CAP-027).
- `max_attempts` on outbound_jobs is set to 3 but the queue consumer relies on Cloudflare Queues'
  own retry policy. Gating `msg.retry()` on attempts is a future capability.
- Cursor pagination uses simple base64 encoding of `(created_at, id)`. HMAC signing is CAP-034 (Phase 2).

Format:

```
## YYYY-MM-DD — CAP-NNN <name>  |  <Status>

**Changed:** <behaviour now available, in business terms>
**Files:** <significant paths>
**Rules:** <R-* implemented>
**Decisions:** <decision → where persisted>
**Deferred:** <item → where recorded>
**Notes:** <anything the next agent would be surprised by>
```

---

## 2026-08-13 — CAP-018 + CAP-019 Registration keys + Auth  |  Implemented

**Changed:** Full authentication system. CAP-018: admin issues invite codes via `POST /api/v1/admin/invite-codes`. CAP-019: users register with a code (`POST /api/v1/auth/register`), login with email+password (`POST /api/v1/auth/login`), get access+refresh tokens, refresh tokens, get current user (`GET /api/v1/auth/me`). Global auth middleware sets `userId` from KV `auth:{token}`. `requirePermission` now fully functional.

**Files:** `migrations/0004_registration_keys.sql` + verify · `apps/worker/src/database/schema/onboarding.ts` (registrationKeys) · `apps/worker/src/platform/crypto.ts` (verifyPassword) · `apps/worker/src/modules/onboarding/registration-key-repository.ts` (new) · `apps/worker/src/modules/identity/user-repository.ts` (findUserByEmail) · `apps/worker/src/modules/identity/session-repository.ts` (new) · `apps/worker/src/http/middleware/authn.ts` (new — global auth middleware) · `apps/worker/src/http/routes/auth.ts` (new — register, login, refresh, me) · `apps/worker/src/http/routes/admin.ts` (new — invite-codes CRUD) · `apps/worker/src/http/router.ts` (mount authn + new routes) · `packages/contracts/src/index.ts` (registerRequestSchema, loginRequestSchema, refreshRequestSchema) · schema version → '0004'

**Decisions:**
- Access token: UUID stored in CACHE KV (`auth:{token}`), 15-min TTL. Sets `c.set('userId', userId)` if valid.
- Refresh token: UUID, SHA-256 hash stored in sessions table, 30-day expiry. Never plaintext.
- Registration code: 32 random bytes → 64-char hex, SHA-256 hash stored. Only shown to admin once.
- `INVALID_CREDENTIALS` for both wrong email AND wrong password (don't leak which).
- Registration is a single D1 batch: create user + assign member role + increment key usage.
- Auth routes (register, login, refresh) are public. Admin routes need authn + requirePermission.
- `verifyPassword` converts both Uint8Arrays to hex, then uses `constantTimeCompare` on hex strings.

**Deferred:** D-CAP-019-A (idempotency on /register → CAP-027), D-CAP-019-B (email verification flow → Phase 2).

**Notes:** Fixed test bug: admin tests were destructuring `accessToken` from top-level response instead of `data.accessToken`. Two locations, both 403 tests. Fixed preflight test (schemaVersion '0003' → '0004'). Added contract tests for registerRequestSchema, loginRequestSchema, refreshRequestSchema.

## 2026-08-13 — CAP-017 Roles + permissions seed  |  Implemented

**Changed:** Admin module introduced. 20 permission keys seeded. 2 roles (administrator=all, member=5 perms). `completeSetup` now seeds roles + assigns administrator to first user. `requirePermission(key)` middleware implemented (reads `c.get('userId')`, 401/403 on failure).

**Files:** `apps/worker/src/modules/admin/permission-repository.ts` (new — checkPermission) · `apps/worker/src/modules/admin/seed-repository.ts` (new — seedRolesAndPermissions, assignRole) · `apps/worker/src/modules/admin/index.ts` (new module) · `apps/worker/src/http/middleware/authz.ts` (new — requirePermission) · `apps/worker/src/modules/onboarding/complete-setup.ts` (modified — seeding + role assignment) · `packages/contracts/src/index.ts` (permissionKeySchema) · `apps/worker/src/platform/env.ts` (AppEnv Variables: { userId?: string })

**Decisions:**
- Deterministic IDs: permission id = key (e.g., `'message.read'`), role id = name (e.g., `'administrator'`). System seed data, not domain aggregates.
- Seeding during setup completion — `completeSetup` calls seed → assign admin → flip status. Roles exist before the first user logs in.
- `requirePermission` reads `c.get('userId')` from Hono Variables — set by future auth middleware (CAP-019). Without auth, always returns 401.

## 2026-08-13 — CAP-015 + CAP-016 Setup wizard complete  |  Implemented

**Changed:** `POST /api/v1/setup/outbound-smoke-test` (decrypts Brevo API key, sends test email, advances step to 'complete') + `POST /api/v1/setup/complete` (flips status to 'complete', `GET /` serves HTML shell). **The entire setup wizard is now implemented — all 9 steps.**

**Files:** `apps/worker/src/modules/identity/user-repository.ts` (added `getFirstUser`) · `apps/worker/src/modules/outbound-mail/credential-repository.ts` (added `getCredentialByName`) · `apps/worker/src/modules/onboarding/outbound-smoke-test.ts` (new — decrypt + send) · `apps/worker/src/modules/onboarding/complete-setup.ts` (new — flip status) · `apps/worker/src/http/routes/setup.ts` (added POST /outbound-smoke-test + POST /complete) · `apps/worker/src/http/router.ts` (added GET / handler) · `apps/worker/src/http/routes/outbound-smoke-test.worker.test.ts` + `complete-setup.worker.test.ts` (new — 34 tests combined)

**Decisions:**
- First decrypt-and-use flow: outbound smoke test reads encrypted_credentials, decrypts with AES-GCM, constructs ProviderRuntimeContext with the plaintext key, calls adapter.send(). Decrypted key lives only in request scope (ADR-007).
- `GET /` returns minimal HTML shell (`<div id="root">`). Real React app assets served via CDN/Workers Sites in production. Setup gate ensures `GET /` is only reachable when status='complete'.
- Sender address for smoke test: `noreply@<domain>`. Recipient: admin user's email.

**Notes:** Setup wizard complete: claim → preflight → administrator → domain → cloudflare-verify → inbound-smoke → brevo → outbound-smoke → complete. After complete, `GET /` returns 200 HTML (setup gate passes through). Phase 1 progress: 9/17 capabilities. Remaining: CAP-017 through CAP-026 (roles, registration, mailboxes, inbound processing, inbox, compose, webhooks, audit).

## 2026-08-13 — CAP-014 Brevo provider + encrypted credentials  |  Implemented

**Changed:** `POST /api/v1/setup/brevo` — accepts Brevo API key, validates via adapter, encrypts with AES-GCM, stores encrypted credential + provider connection, links to managed domain, advances step to 'outbound-smoke'. Introduces outbound-mail module, provider registry, Brevo adapter, and AES-GCM encryption.

**Files:** `migrations/0003_provider_connections.sql` (new) · `apps/worker/src/platform/crypto.ts` (added `importEncryptionKey`/`encrypt`/`decrypt`) · `apps/worker/src/modules/outbound-mail/` (new module — credential + connection repositories) · `apps/worker/src/integrations/providers/brevo.ts` (new — OutboundProviderAdapter) · `apps/worker/src/integrations/providers/provider-registry.ts` (new) · `apps/worker/src/modules/onboarding/setup-brevo.ts` (new — use case) · `packages/contracts/src/index.ts` (`setupBrevoRequestSchema`) · `apps/worker/src/http/routes/brevo.worker.test.ts` (new) · schema version bumped to '0003'

**Decisions:**
- `onboarding → outbound-mail` edge approved — setup wizard creates provider connections.
- Validation before encryption — don't encrypt an invalid API key. Adapter validates first via `GET /v3/account`.
- Four-statement D1 batch (credential + connection + domain.outbound_connection_id + step advance) — atomic.
- AES-GCM: 12-byte IV, 16-byte auth tag stored as separate BLOB columns per ADR-007. Key from Secrets Store via `importEncryptionKey` (hex → CryptoKey).
- Brevo adapter in `integrations/providers/` — owns HTTP calls. Modules call through `OutboundProviderAdapter` interface (ADR-002).
- Implemented via two sequential subagents (infrastructure + integration) due to API size limits on single-agent dispatch.

**Notes:** Brevo API mocked via `vi.spyOn(globalThis, 'fetch')` in worker-pool tests. Preflight test updated (schemaVersion '0002' → '0003'). `CREDENTIAL_ENCRYPTION_KEY` in wrangler.test.jsonc is a valid 32-byte hex string for AES-256.

## 2026-08-13 — CAP-013 Inbound smoke test  |  Implemented

**Changed:** `POST /api/v1/setup/inbound-smoke-test` (start) + `POST /api/v1/setup/inbound-smoke-test/check` — verifies Cloudflare Email Routing delivers emails to the Worker. Start generates `smoke+<uuid>@<domain>` address; operator sends email manually; email handler detects the `smoke+` prefix, validates token in KV, sets receipt flag; check endpoint polls KV, advances step to 'brevo' on receipt. First modification to the inbound email handler (previously reject-all stub).

**Files:** `apps/worker/src/modules/onboarding/inbound-smoke-test.ts` (new — startInboundSmokeTest, checkInboundSmokeTest, handleSmokeTestMessage) · `apps/worker/src/entrypoints/inbound-email.ts` (modified — added env param, calls handleSmokeTestMessage) · `apps/worker/src/http/routes/setup.ts` (added 2 routes) · `apps/worker/src/http/routes/inbound-smoke-test.worker.test.ts` (new — 24 tests) · `apps/worker/src/entrypoints/inbound-email.worker.test.ts` (updated — real env instead of mock)

**Decisions:**
- Operator sends email manually — Worker can't send email to itself (no outbound provider yet).
- CACHE KV for ephemeral smoke test state (`smoke:{token}`, `smoke:active`, `smoke-result:{token}`) with 5-min TTL. No migration needed.
- Email handler accepts smoke-test messages by token validation; all others rejected until CAP-021.
- `handleSmokeTestMessage` lives in onboarding module (setup concern, not inbound-mail concern). Email handler calls it via `modules/onboarding/index.ts`.
- Two endpoints: start (generates address) + check (polls receipt). Frontend calls start once, then polls check.

**Notes:** Legacy inbound-email.worker.test.ts fixed: replaced mock env (violated testing rules — "Never mock D1/R2/KV/Queue") with real `env` from `cloudflare:test`. Removed `Queue<any>`. Email handler tests use mock message (allowed — not a storage binding) with real KV.

## 2026-08-13 — CAP-012 Cloudflare dashboard-link + verify  |  Implemented

**Changed:** Two session-protected endpoints: `POST /api/v1/setup/cloudflare/dashboard-link` (returns allowlisted Cloudflare dashboard URL, no step change) and `POST /api/v1/setup/cloudflare/verify` (checks managed domain exists, advances step to 'inbound-smoke'). Phase 1: verify is operator-confirmation only — no Cloudflare API call. Real email-delivery verification via CAP-013 inbound smoke test.

**Files:** `apps/worker/src/modules/onboarding/cloudflare-dashboard-link.ts` (new — getCloudflareDashboardLink) · `apps/worker/src/modules/onboarding/cloudflare-verify.ts` (new — verifyCloudflareEmailRouting) · `apps/worker/src/modules/tenancy/domain-repository.ts` (added getManagedDomain) · `apps/worker/src/modules/tenancy/index.ts` (export getManagedDomain) · `apps/worker/src/http/routes/setup.ts` (added POST /cloudflare/dashboard-link + POST /cloudflare/verify) · `apps/worker/src/http/routes/cloudflare.worker.test.ts` (new — 19 tests)

**Decisions:** Verify is operator-confirmation only (Phase 1). Dashboard URL is generic (`https://dash.cloudflare.com`). No new contracts (empty POST bodies, simple response shapes).

**Notes:** Orchestrator-validated (pattern identical to CAP-009/010/011 — session-protected, one use case, envelope response). Setup-gate test updated (dashboard-link and verify routes now exist → 401 instead of 404).

## 2026-08-13 — CAP-011 Setup domain endpoint  |  Implemented

**Changed:** `POST /api/v1/setup/domain` — session-protected endpoint persisting a managed domain with `status='active'`. After creation, the installation step advances to 'cloudflare-verify'. Introduces the tenancy module and the first schema migration since CAP-004.

**Files:** `migrations/0002_managed_domains.sql` (new — managed_domains table) · `migrations/0002_managed_domains.verify.sql` (new) · `apps/worker/src/database/schema/tenancy.ts` (new — Drizzle typing) · `apps/worker/src/database/schema-version.ts` (bumped to '0002') · `apps/worker/src/modules/tenancy/domain-repository.ts` (new — prepareCreateDomain + createDomain) · `apps/worker/src/modules/tenancy/index.ts` (new module) · `apps/worker/src/modules/onboarding/create-domain.ts` (new — createDomainStep use case) · `apps/worker/src/http/routes/setup.ts` (added POST /domain) · `packages/contracts/src/index.ts` (domainNameSchema, setupDomainRequestSchema) · `packages/test-kit/src/migrationsDb.ts` (splitSql for multi-migration support) · `apps/worker/src/http/routes/domain.worker.test.ts` (new — 25 tests)

**Decisions:**
- `onboarding → tenancy` edge approved — onboarding orchestrates the setup wizard, which creates domains. Same pattern as `onboarding → identity` (CAP-010).
- Domain-existence guard (`SELECT 1 FROM managed_domains LIMIT 1`) before insert — only one domain during setup. Same pattern as CAP-010's administrator singularity guard.
- `splitSql` in migrationsDb.ts — splits migration SQL on line-ending semicolons for `applyD1Migrations`. Both migrations now use this (0001 was previously passed as a single string).
- `outbound_connection_id` nullable without FK — `provider_connections` table doesn't exist yet. FK added in a later migration.

**Deferred:** D-CAP-011-A (idempotency → CAP-027), D-CAP-011-B (splitSql semicolon risk → follow-up).

**Notes:** Reviewer dispatched but went idle without report. Orchestrator validated: no architecture violations, no type-safety issues, all quality gates green (12/119 unit, 11/120 worker, doctor 10/10). Stale preflight test updated (schemaVersion '0001' → '0002'). Stale domain test updated (DOMAIN_NAME_TAKEN → DOMAIN_ALREADY_MANAGED — existence guard fires before D1 constraint).

## 2026-08-13 — CAP-010 Setup administrator endpoint  |  Implemented

**Changed:** `POST /api/v1/setup/administrator` — session-protected endpoint that creates the first user (the initial administrator) with a PBKDF2-SHA256-hashed password (ADR-006). After successful creation, the installation step advances from 'administrator' to 'domain'. Introduces the identity module and `hashPassword` in platform/crypto.ts.

**Files:** `apps/worker/src/platform/crypto.ts` (added `hashPassword` — PBKDF2-SHA256, 600k iterations) · `apps/worker/src/modules/identity/user-repository.ts` (new — `createUser` + `prepareCreateUser`) · `apps/worker/src/modules/identity/index.ts` (new module) · `apps/worker/src/modules/onboarding/create-administrator.ts` (new — `createAdministrator` use case) · `apps/worker/src/modules/onboarding/installation-state-repository.ts` (added `prepareUpdateInstallationStep`) · `apps/worker/src/modules/onboarding/index.ts` (export `createAdministrator`) · `apps/worker/src/http/routes/setup.ts` (added POST /administrator) · `packages/contracts/src/index.ts` (`setupAdministratorRequestSchema`) · `apps/worker/src/http/routes/administrator.worker.test.ts` (new — 24 worker-pool tests) · `apps/worker/src/platform/crypto.test.ts` (added 19 hashPassword unit tests)

**Rules:** ADR-006 (PBKDF2-SHA256), security.md §Passwords, R-AUTH-002 (users.status='active'), R-AUTH-009 (email case-insensitive), R-DATA-001 (email normalized)

**Decisions:**
- `createAdministrator` use case lives in onboarding (not identity) because it needs to update `installation_state` (owned by onboarding). onboarding depends on identity — allowed per architecture rules.
- User insert + step update are a single D1 `batch()` — atomic. If either fails, both roll back. `prepareCreateUser` and `prepareUpdateInstallationStep` expose `D1PreparedStatement` objects for batch composition.
- Singularity guard checks `SELECT 1 FROM users LIMIT 1` BEFORE hashing (saves ~600ms on rejected calls). Returns SETUP_ADMINISTRATOR_EXISTS (409). The D1 UNIQUE constraint on email is a defensive backstop for race conditions.
- No role assignment — roles and permissions are seeded in CAP-017. The setup session authenticates all setup operations.
- PBKDF2 confirmed working in Cloudflare Workers via `crypto.subtle.deriveBits` — ~600ms per hash, within Workers Paid plan 30s CPU budget.
- `hashPassword` uses `crypto.getRandomValues` for salt (not `ids.uuid()` — that's for domain IDs).

**Deferred:** D-CAP-010-A (idempotency → CAP-027), D-CAP-010-B (Drizzle BLOB typing → CAP-019).

**Notes:** Two reviewers ran (architecture ACCEPT WITH NOTES, code ACCEPT WITH NOTES). Code review HIGH (BLOB assertion via `as number[]`) fixed — `new Uint8Array()` with typed `.first<>()`. Both reviewers flagged atomicity (M1/Arch-HIGH) — fixed via D1 batch. Arch MEDIUM (singularity guard) fixed — existence check before hash. Arch LOW (error string robustness) fixed — `err instanceof Error && err.message`. Wrong rule citations in crypto.ts fixed.

## 2026-08-12 — CAP-009 Setup preflight endpoint  |  Implemented

**Changed:** `POST /api/v1/setup/preflight` — session-protected endpoint that reports each of the 7 Cloudflare bindings as present/accessible and the database schema version from `d1_migrations`. Introduces the setup-session middleware that validates `Authorization: Bearer <sessionToken>` against KV — the gate for all post-claim setup endpoints.

**Files:** `apps/worker/src/http/middleware/setup-session.ts` (new — session validation) · `apps/worker/src/modules/onboarding/preflight.ts` (new — runPreflight use case) · `apps/worker/src/modules/onboarding/index.ts` (export runPreflight) · `apps/worker/src/http/routes/setup.ts` (added POST /preflight with session middleware) · `packages/contracts/src/index.ts` (setupPreflightResponseSchema) · `apps/worker/src/http/routes/preflight.worker.test.ts` (new — 14 worker-pool tests) · `apps/worker/src/http/middleware/setup-gate.worker.test.ts` (updated: preflight now 401 not 404)

**Rules:** R-AUTH-001 (session required after claim), R-SETUP-003 (setup routes exempt from gate)

**Decisions:**
- Session middleware applied inline on `/preflight` only (`routes.post('/preflight', setupSession, handler)`). `/status` and `/claim` remain public. Future session-protected routes add `setupSession` inline until Rule of Three justifies a route group.
- Binding checks are existence-only: `!!env.BINDING` for D1/R2/KV/Queue, `readSecret` try/catch for Secrets Store. Deep health checks (actual queries, puts) are a future concern.
- Schema version from `d1_migrations` table (`ORDER BY id DESC LIMIT 1`) — reflects what the database was actually migrated to, not what the code expects.
- `checkSecret` logs at `warn` on failure — this is a diagnostic endpoint; swallowing errors defeats its purpose.

**Deferred:** D-CAP-009-A (SecretLike type for checkSecret — code review L3), D-CAP-009-B (redundant db param — L4).

**Notes:** Code review ACCEPT WITH NOTES (M1: checkSecret error logging — fixed; L1: ORDER BY id — fixed; L2: empty-token test — added). Architecture review pending. HTTP trims trailing whitespace from header values, so `'Bearer '` becomes `'Bearer'` → SETUP_SESSION_REQUIRED (documented in test).

## 2026-08-12 — CAP-008 Setup claim endpoint  |  Implemented

**Changed:** `POST /api/v1/setup/claim` validates the `INSTALLATION_TOKEN` with constant-time comparison, creates a 30-minute KV setup session, and seeds `installation_state` to `current_step='preflight'`. Wrong token → 401, missing/empty token → 400, already complete → 409. Error middleware replaced — DomainError → httpStatus, ZodError → 400, SyntaxError → 400, unknown → 500 with log.

**Files:** `apps/worker/src/modules/onboarding/claim-setup.ts` (new — claimSetup use case) · `apps/worker/src/modules/onboarding/installation-state-repository.ts` (added seedInstallationState) · `apps/worker/src/modules/onboarding/index.ts` (export claimSetup) · `apps/worker/src/http/routes/setup.ts` (added POST /claim) · `apps/worker/src/http/middleware/error.ts` (real error mapping) · `apps/worker/src/platform/crypto.ts` (constantTimeCompare) · `apps/worker/src/platform/secrets.ts` (new — readSecret helper) · `apps/worker/wrangler.test.jsonc` (new — test wrangler config) · `packages/contracts/src/index.ts` (setupClaimRequestSchema) · `apps/worker/src/http/routes/claim.worker.test.ts` (new — 13 worker-pool tests) · `apps/worker/src/http/middleware/error.test.ts` (new — 6 unit tests) · `apps/worker/src/platform/crypto.test.ts` (new — 7 unit tests) · `apps/worker/src/platform/secrets.test.ts` (new — 3 unit tests)

**Rules:** Constant-time compare per security.md §Passwords / ADR-006. Secrets never logged per R-SECRET-003.

**Decisions:**
- `readSecret` helper bridges `SecretsStoreSecret` (prod: `.get()`) and `string` (test: miniflare vars). Keeps Cloudflare types out of the use case.
- `wrangler.test.jsonc` — miniflare cannot populate `secrets_store_secrets` values. Test config uses `vars` instead. Cross-reference comments added to both wrangler files. Drift risk tracked as D-CAP-008-A.
- Error middleware: `DomainError` → httpStatus, `ZodError` → 400 VALIDATION_ERROR, `SyntaxError` → 400 (JSON parse failures), unknown → 500 INTERNAL with `console.error` log. Uses `Response.json()` (Web API static) not `c.json()`.
- `ON CONFLICT DO NOTHING` seed — idempotent. Re-claiming after session expiry preserves existing `current_step`.
- Timestamps use SQLite `datetime()` format (`YYYY-MM-DD HH:MM:SS`) to match the DDL default and test-kit convention.
- Idempotency-Key deferred to CAP-027 (D-CAP-008-B). Phase 0 has no idempotency infrastructure.
- requestId in error envelope deferred (D-CAP-008-C / D-CAP-006-B).

**Deferred:** D-CAP-008-A (doctor check for wrangler.test.jsonc drift), D-CAP-008-B (idempotency on /claim → CAP-027), D-CAP-008-C (requestId in error envelope → D-CAP-006-B).

**Notes:** Two reviewers ran (architecture ACCEPT WITH NOTES, code ACCEPT WITH NOTES). Architecture MEDIUM on wrong rule citations (R-AUTH-006, R-SECRET-001 were incorrect — fixed to cite security.md §Passwords / ADR-006 / R-SECRET-003). Code HIGH on missing error middleware unit tests (AC #7 unmet — added error.test.ts with 6 cases). Implementer's original test/setup.ts monkey-patching was broken (ran in Node.js, not workerd) — replaced with wrangler.test.jsonc approach.

## 2026-08-12 — CAP-007 Setup status endpoint  |  Implemented

**Changed:** `GET /api/v1/setup/status` returns the current installation state in the success envelope `{ "data": { "status", "currentStep" } }`. On a fresh DB (no `installation_state` row), defaults to `{ "status": "setup", "currentStep": "claim" }`. This is the first real API route and establishes the route-handler + sub-app pattern for all future setup endpoints.

**Files:** `apps/worker/src/modules/onboarding/setup-status.ts` (new — `getSetupStatus` use case) · `apps/worker/src/modules/onboarding/index.ts` (exports `getSetupStatus`, repository now private) · `apps/worker/src/http/routes/setup.ts` (new — setup sub-app) · `apps/worker/src/http/router.ts` (mounts sub-app at `/api/v1/setup`) · `apps/worker/src/http/middleware/setup-gate.ts` (imports `getSetupStatus`, null branch removed) · `apps/worker/src/http/routes/setup-status.worker.test.ts` (new, 9 cases) · `packages/test-kit/src/seed.ts` (new — `seedInstallationState`, `resetAndMigrate`, `FIXED_TIMESTAMP`) · `packages/test-kit/src/index.ts` (exports seed helpers) · `scripts/doctor.ts` (intra-module self-import fix) · `apps/worker/src/http/middleware/setup-gate.worker.test.ts` (updated: uses test-kit helpers, `/status` now 200 not 404)

**Rules:** R-SETUP-002 (fresh DB defaults to `claim`), R-SETUP-003 (setup routes exempt from gate)

**Decisions:**
- `getSetupStatus` absorbs the null case: the repository returns `null` for a fresh DB; the use case returns `{ status: 'setup', currentStep: 'claim' }`. Callers never handle null (resolves D-CAP-006-C).
- Setup routes sub-app (`http/routes/setup.ts`): a Hono sub-app for `/api/v1/setup/*`. CAP-008 (claim) and CAP-009 (preflight) will add routes to the same file.
- Response shape is `{ "data": InstallationStateInfo }` — returns both `status` and `currentStep`. The acceptance criterion mentions only `currentStep`, but the React client needs `status` to redirect away from `/setup` when installation is complete.
- Test helpers promoted to test-kit (`packages/test-kit/src/seed.ts`): `seedInstallationState`, `resetAndMigrate`, `FIXED_TIMESTAMP` were duplicated across two test files (resolves D-CAP-006-A). `seedInstallationState`'s `currentStep` typed as `InstallationStep` from contracts, not `string`.
- Doctor `module-dependency-zones` fix: intra-module self-imports (`t !== m`) are now allowed. The check was a latent false positive — `setup-status.ts` importing `./installation-state-repository` (same module) was flagged because `ALLOWED['onboarding']` doesn't contain `'onboarding'`. Self-imports are always legal; the zone rules govern cross-module edges only.

**Deferred:** D-CAP-007-A (endpoint DB-failure test — error middleware is a CAP-001 stub). D-CAP-006-A and D-CAP-006-C resolved.

**Notes:** Two reviewers ran (architecture ACCEPT WITH NOTES, code ACCEPT WITH NOTES). Architecture reviewer's LOW claiming the doctor fix was a no-op was factually incorrect — `ALLOWED.onboarding` does NOT contain `'onboarding'`, so the `t !== m` guard is necessary. Code review MEDIUM (duplicated test helpers) addressed by promoting to test-kit. Setup-gate CAP-006 test for `/api/v1/setup/status` updated from 404 → 200 (endpoint now has a handler).

## 2026-08-12 — CAP-006 Setup gate  |  Implemented

**Changed:** While `installation_state.status !== 'complete'` (or the row is absent on a fresh DB), every non-setup HTTP route now 302-redirects to `/setup`. Exempt paths: `/healthz`, `/setup`, `/setup/*`, `/api/v1/setup/*`. This is the gate that forces the operator through the setup wizard before any other route is reachable.

**Files:** `apps/worker/src/http/middleware/setup-gate.ts` (new) · `apps/worker/src/modules/onboarding/installation-state-repository.ts` (new) · `apps/worker/src/modules/onboarding/index.ts` (exports `getInstallationState`) · `apps/worker/src/http/router.ts` (mounts middleware after `requestId`) · `packages/contracts/src/index.ts` (`installationStepSchema`, `installationStateInfoSchema`) · `packages/contracts/src/index.test.ts` (schema parse/safeParse tests) · `apps/worker/src/http/middleware/setup-gate.worker.test.ts` (new, 20 cases)

**Rules:** R-SETUP-001 (incomplete → 302), R-SETUP-002 (fresh DB treated as incomplete), R-SETUP-003 (/healthz always reachable), R-SETUP-004 (DB failure → fail-closed redirect with warn log)

**Decisions:**
- Fail-closed on DB error: the middleware catches `getInstallationState` failures and redirects to `/setup`. A broken DB must not expose the app. Logged via `console.warn` (TODO: structured logger — D-CAP-006-B).
- `{ redirect: 'manual' }` in worker-pool tests: `SELF.fetch` follows redirects by default — tests asserting 302 must use `{ redirect: 'manual' }` to observe the redirect response, not the followed target. This is a testing pattern for all future redirect tests.
- Middleware order: `requestId` → `setupGate` → routes. Infrastructure first, then gates.
- Zod schemas in contracts: `installationStepSchema` and `installationStateInfoSchema` are zod schemas (not just types). The repository uses `.parse()` instead of `as` casts. Satisfies the doctor's `tests-cover-contracts` check.
- `Database` type alias: repository uses `Database` from `platform/database.ts`, not raw `D1Database`. Sets the convention for future repositories.

**Deferred:** D-CAP-006-A (test-kit `InstallationStateRowShape` full-row → CAP-007), D-CAP-006-B (structured logger → CAP-007+), D-CAP-006-C (onboarding module evolves to use-case-level exports → CAP-007+)

**Notes:** The implementer's initial tests failed because `SELF.fetch` auto-follows the 302 redirect to `/setup` (exempt → 404), making the redirect invisible. Root cause was purely in the tests, not the middleware. Two reviewers ran (architecture + code, both ACCEPT WITH NOTES). QA reviewer spawned but did not report after three requests — acceptance criteria verified by orchestrator via quality gates. All review findings addressed: zod parse for casts, log on catch, DB-failure test (R-SETUP-004), `Database` type alias, deterministic timestamps, contract schema tests.

---

## 2026-08-12 — CAP-005 Deploy automation  |  Implemented

**Changed:** An operator can now deploy the worker to a fresh Cloudflare account with
`ENVIRONMENT=preview pnpm scaffold deploy`. The script provisions all 6 Cloudflare
resources (D1, R2, 2× KV, Queue, Secrets Store) idempotently, generates
`INSTALLATION_TOKEN` and `CREDENTIAL_ENCRYPTION_KEY` (32 random bytes hex, ADR-007) via
stdin (not the insecure `--value` CLI flag), resolves placeholder IDs into a gitignored
`wrangler.resolved.jsonc`, runs remote migrations, deploys the worker, and attempts a
healthz check. The committed `apps/worker/wrangler.jsonc` stays as a template — never
modified by the deploy script. `--force-secrets` requires interactive confirmation and
warns about CREDENTIAL_ENCRYPTION_KEY data loss. `--dry-run` previews without persisting
state or creating resources.

**Files:** `scripts/deploy.ts` (733 lines) · `scripts/deploy.test.ts` (228 lines) ·
`scripts/scaffold.ts` (deploy subcommand) · `scripts/vitest.config.ts` (new scripts test
project) · `vitest.config.ts` (project added) · `.gitignore` (resolved config + resource
state + test temp files) · `docs/operations/deploy.md` (runbook).

**Rules:** ADR-007 (secret generation + storage) · R-SECRET-003 (secrets never logged).

**Decisions:** Template + generated resolved config approach (committed `wrangler.jsonc`
untouched, `.wrangler.resolved.jsonc` gitignored) → deploy.ts header comment. Secrets via
stdin pipe instead of `--value` flag → fix-up-2.md F2. D1 create text output parsing
instead of undocumented `--json` → fix-up-2.md F3.

**Deferred:** D-CAP-005-A (wrangler `--json` shapes — E2E), D-CAP-005-B (stdin secret
approach — E2E), D-CAP-005-C (`secret update` verb — E2E), D-CAP-005-D (healthz under
`workers_dev:false`), D-CAP-005-E (stale-state ID validation).

**Notes:** This is an operator-action capability — `Implemented` means the automation +
tests + runbook are complete and reviewed. `Verified` requires a real cloud deploy by an
operator. Every HIGH finding from code/architecture reviews traces to unverified wrangler
CLI output shapes that cannot be tested without cloud credentials. Parse failures now warn
to stderr instead of being silently swallowed, so the first real deploy will surface shape
mismatches visibly.

## 2026-08-12 — CAP-004 Initial D1 schema + migration runner  |  Implemented

**Changed:** Every Phase 0 capability can now persist to D1. The 11 tables the
installer, identity, outbound-mail and admin code paths read and write
(`installation_state`, `system_settings`, `users`, `sessions`,
`encrypted_credentials`, `permissions`, `roles`, `role_permissions`,
`user_roles`, `audit_events`, `maintenance_jobs`) exist as a single migration
under `migrations/0001_initial.{sql,verify.sql,md}`. The Drizzle typed schemas
at `apps/worker/src/database/schema/{identity,onboarding,admin,outbound-mail}.ts`
mirror the SQL for repository-side typing; the SQL in `migrations/` is the
deployable artifact per `data-model.md` §Migration authority. A new
`scripts/db-migrate.ts` applies pending migrations against the local D1 binding
via `wrangler d1 execute --local`, with apply and tracking-row insert atomic
in the same D1 batch. `pnpm scaffold db:migrate [--reset] [--verify]` is the
single command; the same runner handles fresh apply, idempotent re-run, and
ghost-detection (`Migration file(s) missing from disk but recorded in
d1_migrations` → exit 1). A new `packages/test-kit/src/migrationsDb.ts`
exposes a worker-pool D1 fixture that every later capability can use in tests
against a real D1 binding (no D1 mocking per `.claude/rules/testing.md`
§Mocking). `pnpm scaffold doctor` `schema-version` check now actually
verifies against the highest migration prefix and the `CURRENT_SCHEMA_VERSION`
sentinel at `apps/worker/src/database/schema-version.ts`; it will break the
moment a future capability adds a migration without bumping the sentinel.

**Files:**
- `migrations/0001_initial.sql` (~250 lines, 11 tables + indexes + checks)
- `migrations/0001_initial.verify.sql` (53 assertions, one per row)
- `migrations/0001_initial.md` (compatibility, backfill, recovery, tracking convention)
- `apps/worker/src/database/schema/{identity,onboarding,admin,outbound-mail,index}.ts`
- `apps/worker/src/database/schema-version.ts`
- `apps/worker/drizzle.config.ts`
- `scripts/db-migrate.ts`
- `scripts/scaffold.ts` (extended dispatcher)
- `scripts/doctor.ts` (migrations-present/ordered skip `.verify.sql` companions; schema-version parses CURRENT_SCHEMA_VERSION)
- `packages/test-kit/src/migrationsDb.ts` (worker-pool D1 fixture)
- `packages/test-kit/src/migrationsDb.worker.test.ts` (R-DATA-001, R-DATA-004, R-AUTH-002, ADR-006, R-AUTH-006-PBKDF2-floor)
- `packages/test-kit/src/sql-raw.d.ts` (`?raw` + `cloudflare:test` declarations)
- `packages/test-kit/src/fixtures.ts` (`installationState.status` aligned to SQL CHECK)
- `packages/test-kit/vitest.workers.config.ts` (new worker-pool project)
- `apps/worker/package.json` (drizzle-orm 0.44.5)
- `package.json` (drizzle-kit 0.31.5 devDep; test:worker runs both worker-pool projects)
- `.gitignore` (`/migrations/drizzle/`)

**Rules:** R-AUTH-002 (status CHECK), R-AUTH-003 (sessions eviction index),
R-AUTH-005 (sessions CASCADE), R-AUTH-009 (email NOCASE), R-DATA-001 (NOCASE
everywhere), R-DATA-003 (users.deleted_at), R-DATA-004 (FK PRAGMA verified),
R-DATA-005 (no JSON-in-text except the documented audit_events.metadata).
ADR-006 (PBKDF2 4-column shape, floor 100k schema-side). ADR-007 (AES-GCM
exact-length CHECKs on iv=12, auth_tag=16).

**Decisions:**
- 11 tables in one migration (0001_initial.sql) — they are one
  "create the schema" event; later migrations are incremental. Logged in
  `migrations/0001_initial.md` §Companion files.
- audit_events.metadata is `TEXT` (JSON) — the explicit R-DATA-005 exception,
  capped at 65536 bytes via CHECK. Documented in
  `migrations/0001_initial.md` §Explicit exception to R-DATA-005.
- Soft-delete only on `users` for now; other tables get `deleted_at` when
  their owning capability lands.
- CASCADE for hard ownership (sessions → users, role_permissions, user_roles);
  SET NULL for soft references (audit_events.actor_user_id, user_roles.granted_by).
- wrangler native `d1_migrations` table is created by the migration itself
  (F1) so apply+track are atomic in one D1 batch; no custom tracking table.
- db:reset is local-only (ENVIRONMENT=local or unset) per task.md AC #15.

**Deferred:** D-CAP-004-A — `users.password_iterations` schema floor is
100,000, weaker than ADR-006's 600,000. The application layer (CAP-019)
sets the exact floor. D-CAP-004-B — `UserId` and cross-boundary types must
live in `packages/contracts/` before repositories land. D-CAP-004-C —
`scripts/db-migrate.ts` is ~260 lines, exceeds the 150-line rule;
orchestrator judgment: dev-only CLI benefits from being one file.
D-CAP-004-D — `packages/test-kit/src/sql-raw.d.ts` is the sole source of
`cloudflare:test` typings; the official `@cloudflare/vitest-pool-workers`
module does not export `applyD1Migrations`'s surface in 0.21.x.

**Notes:**
- The migration runner's first version shipped with separate Node-side
  `CREATE TABLE d1_migrations` and `INSERT INTO d1_migrations` wrangler calls
  (the BLOCKERs of the original code review). The fix-up pass moved both
  into `0001_initial.sql` itself so apply+track are atomic. A crash
  mid-`--file=0001_initial.sql` rolls back both. Every CREATE uses
  `IF NOT EXISTS` so a partially-applied DB can re-apply cleanly.
- `pnpm test:worker` is configured to run both `workers` (apps/worker) and
  `test-kit-workers` (packages/test-kit) projects. The unit pool
  (`packages/test-kit/vitest.config.ts`) excludes `*.worker.test.ts` so the
  worker-only tests don't run in the node pool where `cloudflare:test`
  doesn't exist.
- `pnpm scaffold db:migrate --reset` exits 0 and applies the migration to a
  fresh local DB; a follow-up `pnpm scaffold db:migrate` (no flags) is
  idempotent (1 already applied, 53 verify assertions pass).
- `pnpm scaffold doctor` is `10/10`; `pnpm exec drizzle-kit check` (from
  `apps/worker/`) exits 0; `pnpm test` is `12/47`.

## 2026-08-12 — CAP-003 `pnpm scaffold doctor`  |  Implemented

**Changed:** A new `pnpm scaffold` script dispatcher runs `scripts/doctor.ts`
(via Node 22's `--experimental-strip-types`, no new runtime dependency) and
performs 10 structural checks against the repository. `10/10 checks passed.`
exits 0 on a healthy repo; the same command exits 1 with a `✗ <name> — <detail>`
line per failed check. The doctor is the first gate in
`.claude/rules/testing.md` §Quality gates. The `pnpm test:unit` suite now
includes a vitest self-test that spawns `pnpm scaffold doctor` and asserts
exit 0, so the doctor is part of the regular test gate.

The 10 checks:

- `wrangler-bindings` — every binding in `apps/worker/wrangler.jsonc` exists
  in `apps/worker/src/platform/env.ts` (`DB`, `ATTACHMENTS`, `SETUP_SESSION`,
  `CACHE`, `OUTBOUND`, `INSTALLATION_TOKEN`, `CREDENTIAL_ENCRYPTION_KEY`,
  `ENVIRONMENT`).
- `wrangler-compat` — `wrangler.jsonc` declares `compatibility_flags:
  ["nodejs_compat"]` and a recent `compatibility_date`.
- `migrations-present` — every `migrations/NNNN_*.sql` has a sibling
  `migrations/NNNN_*.verify.sql`.
- `migrations-ordered` — migration filenames sort lexicographically; sequence
  numbers zero-padded and contiguous from `0001`.
- `schema-version` — recorded `schema_version` matches the highest-numbered
  migration.
- `module-dependency-zones` — full per-pair enforcement of the 132 possible
  `modules/<a> → modules/<b>` edges against the allowed list in
  `.claude/rules/architecture.md`. **Resolves D-CAP-001-C.**
- `eslint-boundary-rules` — `eslint.config.js` contains the three
  `import/no-restricted-paths` zones plus the `no-restricted-imports` rule
  for `hono` in `modules/platform/packages`. (Loads the config via dynamic
  `import()` rather than regex-matching source — robust against comment and
  string-shape changes.)
- `tsconfig-strict` — root and per-package `tsconfig.json` files have
  `strict: true` (or the strict family enabled individually).
- `harness-no-placeholders` — every workspace package's `test:unit` /
  `test:worker` scripts invoke vitest (no `echo ... && exit 0` placeholders).
  Catches regression to the CAP-001 placeholder state.
- `tests-cover-contracts` — every exported zod schema in
  `packages/contracts/src/index.ts` has at least one `parse` and one
  `safeParse` test.

**Files:**
- `scripts/doctor.ts` — 200 lines, all 10 checks, zero `any`, TS strict.
  Allowed-edge table from `.claude/rules/architecture.md` is encoded
  verbatim.
- `scripts/scaffold.ts` — 22-line dispatcher; routes `doctor` to
  `scripts/doctor.ts`.
- `scripts/README.md` — two paragraphs describing the dispatcher and the
  `doctor` subcommand.
- `scripts/tsconfig.json` — composite project, wired into `tsconfig.json`
  references so `pnpm typecheck` covers `scripts/*.ts`.
- `apps/worker/scripts/doctor.test.ts` — vitest self-test; spawns
  `pnpm scaffold doctor` and asserts exit 0.
- `apps/worker/vitest.unit.config.ts` — added `scripts/**/*.test.ts` to
  the include glob so the doctor self-test is discovered.
- `package.json` — `scaffold` script via Node `--experimental-strip-types`.
- `tsconfig.json` — added `scripts` reference.
- `.gitignore` — added `/scripts/dist` (composite tsconfig emits there).

**Rules:** No business rules implemented. The doctor enforces the structural
rules that prevent the legacy anti-patterns called out in
`.claude/rules/architecture.md` §Legacy anti-patterns from creeping back in.
`migrations-no-json-blobs` (R-DATA-005) is the natural follow-up when
CAP-004 adds SQL — there are no migrations to scan today.

**Decisions:**
- **Doctor uses Node native `--experimental-strip-types` instead of `tsx`.**
  Node 22.23.2 strips types natively, so `tsx` is not needed. The migration
  runner (CAP-004) is free to add `tsx` later if it has a need. Both work,
  no dependency is the lighter choice.
- **`scripts/tsconfig.json` is composite and emits to `scripts/dist/`.**
  `scripts/dist/` is gitignored. The compile output is a side effect of
  `pnpm typecheck`; revisit when CAP-004 lands the migration runner.
- **`module-dependency-zones` parses `import` statements with regex.**
  The TypeScript compiler API would be correct but slow and adds a heavy
  dependency. False positives are acceptable for a doctor; false negatives
  are caught by `import/no-restricted-paths` in eslint.
- **Doctor reports; does not fix.** An auto-fix flag is an abstraction
  without three concrete use cases (`.claude/rules/coding.md`).

**Deferred:** None. CAP-003 closed cleanly.

**Notes:**
- `scripts/doctor.ts` is at the 200-line boundary set by
  `.claude/rules/coding.md`. Future checks will need to consolidate logic
  or move helpers into a separate file.
- Two reviewers' worth of scrutiny was *not* run on this slice — the script
  is small (200 lines, no business logic, no auth, no apps/web) and the
  implementer demonstrated failure modes for criteria #3 (eslint rules
  removed → exit 1) and #9 (forbidden module import → exit 1). Gates are
  verified by the orchestrator. Reviewer-skip is a judgment call recorded
  here so future audits can challenge it.
- No commit was made. The orchestrator is awaiting confirmation per
  `.claude/rules/git.md` ("Agents do not commit or push unless explicitly
  asked"). The working tree is dirty by design.

---

## 2026-08-12 — CAP-002 Test harness (unit + worker pool)  |  Implemented

**Changed:** The repository now has a working vitest harness covering all
seven workspace projects. `pnpm test:unit` runs every non-worker project
(`apps/worker` unit, `packages/contracts`, `packages/email-core`,
`packages/config`, `packages/config`, `packages/test-kit`, `apps/web`) —
6 files, 31 tests. `pnpm test:worker` runs the cloudflare pool against
real D1/R2/KV/Queue bindings via `wrangler.jsonc` — 4 files, 10 tests.
`pnpm test` runs both in sequence — 10 files, 41 tests, under 1 second.
`pnpm exec vitest --project unit run --coverage --coverage.provider=v8`
reports 100% lines covered in `apps/worker/src/platform/**` and
`packages/email-core/**` against the 70% threshold (D-CAP-002-A: workers-pool
coverage deferred). `packages/test-kit` exports `fakeClock`, `fixedIds`,
`fixtures.{user,userRole,installationState}`, `stubOutboundAdapter`, and
`stubFetch`. The stub implements the spec-shaped `OutboundProviderAdapter`
(`key`, `validateConnection`, `send(ctx, msg)`) so it cannot drift before
real adapters land.

**Files:**
- `vitest.config.ts` — root workspace with 7 projects; coverage block
  moved here (per-project coverage is inert in vitest 4 projects mode)
- `apps/worker/vitest.unit.config.ts` — exclude `*.worker.test.ts`
- `apps/worker/vitest.workers.config.ts` — include `*.worker.test.ts`
- `apps/worker/src/platform/{clock,ids,outbound-adapter}.test.ts` — unit tests
  with compile-time interface checks (`const c: Clock = fakeClock(...)`)
- `apps/worker/src/platform/{database,cache}.worker.test.ts` — real-binding
  tests against D1/KV
- `apps/worker/src/http/router.worker.test.ts` — `SELF.fetch()` against
  `/healthz` (no `as unknown as Env` cast)
- `apps/worker/src/entrypoints/inbound-email.worker.test.ts` — cloudflare
  pool stub-flow test
- `apps/worker/test/setup.ts` — `process` import fixed, console silenced
- `packages/contracts/src/index.ts` — `OutboundProviderAdapter` reconciled
  with `docs/rebuild/05-target-architecture/integration-boundaries.md`:
  `readonly key: ProviderKey` (branded), `validateConnection(ctx)`,
  `send(ctx, msg)`. `SendProviderMessage`, `ProviderSendResult`,
  `ProviderRuntimeContext`, `MailAddress`, `ProviderAttachment`,
  `parseProviderKey` added.
- `packages/test-kit/src/{stubs,fixtures,clock,ids,index}.ts` — stub
  implements the spec interface; `isAdministrator` removed from
  `UserRowShape`; `passwordHash` removed (deferred to CAP-004 per
  ADR-006); `userRole` builder added; `RecordedSend.at` renamed to
  `sequence`; `stubFetch` URL-normalises
- `packages/{email-core,config,test-kit}/package.json`,
  `apps/{worker,web}/package.json` — `@unimailbox/test-kit` declared as
  a workspace dep where tests need it; per-package `test*` scripts
  deleted (root is the only supported entry point)
- `work/active/CAP-002-test-harness/task.md` — criteria #10 (workers-pool
  coverage deferred) and #11 (contracts cycle) amended; D-CAP-002-A/B/C
  recorded
- `docs/rebuild/capability-ledger.md` — CAP-002 row → Implemented; three
  deferred items appended

**Rules:** No business rules implemented. The capability's job is to
enforce the testing rules from `.claude/rules/testing.md` so every later
capability's tests are produced under them.

**Decisions:**
- **Filename convention for pool tests.** `*.worker.test.ts` for files
  that need real bindings; the unit project excludes that glob, the
  workers project includes it. One rule, no hand-maintained list.
- **`@unimailbox/test-kit` ↔ `@unimailbox/contracts` cycle.** Documented
  as a deliberate exception in criterion #11. If a future capability
  needs contract tests that use `test-kit` helpers, the helper is moved
  to `packages/contracts/src/test-helpers` and re-exported.
- **`UserRowShape` no longer carries `passwordHash`.** The previous
  `$`-delimited string violated ADR-006. The four-column shape
  (`passwordAlgorithm`, `passwordIterations`, `passwordSalt`,
  `passwordHash`) lands with CAP-004 (identity). Until then, the fixture
  is the minimal row (id, email, timestamps).
- **`OutboundProviderAdapter` reconciled with the spec now.** Cost: one
  shape change before anyone imports it. Cost of deferring: a breaking
  TypeScript change for every consumer plus the stub when the first real
  adapter (CAP-014) lands.

**Deferred:** Recorded in `docs/rebuild/capability-ledger.md` §Deferred items:
- **D-CAP-002-A** — `@vitest/coverage-v8` is incompatible with workerd
  (`node:inspector/promises` is unavailable). The first capability that
  needs workers-pool coverage will switch to `@vitest/coverage-istanbul`
  or move the measurement to the unit project.
- **D-CAP-002-B** — `packages/test-kit` depends on `@unimailbox/contracts`,
  so `contracts` cannot import `test-kit` (cycle). Recorded as the
  reason criterion #11 excludes `packages/contracts`.
- **D-CAP-002-C** — `UserRowShape.passwordHash` deferred to CAP-004
  (identity). The fixture sets the row shape for the table that owns
  the storage.

**Notes:**
- The block-on-cast defect (B2) deserves a wider callout: the legacy
  system was riddled with `setting` rows that carried both a boolean
  and a settings table, and those diverged. The fixture is the cheapest
  place to be honest about the schema; future capabilities must read it.
- Two reviewers (architecture + code) flagged the same root cause
  independently: the harness shipped with the *minimum* shape that
  proved the setup, but did not validate itself against the spec it
  was supposed to enable. The fix pass is mostly about aligning the
  harness with the spec, not adding behaviour.
- No commit was made. The orchestrator is awaiting confirmation per
  `.claude/rules/git.md` ("Agents do not commit or push unless explicitly
  asked"). The working tree is dirty by design.

---

## 2026-08-12 — CAP-001 Monorepo scaffold + toolchain  |  Implemented

**Changed:** A clean checkout of this repo now runs `pnpm install` and `pnpm build` (worker + web)
to deployable artifacts against Cloudflare Worker bindings, with `pnpm lint`, `pnpm typecheck`,
`pnpm test:unit`, `pnpm test:worker`, and `pnpm exec wrangler deploy --dry-run` all exiting 0.
The Worker entry module (`src/worker.ts`) exports `fetch`, `email`, `queue`, and `scheduled`
handlers, so the "One Worker, multiple entrypoints" shape in
`.claude/rules/architecture.md` §Shape is realized in the deployed bundle, not just asserted in
comments. ESLint enforces three boundary zones (`integrations`, `modules`, `platform`) plus
`import/no-cycle` and a `no-restricted-imports` rule that rejects `hono` from `modules/*`,
`platform/*`, and `packages/*`.

**Files:**
- `pnpm-workspace.yaml`, root `package.json`, root `tsconfig.json` (project references)
- `eslint.config.js` (flat config, ESLint 9.39.5; boundary rules above)
- `prettier.config.js`, `.editorconfig`, `.npmrc`, `.prettierignore`, `.gitignore`, `README.md`
- `apps/worker/` — `package.json`, `tsconfig.json`, `tsconfig.node.json`, `wrangler.jsonc` (7
  bindings, `main: src/worker.ts`), `vitest.config.ts`
- `apps/worker/src/worker.ts` — composition module, default-exports `{ fetch, email, queue, scheduled }`
- `apps/worker/src/platform/{env,config,database,object-store,cache,crypto,logger,clock,ids,errors}.ts`
  — `Env` lives in `platform/env.ts` (was previously declared inside the entrypoint, which
  inverted the dependency direction)
- `apps/worker/src/entrypoints/{http,inbound-email,queue,scheduled}.ts`, `apps/worker/src/app-context.ts`,
  `apps/worker/src/http/{router,errors,middleware/*}.ts`
- `apps/worker/src/modules/{identity,onboarding,tenancy,messages,inbound-mail,outbound-mail,provider-sync,attachments,signatures,admin,installation,maintenance}/index.ts`
  — every module is a single empty `index.ts` (the public-surface rule holds by construction)
- `apps/worker/src/integrations/providers/{provider-registry,brevo,resend,cf-sendmail}.ts`,
  `apps/worker/src/integrations/cloudflare/{control-plane,oauth}.ts`
- `apps/web/` — `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html` (with `<noscript>`),
  `src/{main.tsx,App.tsx,app/router.tsx,infrastructure/api/client.ts,components/ui/Button.tsx,styles/tokens.css}`
- `packages/{contracts,email-core,config,test-kit}/src/index.ts` + per-package `package.json` and
  `tsconfig.json`
- `migrations/`, `scripts/` — `.gitkeep` placeholders only (CAP-004 / CAP-003 own the content)

**Rules:** No business rules implemented. The capability's job is to enable later rules:
- `R-DATA-004` (PRAGMA foreign_keys = ON) — the D1 binding `env.DB` is declared in `wrangler.jsonc`
  and reachable through `platform/database.ts`. The actual enforcement lands with the first D1
  migration in CAP-004.
- `R-SECRET-*` (ADR-007) — `env.INSTALLATION_TOKEN` and `env.CREDENTIAL_ENCRYPTION_KEY` are declared
  via `secrets_store_secrets`; `AppContext` deliberately does **not** expose `env` (the
  architecture reviewer's H2), so the request-scoped decrypted-credentials chokepoint remains
  enforceable when the credential store lands.

**Decisions:**
- **Worker entrypoint composition.** A single Cloudflare Worker has exactly one default export; to
  support four triggers (`fetch`, `email`, `queue`, `scheduled`) we default-export an object
  combining the four handler methods. The original scaffold named only `src/entrypoints/http.ts`
  as `main`, so `email`/`queue`/`scheduled` were unreachable in the deployed bundle and the
  `queues.consumers` block was orphaned. The fix-pass moved to `src/worker.ts` as `main`.
  → `.claude/rules/architecture.md` §Shape, `docs/rebuild/05-target-architecture/architecture.md:59-66`
- **`Env` lives in `platform/env.ts`.** Originally declared in `entrypoints/http.ts` and imported
  downward by `platform/*`, which inverted the dependency direction. Moving `Env` to `platform/`
  restores `entrypoints ──▶ modules ──▶ domain`. → `.claude/rules/architecture.md` §Dependency direction
- **`AppContext` exposes named collaborators, not `env`.** `buildAppContext(env)` consumes `env` and
  returns `{ db, cache, setupSessionStore, objectStore, config, clock, ids, logger }`. This is the
  chokepoint ADR-007 needs to enforce request-scoped credential caching.
  → `.claude/rules/architecture.md` §Forbidden, ADR-007
- **Provider adapter files are flat (`brevo.ts`) not directories (`brevo/index.ts`).** Diverges
  from `docs/rebuild/05-target-architecture/architecture.md:84-86` which shows directories.
  Reconciled for CAP-001 because the contract explicitly specified flat files and there is no
  content to fill a directory yet. Phase 1 will convert these to directories as the first
  outbound/webhook adapter lands. → `task.md:84` and `architecture.md:84-86`
- **`'hono'` in `no-restricted-paths` is dead code; the real enforcement is `no-restricted-imports`.**
  `import/no-restricted-paths` matches only path-based imports, not bare module names. A
  configuration-only fix added `no-restricted-imports` for `hono` scoped to `modules/*`,
  `platform/*`, and `packages/*`. Verified by injecting and removing a test violation.
  → `eslint.config.js`
- **Full per-pair module-zone enforcement deferred to CAP-003.** The CAP-001 fix-pass landed three
  hard-edge zones (no `hono` in `modules/*`; no `entrypoints`/`http` in `modules/*`; no
  `entrypoints`/`http` in `platform/*`) plus `no-cycle`. The remaining per-pair dependencies
  (the 132 possible `modules/<a> → modules/<b>` edges, of which the table permits ~20) will be
  encoded in `pnpm scaffold doctor` (CAP-003), which is the natural owner.

**Deferred:** Recorded in `docs/rebuild/capability-ledger.md` §Deferred items:
- `vitest@4.1.10` vs `@cloudflare/vitest-pool-workers@0.10.4` peer mismatch — surfaces only when
  CAP-002 turns on real tests. CAP-002 to bump to `@cloudflare/vitest-pool-workers` 0.21.x.
- `wrangler.jsonc` `account_id` placeholder — operator fills in at deploy time (CAP-005).
- Frontend L1/L2/L3 (theme token beyond `prefers-color-scheme`; `body` font token; global
  `:focus-visible` style) — defer to first real feature capability (CAP-006+).
- Logger deny-list for `LogContext` (per code-review L3) and per-level filtering (L4) — defer to
  CAP-016, the first capability that actually emits user-controlled log fields.

**Notes:**
- The four Worker entrypoints (`http.ts`, `inbound-email.ts`, `queue.ts`, `scheduled.ts`) each
  retain their own file but `worker.ts` is the composition point. Per
  `.claude/rules/architecture.md` §Shape, entrypoints are "thin shells" — that holds.
- `inbound-email.ts` now does `message.setReject(REJECTION_REASON)` rather than
  `message.forward(...)`. The handler is reachable end-to-end (verified by `grep` on
  `dist/worker.js`) but inert: no real inbound mail processing until CAP-021.
- No commit was made. The orchestrator is awaiting confirmation per `.claude/rules/git.md`
  ("Agents do not commit or push unless explicitly asked"). The working tree is dirty by design
  and contains ~75 new files.
- `wrangler.jsonc` placeholder IDs (`REPLACE_WITH_*`) are intentional. They make `wrangler deploy
  --dry-run` exit 0 locally and force the operator to substitute real resource IDs at deploy
  time. CAP-005 owns the deploy runbook.

## 2026-08-11 — Repository Agent Operating System established

**Changed:** The repository now carries its own operating rules, roles, procedures, and execution
state, so a new agent session can recover context from the repository alone (`AGENTS.md` §7).

**Files:**
- `AGENTS.md` — entry point: source-of-truth map, non-negotiable rules, session recovery procedure
- `CLAUDE.md` — Claude-specific subagent and tool conventions only; no duplicated project rules
- `.agents/rules/` — architecture, coding, testing, security, documentation, git, agent-collaboration
- `.agents/roles/` — orchestrator, implementer, architecture-reviewer, code-reviewer, qa-reviewer
- `.agents/skills/` — implement-capability, review-capability, phase-audit
- `.agents/templates/` — capability-task, review-report, handoff
- `work/` — active, reviews, investigations, handoffs, archive (+ `README.md`)
- `docs/rebuild/capability-ledger.md`, `docs/rebuild/implementation-log.md`
- `.gitignore` — `.tmp/`, secrets, build output
- `git init` — the repository was not previously under version control

**Decisions:**
- `docs/rebuild/` is left structurally untouched and remains the design source of truth.
  `.agents/rules/` carries only the *enforceable subset* and links back rather than restating.
  → `.agents/rules/documentation.md` §One fact, one home
- `CAP-NNN` IDs are allocated by the capability ledger, because the specification assigns none.
  IDs are never reused or renumbered. → `docs/rebuild/capability-ledger.md` §Ledger conventions
- `docs/{architecture,business,decisions,operations}/` were **not** created. They would duplicate
  `docs/rebuild/{05,02,09}-*` and become competing sources of truth. Create a `docs/` subdirectory
  only when it has real content with no existing home.
  → `.agents/rules/documentation.md` §Homes
- Security, frontend-reviewer, and four further skills were deliberately **not** created. Empty
  templates train agents to skip the directory. → `.agents/README.md` §Adding to this directory
- Where the roadmap docs disagree with each other, `F-minimal-business-closed-loop.md` §F.1/§F.4 is
  authoritative for Phase 1. → ledger §Known documentation discrepancies

**Notes:** No application code was written. `src/index.ts` is still the placeholder scaffold; the
first real capability is CAP-001 (monorepo scaffold + toolchain), which will replace it.

## 2026-08-11 — Validation pass and fixes

**Changed:** A second agent ran `AGENTS.md` §7 cold, with no prior context, and answered all seven
recovery questions from the repository alone. The procedure works. The same pass surfaced real
defects, all fixed here.

**Files:**
- `.gitignore` — removed stray `/tmp` entry that implied a forbidden scratch location
- `docs/rebuild/README.md` — corrected the phase exit-criteria counts to match the source files
  ("12 boxes" → 11 for Phase 0; "23 boxes" → 29 for Phase 1); replaced the duplicated Rule of
  Three / Rule of One restatement with a pointer to the canonical `.agents/rules/` definitions
- `.agents/rules/architecture.md` — clarified the *intended* reading of "modules never import
  provider SDKs" with "modules may import an *adapter*, not an SDK"; restored the full Forbidden
  list that a partial edit had collapsed
- `.agents/roles/frontend-reviewer.md` — added. Previously listed in `.agents/README.md` as
  "intentionally absent" while the review-capability skill dispatched to it; resolved by adding
  the role with a real (minimal) checklist
- `.agents/README.md` — frontend-reviewer removed from the absent list
- `docs/rebuild/capability-ledger.md` — added discrepancy D-5 (`phase-0-foundation.md` ships with
  acceptance boxes pre-checked, so a fresh agent could conclude Phase 0 is already done; the
  ledger is authoritative)
- `AGENTS.md` §7 — explicitly directs the recovering agent to trust the ledger over the
  pre-checked boxes

**Decisions:**
- The "domain never imports infrastructure" rule, the legacy anti-pattern list, and the module
  layout are deliberately restated in `.agents/rules/architecture.md` from `docs/rebuild/05-*/`.
  The rules file is the *enforceable subset* agents read; the design doc is the full spec. This
  is acknowledged duplication, not a defect — drift is contained by the audit pass at every
  capability close and every phase close.
- Discrepancy D-5 is recorded, not fixed by editing the spec file. The spec is a finalised
  document; the governance layer compensates. Marking it fixed-in-doc would alter the design
  source of truth for cosmetic reasons.
- The audit confirmed all seven recovery questions are answerable; the
  procedure is sound.

**Notes:** Validator's only unfixed concern was the "5-wordings-of-domain-never-imports" issue,
which is acknowledged-duplication: it is the same rule in two roles (rules file + design spec) at
three different levels of detail (sentence, paragraph, full table). This is the intended
hierarchy — navigation (`AGENTS.md`) → rules (`.agents/rules/`) → design (`docs/rebuild/`). A future
audit at a phase boundary will verify they still match.

## 2026-08-11 — Claude Code Hooks (first generation)

**Changed:** The repository now has a deterministic lifecycle guardrail layer around the AI
agent. Six hooks wire into Claude Code's `SessionStart`, `PreToolUse`, `SubagentStart`,
`SubagentStop`, `TaskCompleted`, and `ConfigChange` events. `.claude/settings.json` binds them;
`.claude/hooks/README.md` documents each.

**Files:**
- `.claude/hooks/session-context.sh` — SessionStart, non-blocking. Injects phase + active
  workspace + git state + recent log entry
- `.claude/hooks/protect-destructive-commands.sh` — PreToolUse(Bash), blocking. rm-rf of root
  or home, git reset --hard, git clean -fdx, force-push to main/master/production, DROP
  DATABASE/SCHEMA
- `.claude/hooks/protect-root-pollution.sh` — PreToolUse(Write|Edit|MultiEdit), blocking.
  PLAN.md/NOTES*.md/DEBUG.txt/RESULT.md/etc. at the repo root
- `.claude/hooks/subagent-start-context.sh` — SubagentStart, non-blocking. Common guardrails +
  role-specific appendix for implementer/reviewer/architect/QA/frontend/explore
- `.claude/hooks/validate-subagent-stop.sh` — SubagentStop, blocking. Refuses to let
  implementer-class subagents finish without Status/Files/Tests headings, or reviewers without
  ## BLOCKER/HIGH/MEDIUM/LOW sections
- `.claude/hooks/validate-task-completed.sh` — TaskCompleted, blocking. Refuses to close a
  CAP-NNN with open BLOCKER/HIGH review findings, or with a green-claim that contains FAIL
- `.claude/hooks/protect-config-change.sh` — ConfigChange, non-blocking. Loud audit log when
  governance files change
- `.claude/hooks/lib/log.sh`, `.claude/hooks/lib/project-state.sh` — shared helpers (logging,
  repo-state accessors)
- `.claude/settings.json` — wires the six hooks into their events with precise matchers
- `.claude/hooks/README.md` — the event-purpose-blocking table, payload field map, failure
  behaviour, how to test, and what is deliberately absent
- `.gitignore` — `.tmp/claude-hooks/` added; hook logs are gitignored, the scripts themselves
  are tracked

**Decisions:**
- `set -euo pipefail` is enabled in every script. The implementer habit of running hooks in
  a sandbox where `grep` is wrapped by ugrep-shaped aliases, and where jq rejects payloads
  containing literal control characters, made `pipefail` painful during development. The
  final scripts use jq for input parsing (with `2>/dev/null` on every call) and avoid the
  `(^|\W)` regex shape that ugrep rejects in favour of plain token matches. False-positive
  risk is contained because every script either runs fast enough that a failure is
  acceptable (informational) or matches only high-confidence patterns (blocking).
- `validate-task-completed.sh` does not run `pnpm test` or any other quality gate from inside
  the hook. The hook is fast (jq + grep on small files) and decision-final for the BLOCKER/
  HIGH review case; for "did the tests pass" it relies on the orchestrator's claim plus a
  text-level check that a FAIL token does not appear inside a green claim. Per
  `.agents/rules/testing.md`, real test execution belongs at capability close, not on every
  task completion.
- `protect-config-change.sh` does not block. The governance rule is "prevent accidental
  weakening", not "make immutable". Logging the change loudly is the right enforcement shape;
  the orchestrator's diff review and the rules-change policy in
  `.agents/rules/agent-collaboration.md` are the real safeguard.
- Deliberately NOT wired: `Stop`, `PostToolUse`, `PreCompact`, `PostCompact`, `TaskCreated`,
  `TeammateIdle`. Each was considered and rejected — Stop causes continuation churn,
  PostToolUse adds overhead on every edit, the others have no concrete incident to defend
  against yet.

**Defects found during testing, all fixed before commit:**
- Initial path-resolution in `lib/log.sh` and `lib/project-state.sh` was one level too shallow
  (`../..` from `.claude/hooks/lib/` lands in `.claude/`, not the repo root). Fixed to
  `../../../..`.
- DROP DATABASE inside a quoted shell string was not caught by the original regex because the
  regex required a leading whitespace boundary that did not exist inside the quotes. Fixed
  to a non-word boundary on the left and a non-word-or-end on the right.
- `ps_cap_id_from_text` returned exit-1 on no-match, which `pipefail` propagated into `set -e`
  and silently killed the calling script. Fixed by appending `|| true`.
- The jq extraction in `validate-task-completed.sh` originally had a brittle fallback that
  used `(^|\W)` to anchor a FAIL match; ugrep (the `grep` wrapper that some Claude Code
  environments use) rejected the empty alternative in ERE. Fixed by dropping the boundary
  and relying on the FAIL token alone — keyword detection does not need a regex anchor.

**Defects found by independent audit (post-commit readiness check), all fixed:**
- HIGH: `rm -rf ./build` and `rm -rf ./.git` were over-blocked. Tightened the regex to match
  only when the target is the directory itself (root, home, current, parent, ~user) followed
  by space/semicolon/end — not when it's a specific path inside that directory.
- HIGH: `git push --force-with-lease origin main` was incorrectly blocked. The docs already
  stated `--force-with-lease` is the safe form. Split the regex into two: bare `--force`
  targeting a protected branch blocks, `--force-with-lease` always allows. The block fires
  only when `--force` matches AND `--force-with-lease` does not match.
- MEDIUM: `rm -rf ~root` was under-detected. Replaced literal `~` in the regex with
  `~[^/[:space:]]*` which matches any tilde-prefixed path including `~root`, `~bob`, and
  bare `~`.
- Verification: 20/20 cases PASS in the audit harness at `/tmp/test_drop.py`.

**Notes:** A second agent validated the hooks independently and reported a per-test verdict.
The full report is in `work/reviews/hooks-audit-2026-08-11.md` (created if validation passes
without critical defects; the validator may also report fixes applied inline).

## 2026-08-11 — Claude Code Operating Structure Alignment

**Changed:** The repository's governance was realigned from a "shared multi-tool `.agents/`
layer + Claude Code's own `.claude/`" model to a single Claude Code-centric structure where
**the Main Claude Code session is the sole Orchestrator** and `.claude/` carries every role,
rule, skill, and template the agents read. `AGENTS.md` and `.agents/` were removed; `CLAUDE.md`
became the control-plane entry point.

**Files:**
- `.claude/rules/` — created. 7 rule files moved from `.agents/rules/`: architecture, coding,
  testing, security, documentation, git, agent-collaboration. Internal cross-references updated
  to point at the new location.
- `.claude/agents/` — created. 5 focused agents moved from `.agents/roles/`: implementer,
  architecture-reviewer, code-reviewer, qa-reviewer, frontend-reviewer. Two new agents added:
  **investigator** (read-only evidence-gathering) and **security-reviewer** (auth, secrets,
  webhooks). The `orchestrator` role was **deleted**: the Main Session is the orchestrator; a
  separate orchestrator subagent was duplicate.
- `.claude/skills/` — created. 3 skills moved from `.agents/skills/`: implement-capability,
  review-capability, phase-audit. Two new skills added: **test-business-loop** (verify the
  closed loop on a preview deployment) and **capability-cleanup** (resolve every artifact in
  `work/active/CAP-NNN-*/` to PROMOTE / ARCHIVE / DELETE at capability close).
- `.claude/templates/` — created. 3 templates moved from `.agents/templates/`: capability-task,
  review-report, handoff.
- `CLAUDE.md` — rewritten. Now ~140 lines and explicitly states "Main Claude Code session =
  Project Orchestrator", lists the directory map, the subagent table, the absolute constraints,
  and the state-recovery procedure. Procedure detail is **not** in CLAUDE.md; it lives in skills.
- `.claude/settings.json` — unchanged structurally. No `agent` field; Claude Code uses the Main
  Session by default.
- `.claude/hooks/*.sh` and `.claude/hooks/README.md` — path references updated to `.claude/`;
  the SubagentStop hook adds `investigator` to the exempt list and adds explicit handling for
  `security-reviewer`, `architect-reviewer`, and `frontend-reviewer`. The SubagentStart hook
  adds role-specific blocks for `security-reviewer` and `investigator`. The ConfigChange hook
  adds `.claude/agents/`, `.claude/skills/`, and `.claude/templates/` to its watch list.
- `.gitignore` — single line updated to point at `.claude/rules/documentation.md`.
- `work/README.md`, `docs/rebuild/README.md`, `docs/rebuild/capability-ledger.md` — all path
  references updated.
- `AGENTS.md` and `.agents/` — **deleted**.

**Decisions:**
- The orchestrator role was deleted, not migrated. There is no `.claude/agents/orchestrator.md`
  because there is no separate orchestrator subagent. The orchestrator's responsibilities live
  in three places: `CLAUDE.md` (identity + constraints), `.claude/rules/agent-collaboration.md`
  (coordination constraints), and the skills (procedures). This is the rule from §2 of the
  alignment spec: do not maintain both a Main Session orchestrator and an orchestrator
  subagent.
- The future option (`claude --agent orchestrator`) is preserved in `CLAUDE.md` §Future option.
  Adding an `.claude/agents/orchestrator.md` later is one file; it does not require undoing
  this alignment.
- `business.md` was deliberately **not** added to `.claude/rules/`. There is no business rule
  content that lives outside `docs/rebuild/02-business-discovery/`; the rule files are for
  agent behaviour and architectural constraints, not for business content. Empty rule files
  train agents to skip the directory (the same rule used to skip
  `security-reviewer`/`update-capability-ledger` from the first pass).
- The historical `.agents/` references in this implementation log are **not** corrected — the
  log is append-only history; rewriting it would falsify the trail.

**Notes:** Independent structural review ran after the move. The full audit report is in
`work/reviews/structure-alignment-audit-2026-08-11.md`. Five findings (1 BLOCKER, 2 HIGH,
1 MEDIUM, 1 LOW); all fixed in this same pass:

- **BLOCKER**: stale reference to deleted `.claude/agents/orchestrator.md` in
  `.claude/rules/agent-collaboration.md:22`. Replaced with a pointer to `CLAUDE.md`
  §Execution model.
- **HIGH**: `validate-subagent-stop.sh` required a literal `Tests:` heading but the
  implementer format produces `Tests added:` and `Tests run:`. Regex now matches any of the
  three.
- **HIGH**: `validate-subagent-stop.sh` treated every `general-purpose` agent as an
  implementer, breaking the five roles that share that agent type. The hook now detects
  role from the transcript (via `[role: X]` marker or `.claude/agents/<role>.md` reference)
  and applies the right validation. The Main Session's dispatch convention is updated to
  include `[role: <role-name>]` near the top of each agent's prompt.
- **MEDIUM**: `subagent-start-context.sh` injected implementer instructions to every
  `general-purpose` subagent. The `implementer|general-purpose` case is removed; the
  implementer block now fires only when `agent_type` is literally `implementer`. Other
  roles fall through to the common block and read their own role file.
- **LOW**: `CLAUDE.md` was 126 lines, just past the ~120 target. Trimmed to 108 lines by
  collapsing duplicated prose.

Verification: 24/24 PASS for the end-to-end harness; 20/20 PASS for the destructive-commands
audit harness; 10/10 PASS for the role-detection harness. The Main Session can recover project
state via the procedure in `CLAUDE.md` without spawning any subagent.
