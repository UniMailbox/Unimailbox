# CAP-039 — Deployment substrate

> The shared contract for this capability. Every agent working on it reads this file first.
> Location: `work/active/CAP-039-deployment-substrate/task.md`. Delete this quote block when filling in.

**Phase:** 1 recovery gate · **Status:** In Progress · **Started:** 2026-08-20

## Goal

A single `pnpm build` produces a Worker that serves the real Vite-built web bundle; the same
build serves `/setup`, every nested client route, and unknown client routes on direct visit or
refresh, without intercepting `/api/v1/*`, email, queue, or scheduled entrypoints; `wrangler.jsonc`
declares the outbound queue consumer; remote deployment applies only pending migrations and a
repeat deploy is a safe no-op.

## Scope

- Declare the built web bundle as an **assets** binding on the Worker; serve `/assets/*` from the
  binding and fall back to `index.html` for any non-API, non-email, non-queue, non-scheduled
  client route (SPA fallback).
- Delete the hand-written `<script src="/assets/index.js">` shell at `apps/worker/src/http/router.ts:52-58`
  — the Vite build emits hashed filenames and the shell referenced a literal that does not exist
  in `apps/web/dist/`. Reuse the assets binding for the root `/` response.
- Declare the queue consumer in `apps/worker/wrangler.jsonc` (and mirror it in
  `apps/worker/wrangler.test.jsonc`) so a deployed Worker actually drains the outbound queue the
  CAP-023 producer enqueues to.
- Rewrite `scripts/deploy.ts:579-609` `runRemoteMigrations` to read the remote `d1_migrations`
  table, compare against the on-disk migrations directory, and apply only the pending ones.
  Demonstrate a clean first deploy and a no-op second deploy.
- Extend `scripts/doctor.ts` with three new checks: (a) `web-assets-binding` — `wrangler.jsonc`
  declares an `assets` block whose `directory` resolves to `apps/web/dist/`; (b)
  `queue-consumer-topology` — `wrangler.jsonc` declares `queues.consumers` for every queue in
  `queues.producers` with a max-retries bound and no orphan producers; (c)
  `migration-strategy-pending-only` — `wrangler.jsonc`'s `d1_databases[].migrations_dir` is unset
  and `wrangler.jsonc`'s `apply_migrations` block is absent (so `wrangler deploy` cannot auto-replay
  migrations) — the pending-only logic in `deploy.ts` is the sole authority.
- Add Worker tests that exercise SPA fallback (`GET /setup`, `GET /inbox/m/abc`,
  `GET /anything-not-mounted`) and the API-before-fallback invariant (`GET /api/v1/setup/status`
  and `GET /api/v1/auth/me` never reach the asset path).
- Add a `scripts/deploy.test.ts` extension that exercises the pending-only migration logic against
  a fake `wrangler d1 execute --command` whose first batch returns an empty `d1_migrations` (clean
  first deploy) and whose second batch returns all migrations (no-op second deploy).

## Out of scope

- Any UI feature page beyond the existing CAP-001 router stub. CAP-041 builds the setup wizard;
  CAP-042 the auth shell; CAP-043 the inbox; CAP-044 the compose/admin surfaces. CAP-039 owns
  *delivery*, not content.
- Cloudflare Access. The pinned Agentic Inbox uses shared Access for tenant admission; Unimailbox
  rejects that — authn, authz, IDOR, and audit are DB-backed and per-request
  (`.claude/rules/reference-implementations.md` §Decision order). Cloudflare Access is not added.
- Per-mailbox Durable Objects, R2 for auth/tenant metadata, treating an email as sent before
  deferred delivery completes, bypassing Unimailbox authz/D1/outbox/idempotency/audit/registry
  — all explicitly rejected by `docs/rebuild/11-agentic-inbox-adaptation.md`.
- A real preview deploy and a real business-loop run. CAP-045 owns the verification gate
  (`docs/rebuild/execution-plan.md` §CAP-045). CAP-039 closes the local-evidence gate.
- Drizzle schema changes. No new tables, no new migrations.
- Vite SSR. The reference uses `createRequestHandler` from React Router; Unimailbox keeps a
  client-only SPA per the adaptation decision table (single Worker + Vite asset wiring is the
  Cloudflare-native shape; the SSR branch is documented but deferred).
- A second web client. There is still exactly one, at `apps/web/`.

## Business rules

| Rule ID | What it means for this slice |
|---|---|
| `R-LOG-001` | No secret, body, or `Idempotency-Key` value appears in any deploy log line. |
| `R-INPUT-001` | Body-size enforcement continues to cap `/api/v1/*` at 1 MB; the new SPA fallback only routes non-API GETs through the asset path. |
| `R-API-002` | The SPA fallback for unknown client routes returns `index.html` (200) — not a 404 from the Worker. A 404 from `env.ASSETS` (file genuinely missing in the bundle) is a real 404 and is logged at `warn` with `event: 'asset.missing'`, `requestId`. |
| `R-SETUP-001..004` | The setup-gate middleware remains the source of truth for the `/setup` redirect. `/setup` is reachable from the SPA fallback because the gate exempts it. No new redirect logic in the asset path. |
| `R-DATA-004` | Foreign keys stay enforced. The pending-only migration logic does not change the schema; it only changes which `wrangler d1 execute --file` calls fire. |

Source: `docs/rebuild/02-business-discovery/business-rules.md`.

## Acceptance criteria

Objectively checkable. No "works correctly". Each maps to a test or a demonstrable behaviour.

- [ ] 1. **Asset binding wired.** `apps/worker/wrangler.jsonc` declares
        `assets: { directory: "../web/dist", binding: "ASSETS" }`. The same block exists in
        `wrangler.test.jsonc` (with `directory: "../web/dist"` — the test worker also reads from
        the real build). `env.ts` exposes `ASSETS: Fetcher`.
- [ ] 2. **Hand-written shell deleted.** The `<script src="/assets/index.js">` literal at
        `apps/worker/src/http/router.ts:52-58` is gone. `GET /` returns `index.html` from the asset
        binding (or 302 to `/setup` while incomplete — gate wins).
- [ ] 3. **SPA fallback works.** Worker-pool test: with installation complete, `GET /setup`,
        `GET /inbox`, `GET /mailboxes/abc`, `GET /some/deep/nested/path` all return the SPA shell
        (200, `Content-Type: text/html`, body matches `apps/web/dist/index.html`) — no 404, no
        catch-all rewrite to `/`.
- [ ] 4. **API never reaches assets.** Worker-pool test: `GET /api/v1/setup/status` returns the
        JSON envelope (not HTML); `GET /api/v1/auth/me` returns 401 `UNAUTHENTICATED` (not HTML).
        Confirms the fallback is mounted *after* the `/api/v1` sub-app, not before.
- [ ] 5. **Email/queue/scheduled unaffected.** Worker-pool test: a `Fetcher`-shaped stub for
        `env.ASSETS` is *not* invoked for `email` events, `queue.batch()`, or `scheduled`
        controller calls (the SPA fallback is a `fetch`-path concern only).
- [ ] 6. **Setup-gate integration.** Worker-pool test: with installation incomplete, `GET /setup`
        returns the SPA shell (not a 302 to itself). With installation complete, `GET /setup` also
        returns the SPA shell (not a redirect away). The gate exemption list is unchanged.
- [ ] 7. **Hashed asset resolution.** `apps/web/dist/index.html` references a hashed script tag
        (e.g. `/assets/index-NZV9_L46.js`); `GET /assets/index-NZV9_L46.js` returns 200 with the
        matching bytes (verified by etag or content-length equality with the on-disk file).
- [ ] 8. **Queue consumer declared.** `apps/worker/wrangler.jsonc` `queues.consumers[]` contains
        `{ queue: "unimailbox-outbound", max_retries: 3 }` (or whatever bound the orchestrator
        approves — see Decisions). The `wrangler.test.jsonc` mirrors the consumer block.
- [ ] 9. **Producer–consumer symmetry.** Every queue in `queues.producers[]` has exactly one
        matching entry in `queues.consumers[]` and vice versa. Doctor check fails if the sets
        drift.
- [ ] 10. **Remote migrations are pending-only.** `scripts/deploy.ts` reads the remote
         `d1_migrations` table via `wrangler d1 execute --command 'SELECT name FROM
         d1_migrations ORDER BY name' --json --remote`, parses it with the same `parseWranglerList`
         helper (or a sibling that handles the `results` key correctly), computes the set
         difference `on-disk - applied`, and applies only that subset. A unit test (Vitest with
         `spawnSync` mocked) demonstrates: (a) empty applied → all migrations applied; (b) full
         applied → zero migrations applied; (c) partial applied → only the gap applied; (d)
         ghost (applied has a name that is not on disk) → exit 1 with the ghost list (mirrors
         `scripts/db-migrate.ts:103-110`).
- [ ] 11. **Repeat deploy is a no-op.** `scripts/deploy.test.ts` asserts the second-deploy log
         line reads `No pending migrations (N already applied).` — the same string the local
         `db-migrate.ts` uses today (`scripts/db-migrate.ts:124`), so the local and remote
         runners speak the same dialect.
- [ ] 12. **Doctor reports the three new checks.** `pnpm scaffold doctor` exits 0 with
         `13/13 checks passed.` and the new lines `✓ web-assets-binding`,
         `✓ queue-consumer-topology`, `✓ migration-strategy-pending-only` appear in the output.
- [ ] 13. **Drizzle / wrangler auto-apply disabled.** Doctor check confirms
         `wrangler.jsonc.d1_databases[].migrations_dir` is unset and no top-level
         `apply_migrations: true` is set; if either is present, the check fails with the exact
         key path so the operator knows what to remove.
- [ ] 14. **Doctor check is self-tested.** The doctor-self-test at
         `apps/worker/scripts/doctor.test.ts` (existing) is extended to cover the three new
         checks: a passing synthetic wrangler.jsonc yields `ok: true`; a wrangler.jsonc with no
         `assets` block yields `ok: false` with `web-assets-binding` in the detail; mismatched
         producer/consumer queues yields `ok: false` on `queue-consumer-topology`; a leftover
         `apply_migrations: true` yields `ok: false` on `migration-strategy-pending-only`.
- [ ] 15. **All existing gates still pass.** `pnpm scaffold doctor` (13/13) · `pnpm lint` (0
         errors) · `pnpm typecheck` · `pnpm test:unit` (≥459 tests, prior baseline) ·
         `pnpm test:worker` (≥540 tests, prior baseline; new tests above) · `pnpm build` ·
         `git diff --check` clean. No new lint warnings in `apps/worker/scripts/` or `scripts/`.

## Vertical slice

Layers this touches, in dependency order:

- [ ] wrangler — `apps/worker/wrangler.jsonc`, `apps/worker/wrangler.test.jsonc`
- [ ] platform/env — `apps/worker/src/platform/env.ts` add `ASSETS: Fetcher`
- [ ] http/router — `apps/worker/src/http/router.ts` SPA fallback before API catch-all
- [ ] build orchestration — `package.json` (root) `build` script + `apps/worker/package.json`
        `build` script ensure the web build runs before the worker build and the dist path is
        stable
- [ ] deploy script — `scripts/deploy.ts` pending-only migrations + extend `parseWranglerList`
        to handle the `SELECT name FROM d1_migrations` shape (or add a sibling
        `parseWranglerResults`)
- [ ] doctor — `scripts/doctor.ts` three new checks
- [ ] tests — `apps/worker/src/http/router.worker.test.ts` (new) SPA-fallback tests;
        `apps/worker/scripts/doctor.test.ts` (existing) extended — see D3;
        `scripts/deploy.test.ts` (existing) extended
- [ ] docs — `docs/operations/deploy.md` updated with the repeat-deploy-no-op expectation;
        `apps/worker/wrangler.jsonc` and `wrangler.test.jsonc` header comments cite CAP-039

New module dependency edges introduced: **none.** All edits live in the entrypoint/orchestration
layer (platform/env, http/router, scripts/*, wrangler.jsonc), which already compose downward into
modules.

## Delivery path

Trace the real invocation, not only the module calls:

`<browser>` → `GET /setup` → `apps/worker` `fetch` handler → Hono router → setup-gate
exemption → SPA fallback → `env.ASSETS.fetch(/setup)` → `index.html` 200
→ `<browser renders React shell>` → `<JS hydrates>` → `createAppRouter()` → `/setup` route
component.

- Build/runtime configuration touched: `apps/worker/wrangler.jsonc`, `apps/worker/wrangler.test.jsonc`,
  `apps/worker/package.json` (build orchestration), root `package.json` (build order).
- Fresh-deploy evidence required: `wrangler deploy --dry-run --outdir=dist` exits 0 against the
  new `wrangler.jsonc`; `pnpm exec wrangler deploy --dry-run` (in `apps/worker`) confirms the
  assets block parses and the queue consumer block parses.
- Repeat-deploy/idempotency evidence required: `scripts/deploy.test.ts` covers cases (a)–(d)
  above; the local `pnpm scaffold db:migrate` and the new remote path produce the same
  `No pending migrations (N already applied).` log line.

## Reference implementation

Use the pinned Agentic Inbox commit; consult
`.claude/rules/reference-implementations.md` and `docs/rebuild/11-agentic-inbox-adaptation.md`.

| Field | Value |
|---|---|
| Repository + pinned commit | `https://github.com/cloudflare/agentic-inbox` @ `48039bb6785af34e592c2966f87cde2b255c4c80` |
| License | Apache-2.0 (attribution required for any code adapted; pattern-only use does not require notice) |
| Files inspected | `wrangler.jsonc`, `workers/app.ts`, `vite.config.ts` (commit `48039bb` does not declare `assets` — the reference uses SSR via `createRequestHandler`, not the Vite asset binding Unimailbox needs); Cloudflare docs for `wrangler 4.x` `assets` block + `not_found_handling: "single-page-application"` |
| Adopt | API-before-client fallback (Hono router composes API sub-app, then SPA catch-all); queue consumer topology (declared on the Worker); single Cloudflare Worker owns `fetch`, `email`, `queue`, `scheduled`. |
| Adapt | Unimailbox uses Vite SPA + `assets` binding + `not_found_handling: "single-page-application"` instead of React Router SSR; Unimailbox Worker tests are real-bindings pool tests, not Node mocks; SPA fallback is mount-after-API, not mount-via-`app.all('*')` (Hono's `app.all('*')` would also catch the `/api/v1/*` sub-app, which is wrong — Unimailbox routes API via `app.route('/api/v1', apiV1)` first, then `app.get('*', spaFallback)` last). |
| Reject | Shared Cloudflare Access (auth is DB-backed); per-mailbox DO (D1 + module ownership); R2 for auth/tenant metadata; treating send as complete before the queue consumer acks; bypassing Unimailbox authz/D1/outbox/idempotency/audit/registry. |
| Attribution needed | **No** — patterns only; no code adapted from Agentic Inbox. |

## File ownership

One writer per file. Reading anything is fine; writing outside your list is not.

| Agent | Owns |
|---|---|
| implementer-1 (worker + deploy) | `apps/worker/wrangler.jsonc`, `apps/worker/wrangler.test.jsonc`, `apps/worker/src/platform/env.ts`, `apps/worker/src/http/router.ts`, `apps/worker/package.json`, root `package.json`, `apps/worker/src/http/router.worker.test.ts` (new), `apps/worker/scripts/doctor.test.ts` (extend — see D3), `scripts/deploy.ts`, `scripts/deploy.test.ts` (extend), `scripts/doctor.ts`, `docs/operations/deploy.md` |

A single implementer is sufficient: the wrangler config, the SPA fallback, the deploy-script
rewrite, and the doctor checks are tightly coupled (the doctor checks *parse* the wrangler
config the implementer writes; the deploy script *consumes* the same shape). Splitting would
force two agents to negotiate the wrangler.jsonc shape mid-slice, which the orchestrator
forbids ("exactly one agent writes a given file at a time").

The implementer does not commit. The orchestrator commits at the capability boundary.

Reviewers run in parallel against the implementer's diff:
- **architecture-reviewer** — adopts? adapts? rejects correctly documented? Worker/Vite
  integration does not import Hono, fetch, or a provider SDK into the wrong layer.
- **code-reviewer** — Hono routing order, env type additions, deploy-script pending-only logic,
  doctor-check parsers, naming.
- **security-reviewer** — `/api/v1/*` is never routed to assets; the fallback never leaks a
  request body; the assets binding cannot serve `/api/v1/*` because Hono's route precedence
  holds (verify with the explicit test in AC #4); no secret material in deploy logs.
- **qa-reviewer** — AC walk-through; asserts the three new doctor checks can each be made to
  fail with a one-character `wrangler.jsonc` mutation, then pass after revert.

## Reading list

Give each subagent exactly this — not the whole `docs/` tree.

- `CLAUDE.md`
- this file
- `.claude/agents/<role>.md`
- `.claude/rules/architecture.md`
- `.claude/rules/coding.md`
- `.claude/rules/security.md`
- `.claude/rules/testing.md`
- `.claude/rules/git.md`
- `.claude/rules/reference-implementations.md`
- `.claude/skills/implement-capability/SKILL.md`
- `.claude/skills/review-capability/SKILL.md`
- `docs/rebuild/execution-plan.md` §CAP-039
- `docs/rebuild/11-agentic-inbox-adaptation.md`
- `docs/rebuild/02-business-discovery/business-rules.md` (only the rules listed in §Business rules)
- `apps/worker/wrangler.jsonc`, `apps/worker/wrangler.test.jsonc`
- `apps/worker/src/http/router.ts`, `apps/worker/src/http/middleware/setup-gate.ts`,
  `apps/worker/src/platform/env.ts`
- `apps/web/vite.config.ts`, `apps/web/dist/index.html` (current build output to understand hashed
  asset naming)
- `scripts/deploy.ts`, `scripts/db-migrate.ts`, `scripts/doctor.ts`
- `apps/worker/scripts/doctor.test.ts`
- `scripts/deploy.test.ts`

## Dependencies

- Requires: **CAP-030 — Lifecycle direction** (status: **Implemented**; closed 2026-08-20). CAP-030
  is the gating capability per `docs/rebuild/execution-plan.md`.
- Blocks: **CAP-040 — Webhook + audit reliability** (needs the new assets/consumer topology so the
  webhook list endpoint and the audit query page are reachable end-to-end);
  **CAP-041 — Setup web vertical slice** (needs `/setup` reachable via SPA fallback);
  **CAP-042 — Auth and mailbox shell** (needs `/login`, `/inbox`, `/mailboxes/:id` reachable via
  SPA fallback); **CAP-043**, **CAP-044**, **CAP-045** (all depend on the deployment substrate).

## Decisions made during this capability

(Append as the slice proceeds. Each is promoted to a rule, an ADR, the implementation log, or
deleted as not load-bearing. Nothing stays only here.)

### D1 — `max_retries` bound for the outbound queue consumer

`apps/worker/wrangler.jsonc` `queues.consumers[]` entry declares `max_retries: 5`. The
Cloudflare-recommended default is 3; the queue consumer's adapter-error taxonomy (CAP-029) now
classifies `4xx` as `TerminalProviderError` and `5xx`/`429` as `RetryableProviderError`, so the
Worker-side error model already short-circuits permanent failures before exhausting retries. 5
gives transient `5xx`/`429` enough room to recover from a brief Brevo outage without needing
operator intervention. Promote or revisit when CAP-045 produces real provider-failure evidence.

### D2 — `not_found_handling: "single-page-application"` vs manual fallback

The wrangler `assets` block uses `not_found_handling: "single-page-application"` rather than a
Worker-side `env.ASSETS.fetch()` try/catch with manual `index.html` rewrite. Reasons: (a) the
Cloudflare edge handles the fallback before the Worker is invoked, so request-log volume and CPU
billing are lower; (b) the manual pattern is exactly what the `not_found_handling` flag is
designed to replace — reimplementing it inside the Worker would be a small, untested copy of a
documented platform behaviour; (c) the asset-block configuration is one JSONC line, the manual
pattern is ~15 lines + a test for the 404 → index.html rewrite + a test for the cache headers.
A custom `not_found_handling` is rejected; if a future capability needs the manual pattern (e.g.
per-tenant asset roots), it adds the `ASSETS` binding explicitly and handles the rewrite itself.

### D3 — `scripts/doctor.test.ts` location

The doctor self-test lives at `apps/worker/scripts/doctor.test.ts` (Node-pool vitest,
`scripts/vitest.config.ts`). The implementer adds a sibling at `scripts/doctor.test.ts` (or
extends `apps/worker/scripts/doctor.test.ts` to also cover the new checks). Resolution: extend
`apps/worker/scripts/doctor.test.ts`. Reason: doctor is a single-process Node script;
`apps/worker/scripts/` is where Node-pool tests already live; duplicating into `scripts/` would
add a second test runner config. Single doctor test file, three new `it()` blocks.

### D4 — Asset `directory` path is relative to wrangler config

`apps/worker/wrangler.jsonc` `assets.directory` is `../web/dist` (relative to
`apps/worker/wrangler.jsonc`). `wrangler 4.x` resolves the path relative to the config file
itself, which is the documented behaviour. The implementer verifies with
`pnpm exec wrangler deploy --dry-run --outdir=apps/worker/dist` from the repo root before
committing. If `wrangler` rejects the path (some 4.x versions require an absolute path), the
implementer uses the absolute path computed at deploy time and pins the decision here.

### D5 — `run_worker_first: ["/api/*"]` enforces API-never-reaches-assets at the platform layer

`apps/worker/wrangler.jsonc` and `apps/worker/wrangler.test.jsonc` declare
`assets.run_worker_first: ["/api/*"]`. Without this flag, the Cloudflare platform's
`not_found_handling: "single-page-application"` rewrites 404 responses on browser
navigations to `index.html`, so `GET /api/v1/some-nonexistent-route` typed into the
address bar would return the SPA shell instead of a 404 — AC #4 ("API never reaches
assets") would not be enforceable at the platform layer. With the flag set, the Worker
always handles `/api/*` requests first and the platform's SPA fallback only fires for
non-API paths. The router's `startsWith('/api/v1')` guard is now strictly
defense-in-depth, redundant with the wrangler config. Source:
<https://developers.cloudflare.com/workers/static-assets/routing/single-page-application>.

### D6 — `queue-consumer-topology` parity is enforced BOTH by count AND by name-set disjointness

`scripts/doctor.ts:evaluateQueueConsumerTopology` checks three things: (a) producer/consumer
queues match by name within a single config, (b) producer/consumer counts match between
prod and test configs, (c) the union of producer queue names and consumer queue names across
both configs is **disjoint** — every queue name appears in exactly one config, never both.
The disjointness assertion catches a rename that propagates partially: someone renames
`unimailbox-outbound` to a different name in `wrangler.jsonc` but forgets to rename it in
`wrangler.test.jsonc`, and the test pool ends up draining messages from a name that no
production consumer owns (or vice versa). Count parity alone would miss this because each
config still declares the same number of queues. Sources: `scripts/doctor.ts:304-326`.

### D7 — `readRemoteApplied` treats wrangler `success: false` on a missing `d1_migrations` as empty applied

`scripts/deploy.ts:readRemoteApplied` previously exited 1 on any `parseWranglerJson`
failure, including the documented fresh-DB case where wrangler returns `success: false`
with `error: no such table: d1_migrations`. This blocked every first deploy on a fresh
account — AC #10(a) ("empty applied → all migrations apply") could not run. The fix
extracts a `parseAppliedMigrationNames(raw: string): string[]` helper that the test
suite drives directly. On a parse failure containing `no such table: d1_migrations`, the
helper returns `[]` (mirroring `scripts/db-migrate.ts:98-101`). On any other parse
failure it throws — the caller decides whether to swallow (the deploy script catches the
fresh-DB path) or surface. Local and remote runners now share the same dialect for this
edge case.

## Open questions

(Blockers needing the orchestrator or the operator. An unanswered question is not an excuse to
guess.)

- **Q1** — Does the operator prefer a `dead_letter_queue` on the outbound consumer (e.g.
  `unimailbox-outbound-dlq`)? The current outbox (`reclaimStaleOutboundJobs`,
  `markOutboundJobTerminal`) records terminal failure in `outbound_jobs.status='failed'` with an
  `attempts >= max_attempts` discriminator. A Cloudflare DLQ would duplicate that record at the
  platform level. **Default if unanswered:** no DLQ; the Worker-side terminal-failure write is
  the durable record. The operator can add a DLQ later by editing `wrangler.jsonc` — Doctor
  check `queue-consumer-topology` allows `dead_letter_queue` as an optional field.
- **Q2** — Does the operator want the assets block to also include `html_handling` (auto-detect
  vs force-trailing-slash vs none)? The current `apps/web/dist/index.html` does not require
  trailing-slash rewrite. **Default if unanswered:** omit `html_handling`; rely on the default.
- **Q3** — The `wrangler deploy` step currently runs without `pnpm build` first. Should
  `pnpm scaffold deploy` invoke `pnpm build` automatically before `wrangler deploy`? The current
  `package.json` `build` script chains worker + web, so adding `pnpm build && wrangler deploy`
  inside `deploy.ts` would couple deploy to the repo's local Node toolchain. **Default if
  unanswered:** no — the operator runs `pnpm build` explicitly before `pnpm scaffold deploy`,
  matching today's implicit order. Document in `docs/operations/deploy.md`.