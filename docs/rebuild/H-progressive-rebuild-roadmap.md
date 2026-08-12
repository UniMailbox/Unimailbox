# H. Progressive Rebuild Roadmap

The new system is built in a **new repository**, in seven phases. Each phase is independently deployable and has explicit exit criteria. We do not move to the next phase until the current phase passes all checks on a preview deployment.

## Premise

The new repo runs on a **separate route** from the legacy system. During Phase 0–3, both systems run in parallel; the legacy system keeps serving production users on its route. The new system is on a preview route and may be used by an opt-in pilot deployment. In Phase 4, the data import tool becomes available and per-deployment cutover begins.

This is **not** a strangler migration. The new repo is built from scratch using the design in `05-target-architecture/`. No code is copied from `mail-worker/`, `mail-vue/`, or `mail-react/`. The only thing that crosses the boundary is **data**, via the migration script built in Phase 4.

## Phase 0 — Foundation

**Business goal:** a fresh cloud account can deploy the new system with zero `.env` edits. Setup is gated by a token. The admin can land on `/setup`.

**User value:** none directly. This phase exists to lay the rails.

**Scope:**

- Monorepo workspace (`apps/worker`, `apps/web`, `packages/contracts`, `packages/email-core`, `packages/config`, `packages/test-kit`).
- Worker entrypoints: `http`, `inbound-email`, `queue`, `scheduled`.
- Hono router with `/api/v1` and `/setup/*` routes.
- Drizzle schema for: `installation_state`, `system_settings`, `users`, `sessions`, `encrypted_credentials`, `permissions`, `roles`, `role_permissions`, `user_roles`, `audit_events`, `maintenance_jobs`.
- Migration CLI (`pnpm scaffold init`, `pnpm scaffold db:migrate`).
- Wrangler config with auto-provisioned bindings.
- Web client (React + shadcn/ui + TanStack Query) with router and design tokens (matches `DESIGN.md`).
- Setup wizard step 1 (`claim`) and step 2 (`preflight`) only.
- Setup-route guard: all non-setup routes 302 to `/setup` while `installation_state.status ≠ 'complete'`.
- Structured logger; error model; UUID generator; clock.
- Encrypted credential store (AES-GCM, key from Secrets Store).
- `pnpm test:unit`, `pnpm test:worker`, `pnpm scaffold doctor` all green.

**Out of scope:** user-facing routes, message lifecycle, providers.

**Legacy impact:** none. Phase 0 is the new repo only.

**Testing:**

- Vitest unit tests for crypto, errors, clock.
- Worker-pool tests for the setup-state machine (claim → preflight transitions).
- Doctor checks: bindings declared, schema in sync, no missing migrations, Wrangler version pinned.

**Acceptance criteria:**

```text
[x] pnpm install works from a clean checkout of the new repo.
[x] pnpm scaffold doctor exits 0.
[x] pnpm test:unit passes.
[x] pnpm test:worker passes.
[x] pnpm build produces a deployable Worker + web client bundle.
[x] Deploying to a fresh cloud account succeeds with no manual .env edits.
[x] First GET / returns 302 to /setup.
[x] /setup/status returns { currentStep: 'claim' } on a fresh DB.
[x] /setup/claim with the correct INSTALLATION_TOKEN binds a setup session.
[x] /setup/claim with the wrong token returns 401.
[x] /setup/preflight reports each binding present.
```

**Risks:** Wrangler auto-provisioning is relatively new; pin a tested version. Secrets Store is also recent; have a fallback.

---

## Phase 1 — Minimal Business Closed Loop

**Business goal:** an admin can install, claim a domain, connect Brevo, invite a user, and that user can read a real inbound email and reply.

**User value:** end-to-end mail flow works for the first tenant (typically a pilot deployment).

**Scope:**

- Modules: `identity`, `onboarding`, `tenancy`, `messages`, `inbound-mail`, `outbound-mail`, `admin/installation`, `admin/audit`.
- Full setup wizard (steps 3–9): administrator, cloudflare (dashboard-assisted mode), domain, inbound smoke test, brevo, outbound smoke test, complete.
- Authn + Authz middleware.
- Mailbox CRUD (owner only — no sharing yet).
- Inbox list, message detail, read state, basic delete.
- Compose + send with provider registry (Brevo only).
- Outbound queue + consumer + dispatcher recovery cron.
- Webhook ingest (Brevo) + delivery idempotency + status application.
- Admin pages: users (list only), webhook events (read-only).
- Audit event emission on every state transition.

**Out of scope:** mailbox sharing, drafts, stars, archive/trash, attachments beyond simple inline, signatures, server drafts, search, bulk admin operations, provider sync, Resend/CF providers, Telegram, AI, S3, OAuth, Turnstile, analytics.

**Legacy impact:** none. The new system runs on its own bindings.

**Testing:**

- Domain tests: state machine transitions for `Message.status` and `OutboundJob.status`.
- Integration tests: Brevo mock + Worker pool; full inbound → outbound round trip.
- API contract tests: every `/api/v1/*` route exercised via `app.fetch` with a mocked env.
- One E2E test: register → mailbox → inbound → reply.

**Acceptance criteria:** see `F.4` (Phase 1 Exit Criteria — 23 boxes).

**Risks:** Brevo API rate limits during smoke tests; cloudflare Email Routing may need manual DNS verification.

---

## Phase 2 — Reliable Business Loop

**Business goal:** the loop is correct under failure. Validation, permission, state machine, idempotency, retry, and audit are enforced.

**User value:** no silent corruption, no duplicate sends, no lost deliveries.

**Scope:**

- **Idempotency**: every mutating endpoint accepts `Idempotency-Key`.
- **Outbox pattern**: `SendMessage` writes `messages` + `outbound_jobs` + `idempotency_records` in one D1 batch.
- **Retry**: queue consumer classifies errors; retryable errors re-queue with backoff; terminal errors mark `failed`.
- **State machine guards**: `applyStatusIfNewer` prevents downgrades; `attempts` cap on outbound jobs.
- **Stale authn**: permission check consults DB on every request, not KV snapshot. KV cache TTL reduced to 60s.
- **Validation**: zod schemas on every endpoint; max body size; max recipient count; max subject length.
- **Error model**: every endpoint returns `{ error: { code, message, requestId } }` with stable codes.
- **Audit log**: full audit event coverage; `/admin/audit-events` UI.
- **Webhook ordering**: `provider_message_state.status_rank` properly applied.
- **Observability**: structured logs, basic request metrics.

**Out of scope:** still no drafts, attachments, sharing.

**Legacy impact:** none.

**Acceptance criteria:**

```text
[x] Replaying /messages/send with same Idempotency-Key returns same message id.
[x] /messages/send with same key + different body returns 409.
[x] Outbound job survives consumer crash mid-send (attempts++, lock expires, re-queued).
[x] Webhook arriving before send-complete is queued, not lost.
[x] No /api/v1/* endpoint accepts a request > 1 MB.
[x] All audit events are queryable by actor and resource.
[x] All endpoints return JSON error body with stable code.
```

**Risks:** Idempotency key TTL must match client retry window; we set 24h default.

---

## Phase 3 — Complete Core Business

**Business goal:** the second and third core flows work: drafts and attachments.

**User value:** users can save drafts locally + server-side, attach files, share mailboxes.

**Scope:**

- **Attachments**:
  - `attachment_uploads` table with presigned R2 PUT URLs.
  - Triggers validate ownership + status + expiry + size match.
  - `attachments/:id/download` API with authorization check.
  - Inline image CID rewriting.
- **Drafts**:
  - Server-authoritative drafts via `messages.status='draft'` + `mailbox_messages.folder='drafts'`.
  - Optimistic concurrency on `messages.updated_at` (`If-Match` header).
  - IndexedDB-backed local working copy (crash recovery only).
  - `POST /drafts/:id/send` atomically transitions draft → sent.
- **Sharing**:
  - `mailbox_members` CRUD (viewer / sender / admin).
  - Per-user read/star/delete state on `message_user_state`.
  - `mailbox.share` permission gates member management.
- **Folders**: sent, drafts, archive, trash views.
- **Stars**: per-user star toggle.

**Out of scope:** search, bulk operations, advanced admin features.

**Legacy impact:** none.

**Acceptance criteria:**

```text
[x] User uploads 5 MB PDF → attaches to compose → sends → recipient downloads.
[x] User saves draft → closes browser → reopens → draft is on server.
[x] Owner shares mailbox with viewer → viewer reads; viewer cannot delete.
[x] Two users star the same message; starring one does not affect the other.
[x] Attachment upload row is consumed in same transaction as message insert.
[x] Unused upload expires after 1 hour and is cleaned by scheduled job.
```

---

## Phase 4 — Operations + Data Import

**Business goal:** admins can operate the system: search, audit, manual intervention, exception handling. **And** the data import tool is ready for legacy cutover.

**User value:** administrators can diagnose and recover from incidents. Existing legacy deployments can cut over.

**Scope:**

- **Search**: cursor-paginated full-text search over `messages.subject`, `from_address`, `to_address`. FTS5 virtual table.
- **Bulk operations**: admin `messages/batch-delete` with idempotency + soft-delete.
- **Provider sync**: `BrevoSyncAdapter` lists known messages and back-fills status.
- **Audit UI**: filter by actor, action, resource, time range.
- **Maintenance jobs**: cursor-based backfills; `MaintenanceJob` table; handler registry.
- **Scheduled jobs**:
  - Outbound dispatcher recovery (every minute).
  - Session cleanup (daily).
  - Idempotency cleanup (daily).
  - Upload cleanup (hourly).
  - Webhook cleanup (daily).
  - Orphan R2 cleanup (daily).
- **Setup repair session**: authenticated admin can re-enter `/setup` for upgrade-only steps.
- **Rate limits**: per-IP on `/auth/login`, per-user on `/messages/send`, per-IP on `/setup/claim`.
- **ECharts dashboard**: simple counters.
- **Operator runbook**: `docs/operations/runbook.md`.
- **Data import tool**: `scripts/migrate-from-legacy/` reads from legacy D1 + R2, transforms, writes to new D1 + R2. Idempotent, cursor-based, tested against a legacy fixture.

**Out of scope:** full-text search across attachments; provider sync for Resend/CF (those are added in Phase 5).

**Legacy impact:** per-deployment cutover begins. See `07-migration/cutover-plan.md`.

**Acceptance criteria:**

```text
[x] Admin searches for "test" in subject across all mailboxes.
[x] Admin bulk-deletes 50 messages in one request with idempotency.
[x] Outbound dispatcher cron recovers 5 stuck jobs.
[x] Operator runbook executes successfully against a staging deployment.
[x] Setup repair session allows re-running only the upgraded step.
[x] Migration script dry-run produces a report with row counts.
[x] Migration script real-run transforms 100% of legacy users, mailboxes, and messages without data loss.
[x] Migration script is idempotent: re-running produces zero additional inserts.
[x] Migration script is cursor-based: a crash mid-run resumes from the last checkpoint.
[x] After migration, the new system can authenticate a legacy user (after password reset).
[x] After migration, a legacy inbox is viewable in the new client.
```

---

## Phase 5 — Automation & Multi-Provider

**Business goal:** the system supports additional providers and side-effect automations without changing message lifecycle code.

**User value:** operators can switch providers or add automations per their deployment.

**Scope:**

- **Second provider**: Resend adapter. Tests must pass without changing `SendMessage` use case.
- **Cloudflare Email binding adapter**: if `c.env.email` is configured, register `cf-sendmail` provider.
- **Provider-neutral event mapping**: status application is per-provider in the adapter; use case does not branch.
- **Telegram forwarding**: per-user opt-in; outbound webhook job.
- **AI verification-code extraction**: per-user opt-in; requires Workers AI binding.
- **OAuth (LinuxDo)**: optional; admin can disable.
- **Turnstile**: optional; admin can disable.
- **S3 backend**: optional; admin can configure.
- **Notification subsystem**: simple in-app notifications.
- **Custom domain for R2**: per-deployment.

**Out of scope:** POP3/IMAP (separate plan), DMARC/SPF/DKIM tooling, anti-spam.

**Acceptance criteria:**

```text
[x] Provider registry holds 3 adapters (Brevo, Resend, CF); no business code branches on provider.
[x] Adding a 4th provider requires only: new file in integrations/, registry entry, schema.
[x] Telegram forwarding respects per-user opt-in and survives worker restart.
[x] AI extraction disabled by default; per-user opt-in only.
```

---

## Phase 6 — Scale & Performance

**Business goal:** the system handles realistic load without degradation.

**User value:** snappy UX under load.

**Scope:**

- **Caching**: KV cache for `installation_state`, `system_settings`, permission lookups (TTL 60s).
- **Pagination**: cursor-based pagination on every list endpoint; stable across inserts.
- **Async dispatch**: outbound jobs dispatched via Cloudflare Queue; backpressure tuning.
- **Performance budgets**:
  - `/inbox` GET p95 ≤ 300 ms.
  - `/messages/send` POST p95 ≤ 800 ms (excluding provider roundtrip).
  - Inbound handler p95 ≤ 5 s for 5 MB messages.
- **Observability**: OpenTelemetry traces; per-module metrics; SLO dashboards.
- **Capacity testing**: k6 load tests at 10× expected peak.
- **R2 lifecycle rules**: archive deleted attachments after 90 days.
- **D1 Time Travel bookmarks** before every production migration.
- **Auto-scaling**: Workers scale automatically; verify cold-start budget.

**Out of scope:** moving to a different runtime.

**Acceptance criteria:**

```text
[x] p95 /inbox < 300 ms over 10-minute sustained load.
[x] Inbound handler < 5 s p95 for 5 MB messages.
[x] Cold-start budget < 50 ms.
[x] Cache hit rate > 90% for settings.
```

---

## Summary: phase → capability map

| Phase | Capability unlocked |
|---|---|
| 0 | Deploy-to-cloud, setup gating, encrypted secret store |
| 1 | **First end-to-end mail flow** |
| 2 | Idempotency, retry, audit, observability |
| 3 | Attachments, drafts, sharing, stars, folders |
| 4 | Search, bulk operations, sync, runbook, repair, **data import** |
| 5 | Multi-provider, Telegram, AI, OAuth |
| 6 | Performance, caching, observability depth |

Each phase's deliverables form a **vertical slice**: domain, persistence, application, API, UI, tests, deploy, smoke-test.

## Cumulative capability ledger

The ledger is a checklist in the new repo (`docs/capability-ledger.md`). It tracks:

- Each business capability from `I-legacy-new-mapping.md`.
- The phase when the new system implements it.
- The status: `Pending`, `In Progress`, `Implemented` (tested), `Verified` (tested against legacy data + behavior), or `Deferred`.

In the new repo, "Verified" means: the new implementation has been tested side-by-side with the equivalent legacy implementation on the same inputs. "Implemented" means code-complete but not yet compared to legacy. Per-deployment cutover is the moment a capability transitions from `Verified` to `In Production` in the legacy deployment.