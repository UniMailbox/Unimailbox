# CAP-042 — Better Auth and Authorized Mailbox Shell

> The shared contract for this capability. Every agent working on it reads this file first.

**Phase:** 1 closure / 2 in-progress · **Status:** In Progress · **Started:** 2026-08-22

## Goal

An existing or invited user can register, log in, recover and end a secure Better Auth cookie
session, and enter the authorized mailbox shell without changing their canonical user identity,
role permissions, or mailbox ownership.

## Current slice

**Slice 0 and the additive migration subtask are complete — runtime config and the request-scoped
auth factory are next.** Main-Codex investigation and architecture decisions are recorded in
`spike-evidence.md`; the spike proofs and repository-owned 0014 migration passed main-Codex
reproduction and Grok review. No production auth route or Better Auth secret/config binding has
been cut over.

## Scope

- Integrate an exactly pinned Better Auth core + Drizzle adapter with Hono and Cloudflare D1.
- Keep `users.id` as the canonical application identity and preserve existing RBAC/business foreign
  keys.
- Add separate Better Auth account/session/verification tables through repository-owned SQL
  migrations and verification SQL.
- Preserve ADR-006 PBKDF2 credentials through a custom Better Auth password hash/verify boundary and
  an idempotent existing-user backfill.
- Mount a non-conflicting Better Auth shadow handler and bridge its cookie session to the existing
  Hono `userId` consumed by authorization.
- Preserve invitation consumption, default-role assignment, setup-administrator creation, and
  idempotency invariants when credential creation moves behind Better Auth.
- Add login, registration, logout, session recovery, unauthorized handling, and authorized mailbox
  navigation to the single React client.
- Prove local `legacy → dual → better-auth → legacy` switching without destructive schema changes.
- Close D-CAP-041-1 and D-CAP-041-9 before copying the setup router/query pattern into the mailbox
  shell.

The ordered slices are defined in `docs/rebuild/execution-plan.md` §CAP-042 and may not be reordered
without an orchestrator decision.

## Out of scope

- OAuth or any external identity provider — Phase 5.
- Deleting legacy `sessions` or `users.password_*` columns — a later cleanup after CAP-045 evidence
  and a recorded retention window.
- KV as the authoritative Better Auth session store. D1 owns session truth in CAP-042.
- Inbox contents, message detail/thread, mark-read, and delete behavior — CAP-043.
- Compose/reply and admin users/webhook/audit UI — CAP-044.
- Production or preview cutover — CAP-045. CAP-042 proves the local runtime and rollback path.
- A second user table or identity-linking subsystem unless ADR-008 is superseded first.
- Silently changing an `R-AUTH-*` rule to match Better Auth defaults. A conflict stops the affected
  slice for an explicit business decision.

Email verification and password bounds are not assumed out of scope: Slice 0 must reconcile the
known CAP-019 behavior with R-AUTH-001 and R-AUTH-007 before the auth implementation contract is
finalized.

## Business rules

| Rule ID | What it means for this slice |
|---|---|
| `R-AUTH-001` | Non-public browser routes require the reconciled verified-email/password session policy; Slice 0 must resolve current behavior drift. |
| `R-AUTH-002` | `banned` and `deleted` users cannot log in or continue an existing session. |
| `R-AUTH-003` | At most ten active Better Auth sessions per user; deterministic oldest-session eviction is tested. |
| `R-AUTH-004` | Session renewal must preserve the rule's token-rotation security outcome; Better Auth defaults do not redefine it. |
| `R-AUTH-005` | Password change/reset revokes every active session for the user. |
| `R-AUTH-006` | OAuth remains deferred; credential-account mapping must not fabricate password eligibility. |
| `R-AUTH-007` | Password limits follow the reconciled business rule, not Better Auth defaults. |
| `R-AUTH-008` | Registration continues to enforce the configured minimum email prefix. |
| `R-AUTH-009` | Email lookup, uniqueness, backfill, and login remain case-insensitive. |
| `R-AUTHZ-001` | Every protected request has one authenticated principal. |
| `R-AUTHZ-002` | Better Auth changes authentication only; existing database-backed permission checks remain authoritative. |
| `R-AUTHZ-003` | Global and mailbox permissions remain independent and both must pass. |
| `R-AUTHZ-004` | Mailbox authorization continues to use the target mailbox, never a client-supplied owner. |
| `R-AUTHZ-005` | Administrator identity remains role-based. |
| `R-SECRET-003` | Auth secrets, cookies, password material, and session tokens are never logged or returned outside their intended boundary. |
| `R-DATA-001` | Email storage and comparison remain case-insensitive. |
| `R-API-002` | Existing domain API error codes remain stable; Better Auth response shapes are confined to its auth boundary. |
| `R-WORKFLOW-004` | Setup repair remains available only to an authenticated administrator after the session migration. |

Source: `docs/rebuild/02-business-discovery/business-rules.md` and ADR-008.

## Acceptance criteria

Objectively checkable. No criterion is complete from a typecheck or mocked Node-only test alone.

### Slice 0 — spike gate

- [x] 1. Better Auth core and the Drizzle adapter are pinned to exact matching versions; the current
      Drizzle peer range and Workers runtime requirements are recorded from primary sources.
- [x] 2. The Hono reference source is pinned to a repository commit, license, and exact inspected
      files before any closely adapted code is used; adopt/adapt/reject decisions match ADR-008.
- [x] 3. A Workers Pool test proves a Better Auth instance can use the real D1 binding and handle a
      raw Hono/Workers `Request`; a Node-only fake does not satisfy this criterion.
- [x] 4. Generated Better Auth SQLite schema is compared with `users` and `sessions`; the proposed
      mapping and every required compatibility column/index are recorded. No CLI applies schema to
      remote or local authoritative databases.
- [x] 5. A failing-first then passing Workers test proves a fixture using the existing ADR-006
      PBKDF2 columns can be verified through the proposed Better Auth password boundary.
- [x] 6. A failure-injection Workers test proves whether user + credential + invite usage + member
      role and setup administrator + credential + setup transition can commit atomically. If not,
      Slice 0 ends with an accepted durable pending/compensation design and no sign-up cutover.
- [x] 7. An R-AUTH-001..009 matrix records Better Auth support, required extension, and tests for
      each rule. Verified-email and password-bound drift have explicit decisions.
- [x] 8. The spike records bundle/runtime behavior, Secrets Store access shape, cookie attributes,
      trusted-origin/CSRF behavior, and D1 transaction limitations from current primary sources or
      executable evidence.
- [x] 9. No application source route, production binding, dependency lockfile, or deployable
      migration is changed merely to claim the spike complete; any deliberate executable harness
      change is isolated, tested, and owned below.

### Additive auth substrate and migration

- [x] 10. Fresh and repeat migrations create verified `auth_accounts`, `auth_sessions`, and
      `auth_verifications` shapes without changing canonical user IDs or dropping legacy data.
- [ ] 11. Wrangler production/test bindings, Env typing, deploy provisioning, doctor parity checks,
      and a new independent `BETTER_AUTH_SECRET` are wired and tested without exposing secret data.
- [ ] 12. `/api/v1/auth/better/*` and Better Auth `basePath` match; sign-in, get-session, and sign-out
      work in Workers Pool tests while legacy issuance remains available in dual mode.
- [ ] 13. The session bridge sets the existing `userId`; existing permission and mailbox IDOR tests
      pass without moving authorization ownership into Better Auth.
- [ ] 14. Conflicting cookie and bearer principals return 401; matching/sole credentials have named
      precedence tests.

### Existing users and registration

- [x] 15. Credential backfill is repeat-safe and verifies source/target counts, duplicates, orphan
      rows, non-password users, and case-insensitive email behavior.
- [x] 16. Existing PBKDF2 users log in without a forced password reset; wrong-password behavior
      remains non-enumerating.
- [x] 17. Invitation registration atomically creates canonical user + credential + member role and
      consumes the invite once; injected failure rolls everything back or proves the accepted
      durable compensation state.
- [x] 18. Setup administrator creation has the equivalent credential and setup-state atomicity
      evidence.
- [x] 19. Tests named for R-AUTH-001..009 cover verified-email policy, banned/deleted denial,
      ten-session eviction, renewal rotation, revoke-all, password eligibility/limits, email-prefix
      limit, and case-insensitive email.

### Browser shell and rollback

- [x] 20. The single React client implements login, registration, logout, session recovery,
      authorized mailbox navigation, and loading/error/unauthorized/expired-session states from
      shared contracts where applicable.
- [x] 21. Browser auth uses HttpOnly cookies and writes no access/refresh/session token to
      `localStorage`, `sessionStorage`, or IndexedDB.
- [x] 22. D-CAP-041-1 and D-CAP-041-9 are closed with cache-backed router loading and at least one
      real router-context test before the mailbox shell reuses that pattern.
- [ ] 23. Local `AUTH_PROVIDER=legacy|dual|better-auth` tests prove controlled cutover, legacy
      session invalidation at the final switch, and rollback on the same additive schema.
- [ ] 24. All six gates pass after fixes: `pnpm scaffold doctor`, `pnpm lint`, `pnpm typecheck`,
      `pnpm test:unit`, `pnpm test:worker`, and `pnpm build`; relevant coverage remains at least 80%.
- [ ] 25. Independent architecture, code, QA, security, and frontend reviews report no unresolved
      BLOCKER or HIGH. Every deferred MEDIUM has a ledger owner and reason.

## Vertical slice

Layers touched, in dependency order; exact files are finalized after Slice 0.

- [x] decision/evidence — ADR-008 plus this contract's Slice 0 findings.
- [ ] dependencies/runtime — workspace manifests, lockfile, Worker Wrangler production/test config,
      Env typing, secret provisioning, doctor parity checks.
- [x] migration — next ordered `migrations/NNNN_*.sql` plus `.verify.sql`; schema version and Drizzle
      typing declarations.
- [ ] integration boundary — request-scoped Better Auth factory and D1 Drizzle adapter.
- [ ] identity — credential migration and application-owned registration/setup orchestration.
- [ ] HTTP — shadow Better Auth handler and session-to-`userId` bridge.
- [ ] contracts — only Unimailbox-owned orchestration/session-shell contracts; Better Auth remains
      the source of its raw auth endpoint shapes.
- [ ] client — auth routes, session recovery, authorized shell, and router/query follow-up fixes.
- [ ] tests — unit, Workers Pool/D1, component/router, migration fresh/repeat, denial/failure, and
      local cutover/rollback evidence.

New module dependency edges introduced: none approved yet. Slice 0 must propose any necessary edge
against `.claude/rules/architecture.md` before implementation.

## Delivery path

`Browser login/register` → `Hono Better Auth boundary` → `D1 auth tables + canonical users` →
`session bridge sets userId` → `existing RBAC/mailbox authorization` → `authorized mailbox shell`.

- Build/runtime configuration touched: yes — Worker bindings, test bindings, deploy provisioning,
  dependencies, and migrations after Slice 0 passes.
- Fresh-deploy evidence required: yes — fresh D1 migration plus local Workers/browser flow.
- Repeat-deploy/idempotency evidence required: yes — repeat migration, credential backfill,
  registration replay, provider-mode rollback.
- Preview evidence required for CAP-042 status: no; CAP-045 owns preview verification. CAP-042 must
  still prove the complete local runtime path.

## Reference implementation

Documentation-only reference during Slice 0. No source may be copied or closely adapted until the
upstream repository commit and license are pinned.

| Field | Value |
|---|---|
| Repository + pinned commit | `honojs/website@6b0692bcdbc4674d01723cb9754b8cf01222f2ef`; linked sample inspected at `bytaesu/cloudflare-auth-worker@7cb28e1e22a76697d96f845e83ccdb4bb6e5cb4b` |
| License | Hono website MIT; linked sample has no detected license and is inspect-only |
| Files inspected | Hono `examples/better-auth-on-cloudflare.md`; linked sample `src/index.ts`, `src/lib/better-auth/{index,options}.ts`, schema/config; Better Auth 1.7.1 published core schema/session and Drizzle adapter; primary docs |
| Adopt | Request-scoped auth factory; pass Hono raw Request to Better Auth handler; mount path equals `basePath` |
| Adapt | Replace Neon/Postgres with D1/SQLite Drizzle; preserve repository SQL migration authority, canonical users, RBAC, ADR-006, invitation/setup atomicity |
| Reject | Neon database assumptions; big-bang cutover; second user identity; legacy-session migration; KV as primary session truth |
| Attribution needed | No code copied; public API usage only. Do not copy the unlicensed linked sample. |

Primary documentation:

- <https://hono.dev/examples/better-auth-on-cloudflare>
- <https://better-auth.com/docs/adapters/drizzle>
- <https://better-auth.com/docs/concepts/database>
- <https://better-auth.com/docs/reference/options>
- <https://better-auth.com/docs/installation>
- <https://developers.cloudflare.com/d1/examples/d1-and-hono/>

## File ownership

One writer per file. Slice 0 is investigation-first; ownership expands only after its decisions are
accepted.

| Agent | Owns |
|---|---|
| Main Codex orchestrator | Slice 0 investigation and evidence; `work/active/CAP-042-better-auth-shell/task.md`; ledger/plan/ADR reconciliation |
| Claude Code / Grok | No Slice 0 investigation ownership; later receive one concrete, bounded, test-verifiable implementation or review task at a time |
| Claude Code task 1 | Completed: exact Better Auth dependency pins plus isolated real-D1/raw-Request compatibility test; no production route/schema/binding changes |
| Grok task 1 | Completed: two schema-fidelity HIGHs found, fixed by Claude, then re-review ACCEPT with zero remaining HIGHs |
| Claude Code task 2 | ADR-006 credential-envelope adapter plus one Workers test proving correct/wrong/malformed verification through Better Auth's callback shape |
| Grok task 2 | Completed: found wrong Better Auth 1.7.1 positional hash callback BLOCKER; Claude fixed it with an exported-type guard; re-review ACCEPT |
| Claude Code task 3 | One isolated Workers Pool failure-injection proof for invite-registration and setup-administrator D1 batches; no production path changes |
| Grok task 3 | Completed: found three atomicity/role/probe HIGHs; main Codex rewrote the bounded test; re-review ACCEPT after 6/6 reproduction |
| Claude Code task 4 | Stalled after writing the initial 0014 SQL draft; main Codex rejected its `OFFSET 9` session-eviction bug and completed the bounded implementation |
| Grok task 4 | Completed read-only review of the final 0014 DDL/trigger/fresh-upgrade/repeat contract; ACCEPT with no findings and independent 13/13 reproduction |

## Reading list

- `CLAUDE.md`
- this file
- `.claude/agents/investigator.md` for Slice 0 investigators
- `.claude/rules/{architecture,security,testing,coding,documentation,reference-implementations}.md`
- `docs/rebuild/09-decisions/{ADR-006-pbkdf2-password-hashing,ADR-008-better-auth-on-cloudflare-d1}.md`
- `docs/rebuild/02-business-discovery/business-rules.md` §R-AUTH, §R-AUTHZ, §R-SECRET
- `docs/rebuild/05-target-architecture/{api-design,data-model,module-boundaries}.md`
- `docs/rebuild/{capability-ledger,execution-plan}.md` §CAP-042
- current identity schema/routes/middleware, setup administrator flow, invite registration, Worker
  bindings, deploy/doctor scripts, and Workers Pool test configuration

## Dependencies

- Requires: CAP-041 (setup web vertical slice) — Implemented.
- Blocks: CAP-043 (inbox and message reading), CAP-044 indirectly, and CAP-045 verification.
- Internal prerequisite before browser work: D-CAP-041-1 and D-CAP-041-9.

## Decisions made during this capability

- 2026-08-22: CAP-042 starts with an orchestrator-owned read-only Spike; no package, route, binding,
  or migration mutation is authorized until the orchestrator records its evidence and decisions.
- 2026-08-22: Claude Code and Grok are the requested task agents. They receive concrete,
  file-bounded implementation or review tasks with named failing tests and commands; broad
  investigation and architecture decisions remain with the main Codex orchestrator.
- 2026-08-22: Main Codex pinned Better Auth/adapter `1.7.1`, generated and compared the SQLite
  schema, proved Drizzle transactions are unsupported by D1, retained canonical `users.id`, and
  selected application-owned `DB.batch()` registration/setup. Full evidence and the R-AUTH matrix
  are in `spike-evidence.md`.
- 2026-08-22: Claude Code task 1 added the exact dependency pins and a 2-test Workers harness.
  Main Codex independently reproduced it; Grok found two generated-schema fidelity gaps (FK
  cascades and verification timestamp nullability), Claude fixed only those lines, and Grok
  re-review accepted both closures.
- 2026-08-22: Claude Code task 2 added the self-describing ADR-006 envelope and Worker tests. Main
  Codex rejected an implicit-iteration deviation; Grok then found the Better Auth 1.7.1 positional
  `hash(password)` callback BLOCKER. Claude applied the bounded fix with a Better Auth exported-type
  guard, main Codex reproduced 27/27 tests, and Grok re-review accepted the closure.
- 2026-08-22: Claude Code task 3's first 4/4 harness proved generic PK rollback but did not prove
  invite exhaustion or role fallback and retained independent-write probes. Grok reported three
  HIGHs. Two bounded Claude fix attempts returned no response and no edits, so main Codex rewrote
  only the owned test with a SQLite abort trigger, selected/null-role cases, and production-shaped
  batches. Main Codex reproduced 6/6; Grok re-review ACCEPT closed all three HIGHs.
- 2026-08-22: Main Codex ran the post-Slice-0 gates after fixes: doctor 13/13, lint and typecheck
  clean, unit 560/560, Worker 595/595, build and format checks clean. This closes the Slice 0 exit
  gate but not CAP-042 AC 24, which must be rerun after the complete capability lands.
- 2026-08-22: Main Codex fixed the 0014 migration contract before delegation. The migration is
  named `0014_better_auth_substrate`; it adds `users.email_verified` (0/1, default 0) and `image`,
  backfills null/blank names from the first 100 characters of the email prefix, and keeps future
  null/blank writes compatible through deterministic AFTER INSERT/UPDATE fallback triggers. It
  creates only `auth_accounts`, `auth_sessions`, and `auth_verifications` with the exact Better
  Auth 1.7.1 SQLite shape recorded in `spike-evidence.md`; legacy password columns, canonical user
  IDs, and legacy `sessions` remain untouched. Named triggers must deterministically retain ten
  auth sessions per user (`created_at DESC, id DESC`), delete all auth sessions when an account
  password changes, and abort `registration_keys.used_count > max_uses`. Acceptance requires a
  real Workers/D1 upgrade test that pauses at 0013, seeds null/blank legacy names, advances to 0014,
  verifies preserved IDs/password/session rows and backfill, then proves a repeat application is a
  no-op. Shape/FK/index and all three trigger behaviors need separate load-bearing assertions.
- 2026-08-22: Claude Code task 4 stalled after its initial migration draft. Main Codex found and
  fixed an `OFFSET 9` eviction error that would have removed the tenth-newest session, then found
  the pre-existing test-kit SQL splitter could not preserve trigger bodies. The completed task adds
  trigger-aware splitting, pending-migration filtering, 0013-to-0014 upgrade and repeat evidence,
  Drizzle typings, and both schema sentinels. Main Codex reproduced 13/13 focused migration tests,
  a fresh temporary D1 verify run with 15/15 assertions, doctor 13/13, unit 568/568, Worker
  603/603, lint, typecheck, build, format, and diff checks. Grok's final read-only review returned
  ACCEPT with no findings and independently reproduced 13/13.
- 2026-08-22: Main Codex investigated the next local-runtime task before delegation. The bounded
  implementation must add an independent `BETTER_AUTH_SECRET` (production Secrets Store; plain
  test var), local `BETTER_AUTH_URL=http://localhost`, and default `AUTH_PROVIDER=legacy` across
  production/test Wrangler topology and `Env` typing. Doctor must compare the complete expected
  name set in both configs, not only production-to-`env.ts`; preflight must read the new secret and
  report eight binding/resource checks. The request-scoped factory will validate the URL/provider
  and call `readSecret()` in a following task. Remote secret generation and environment-specific
  URL substitution stay part of AC11 and may not be claimed by this local-only subtask.

## Open questions

No Slice 0 question remains. Later-slice implementation details stay governed by the accepted
mapping, trigger, callback, and batch contracts in `spike-evidence.md` and ADR-008.
