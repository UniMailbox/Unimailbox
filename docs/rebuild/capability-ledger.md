# Capability Ledger

**The authoritative answer to "what is done, what is in progress, what is next."**

Update this file at every capability boundary. If it disagrees with reality, the repository's memory
is broken — fix it before writing more code.

- Design source of truth: `docs/rebuild/` (do not restate design here)
- Procedure: `.claude/skills/implement-capability/SKILL.md`
- Phase gate: `.claude/skills/phase-audit/SKILL.md`

## Status vocabulary

| Status | Meaning |
|---|---|
| `Pending` | Not started |
| `In Progress` | A workspace exists in `work/active/` |
| `Implemented` | Code complete, reviewed, quality gates pass |
| `Verified` | Demonstrated end-to-end on a preview deployment, evidence recorded |
| `Deferred` | Explicitly moved to a later phase, with a reason recorded here |

`Implemented` requires only that the code is complete and reviewed. `Verified` requires an
observed end-to-end run. Never mark either from a subagent's unverified claim.

## Current state

| | |
|---|---|
| **Phase** | 0 — Foundation |
| **Active capability** | none |
| **Next capability** | CAP-006 |
| **Blocked** | none |
| **Repository state** | scaffold only — `src/index.ts` is a placeholder; no `apps/`, `packages/`, or `migrations/` yet |

## Phase progress

| Phase | Title | Status | Exit criteria | Audit |
|---|---|---|---|---|
| 0 | Foundation | Not started | 11 boxes — `docs/rebuild/08-roadmap/phase-0-foundation.md` | — |
| 1 | Minimal Business Closed Loop | Not started | 29 boxes — `docs/rebuild/F-minimal-business-closed-loop.md` §F.4 | — |
| 2 | Reliable Business Loop | Not started | 7 boxes — `docs/rebuild/08-roadmap/phase-2-core-loop.md` | — |
| 3 | Complete Core Business | Not started | drafts + attachments | — |
| 4 | Operations + Data Import | Not started | ops tooling + legacy import | — |
| 5 | Automation & Multi-Provider | Not started | — | — |
| 6 | Scale & Performance | Not started | — | — |

A phase closes only when **every** exit criterion is MET, verified by an agent that did not
implement it. There is no partial pass.

---

## Phase 0 — Foundation

> Goal: a fresh cloud account can deploy the new system with zero `.env` edits. Setup is gated by a
> token. The admin can land on `/setup`.
> Out of scope: user-facing routes, message lifecycle, providers.

| ID | Capability | Status | Depends on | Evidence |
|---|---|---|---|---|
| CAP-001 | Monorepo scaffold + toolchain (`pnpm install`, `lint`, `typecheck`, `build`) | Implemented | — | `pnpm install` ✓ · `pnpm typecheck` ✓ · `pnpm lint` ✓ · `pnpm test:unit`/`test:worker` stubs ✓ · `pnpm build` ✓ · `wrangler deploy --dry-run` ✓ (7 bindings); smoke `/healthz` → 200; bundle exports `fetch`/`email`/`queue`/`scheduled` from `src/worker.ts`; boundary rules enforced (`import/no-cycle` + 3 `no-restricted-paths` zones + `no-restricted-imports` for `hono`). Four reviewers ran; 1 BLOCKER + 7 HIGH + ~6 MEDIUM all resolved in fix pass. See `work/archive/2026-08/CAP-001/`. |
| CAP-002 | Test harness: `test:unit` (vitest) + `test:worker` (cloudflare pool) | Implemented | CAP-001 | `pnpm test:unit` ✓ (6 files, 31 tests) · `pnpm test:worker` ✓ (4 files, 10 tests) · `pnpm test` ✓ (10 files, 41 tests in <1 s) · `pnpm exec vitest --project unit run --coverage --coverage.provider=v8` ✓ (100% lines, threshold 70%) · `pnpm typecheck` ✓ · `pnpm lint` ✓ · `pnpm build` ✓. Workspace: `vitest.workspace.ts` + 7 per-project configs; `apps/worker` splits into `unit` (node pool) and `workers` (cloudflare pool). `packages/test-kit` exports `fakeClock`, `fixedIds`, `fixtures.{user,userRole,installationState}`, `stubOutboundAdapter`, `stubFetch`. Two reviewers ran; 2 BLOCKER + 5 HIGH + ~8 MEDIUM resolved. D-CAP-002-A (workers-pool coverage deferred), D-CAP-002-B (test-kit cycle in `contracts`), D-CAP-002-C (passwordHash row shape) logged. |
| CAP-003 | `pnpm scaffold doctor` — binding + schema diagnostics, exits 0 | Implemented | CAP-001 | `pnpm scaffold doctor` ✓ (`10/10 checks passed.`). `scripts/doctor.ts` (200 lines, zero `any`); `scripts/scaffold.ts` (22-line dispatcher via Node 22 `--experimental-strip-types`). 10 checks: `wrangler-bindings` · `wrangler-compat` · `migrations-present` · `migrations-ordered` · `schema-version` · `module-dependency-zones` · `eslint-boundary-rules` · `tsconfig-strict` · `harness-no-placeholders` · `tests-cover-contracts`. Self-test at `apps/worker/scripts/doctor.test.ts` spawns the doctor and asserts exit 0; failure modes demonstrated (criteria #3 and #9). D-CAP-001-C resolved — full per-pair module-zone enforcement is in `module-dependency-zones`. |
| CAP-004 | Initial D1 schema + `migrations/0001_initial.sql` + `.verify.sql` | Implemented | CAP-001, CAP-002, CAP-003 | `migrations/0001_initial.sql` (11 tables, 250 lines, FK + NOCASE + CHECK + CASCADE substrate) · `.verify.sql` (53 assertions, all green) · `.md` (compatibility / backfill / recovery / tracking convention) · Drizzle typed schemas at `apps/worker/src/database/schema/{identity,onboarding,admin,outbound-mail}.ts` with `$inferSelect`/`$inferInsert` exports, zero `any` · `scripts/db-migrate.ts` (apply+track atomic in one D1 batch; ghost detection; --reset refuses unless `ENVIRONMENT=local`; stderr merged into stdout before --json parse; `parseWranglerJson` fails closed on shape mismatch; filename regex validation) · `pnpm scaffold db:migrate [--reset] [--verify]` works; second run is idempotent ("No pending migrations (1 already applied)") · `packages/test-kit/src/migrationsDb.ts` worker-pool D1 fixture (4 named tests: R-DATA-001 case-insensitive email, R-DATA-004 FK PRAGMA, R-AUTH-002 status CHECK, R-AUTH-006-PBKDF2-floor iterations CHECK; ADR-006 four-column shape) · `pnpm scaffold doctor` `schema-version` parses `CURRENT_SCHEMA_VERSION` from `apps/worker/src/database/schema-version.ts` and matches the highest migration prefix · `pnpm exec drizzle-kit check` exits 0 · `ENVIRONMENT=preview pnpm scaffold db:reset` exits 2 (AC #15) · `pnpm typecheck`/`lint`/`test:unit` (8/37) /`test:worker` (5/15, both worker-pool projects) /`test` (12/47) /`build` all exit 0. Three reviewers ran (architecture ACCEPT WITH NOTES, code REJECT, qa ACCEPT, security ACCEPT WITH FIXES); fix-up pass addressed every BLOCKER and HIGH; re-review ACCEPT. Deferred: D-CAP-004-A (password_iterations 100k schema floor vs ADR-006's 600k — CAP-019), D-CAP-004-B (UserId contracts — CAP-017/019), D-CAP-004-C (db-migrate.ts ~260 lines — orchestrator judgment), D-CAP-004-D (sql-raw.d.ts sole source of cloudflare:test typings). |
| CAP-005 | Deploy to a fresh Cloudflare account with no manual `.env` edits | Implemented | CAP-003, CAP-004 | `scripts/deploy.ts` (733 lines, zero `any`) · `pnpm scaffold deploy` provisions D1 + R2 + 2× KV + Queue + Secrets Store idempotently · secrets generated via `crypto.getRandomValues` (32 bytes hex, ADR-007), piped via stdin (not `--value` CLI flag) · `--force-secrets` requires interactive confirmation (CREDENTIAL_ENCRYPTION_KEY data-loss warning) · resolves placeholders into gitignored `wrangler.resolved.jsonc` — committed `wrangler.jsonc` byte-for-byte unmodified · `ENVIRONMENT` guard (exit 2 on unset/local) · D1 create parses text output (no undocumented `--json`), D1 list uses `uuid` field · parse failures warn to stderr (not silently swallowed) · `AbortSignal.timeout(10s)` healthz with JSON body parse · `computeSecretAction` pure function exported + 7 test cases · dry-run does not persist state or flip secret flags (BLOCKER fix verified) · `docs/operations/deploy.md` runbook (rotation warning, shared-machine risk, multi-account, healthz limitation) · `scripts/vitest.config.ts` new test project · `pnpm typecheck`/`lint`/`test:unit` (9/55)/`test:worker` (5/15)/`test` (13/65)/`build` all exit 0 · `pnpm scaffold doctor` 10/10. Three reviewers ran (code REJECT→ACCEPT, security ACCEPT WITH FIXES, architecture ACCEPT WITH NOTES); fix-up pass 2 addressed 2 BLOCKER + 3 HIGH + 5 MEDIUM + 4 LOW; focused re-review ACCEPT. Deferred: D-CAP-005-A (wrangler --json output shapes — E2E), D-CAP-005-B (stdin secret approach — E2E), D-CAP-005-C (`secret update` verb — E2E), D-CAP-005-D (healthz under `workers_dev:false`), D-CAP-005-E (stale-state ID validation). |
| CAP-006 | Setup gate: `GET /` → 302 `/setup` while `installation_state.status != 'complete'` | Pending | CAP-004 | |
| CAP-007 | `GET /setup/status` → `{ currentStep: 'claim' }` on a fresh DB | Pending | CAP-006 | |
| CAP-008 | `POST /setup/claim` — `INSTALLATION_TOKEN` binds a KV setup session; wrong token → 401 | Pending | CAP-007 | |
| CAP-009 | `POST /setup/preflight` — reports each binding present + schema version | Pending | CAP-008 | |

## Phase 1 — Minimal Business Closed Loop

> Goal: an admin can install, claim a domain, connect Brevo, invite a user, and that user can read a
> real inbound email and reply.
> The 27-step loop is in `docs/rebuild/F-minimal-business-closed-loop.md` §F.1.

| ID | Capability | Status | Depends on | Evidence |
|---|---|---|---|---|
| CAP-010 | `POST /setup/administrator` — first user, PBKDF2 password (ADR-006) | Pending | CAP-009 | |
| CAP-011 | `POST /setup/domain` — persist a managed domain as `active` | Pending | CAP-010 | |
| CAP-012 | Cloudflare dashboard-link (allowlisted) + `/setup/cloudflare/verify` Email Routing check | Pending | CAP-011 | |
| CAP-013 | `POST /setup/inbound-smoke-test` — generated message reaches the Worker | Pending | CAP-012 | |
| CAP-014 | Provider registry + Brevo adapter; `POST /setup/brevo` encrypts the key (ADR-002, ADR-007) | Pending | CAP-011 | |
| CAP-015 | `POST /setup/outbound-smoke-test` — real send, provider ID confirmed | Pending | CAP-014 | |
| CAP-016 | `POST /setup/complete` — status `complete`; `GET /` serves the React app shell | Pending | CAP-013, CAP-015 | |
| CAP-017 | Roles + permissions seed; `requirePermission` middleware | Pending | CAP-010 | |
| CAP-018 | Registration keys — admin issues via `/admin/invite-codes` | Pending | CAP-017 | |
| CAP-019 | User registration with a key + login + session; lands on `/inbox` | Pending | CAP-018 | |
| CAP-020 | Mailbox creation and `mailboxes.assertCan` authorizer | Pending | CAP-019, CAP-011 | |
| CAP-021 | Inbound mail: MIME parse → Message + MailboxMessage in one D1 batch (`R-INBOUND-008`) | Pending | CAP-020, CAP-013 | |
| CAP-022 | Inbox list + read message; `isRead` persists per user (`R-MESSAGE-005`) | Pending | CAP-021 | |
| CAP-023 | Compose reply with quoted text; send → outbound job → queue consumer → Brevo | Pending | CAP-022, CAP-014 | |
| CAP-024 | Brevo webhook → message `delivered`; signature verified before JSON parse | Pending | CAP-023 | |
| CAP-025 | `/admin/webhook-events` — admin sees the delivery event | Pending | CAP-024 | |
| CAP-026 | Audit events for `setup.claim`, `setup.complete`, `mailbox.create`, `message.receive`, `message.send`, `webhook.delivered` | Pending | CAP-023, CAP-024 | |

## Phase 2 — Reliable Business Loop

> Goal: the loop is correct under failure. Validation, permission, state machine, idempotency,
> retry, and audit are enforced.
> Out of scope: still no drafts, attachments, or sharing.

| ID | Capability | Status | Depends on | Evidence |
|---|---|---|---|---|
| CAP-027 | Idempotency records on every mutating endpoint (ADR-004) | Pending | Phase 1 | |
| CAP-028 | Durable outbox: attempts, lock expiry, re-queue on consumer crash (ADR-003) | Pending | CAP-023 | |
| CAP-029 | Webhook ordering — early or out-of-order events queued, never lost (`R-MESSAGE-007`) | Pending | CAP-024 | |
| CAP-030 | Message + OutboundJob state machine guards; terminal states provably terminal | Pending | CAP-023 | |
| CAP-031 | Request validation + 1 MB body limit on all `/api/v1/*` | Pending | Phase 1 | |
| CAP-032 | Stable error model — every endpoint returns a JSON body with a stable `code` | Pending | Phase 1 | |
| CAP-033 | Audit events queryable by actor and by resource | Pending | CAP-026 | |
| CAP-034 | Cursor pagination (HMAC-signed `(created_at, id)`) | Pending | CAP-022 | |

## Phases 3–6

Decomposed into capabilities when the preceding phase's audit passes. Premature decomposition
produces IDs that no longer match the work by the time it starts.

| Phase | Scope summary | Source |
|---|---|---|
| 3 | Drafts, attachments, mailbox sharing, stars, folders | `docs/rebuild/08-roadmap/phase-3-business-completeness.md` |
| 4 | Search, audit UI, manual intervention, **legacy data import** (`scripts/migrate-from-legacy/`), cutover | `docs/rebuild/08-roadmap/phase-4-operations.md` |
| 5 | Resend + Cloudflare Email adapters, provider sync, side-effect automations | `docs/rebuild/08-roadmap/phase-5-automation.md` |
| 6 | Caching, async dispatch, performance budgets, OTel, capacity testing | `docs/rebuild/08-roadmap/phase-6-optimization.md` |

---

## Deferred items

Every MEDIUM review finding not fixed, and every feature moved to a later phase, is recorded here
with a reason. An unrecorded deferral is a dropped finding.

| ID | Item | Deferred from | To | Reason |
|---|---|---|---|---|
| D-CAP-001-A | `vitest@4.1.10` vs `@cloudflare/vitest-pool-workers@0.10.4` peer mismatch — surfaces when CAP-002 turns on real tests | CAP-001 | CAP-002 | Peer mismatch only matters when the worker test pool is invoked. CAP-002 will bump `@cloudflare/vitest-pool-workers` to ≥ 0.21.x as part of the test harness configuration. |
| D-CAP-001-B | `wrangler.jsonc` placeholder IDs (`REPLACE_WITH_D1_DATABASE_ID` etc.) — placeholder by design, operator fills in at deploy | CAP-001 | CAP-005 | Wrangler dry-run exits 0 against placeholders; real resource IDs only matter at deploy. |
| D-CAP-001-C | Full per-pair `modules/<a> → modules/<b>` zone enforcement (132 possible edges, table permits ~20) | CAP-001 | CAP-003 | CAP-003 (`pnpm scaffold doctor`) is the natural owner — the diagnostic command already iterates the table to check rules. |
| D-CAP-001-D | Provider adapter flat files (`brevo.ts`) vs spec directories (`brevo/index.ts`) — divergence from `architecture.md:84-86` | CAP-001 | Phase 1 | Contract specified flat files; no content to fill a directory yet. Phase 1 will convert when the first outbound/webhook adapter lands. |
| D-CAP-001-E | Frontend theme beyond `prefers-color-scheme`, tokenized `body` font, global `:focus-visible` style | CAP-001 | CAP-006+ | Skeleton has tokens.css; full theme system lands with the first real feature page (CAP-006 setup wizard). |
| D-CAP-001-F | Logger deny-list for `LogContext` and per-level filtering | CAP-001 | CAP-016 | The platform logger is a thin wrapper today. CAP-016 (the first capability that emits user-controlled log fields — outbound send receipts) is where a deny-list earns its keep. |
| D-CAP-002-A | Worker-pool v8 coverage is incompatible with workerd (`@vitest/coverage-v8` imports `node:inspector/promises`). | CAP-002 | Phase 1 | Coverage is measured against the `unit` project only (criterion #10). The first capability that needs workers-pool coverage will switch to `@vitest/coverage-istanbul` or move the measurement to the unit project. |
| D-CAP-002-B | `packages/test-kit` depends on `@unimailbox/contracts`. Importing `test-kit` from `contracts` would cycle. | CAP-002 | Phase 1 | Criterion #11 excludes `packages/contracts` with the cycle recorded as the reason. If a future capability needs a contract test that uses `test-kit` helpers, the helper is moved to `packages/contracts/src/test-helpers` and re-exported via `test-kit`. |
| D-CAP-002-C | `UserRowShape` no longer carries `passwordHash` (the previous `$`-delimited string violated ADR-006). | CAP-002 | CAP-004 | The four-column shape `passwordAlgorithm` / `passwordIterations` / `passwordSalt` / `passwordHash` lands with CAP-004 (identity). **RESOLVED in CAP-004** — `users.password_{algorithm,iterations,salt,hash}` columns exist; the test-kit `UserRowShape` still omits them (CAP-019 territory). |
| D-CAP-004-A | `users.password_iterations` schema `CHECK (password_iterations &gt;= 100000)` is weaker than ADR-006's 600,000. | CAP-004 | CAP-019 | Schema-side floor is a sanity check; the exact 600k default lives in the application layer (user registration) and rehashes on the next login when the floor is raised. |
| D-CAP-004-B | `UserId` and other cross-boundary types must live in `packages/contracts/` before repositories land in the admin/identity modules. | CAP-004 | CAP-017/CAP-019 | Architecture reviewer L1: Drizzle schemas currently cross-reference `users.id` from `./identity`; repositories must not reach into `database/schema/*` for row types. |
| D-CAP-004-C | `scripts/db-migrate.ts` is ~260 lines, exceeds the 150-line rule in `.claude/rules/coding.md`. | CAP-004 | — | Orchestrator judgment: dev-only CLI script; the five jobs (env-guard, reset, ensure-table, ghost-check, apply, verify) benefit from co-location. Splitting would add files without simplifying the logic. |
| D-CAP-004-D | `packages/test-kit/src/sql-raw.d.ts` is the sole source of `cloudflare:test` typings (`env.DB`, `applyD1Migrations`); the official `@cloudflare/vitest-pool-workers` module does not export this surface in 0.21.x. | CAP-004 | — | Code reviewer M4. If a future tsconfig pulls in `@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts`, the `env` declaration needs to merge rather than override. |
| D-CAP-005-A | Actual wrangler `--json` output shapes for `d1 list`, `kv namespace list`, `queues list`, `secrets-store store list` are unverified — `parseWranglerList` assumes a `{success, result}` envelope that may differ. | CAP-005 | Verified gate | Every HIGH from code+arch reviews traces to unverified CLI output. The operator's first real deploy pins the shapes; parse failures now warn to stderr instead of being silently swallowed. |
| D-CAP-005-B | `wranglerSecret` stdin approach (piping secret via `input` instead of `--value`) is unverified against wrangler's interactive prompt. | CAP-005 | Verified gate | Wrangler's `--value` flag is documented as insecure; stdin is the correct approach. If wrangler's prompt does not read from piped stdin, the operator will see a hang or error on first deploy. |
| D-CAP-005-C | `wrangler secrets-store secret update` verb is used for `--force-secrets` but was not documented in the task contract's CLI reference. | CAP-005 | Verified gate | Code reviewer confirmed via wrangler docs that `update` exists with `--name`/`--scopes`. If the shape differs at runtime, force-secrets will fail visibly. |
| D-CAP-005-D | Healthz check is unreachable under the default `workers_dev: false` config. | CAP-005 | CAP-006+ | The URL regex looks for `*.workers.dev` which never appears when `workers_dev` is false. Runbook documents this; operator must configure a route or set `workers_dev: true` for preview. |
| D-CAP-005-E | Stale `.cloudflare-resources.json` IDs are trusted unconditionally by provisioners — no existence validation. | CAP-005 | Verified gate | Architecture reviewer M1. An out-of-band-deleted resource with lingering state yields an opaque failure at deploy time. Acceptable until the first operator encounters it. |

## Known documentation discrepancies

Found while building this ledger. Each needs an owner decision before the affected phase closes;
none is a blocker for Phase 0.

| # | Discrepancy | Files |
|---|---|---|
| D-1 | Phase 1 exit criteria described as "23 boxes" but §F.4 lists 29. This ledger and the phase audit use **§F.4 verbatim** as authoritative. | `H-progressive-rebuild-roadmap.md` vs `F-minimal-business-closed-loop.md` |
| D-2 | §F.5 justifies a step "(28)"; §F.1 ends at step 27. | `F-minimal-business-closed-loop.md` |
| D-3 | Header says "22-step slice", body lists 23 steps and skips step 13. §F.1's 27-step version is authoritative. | `06-business-loops/minimal-loop.md` |
| D-4 | §F.2 says "32 capabilities"; the table has 33 rows. | `F-minimal-business-closed-loop.md` |
| D-5 | `08-roadmap/phase-0-foundation.md` ships with all 11 acceptance-criteria checkboxes pre-marked `[x]`. **A new agent reading that file alone would conclude Phase 0 is already done.** The `docs/rebuild/README.md` Phase progress table (now updated) and this ledger say otherwise. Authoritative status is this ledger's `Phase progress` table. Do not trust the in-document checkboxes. | `docs/rebuild/08-roadmap/phase-0-foundation.md` |

## Ledger conventions

- **The `docs/rebuild/` specification assigns no capability IDs.** `CAP-NNN` IDs are allocated here
  and are the project's identifiers. Once allocated, an ID is never reused or renumbered — it
  appears in `work/active/` directory names, review filenames, and commit scopes, and renumbering
  would break that trail.
- IDs are allocated at the start of a phase, from this ledger, by the orchestrator.
- A capability with no `Depends on` entry may start as soon as its phase is open.
- Evidence is a test path, a `file:line`, or a command and its output. Never "the implementer said so".
