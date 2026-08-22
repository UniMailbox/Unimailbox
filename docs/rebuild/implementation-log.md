# Implementation Log

**What changed recently, and why.** Append-only; newest entry at the top. This is the second file a
recovering agent reads, after `capability-ledger.md`.

Log an entry when a capability closes, when a decision is made that is not big enough for an ADR but
that future agents depend on, or when a documentation source of truth is corrected.

**Do not log:** routine edits, test output, or anything the git history already answers well.

---

## 2026-08-22 — CAP-041 closure: setup web vertical slice ships

Five-way parallel review (architecture, code, security, qa, frontend) closed the prior cycle's 2 BLOCKERS + 7 HIGHs in one fix slice, then a re-review cycle landed 4 more MEDIUMs / 1 LOW that the orchestrator handled inline. Slice ships; CAP-042 is unblocked.

### Inline orchestrator fixes during the commit-prep pass

- **Code review M1** — added `retryDelays` array assertions to both retry tests in `apps/web/src/infrastructure/api/client.test.ts`. The test captures the delays the retry policy chose into a caller-supplied array (no real-time sleep) and asserts the exact sequence: `[1_000, 2_000]` for retry-then-succeed, `[1_000, 2_000, 4_000, 8_000, 16_000]` for retry-exhausted-capped-at-30s. A regression producing `[NaN, ...]` or `[0, ...]` would fail this. The `ApiRequestInit` interface gained a `readonly retryDelays?: number[]` field (`client.ts:42`).
- **Architecture review M1** — `apps/web/src/app/router.tsx:160-164` previously `return;`'d when `subIndex === -1` (operator hits `/setup/<unknown-segment>` like `/setup/foo`); TanStack Router rendered the parent `SetupLayout` with an empty `<Outlet/>`. Changed to `throw redirect({ to: '/setup/${activeStep}' as const });` so unknown URLs fall back to the server's current step — same path the stale-ahead branch takes. One-line behavioural fix; small absolute impact (stale-bookmark path only).
- **Duplicate `RouterContext` interface** — false-positive finding from the orchestrator's earlier scan (only one declaration at `router.tsx:62` exists in the post-fix tree). Architecture reviewer L4 confirmed only one declaration exists.

### Deferred items recorded for follow-up sweeps

9 items in `work/archive/2026-08/CAP-041/task.md` §Deferred items; 3 of them (`D-CAP-041-1`, `D-CAP-041-2`, `D-CAP-041-9`) are in the capability ledger's "CAP-041 follow-ups" section because they constrain CAP-042 (mailbox shell) — same router-context pattern, same wizard-cache pattern, same test-utility surface.

### Gates (orchestrator-run, post-everything)

doctor 13/13 · lint 0 · typecheck clean · test:unit 556/556 (32 files, +72 vs CAP-039 baseline 484) · test:worker 560/560 (33 files, +9 vs CAP-039 baseline 551) · `pnpm build` clean (362.07 KiB / 67.81 KiB gzipped) · `wrangler --dry-run` clean.

### What the slice actually ships (delivery-path proof)

`Browser navigates to /setup` → `apps/web/src/app/router.tsx` `setupRoute` (`/setup/$subStep`) `beforeLoad` → `fetchSetupStatus(apiClient)` (D-CAP-041-A path: apiClient comes from `createAppRouter(apiClient)`'s context, not a React hook) → `GET /api/v1/setup/status` → Hono `setupRoutes().get('/status')` → `InstallationStateInfo` (zod-validated against `installationStateInfoSchema` from `packages/contracts`) → router renders `<SetupLayout>` with sub-route for the server's `currentStep`. `Operator submits a step form` → React Hook Form `handleSubmit` → `useMutation` → `apiClient.fetch(...)` injects `Idempotency-Key` (POST/PUT/PATCH/DELETE — Security MEDIUM #4 fix), `Authorization: Bearer <sessionToken>` (after `/claim`), `x-request-id` (UUID-shaped — Security MEDIUM #6 fix); body is capped at 1 MB before fetch (Security MEDIUM #5 fix); on 5xx / 429 the client retries with exponential backoff (1s, 2s, 4s, capped 30s, 5 attempts) via `defaultRetryPolicy`. Successful mutation → TanStack Query invalidates `setupQueryKeys.status()` → router re-evaluates `beforeLoad` → new step renders (no client-side step mutation — R-WORKFLOW-002). Refresh on a deep route lands on the same route (router uses `$subStep` typed path). Session token is in-memory only (Zustand store, no `localStorage`/`sessionStorage`/`IndexedDB`) — verified by `setup-session-store.test.ts`.

### Decisions added this cycle

- **D-CAP-041-A** (2026-08-21) — `ApiClient` constructed once at the root via `useMemo` in `apps/web/src/App.tsx`; threaded through React context (for step components, which keep using `useApiClient()`) AND through TanStack Router context (for `beforeLoad`, which reads `({ context })`). Documented in implementation-log 2026-08-21.
- **D-CAP-041-B** (this entry) — `retryDelays` capture array on `ApiRequestInit` is a test-only seam; production code never reads it. Documented so a future reader does not mistake it for production telemetry.

### Resolves

- **Reality-audit BLOCKER #56** — "The setup gate redirects users to a route the Worker does not serve." `apps/worker/src/http/middleware/setup-gate.worker.test.ts` used to expect `/setup` and `/setup/anything` to return 404. With CAP-039's asset binding + run_worker_first=`/api/*` and CAP-041's code-based router, the catch-all returns the SPA shell and the wizard handles `/setup/*` in-client.
- **Reality-audit HIGH #60** — "Phase 1 user workflows are not implemented in the web client." Wizard ships all 9 step components with happy + error paths covered by happy-dom tests.

---

## 2026-08-21 — CAP-041 review cycle: apiClient ownership decision (pre-fix note)

5-way parallel review of CAP-041 surfaced 2 production-breaking BLOCKERS that share a single root cause: the `ApiClient` instance was constructed inside the React tree (in `ApiClientProvider`) and only reachable via a React hook (`useApiClient`). `setupRoute.beforeLoad` (TanStack Router) ran outside any React render and called that hook, throwing "Invalid hook call" on every navigation into `/setup/*`; `createApiClient` was also reallocated on every render, destroying in-flight retry state. Three reviewers (architecture, security, frontend) converged on the same defect independently.

### Decision (orchestrator, ahead of the fix slice)

**D-CAP-041-A**: The `ApiClient` is constructed **once** at the application root via `useMemo(() => createApiClient(init), [])` in `apps/web/src/App.tsx`. The same instance is threaded through two channels:

1. **React context** — `<ApiClientProvider client={apiClient}>` provides it for step components, which continue to read via `useApiClient()`. The provider no longer constructs the client; it only consumes the `client` prop and forwards it on the existing `ApiClientContext`.
2. **TanStack Router context** — `createRouter({ context: { apiClient } })` makes it available to `beforeLoad` callbacks via the `context` argument. The router's `beforeLoad` MUST read `apiClient` from `context`, never via `useApiClient()`.

Rejected alternatives:
- Module-level singleton at the top of `client.ts`. Breaks the test override path (`test-utils.tsx` constructs a per-test client with the spy fetch). Tests for `beforeLoad`-bearing routes need a `mountAppRouter({ apiClient })` helper that constructs a fresh `QueryClient` + `createRouter` per test.
- Move the status fetch out of `beforeLoad` and into the route component's `useQuery`. Breaks AC #4's "stale /setup/<step> URLs redirect to the server's current step" — the redirect must happen before the component renders, otherwise the operator sees a flash of the wrong step.

### Other consequences of the same decision

- `ApiClientProvider` no longer subscribes to `useSetupSession` for re-render purposes — the provider's only job is forwarding the prop. The `void sessionToken;` pattern at the old `client-provider.tsx:36` is deleted.
- `__setApiClientForTesting` dead export (`client-provider.tsx:52-57`) is deleted; tests pass `client` into `<ApiClientProvider client={apiClient}>` directly, matching production.
- `App.tsx`'s `QueryClient` defaults `queries.retry: false` (the API client is the retry authority — ADR-004 / `retry.ts`).

### Process

Fix slice dispatched 2026-08-21 as a single implementer pass (one writer across `apps/web/**` + `packages/contracts/src/index.ts`; ~21 source files + 9 new test files). Single PR because all findings share the router, provider, and `client.ts` — splitting creates merge conflicts and forces re-review of unchanged lines. Implementation-log entry for the actual fix lands after the diff is accepted.

---

## 2026-08-20 — D-CAP-030-A: TS overloads on `canTransition` / `assertCanTransition`

CAP-030 deferred **D-CAP-030-A** (Security L1 + Code L3): the `from as MessageStatus` / `from as OutboundJobStatus` casts inside `Map.get()` are a type-system escape hatch. The runtime behaviour is correct (the `?? false` fallback yields a conservative false when the lookup misses), but a caller passing `domain: 'job'` with `'draft'` (messages-only) was a silent no-op rather than a compile-time error.

### What changed

**Contracts** — `packages/contracts/src/index.ts:305-422`:

- `canTransition` now exposes two public overloads (`domain: 'message' → MessageStatus`, `domain: 'job' → OutboundJobStatus`); the broad-union signature is the internal `canTransitionImpl`. A caller passing `domain: 'job'` with `'draft'` is now a compile-time error.
- `assertCanTransition` mirrors the same overload pattern and calls `canTransitionImpl` directly so the union `domain` from the implementation signature never needs to match the public overloads.
- The original JSDoc (which documented the `domain` discriminator as load-bearing) is restored and now also documents the overload split; the per-function `assertCanTransition` JSDoc preserves the D-CAP-030-G programmer-error pattern note.

**Tests** — `packages/contracts/src/index.test.ts:1486-1501`:

- The three pre-existing tests that exercise the messages-only values `'draft'` and `'delivered'` against the job domain now cast the literals explicitly (`'draft' as OutboundJobStatus`, `'delivered' as OutboundJobStatus`) so they continue to assert the runtime-false behaviour while documenting that the compile-time rejection is the new contract.

### Gates (orchestrator-run)

| Gate | Result |
|---|---|
| `pnpm typecheck` | clean (overload recursion resolved via `canTransitionImpl`) |
| `pnpm test:unit` | 340/340 |
| `pnpm test:worker` | 534/534 |
| `pnpm lint` | 0 errors |
| `pnpm scaffold doctor` | 10/10 |
| `pnpm build` | clean |

### Process

Single-chore commit (`chore(CAP-030): tighten canTransition with TS overloads (D-CAP-030-A)`); no review round required because the change is a localised type-system tightening on a function already at LOW severity. Three remaining CAP-030 follow-ups (D-CAP-030-B direction-guard comment propagation, D-CAP-030-C `OutboundJobStatus` adoption on internal writer signatures, D-CAP-030-D deleted-test provenance) are still open.

---

## 2026-08-20 — CAP-039: Deployment substrate

The Worker now actually deploys. A single `pnpm build` produces an artefact that serves the real Vite-built web bundle, drains the outbound queue CAP-023/CAP-029 enqueue to, and applies remote migrations in pending-only mode — so a repeat deploy is a safe no-op. Closes the four Phase 0/1 BLOCKERs that pointed at this contract (`setup-gate redirects to a route the Worker does not serve`, `built web application not connected to the deployed Worker`, `producer binding but no consumer declaration`, `remote deploy replays every SQL migration`).

### What changed

**Wrangler config** — `apps/worker/wrangler.jsonc` + `apps/worker/wrangler.test.jsonc`:

- New `assets` block: `{ directory: "../web/dist", binding: "ASSETS", not_found_handling: "single-page-application", run_worker_first: ["/api/*"] }`. The `run_worker_first` flag is the load-bearing piece for AC #4 — without it, Cloudflare rewrites 404 responses on browser navigation fetches to `index.html`, which would route `/api/v1/foo` typed in the address bar to the SPA shell. The router's `startsWith('/api/v1')` guard is now strictly belt-and-braces.
- New `queues.consumers[]` entry `{ queue: "unimailbox-outbound", max_retries: 5 }` (D1) so the deployed Worker actually drains the queue CAP-023 produces.
- Removed `d1_databases[0].migrations_dir` and confirmed no top-level `apply_migrations` — `wrangler deploy` will never replay migrations; `scripts/deploy.ts` is the sole authority.

**Router** — `apps/worker/src/http/router.ts:97-119`:

- Deleted the hand-written `<script src="/assets/index.js">` HTML shell at the old lines 52-58 (the literal referenced a path the Vite build never produced).
- Replaced with `router.get('/', (c) => c.env.ASSETS.fetch(...))` and a `router.get('*', ...)` catch-all that forwards GETs to `env.ASSETS`, with explicit guards for non-GET methods (POST/PUT/DELETE → 404, "would leak a write surface") and `/api/v1/*` paths (404 from sub-app's own error handler, never index.html). Routing order: `apiV1`/`webhookV1` sub-apps first, then SPA fallback — the sub-apps win on their paths.

**Env type** — `apps/worker/src/platform/env.ts:19`: added `ASSETS: Fetcher` to the `Env` type.

**Pending-only migrations** — `scripts/deploy.ts`:

- New `parseWranglerJson(r, source)` + `extractColumn(parsed, col)` mirror `scripts/db-migrate.ts:98-101`/`extractColumn` so local and remote runners share the same parse discipline (D7).
- `readRemoteApplied` now treats `wrangler success: false` on a missing `d1_migrations` table as `[]` (empty applied), not as a hard error — mirrors the local runner's behaviour. The misleading "Success=false from a fresh DB is the expected path" comment was deleted; the new comment at `parseWranglerJson` documents the asymmetry that was there before CAP-039.
- `runRemoteMigrations` reads remote `d1_migrations` via `wrangler d1 execute DB --config .wrangler.resolved.jsonc --remote --command 'SELECT name FROM d1_migrations ORDER BY name' --json`, applies the set difference against on-disk migrations. Repeat-deploy log line `No pending migrations (N already applied).` byte-for-byte matches `db-migrate.ts:124`.
- Exported `NO_PENDING_LOG_FORMAT = 'No pending migrations'` (D6) so the deploy test asserts both runners speak the same dialect.

**Doctor** — `scripts/doctor.ts`:

- Three new checks (D3): `web-assets-binding`, `queue-consumer-topology` (count AND name-set disjointness, D6), `migration-strategy-pending-only`.
- New `stripJsoncComments(src)` character-based walker (the previous regex-based stripper matched `/*` and `*/` inside JSON strings, which broke parsing of `["/api/*"]` and `["*/2 * * * *"]` once `run_worker_first` and the cron trigger landed in the same config). Skips comments only outside strings; preserves escape sequences.
- New `evaluateWebAssetsBinding(w, repoRoot)` / `evaluateQueueConsumerTopology(prodCfg, testCfg)` / `evaluateMigrationStrategyPendingOnly(w)` exported as pure functions so `apps/worker/scripts/doctor.test.ts` can drive them with synthetic wrangler.jsonc fixtures.

**Tests** — `apps/worker/src/http/router.worker.test.ts` (NEW, 13 tests), `apps/worker/scripts/doctor.test.ts` (extended by 12), `scripts/deploy.test.ts` (extended by 11), `scripts/scaffold.ts:59` (one-line doc drift 10 → 13):

- Worker-pool SPA fallback cases: `GET /`, `GET /setup`, `GET /inbox`, `GET /mailboxes/abc`, `GET /some/deep/nested/path` → 200 with `<div id="root"></div>` (identity test asserts the same shell is reused). `GET /api/v1/setup/status` → JSON envelope; `GET /api/v1/auth/me` → 401 JSON; `POST /unknown` → 404 (only GETs reach the fallback). `GET /assets/index-*.js` regex shape — the previous literal `NZV9_L46` would have failed on the next Vite rebuild.
- Setup-gate integration: with installation incomplete, `GET /setup` returns the shell, `GET /` 302s to `/setup`.
- Doctor fixtures: every check has both a passing shape and one-character mutations (missing assets, wrong binding, missing `not_found_handling`, orphan producer/consumer, missing `max_retries`, top-level `apply_migrations: true`, `migrations_dir` set, name-set rename drift).
- Deploy fixtures: `computePendingMigrations` (a)–(d) (empty applied → all pending; full applied → zero pending; partial → only gap; ghost → exit 1 with ghost list). `parseAppliedMigrationNames` 4 cases (success, fresh-DB missing-table returns `[]`, unrelated parse failure). The byte-for-byte no-op log line asserted against `db-migrate.ts:124`.

**Docs** — `docs/operations/deploy.md` documents the repeat-deploy no-op behaviour.

**Build order** — root `package.json`: web builds first, then worker, so `apps/web/dist/` exists when `wrangler deploy --dry-run` reads it.

### Decisions

D1–D4 are pre-existing and unchanged from the contract draft. **D5–D7 are new** and were promoted during the fix slice (review-round pressure, not implementer foresight):

- **D5** — `run_worker_first: ["/api/*"]` enforces the API-never-reaches-assets invariant at the Cloudflare platform layer. Without it, navigation fetches to `/api/v1/foo` get rewritten to `index.html` regardless of the Worker-side guard.
- **D6** — `queue-consumer-topology` parity is enforced BOTH by count AND by name-set disjointness. The two configs declare queue names from disjoint sets; rename drift in one config is caught.
- **D7** — `readRemoteApplied` treats wrangler `success: false` on a missing `d1_migrations` table as empty applied, mirroring `scripts/db-migrate.ts:98-101`. Local and remote runners share the same dialect for this edge case.

### Process trail

4-way parallel review (architecture, code, security, qa) surfaced **2 HIGH + 4 MEDIUM + 5 LOW**. Security came back clean (ACCEPT). QA came back ACCEPT — all 15 ACs PASS — but the architecture reviewer's HIGH (missing `run_worker_first`) and the code reviewer's HIGH (`readRemoteApplied` fresh-DB) were independently surfaced and converged on the same deploy-script/config fix. The single fix-slice implementer (one writer — file set is tightly coupled across wrangler + deploy + doctor) closed all HIGH/MEDIUM + the in-scope LOW doc drift in `scripts/scaffold.ts:59` (10 → 13). 5 LOW findings explicitly out of scope: redundant `router.get('/')`, `cons`/`tcons` naming in `doctor.ts`, HEAD probe handling, header forwarding to ASSETS, stale `scripts/dist/doctor.js` — recorded as D-CAP-039-A through E.

### Gates (orchestrator-run after fix slice)

| Gate | Result |
|---|---|
| `pnpm scaffold doctor` | 13/13 |
| `pnpm lint` | 0 errors / 134 warnings (baseline) |
| `pnpm typecheck` | clean |
| `pnpm test:unit` | 484 passed (+5 from baseline 479) |
| `pnpm test:worker` | 551 passed (baseline 551) |
| `pnpm build` | clean; `wrangler deploy --dry-run` prints `env.ASSETS` binding + reads 5 files from `apps/web/dist` |
| `git diff --check` | clean |

CAP-040 (webhook + audit reliability) is now unblocked — `d1_databases[0]` no longer auto-replays migrations, the queue consumer is wired, and the deploy script's failure modes are bounded.

---

## 2026-08-20 — CAP-030: Lifecycle direction — state-machine guards for messages + outbound_jobs

Closed the long-standing gap that the `messages.status` and `outbound_jobs.status` writers carried no SQL-level direction invariant: a buggy or malicious caller could violate the documented lifecycle (e.g. resurrect a `failed` row via a strictly-newer event, or overwrite a `sent` job with `queued`), and the only defence was the rank-aware predicate closed by CAP-029 — which ranks by event time, not by lifecycle semantics. CAP-030 introduces a **direction table** that pins every legal `(from, to)` pair in `packages/contracts` and layers a SQL `AND` predicate on top of the existing rank predicate, so a forbidden transition is rejected at the database boundary regardless of which caller invoked it.

### What changed

**Contracts** — `packages/contracts/src/index.ts`:

- `outboundJobStatusSchema` (closed zod enum, `:193-203`) + `OutboundJobStatus` derived type — mirrors `messageStatusSchema` exactly. The 7-value set matches the `migrations/0007_outbound_jobs.sql` CHECK constraint (`'queued','sending','sent','delayed','bounced','complained','failed'`).
- `ALLOWED_MESSAGE_TRANSITIONS: ReadonlyMap<MessageStatus, ReadonlySet<MessageStatus>>` (`:234-260`) — 9 entries; terminal sets empty for `failed`/`bounced`/`complained`. The retry-reset and forward-on-delayed paths are encoded explicitly.
- `ALLOWED_JOB_TRANSITIONS: ReadonlyMap<OutboundJobStatus, ReadonlySet<OutboundJobStatus>>` (`:284-303`) — 7 entries; terminal sets empty for `failed`/`bounced`/`complained` and `sent` (R-OUTBOUND-009). `sending → queued` is the explicit retry reset (R-OUTBOUND-008).
- `canTransition(domain, from, to): boolean` (`:321-336`) — domain discriminator is load-bearing: `sending → queued` is allowed on jobs, forbidden on messages. The two `as` casts inside `Map.get()` are runtime-safe (`:335` falls back to `false` via `?? false`) but add a deferred D-CAP-030-A to tighten with strict TS overloads.
- `assertCanTransition(domain, from, to): void` (`:349-359`) — throws plain `new Error(\`assertCanTransition(...)…)` per D-CAP-030-G. This is a programmer-error guard, not a user-facing 409 (same pattern as `statusRank` at `:172`). No `DomainError`, no new catalog entry.
- `allowedFromForMessageStatus(status): MessageStatus[]` (`:371-379`) — inverse helper that feeds the SQL `IN (SELECT value FROM json_each(?))` clause. Iteration order matches `ALLOWED_MESSAGE_TRANSITIONS` (Map ordering); empty array for `to='draft'` so the IN predicate is provably closed.

**Message writer** — `apps/worker/src/modules/messages/message-repository.ts`:

- `updateMessageStatus` (`:209-271`) now layers a direction predicate **alongside** the rank predicate. The single D1 statement composes:
  ```sql
  AND status IN (SELECT value FROM json_each(?))            -- CAP-030 direction guard
  AND (provider_event_time IS NULL OR provider_event_time < ? OR (...))  -- CAP-029 rank guard
  ```
- Bind order: `?1` status, `?2` provider_event_time, `?3` sent_at, `?4` now, `?5` id, `?6` allowedFromJson, `?7` providerEventTimeMs (strict-less), `?8` providerEventTimeMs (equal), `?9` newRank.
- `allowedFromJson` is `JSON.stringify(allowedFromForMessageStatus(input.status))` (`:221`). SQLite JSON1 `json_each` reads the array; empty array yields zero rows, which is the documented provably-closed behaviour for `to='draft'`.
- JSDoc at `:174-201` documents the predicate composition (id → direction → rank) and the load-bearing distinction: CAP-029 rejects by rank (event time), CAP-030 rejects by direction (lifecycle). The single D1 statement is still atomic; D1 serialises per-row writes (A6).

**Lease-aware job writers** — `apps/worker/src/modules/outbound-mail/job-repository.ts` (comment-only, no SQL change):

- `claimOutboundJob` (`:194-199`) — `status='queued'` is the FROM-state for the only legal target `sending`. Pinned to `ALLOWED_JOB_TRANSITIONS.get('queued')`.
- `markOutboundJobSent` (`:231-236`) — `status='sending'` for target `sent`. The single-status predicate is a strict subset of the direction table; widening to `IN (...)` would be cosmetic (D-CAP-030-C).
- `markOutboundJobRetryable` (`:278-283`) — `status='sending'` for target `queued` (R-OUTBOUND-008 retry reset). `ALLOWED_JOB_TRANSITIONS` explicitly lists `'queued'` as a legal target of `'sending'` so a future reviewer does not file it as a regression.
- `markOutboundJobTerminal` (`:324-327`) — `status='sending'` for target `failed` (R-OUTBOUND-008/009). `failed` itself is terminal (empty allowed-from set).

**Compose INSERT** — `apps/worker/src/http/routes/compose.ts:177-187`:

- Inline comment explaining the bypass: the `messages` row has no prior state on insert (vacuously true); the `migrations/0006_messages.sql` CHECK on `status` is the safety net. The comment explicitly warns against re-routing the compose write through `updateMessageStatus` — that would break R-OUTBOUND-006's atomic batch (idempotency record + message + mailbox_messages + outbound_job must be one D1 batch, and the direction guard is for UPDATE only).

**Tests** — `packages/contracts/src/index.test.ts:1237-1592` new `describe('ALLOWED_*_TRANSITIONS — CAP-030 direction guard')` block (119 tests):

- Literal pins: `EXPECTED_MESSAGE_TRANSITIONS` and `EXPECTED_JOB_TRANSITIONS` map expected sets; the test asserts each `ALLOWED_*_TRANSITIONS` map matches the literal exactly and the terminal sets are empty.
- Forward coverage: every non-terminal source × every legal target.
- Regression coverage: every non-terminal source × every forbidden (regression) target.
- Terminal-out coverage: every terminal state × every non-terminal target (must reject).
- Retry-reset asymmetry: `sending → queued` allowed on jobs, forbidden on messages (domain discriminator).
- `assertCanTransition` happy + error paths (D-CAP-030-G: plain `Error` with `from → to` message).
- `allowedFromForMessageStatus` round-trip: 6 targets including the empty `draft` case.

**Worker-pool tests** — `apps/worker/src/modules/messages/message-repository.worker.test.ts` (4 new tests, B1–B4):

- B1: `sent → queued` rejected — rank predicate would accept (strictly-newer event time), only direction rejects. Load-bearing for the direction guard.
- B2: `failed → sent` rejected — terminal violation (R-MESSAGE-012), rank predicate would accept.
- B3: `sent → delivered` accepted — forward + higher rank, both predicates pass.
- B4: `delivered → bounced` accepted — retroactive terminal correction (rank tie-breaker); both predicates pass.
- B1/B2 are the load-bearing pair: each scenario is one where **rank alone would accept**, so the only thing that can fail the test is the direction clause. A future regression that drops the direction clause turns B1/B2 into false-positive accepts.

**Worker-pool tests** — `apps/worker/src/modules/outbound-mail/job-repository.worker.test.ts:339-421` (4 new tests, one per lease-aware writer):

- Each test does (a) a contracts-side `canTransition` + `ALLOWED_JOB_TRANSITIONS.has(from, to)` inspection, AND (b) a real-D1 writer invocation against a seeded row. The pair pins the direction table entry against the SQL — a future SQL regression that drifts the predicate fails the (b) half even though (a) still passes.
- `markOutboundJobRetryable` test exercises the retry-reset path (D-CAP-030-B): asserts `attempts` bumps from 1→2 and the lock is cleared.
- `markOutboundJobTerminal` test asserts `attempts` is NOT incremented (the failed-final-attempt count is already in `attempts` from earlier retryable writes) and the lock is cleared.

**Tests deleted** — principled per R-MESSAGE-012:

- `webhooks.worker.test.ts` A2 (`bounced → delivered` on strictly newer event time) — the premise directly contradicts R-MESSAGE-012. Equivalent strict-newer-time coverage retained in B1/B2 (direction rejection) and B3/B4 (direction acceptance with higher rank).
- `message-repository.worker.test.ts` "newer event of any rank always wins" — same premise. Each deletion has a one-line inline comment with the rationale. Recorded as **D-CAP-030-D** so a future reader of git history knows the deletions are principled, not lost.

### Review round

Architecture review (run before the parallel code/QA/security round) — **ACCEPT** with 1 MEDIUM wording correction and 3 LOW follow-ups. The MEDIUM (D-CAP-030-E wording softened from "fixes drift" to "forward-availability — drift is potential, not actual") is recorded in `task.md:236-237` and in the ledger row.

Three independent reviewers ran in parallel (code, QA, security — none of them wrote the code). Aggregated: **0 BLOCKER / 0 HIGH / 0 MEDIUM / 7 LOW**:

- **Code** (4 LOWs): L1 `reclaimStaleOutboundJobs` lacks the direction-guard comment the four lease-aware writers carry (→ D-CAP-030-B). L2 `OutboundJobStatus` adoption two-step on internal writer signatures (`isJobTerminal`/`updateJobStatus` still type against `OutboundJobRow['status']`; → D-CAP-030-C). L3 `canTransition` overload could be stricter compile-time (→ D-CAP-030-A). L4 B3/B4 prose slightly loose on "load-bearing" framing (deletion rationale → D-CAP-030-D).
- **QA** (2 LOWs): L1 `process-outbound-job.ts:230` could cross-reference the direction table (→ D-CAP-030-B). L2 D-CAP-030-E wording cautious vs outcome (already softened in `task.md`).
- **Security** (1 LOW): L1 `canTransition` casts inside `Map.get()` — runtime-safe fallback to `false` via `?? false`; the `'draft is unreachable in the job domain'` test pins the conservative behaviour (→ D-CAP-030-A combined with Code L3).

All LOWs are non-blocking, scoped to follow-up slices, and recorded in the ledger. **No HIGH, no BLOCKER, no MEDIUM** — the capability is accepted as-is.

### Gates

Orchestrator-run, post-slice, post-review: `pnpm scaffold doctor` 10/10 ✓, `pnpm lint` 0 errors (67 pre-existing `no-console` warnings in `scripts/`, none in CAP-030 scope), `pnpm typecheck` ✓, `pnpm test:unit` 459/459 ✓, `pnpm test:worker` 540/540 ✓, `pnpm build` ✓, `git diff --check` clean ✓.

**Grep verification** (post-slice):

- `git grep -n "UPDATE messages" -- 'apps/worker/src/'` → 3 hits (the writer at `message-repository.ts:229`, the doc comment at `:185`, the test SQL constant).
- `git grep -n "ALLOWED_JOB_TRANSITIONS" -- 'apps/worker/src/'` → 4 writer-comment refs + 4 test refs.
- `git grep -n "ALLOWED_MESSAGE_TRANSITIONS" -- 'apps/worker/src/'` → 2 test refs (the `index.test.ts` block + `message-repository.ts:220`).
- `git grep -n "outboundJobStatusSchema" -- 'apps/worker/src/'` → 0 hits outside `packages/contracts/` (the new schema is consumed only by the test block; future adopters will import it).
- `git grep -n "canTransition" -- 'apps/worker/src/'` → 4 test refs (contracts tests + the worker tests).

### Resolves

- **D-CAP-028-C** — `updateJobStatus` retention is now explicitly documented with the CAP-030 direction pairing (the lease-aware writes are the only path the queue consumer takes; the unconditional writer is retained for compose-insert + idempotency-replay).

### Deferred

- **D-CAP-030-A** — `canTransition` runtime type narrowing (Security L1 + Code L3): tighten with TS overloads or a runtime check that rejects messages-only `from` values when `domain === 'job'`. Wait for the second caller-mismatch before extracting (Rule of Three).
- **D-CAP-030-B** — Direction-guard comment propagation to `reclaimStaleOutboundJobs` (Code L1) plus `process-outbound-job.ts:230` cross-reference (QA L1). Cosmetic symmetry gap.
- **D-CAP-030-C** — `OutboundJobStatus` adoption on `isJobTerminal` + `updateJobStatus` (Code L2). Internal-to-module, no current cross-boundary violation.
- **D-CAP-030-D** — Record the deleted A2 / "newer-event-of-any-rank" tests so a future reader of git history knows the deletions are principled per R-MESSAGE-012 (Code L4).

### Workspace cleanup

`work/active/CAP-030-lifecycle-direction/` and `work/reviews/CAP-030-architecture-review.md` moved to `work/archive/2026-08/CAP-030/` (task.md and architecture-review.md both retained). `work/active/` is now empty (`.gitkeep` only). No commit/push per the active constraints — the ledger, implementation log, and archive are the only files changed in this closure pass.

---

## 2026-08-19 — Project-state recovery and delivery-plan correction

Reconciled the ledger and roadmap against the current code, deployment configuration, active
workspace, and Git state. CAP-030 is now correctly recorded as in progress. Phase 0 and Phase 1
delivery status is reopened: `/setup` is unserved, the Vite output is not wired to the Worker, the
Wrangler queue has no consumer, the remote deploy path replays all migrations, and the web client
does not implement the business loop.

Added `execution-plan.md` with CAP-039–CAP-045 as the recovery gate and pinned Cloudflare
`agentic-inbox` commit `48039bb6785af34e592c2966f87cde2b255c4c80` in
`11-agentic-inbox-adaptation.md`. The reference's Worker/UI integration, Email Routing, R2, API
client, query, and mailbox UI patterns are reusable; its shared Cloudflare Access trust boundary,
per-mailbox Durable Object persistence, R2 metadata, and best-effort send lifecycle are explicitly
rejected for Unimailbox.

Project workflow was tightened in `.claude/`: reference provenance is now a rule and capability
template section; implementation and phase-audit procedures now verify delivery topology; state
recovery reads the ledger's Current state table instead of the first Phase heading and reports
ledger/workspace CAP drift. Future-phase roadmap criteria were reset from pre-checked claims to
unchecked requirements.

No CAP-030 business source was changed by this recovery update.

---

## 2026-08-15 — CAP-029: Webhook ordering — rank-aware status updates + IDOR closure

Closed the long-standing gap that webhook-driven status updates could clobber a higher-rank state (a `delivered` arriving after `bounced`), that `provider_message_id` collisions across connections were exploitable as a cross-tenant IDOR (R-AUTHZ-004), and that Brevo response bodies could leak into the queue consumer's logger via `error.message` (R-SECRET-003 / R-LOG-001). CAP-029 introduces a rank-aware writer, a closed error taxonomy, and two migrations that pin the ordering invariant in SQL.

### What changed

**Migrations** — `migrations/`:

- `0011_message_event_time.sql` (new) — adds `messages.provider_event_time INTEGER` (nullable ms epoch) + index `(provider_event_time)` for range queries + inline R-MESSAGE-007 rationale comment ("newer-or-equal on tie breaks in favour of higher status rank"). Verify file: `0011_message_event_time.verify.sql` asserts column + index + nullable shape.
- `0012_webhook_event_time.sql` (new) — adds `webhook_deliveries.event_time INTEGER` (nullable ms epoch) to mirror the inbound timestamp the processor uses for the rank predicate. Verify file: `0012_webhook_event_time.verify.sql` asserts column + nullable shape.

**Domain** — `packages/contracts/src/index.ts`:

- `STATUS_RANK_TABLE: ReadonlyArray<readonly [MessageStatus, number]>` (lines 155-165) — closed rank table for the seven message statuses. Tuple order is `[status, rank]`, pinned by `packages/contracts/src/index.test.ts:1184-1227` which destructures `[s, rank]` accordingly. Order: `failed ≈ bounced ≈ complained` (terminal) > `delivered` > `delayed` > `queued` > `sending` > `sent`.
- `RetryableProviderError` / `TerminalProviderError` classes (lines 210-235) with `kind: 'retryable' | 'terminal'` discriminator and closed-catalog `code: 'RETRYABLE_PROVIDER_ERROR' | 'TERMINAL_PROVIDER_ERROR'`. The cause chain is preserved via `super(message, chainCause(options))` — the inline comment at lines 213-216 documents the `useDefineForClassFields: true` shadowing trap (a redeclared `cause` class field would reset the prototype assignment to `undefined` under ES2022).
- `SEND_FAILED` added to `ERROR_CODES` (CAP-032 catalog) — emitted by the outbound queue consumer on terminal send failure.

**Repository** — `apps/worker/src/modules/messages/message-repository.ts`:

- `updateMessageStatus(db, messageId, newStatus, providerEventTime, expectedPreviousStatus?)` (lines 193-245) — single D1 statement with a rank-aware SQL CASE predicate inside the `WHERE` clause. Equal `provider_event_time` + lower rank → reject; equal + same rank → reject (idempotent); newer event → apply regardless of rank (so a late `delivered` after `failed` is honoured, but a late `sent` after `delivered` is not). Doc-comment at lines 178-182 records "D1 serialises per row" as the rationale for the no-batch shape today — the future batching work is tracked as **D-CAP-029-A**.
- Reached from `process-outbound-job.ts:270-274` via `updateMessageStatus(...)` imported from `modules/messages/index.ts`. The previous direct `UPDATE messages` is gone — `outbound-mail` now consumes the messages module through its index only, never touching the table directly (D-CAP-028-D closure).

**Webhook processor** — `apps/worker/src/modules/outbound-mail/webhook-processor.ts`:

- `mapEventToMessageStatus(event)` (lines 50-67) — closed mapping from Brevo event types to `MessageStatus`. Returns `null` for unknown events; the caller (lines 166-182) branches on `if (status !== null)` so unknown events still record a `webhook_deliveries` row but skip the messages UPDATE.
- `extractBrevoEventTimeMs(raw, fallback)` (lines 230-261) — format-based timestamp discriminator. `SECONDS_MS_THRESHOLD = 1e10` (year 2286 sentinel) discriminates integer ms from integer seconds; `!Number.isInteger(raw)` rejects fractional values; the string path uses `Date.parse` and rejects `NaN-Infinity` and `<= 0`; other types (boolean, bigint, object, undefined, null) route to server fallback with `source: 'server'`. Worker-pool coverage at `webhooks.worker.test.ts:538-652` exercises all six input shapes.

**Webhook repository** — `apps/worker/src/modules/outbound-mail/webhook-repository.ts`:

- `findJobByProviderMessageId(db, connectionId, providerMessageId)` (lines 139-150) — connection-scoped SQL: `WHERE provider_message_id = ? AND provider_connection_id = ?`. Closes R-AUTHZ-004: a collision across connections no longer lets a malicious actor on connection A clobber connection B's message status. Regression test `webhooks.worker.test.ts:458-529` seeds two connections, forces the collision (`expect(collision?.n).toBe(2)`), posts to A only, and asserts message A flips to `delivered` while message B remains `sent`.

**Brevo adapter** — `apps/worker/src/integrations/providers/brevo.ts`:

- 5xx/429 vs 4xx classification (lines 160-197): `status === 429` → `RetryableProviderError` (lines 177-183); other `status >= 400 && status < 500` → `TerminalProviderError` (lines 184-190); 5xx and anything outside 4xx/5xx not yet classified → `RetryableProviderError` (lines 192-196); fetch rejection → `RetryableProviderError` (lines 150-158).
- `errorMessage` is `` `Brevo send failed: status ${status}` `` only (line 171) — **no body interpolation**. Body is attached via `{ cause: body ? new Error(...) : undefined }` at lines 168-170, 179-181, 191-193. Empty body → no cause. Closes R-SECRET-003 / R-LOG-001: bodies can carry PII (recipient addresses) and `xkeysib-…` secret prefixes that must never land in the worker log stream.
- Regression tests at `brevo.test.ts:39-87` (body NOT in `err.message`, IS in `err.cause`), `:89-122` (429 → retryable, body on cause), `:189-215` (empty body → no cause), `:217-245` (fetch rejection → retryable).

### Review round

The original slice went through four independent reviewers (architecture, code, QA, security). Findings were consolidated into the review-triage table and resolved in a fix slice (D6/D7 deferrals recorded for atomicity and chain-walking). After the fix slice, fresh security + code reviewers re-reviewed the H/M fixes.

- **Code re-review** (2026-08-15): ACCEPT WITH FIXES. **1 MEDIUM** — M1: webhook-delivery INSERT and `messages` UPDATE are not in a single D1 batch (`webhook-processor.ts:166-198`). A worker crash between them leaves an applied status change with no `webhook_deliveries` audit row. Fix shape: wrap both calls in `db.batch([...])`; trade-off accepted is that the boolean from `updateMessageStatus` cannot drive the "applied or rejected" log line — instead the delivery row's `event_time` + `event_type` are logged and operators correlate via `messages.status` history. Recorded as **D-CAP-029-A** in the ledger, not blocking CAP-029 (the atomicity invariant is out of scope; CAP-029 owns the ordering invariant). **1 LOW** — L1: `extractBrevoEventTimeMs` is not exported for testing in isolation. Deferred until a second provider surfaces a different timestamp format (Rule of Three).
- **Security re-review** (2026-08-15): ACCEPT WITH FIXES. H1 (R-AUTHZ-004 cross-tenant IDOR closed via connection-scoped SQL at `webhook-repository.ts:146`) + H2 (R-SECRET-003 body on `cause` not on `message`; `useDefineForClassFields` shadowing trap intact) + M1 (429 split from terminal 4xx branch) all verified fixed with file:line evidence. **1 LOW** — L1: `process-outbound-job.ts:340` logs `error.message` only; the body sits on `cause` and is safe today, but a future chain-walking logger helper could re-leak it. Recorded as **D-CAP-029-B** in the ledger.

### Gates

Orchestrator-run, post-fix-slice, post-re-review: typecheck ✓, lint ✓, test:unit 340/340 (+16 since CAP-038), test:worker 534/534 (+71), build ✓, scaffold doctor 10/10.

**Grep verification** (post-slice):

- `git grep -n "UPDATE messages" -- 'apps/worker/src/'` → 3 legitimate hits (`message-repository.ts:185` doc comment, `message-repository.ts:207` writer, `process-outbound-job.worker.test.ts:677` test SQL constant). The previous direct UPDATE at `process-outbound-job.ts` is gone.
- `git grep -n "updateJobStatus" -- 'apps/worker/src/'` → 4 legitimate hits (2 imports/exports, 1 define, 1 call in `queue.worker.test.ts`).
- `git grep -n "code: 'INVALID_REQUEST'" -- 'apps/worker/src/'` → 0 hits (CAP-038 closed the catalog entry).

Resolves D-CAP-028-A (cross-tenant IDOR on `findJobByProviderMessageId`), D-CAP-028-C (rank-aware writer without direct table access from outbound-mail), D-CAP-028-D (`process-outbound-job.ts` direct UPDATE replaced by `updateMessageStatus` call through `modules/messages/index.ts`).

---

## 2026-08-15 — CAP-038: Remove deprecated `INVALID_REQUEST` catalog entry

Closed the CAP-032 migration window. The `INVALID_REQUEST` code was deprecated during
CAP-032 (see D-CAP-032-B) after the three `auth.ts` call sites were reclassified to
`VALIDATION_ERROR`; the `EmittableErrorCode = Exclude<ErrorCode, 'INVALID_REQUEST'>`
type alias + runtime narrowing were belt-and-braces defences that prevented
accidental emission during the window. CAP-038 deletes the entry, the defences, and
the migration-window test assertion in one slice — the catalog union no longer
carries a code that no route emits.

### What changed

**Catalog** — `apps/worker/src/platform/errors.ts`:

- `ERROR_CODES.INVALID_REQUEST` deleted; the preceding "Deprecated — migration
  window only" comment deleted; the catalog-header "3. Deprecated" bullet deleted
  (the post-slice catalog has two buckets, not three: Live + Catalogued-but-unused).
- After the deletion, `ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]`
  is a tighter closed union — R-API-002 enforced more strongly.

**Middleware** — `apps/worker/src/http/middleware/error.ts`:

- `EmittableErrorCode` type alias deleted (`:28-34`); `envelope()` parameter retyped
  to `ErrorCode` directly (`:45`). With the catalog entry gone, `err.code` is
  already `ErrorCode` and no longer contains `'INVALID_REQUEST'` — the alias was
  defending against a state that no longer holds.
- Runtime narrowing `err.code === 'INVALID_REQUEST' ? 'VALIDATION_ERROR' :
  err.code` + the preceding "The envelope helper refuses to emit 'INVALID_REQUEST'…"
  comment block deleted at `:82-90`. `envelope()` now passes `err.code` straight
  through.

**Tests** — `apps/worker/src/platform/errors.test.ts`:

- AC1 "migration-window" test repurposed to "AC1: every catalogued-but-unused code
  and canonical envelope code is present in the catalog" (`:50`). The catalog-shape
  loop at `:11-21` tests SHAPE (every entry well-formed), not SET (which codes
  exist); this named test pins 5 high-value codes (`BODY_TOO_LARGE`, `INTERNAL`,
  `VALIDATION_ERROR`, `RATE_LIMITED`, `LOCK_CONTENTION`) so a future contributor
  removing one breaks a named test rather than slipping past the shape check. AC3
  `@ts-expect-error` demo at `:23-34` untouched (uses `'R-AUTHZ-004'`, not
  `INVALID_REQUEST`).

### Review round

Architecture + code in parallel (no business behaviour change; QA / security /
frontend skipped per `.claude/skills/review-capability` §1). Both reviewers
returned ACCEPT WITH FIXES.

- **Code reviewer**: 1 MEDIUM (M1) — the AC1 test's title still claimed
  "migration-window code is present in the catalog" after the slice, but the
  assertions were now redundant with the catalog-shape test. Recommended either
  delete the redundant test or repurpose it to assert the catalogue-but-unused
  codes the inline comment actually named.
- **Architecture reviewer**: 1 MEDIUM (M1) — same finding, different fix
  proposal. Recommended renaming the title only and keeping the existing
  assertions (`BODY_TOO_LARGE` / `INTERNAL` / `VALIDATION_ERROR`) because they
  add genuine churn protection the catalog-shape loop cannot provide (SHAPE vs
  SET distinction).
- **Orchestrator decision** (per `.claude/rules/agent-collaboration.md` §Conflict
  handling): architecture reviewer's option 1 wins. The catalog-shape loop
  iterates entries and checks each is a string equal to its key, but does not pin
  which codes exist — `entries.length >= 40` still passes if `BODY_TOO_LARGE` is
  removed. A named test asserting `BODY_TOO_LARGE` IS additive. Fix landed inline
  (5-line edit to `errors.test.ts:50-58`) and gates re-verified. **1 LOW**
  (architecture) — pre-existing "two buckets" header comment imprecision, not
  introduced by this slice; recorded for a future cleanup pass.

### Gates

Orchestrator-run, post-fix: typecheck ✓, lint ✓, test:unit 324/324,
test:worker 463/463, build ✓, scaffold doctor 10/10.

**Grep verification** (post-slice): `grep -rn "INVALID_REQUEST" apps/worker/src/
--include='*.ts'` → 0 hits.

Resolves D-CAP-032-B. Closes the CAP-032 migration window completely.

---

## 2026-08-15 — CAP-032: Stable error model — closed catalog + canonical envelope

Closed the long-standing gap that error responses had no stable machine-readable `code`: routes
returned generic shapes (`{ error: '...' }` text strings, hand-rolled 404s, `ContentfulStatusCode`
leaks), the catalog lived in a dead branch (`http/errors.ts`), and the `requestId` was a
per-locale stub. CAP-032 fixes the **shape**, the **catalog**, the **middleware**, and the
**audit-ability** of every `/api/v1/*` response in one slice.

### What changed

**Catalog** — `apps/worker/src/platform/errors.ts`:

- Closed `ERROR_CODES = { ... } as const satisfies Readonly<Record<string, string>>` (R-API-002);
  `ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]` is the closed union. Adding a code
  is a deliberate catalog edit, not a string at a call site.
- `DomainError` carries `code: ErrorCode` + `httpStatus?: HttpStatusCode` (F1 — local literal
  union, framework-neutral; `platform/*` no longer depends on Hono's `ContentfulStatusCode`).
- `HttpErrorBody` is the canonical envelope shape `{ error: { code, message, requestId } }` with
  all three fields required by the type system (R-API-001).

**Middleware** — `apps/worker/src/http/middleware/error.ts`:

- Single `envelope(code, message, httpStatus, requestId)` helper is the **only** place that
  emits the canonical envelope (single source of truth — F3 refactor). `requestId` flows from
  the middleware-set `c.get('requestId')` once, not twice (Arch L3).
- `EmittableErrorCode = Exclude<ErrorCode, 'INVALID_REQUEST'>` + call-site runtime narrowing
  `INVALID_REQUEST → VALIDATION_ERROR` belt-and-braces — the envelope helper cannot be tricked
  into resurrecting a retired code (Code M1).
- Four branches — `ZodError → VALIDATION_ERROR 400`, `DomainError → err.httpStatus`,
  `SyntaxError → VALIDATION_ERROR 400` (defence in depth; D-CAP-031-D), unknown → `INTERNAL 500`
  with `console.error('[error-middleware] unhandled error:', err)` carrying the R-LOG-001
  redaction comment (Code L6).

**Request-id middleware** — `apps/worker/src/http/middleware/request-id.ts`:

- Real implementation: generates a UUIDv4, sets `c.set('requestId', id)`, propagates
  `X-Request-Id` to the response header. AC5 fallback `<unknown>` sentinel is defence in depth
  for the case where middleware did not run (Code L3).
- New test file `request-id.test.ts` covers UUIDv4 regex + AC4 cross-check that the envelope
  `requestId` matches the `X-Request-Id` header.

**Route fixes** (12 sites total):

- `admin-blocklist.ts:51` — hand-rolled 404 replaced with typed `DomainError({ code:
  'BLOCKLIST_ENTRY_NOT_FOUND', httpStatus: 404 })`.
- `auth.ts:127, 336, 542` — three reclassified sites now throw `VALIDATION_ERROR` (D-CAP-031-C
  / Fix 9). The messages carry field context; finer-grained codes deferred per **D-CAP-032-A**
  (QA M2 decision — see ledger).
- `parse-json-body.ts` (`Invalid_json` shape) + every `/api/v1/*` route's `INVALID_JSON` guard
  coexist with `error.ts`'s SyntaxError fallback (D-CAP-031-D).

**Tests** — unit + worker:

- `errors.test.ts` (AC1 catalog enum, AC2 reconciliation, AC3 `@ts-expect-error` demo).
- `error.test.ts` (zod + domain + syntax + unknown envelope shape, AC5 fallback + positive,
  console.error spy tightened to tag assertion).
- `request-id.test.ts` (UUIDv4 regex, AC4 header matches body).
- Per-route envelope-shape assertions on `webhooks.worker.test.ts` (4 sites), audit-events +
  setup-status new error-path tests (F8 / QA M1).
- `admin-blocklist.worker.test.ts` — replay test renamed "replay returns identical envelope
  shape with fresh requestId" with explanatory comment (Code M2).

**Deferred** — captured in ledger §Deferred items:

- **D-CAP-032-A** — generic `VALIDATION_ERROR` reclassification for the three auth.ts sites
  accepted; messages carry field context; the catalog stays small. CAP-034 / next-phase input-
  error granularity is the natural owner if finer-grained codes are needed.
- **D-CAP-032-B** → **CAP-038** tracks the `INVALID_REQUEST` catalog entry removal (Code L5).
- **D-CAP-032-D** — `RATE_LIMITED` / `LOCK_CONTENTION` declared in catalog as `catalogued but
  unused`; no route emits 429/503 today (the live mappings are 400/401/403/404/409/413/502).

**Reviews** — three reviewers (architecture + code + qa) ran in parallel: 0 BLOCKER / 0 HIGH /
6 MEDIUM / 12 LOW total. **Fix slice** (12 items F1–F8) implemented per
`work/archive/2026-08/CAP-032/fix-slice-task.md`. **Triage**: 12 FIX (in slice) / 2
ORCHESTRATOR (D-CAP-032-A, CAP-038) / 1 DROP (Code L4 verified correct).

**Gates** (orchestrator-run, post-fix-slice, verified independently): typecheck ✓, lint ✓,
test:unit 324/324 (+1 from F6 positive AC5 case), test:worker 463/463 (+2 from F8 audit-events +
setup-status tests), build ✓, scaffold doctor 10/10. **Grep verification**: `grep -rn
"hono/utils/http-status" apps/worker/src/` → empty; `grep -rn "code: 'NOT_FOUND'" apps/worker/src/`
→ empty; `grep -rn "code: 'INVALID_REQUEST'" apps/worker/src/` → 1 hit (the deliberate narrowing
comment in `error.ts:85`).

Resolves D-CAP-008-C, D-CAP-032-B (partial — type-level only, `INVALID_REQUEST` catalog entry
itself deferred to CAP-038).

---

## 2026-08-14 — CAP-031: request validation + 1 MB body limit on all `/api/v1/*`

Codified the long-standing gap that `JSON.parse(rawBody)` was duplicated at every route, with no
single point of error shape (`VALIDATION_ERROR` only, never the dedicated `INVALID_JSON` that
CAP-035 introduced), and no single place to enforce the 1 MB body cap from R-API-005. The slice
also resolves **D-CAP-037-A** (CAP-037's own follow-up: "codify the no-record rule"), making
CAP-031 the natural owner of the `INVALID_JSON` → `idempotency_records` gap.

**New helpers** — `apps/worker/src/http/middleware/`:

- `parse-json-body.ts` — file header cites **ADR-004 + D-CAP-037-A** so the no-record rule
  travels with the helper, not with every call site. `parseJsonBody(rawBody, schema, ctx)`
  parses, validates via zod, and on `SyntaxError` emits a structured `logger.warn({ event,
  actorUserId })` (never the body — R-LOG-001 / R-SECRET-003) and throws
  `DomainError({ code: 'INVALID_JSON', httpStatus: 400 })`. `ZodError` is intentionally NOT
  caught here (D-CAP-031-B): structural failures continue to surface as `400 VALIDATION_ERROR`
  via the error middleware, preserving the distinct error code for clients.
- `body-size.ts` — `enforceBodySize` middleware uses `c.req.raw` byte-length check via
  `Content-Length` header BEFORE any body read so oversized payloads never enter the helper
  pipeline. Wired in `router.ts` AFTER `requestId` but BEFORE authn/authz/idempotency so
  rejected requests still carry a `requestId` for the audit log line. Webhook routes are
  exempt — see D-CAP-031-A below.

**Refactors** — 12 route sites updated:

- 9 sites call `parseJsonBody`: `compose.ts` (compose), messages-send, messages-read,
  messages-list, `mailboxes.ts` (mailboxes-create), `admin-blocklist.ts` POST, `admin-role-policies.ts`
  PUT, `admin.ts` invite-codes, `setup.ts` `create`/`invite`/`disable-invite`/`claim` (4 sites in
  setup.ts). Each cites **D-CAP-037-A** in an inline comment explaining why no
  `idempotency_records` row is written on `INVALID_JSON`.
- 3 sites in `auth.ts` keep a local try/catch (D-CAP-031-C): Fix 9 / CAP-027 requires
  extracting the `actorId` field from `rawBodyJson` BEFORE schema parse AND BEFORE replay
  lookup, so the canonical message ID can be used as the provider idempotency key.

**Defense in depth** — `apps/worker/src/http/middleware/error.ts:31-41` retains its
`SyntaxError → 400 VALIDATION_ERROR` branch (D-CAP-031-D). With every route now going through
`parseJsonBody` (or a local try/catch in /api/v1/auth/*), this branch should be unreachable in
normal flow. Kept so a future route that forgets the helper still returns `400` rather than
`500`. R-INPUT-002 keeps the stable code (`VALIDATION_ERROR`) here only as a last-resort shape —
the canonical surface for malformed bodies is `INVALID_JSON`.

**Tests** — `parse-json-body.test.ts` + `body-size.test.ts` (unit, 100% line coverage of the
two helpers), plus 12 AC10 + 2 AC11 cases in `compose.worker.test.ts` covering malformed body
(round-trip with same Idempotency-Key succeeds), `VALIDATION_ERROR` still served on zod
failures, and `BODY_TOO_LARGE` (413) on 1 MB + 1 byte.

**Citation drift caught at orchestrator review** — the first slice used `D-CAP-031-D` in
helper-site comments to mean "no `idempotency_records` row", but `D-CAP-031-D` is actually the
error.ts defense-in-depth decision. The rule the comments describe is `D-CAP-037-A`. Fixed
mechanically across 10 comments in 6 files: `admin-blocklist.ts:89`, `admin-role-policies.ts:128`,
`admin.ts:136`, `mailboxes.ts:95`, `setup.ts` ×4 (the `/claim` site had different comment wording
and was missed by the first `replace_all` pass — caught by post-edit grep, fixed by targeted
edit), `compose.worker.test.ts:806`. `error.ts:32` correctly retains `D-CAP-031-D` (the canonical
home). All gates re-verified post-fix (test:worker 461/461, exit 0).

**Deferred** — **D-CAP-031-A**: webhook routes (`/api/v1/webhooks/:providerKey/:connectionId`)
exempt from `enforceBodySize`. Provider payloads routinely exceed 1 MB (raw RFC 5322 with
attachments, multi-MB JSON event streams from Brevo/Resend). The right enforcement point is
inside `integrations/providers/*`, where per-provider size limits are published and known.
Captured in ledger §Deferred items so the work has an owner.

**Gates** (orchestrator-run, post-citation-drift-fix): typecheck ✓, lint ✓, test:unit 313/313,
test:worker 461/461, build ✓, scaffold doctor 10/10.

---

## 2026-08-14 — CAP-037: port INVALID_JSON guard to admin-blocklist POST

Mechanical mirror of the CAP-035 fix-slice M1 guard. Same pattern, same shape, single route
extension. Captured as a follow-up during CAP-035 closure rather than expanding that slice.

**Fix** — `apps/worker/src/http/routes/admin-blocklist.ts:89-108`:

- Added `import { logger } from '../../platform/logger';` (line 31).
- Wrapped `createBlocklistEntryRequestSchema.parse(JSON.parse(rawBody))` (was line 88) in a
  try/catch that mirrors `admin-role-policies.ts:132-151` verbatim: `SyntaxError` →
  `logger.warn({ event: 'blocklist.post.invalid_json', actorUserId: userId })` (no body per
  R-SECRET-003 / `.claude/rules/security.md` §Logging) → `DomainError({ code: 'INVALID_JSON',
  message: 'Request body is not valid JSON', httpStatus: 400 })`. Non-`SyntaxError` exceptions
  re-throw so the zod `ZodError` path still reaches the error middleware as `400 VALIDATION_ERROR`.

**Test** — `apps/worker/src/http/routes/admin-blocklist.worker.test.ts` (added inside the existing
`describe('POST /api/v1/admin/blocklist', …)` block): one test that POSTs `{not valid json` with a
fresh `Idempotency-Key` and asserts `response.status === 400` + `body.error.code === 'INVALID_JSON'`.
Mirrors `admin-role-policies.worker.test.ts:672-693`.

**Pre-fix behavior** (corrected per review M1): the error middleware (`http/middleware/error.ts:31-41`)
already maps `SyntaxError → 400 VALIDATION_ERROR`, so the pre-fix bug was not "500" but "generic
`VALIDATION_ERROR` code conflated with zod structural failures, no audit log line". The fix upgrades
the response to a stable dedicated code with a structured warn log carrying `actorUserId`. The
followup `VALIDATION_ERROR` path for zod failures is unchanged.

**Rule of Three:** two sites (`admin-role-policies.ts` + `admin-blocklist.ts`) remain a coincidence.
Deliberately not extracted into a helper — the helper is the CAP-031 decision.

**Review round** (single code reviewer — surface is verbatim mirror of an audited pattern):

- **M1** (contract + ledger text overstated pre-fix severity): original text claimed "surfaces as
  500 instead of 400". Verified false by reading `error.ts:31-41`. Corrected both the contract
  (`work/archive/2026-08/CAP-037/task.md`) and the ledger row to state "400 `VALIDATION_ERROR`
  (generic) → 400 `INVALID_JSON` (specific stable code)".
- **M2** (idempotency record not written on `INVALID_JSON`): intentional per ADR-004 — malformed
  body has no usable `requestHash`; storing and replaying would 409 a corrected retry. Same gap
  exists at `admin-role-policies.ts:132-151`. Deferred to **CAP-031** as **D-CAP-037-A**.
- **L1** (test header drops "Security M1" provenance): contract-prescribed, no action.
- **L2** (contract cited `:128-151` for the guard; actual guard is `:132-151`): corrected in
  contract.

**Status:** ACCEPT WITH FIXES. Ship after M1 + L2 (applied). M2 promoted to ledger; L1 follows.

**Gates** (orchestrator-run, post-fix, post-review): `pnpm typecheck` ✓, `pnpm lint` ✓,
`pnpm test:unit` 304/304, `pnpm test:worker` 449/449 (+1), `pnpm build` ✓,
`pnpm scaffold doctor` 10/10.

**Verified status** requires the operator's Phase 1 preview deploy with an
`Idempotency-Key`-keyed retry of the malformed-body case.

---

## 2026-08-14 — CAP-035 fix slice: review round + resolutions + re-review

Following the initial implementation (entry below), three independent reviewers ran in parallel
(architecture, code, security) and produced a consolidated finding list: **2 BLOCKER, 2 HIGH, 3
MEDIUM, 2 LOW**. The orchestrator dispatched a fix slice to the implementer (slice scope frozen
to the named finding list), ran the six quality gates independently to validate, then dispatched
fresh security + code reviewers for re-review.

**Fix slice — resolutions (file:line evidence where reviewer-named):**

- **B1 — Architecture rule dependency table did not permit `inbound-mail → admin`.** Added
  `admin (read-only, via contracts/*)` to the `inbound-mail` row at
  `.claude/rules/architecture.md:48`, plus the explanatory paragraph at `:60-64` recording the
  interface-only constraint (`BlocklistReader` + `RolePolicyReader` in
  `packages/contracts/src/admin/`, implementations in `modules/admin/`, wired in
  `app-context.ts`). Mirrors the outbound provider registry pattern (ADR-002). The
  persistence-ownership row at `:103` extended with `blocklist_entries, role_policies`.
- **B2 — Audit row not in the same D1 batch as the business write (R-AUDIT-001).** Every
  state transition on `blocklist_entries` / `role_policies` now writes `audit_events` +
  business row + `idempotency_records` in one `db.batch([...])`:
  - `admin-blocklist.ts:107` — POST: `prepareCreateBlocklistEntry` +
    `prepareCreateAuditEvent` (`action: 'blocklist.create'`) +
    `prepareCreateIdempotencyRecord`.
  - `admin-blocklist.ts:239` — DELETE (success path): `prepareDeleteBlocklistEntry` +
    `prepareCreateAuditEvent` (`action: 'blocklist.delete'`) +
    `prepareCreateIdempotencyRecord`.
  - `admin-role-policies.ts:169` — PUT: `prepareSetRolePolicy` +
    `prepareCreateAuditEvent` (`action: 'role_policy.set'`) +
    `prepareCreateIdempotencyRecord`.
  - DELETE 404 path (`admin-blocklist.ts:209-231`) writes an idempotency-only record with
    no business write and no audit row — security reviewer confirmed this is the correct
    non-state-transition shape.
- **H1 — Idempotency `operation` literal used a static `:id`-like substring instead of the
  per-request id (ADR-004 cross-resource collision).** Per-id operation namespace now
  embedded with the template literal at handler entry:
  - `admin-blocklist.ts:185` — `const operation = \`DELETE /api/v1/admin/blocklist/${id}\`;`,
    used by both `findIdempotencyRecord` and `prepareCreateIdempotencyRecord`.
  - `admin-role-policies.ts:100` — `const operation = \`PUT /api/v1/admin/roles/${roleId}/policy\`;`.
  - Cross-role idempotency collision test asserts isolation
    (`admin-role-policies.worker.test.ts:522-607`).
- **H2 — Test coverage gap on audit-in-batch + INVALID_JSON + banEmail `*`.** Added per-route
  worker tests named after the rule IDs:
  - `admin-blocklist.worker.test.ts:374-422` — POST audit row appears in `audit_events`.
  - `admin-blocklist.worker.test.ts:727-776` — DELETE audit row appears in `audit_events`.
  - `admin-blocklist.worker.test.ts:780-802` — DELETE 404 writes NO audit row.
  - `admin-role-policies.worker.test.ts:613-670` — PUT audit row appears in `audit_events`.
  - `admin-role-policies.worker.test.ts:676-693` — `INVALID_JSON` round-trip (status + code).
  - `pattern-matchers.test.ts` — deep-subdomain `matchesAvailDomain`, banEmail `*` round-trip.
- **M1 — `JSON.parse(rawBody)` would surface a SyntaxError as 500 instead of 400.** Wrapped
  in try/catch at `admin-role-policies.ts:132-151`: SyntaxError → log at `warn` with
  `{ event: 'role_policy.put.invalid_json', actorUserId: userId }` (no body) → throw
  `DomainError({ code: 'INVALID_JSON', message: 'Request body is not valid JSON',
  httpStatus: 400 })`. **The same antipattern is also present at `admin-blocklist.ts:88`**
  — escalated to MEDIUM and recorded as **CAP-037** rather than expanding the frozen slice.
- **M2 — Drizzle row-type aliases collided with contracts interface names.** Renamed to
  `BlocklistEntryRowDrizzle` / `NewBlocklistEntryRowDrizzle` in
  `apps/worker/src/database/schema/admin.ts:153-154`. `RolePolicyRowDrizzle` /
  `NewRolePolicyRowDrizzle` already had the suffix. Cross-boundary types continue to come
  from `packages/contracts`.
- **M3 — JSON-in-text relaxation comment referenced a placeholder CAP ID.** Migration
  `0010_blocklist_and_role_policies.sql:16` now names **CAP-036 JSON-AUDIT**; placeholder
  resolved.
- **L1 (accepted) — `inbound-mail.ts:88-97` per-recipient `getUserRoleIds` loop.** Future-
  scaling note, not a defect at current throughput; orchestrator-acknowledged.

**Process notes:**

- Architecture / code / security reviewers ran **in parallel** (3 independent reviewers, not
  3 sequential rounds).
- The fix slice was **frozen** to the consolidated finding list — implementer did not
  redesign or "fix" adjacent code outside the named list.
- All six quality gates run by the orchestrator **after** the fix slice, **before** the
  re-review dispatch:
  - `pnpm typecheck` ✓
  - `pnpm lint` ✓
  - `pnpm test:unit` — **304/304** (+1: matchesAvailDomain deep-subdomain)
  - `pnpm test:worker` — **448/448** (+7: audit-in-batch ×3, 404-no-audit, INVALID_JSON,
    cross-role idempotency, banEmail `*` round-trip)
  - `pnpm build` ✓
  - `pnpm scaffold doctor` — 10/10

**Re-review** (fresh security + code reviewers, did not write the fix slice):

- Security: **0 findings.** B1, H1, M1 all confirmed resolved with file:line evidence.
- Code: **0 BLOCKER / 0 HIGH / 0 MEDIUM / 1 LOW** — L1 admin-blocklist.ts:88 bare
  `JSON.parse`. Security reviewer had stated admin-blocklist was unaffected by M1 (incorrect);
  code reviewer correctly caught the inconsistency but under-classified the severity as LOW.

**Resolution of the classification conflict:** Per `.claude/rules/agent-collaboration.md`
§Conflict handling, the orchestrator decides and records the reasoning when two reviewers
disagree. The L1 finding is **the same class of bug** as M1 (bare `JSON.parse` on rawBody
with no try/catch), in **the same module** (admin), with **the same downstream consequence**
(SyntaxError surfaces as 500 instead of 400). Re-classified LOW → MEDIUM based on the
established precedent. Recorded as **CAP-037** rather than expanding the fix slice — the
scope was frozen.

**Deferred:**

- **CAP-037** — Port INVALID_JSON guard from `admin-role-policies.ts:132-151` to
  `admin-blocklist.ts:88`. Mechanical 5-line fix reusing the established pattern. Captured
  by the orchestrator during closure; the next capability picker will see it on the same
  row as CAP-035.

**CAP-035 status:** In Progress → **Implemented**. Contract archived to
`work/archive/2026-08/CAP-035/`.

---

## 2026-08-14 — D-CAP-021-A → CAP-035: Inbound blocklist + per-role policies

Phase 1 closed with two deferred rules unaddressed: `R-INBOUND-005` (blocklist matching on
subject/content/from) and `R-INBOUND-006` (per-role `availDomain` + `banEmail`). The deferred
item's wording ("per-role policies" is part of the same subsystem) was the prompt to lift both
into one capability rather than two.

**Contract** at `work/active/D-CAP-021-blocklist-and-role-policies/task.md`. Highlights:

- New tables `blocklist_entries` and `role_policies`, both admin-owned. The admin module already
  owns `roles`, so the `role_policies` FK is local; the inbound-mail module does **not** own
  the storage — it consumes via `packages/contracts` interfaces, the same shape the rest of
  the architecture uses for cross-module reads.
- Pattern semantics preserved from legacy facts BF-099 / BF-100: substring for blocklist;
  exact / `@domain` / `*` for `banEmail`; `@domain` for `availDomain`; empty `availDomain`
  means allow all. No regex in v1.
- Evaluation order from `workflows.md` step 4–6: blocklist → mailbox resolve → per-role
  policy. Rejection short-circuits before the `R-INBOUND-008` atomic batch, so no new
  atomicity concern.
- Admin CRUD surface for both tables. Idempotency wired (CAP-027). All routes gated by
  `requirePermission` (`settings.manage` / `role.manage`).
- Tests named after the rule IDs (`R-INBOUND-005` per kind; `R-INBOUND-006` per pattern form).

**Decisions locked in the contract** (all four open questions resolved before delegation):

1. The `inbound-mail → admin` dependency edge is **read-only and interface-only**: `inbound-mail`
   consumes `BlocklistEntryReader` / `RolePolicyReader` declared in `packages/contracts`,
   implemented in `modules/admin/*`, wired in `app-context.ts`. Mirrors the outbound provider
   registry pattern (ADR-002). The architecture rule table was updated to add this edge and
   record its semantics; `admin` persistence ownership row extended with `blocklist_entries`
   and `role_policies`.
2. `role_policies` JSON columns ship as **TEXT JSON in v1** with an inline comment naming the
   deferred-normalization follow-up. Captured as **CAP-036 (JSON-AUDIT)** in the ledger; the
   migration's `CAP-NNN` placeholder resolves to CAP-036.
3. Admin routes split into `admin-blocklist.ts` + `admin-role-policies.ts` (the existing
   `admin.ts` was already at 256 lines; the split keeps route files under the 150-line
   guideline).
4. Audit on reject is **OUT OF SCOPE** for v1 — `message.setReject(reason)` short-circuits
   before any DB write and returns immediately. Rationale: rejection is a no-op from the
   system's perspective (no state transition occurred), and the policy engine is local logic
   rather than a state machine. A future audit pass can add a `message.reject` action with no
   schema change beyond a new `audit_events.action` enum value.

**Resolved D-CAP-021-A** — the deferred item is closed by promotion to CAP-035 (In Progress).

## 2026-08-13 — CAP-027 review round: secret redaction, race wiring, ADR-004 amendment

Independent code + architecture review of CAP-027 (commit `ba35bd3`) produced two BLOCKERs, one
HIGH, and several MEDIUM/LOW findings; all confirmed by the orchestrator against the code before
delegation. The fix round (implementer subagent, validated by the orchestrator — its report
channel failed, so the tree was verified directly against the contract):

- **Secret redaction (BLOCKER).** `login`, `refresh`, `setup/claim`, and `admin/invite-codes`
  were persisting plaintext credentials in `idempotency_records.response_json`, surviving
  R-AUTH-005 revocation. These four now store a redacted body that is never served, and replay
  (same key + same hash) **re-executes** the handler, minting fresh credentials. Same key +
  different body still 409s. `register` keeps true replay (response carries no tokens —
  verified).
- **Race wiring (HIGH).** `replayAfterRace`/`isIdempotencyUniqueViolation` are now called by the
  three strict/batch routes; a UNIQUE-race loser replays the winner's response instead of 500ing
  or getting a false 409 `DOMAIN_ADDRESS_TAKEN` (mailboxes distinguishes the idempotency UNIQUE
  from the `(domain_id, local_part)` business UNIQUE).
- **Mailboxes create is now strict batch** (mailbox + audit_event + record in one D1 batch,
  R-OUTBOUND-006); messages read stays best-effort with a rationale comment.
- Setup routes run `setupSession` (401) before `requireIdempotencyKey` (400); smoke-test pending
  path returns typed 409 `IDEMPOTENCY_REQUEST_PENDING`; defensive missing-key errors are typed
  `IDEMPOTENCY_KEY_REQUIRED`; auth routes hash the raw body before replay lookup;
  `idempotencyRecords` Drizzle typing moved to `database/schema/identity.ts` (identity owns the
  table); verify.sql 9-column assertion fixed.
- **Tests.** Per-route-file: missing key 400, malformed key 400, byte-identical replay with
  no-second-business-row, 409 reuse, and a UNIQUE-race loser simulation named after
  R-OUTBOUND-005 / R-API-004. Gates (orchestrator-run): lint ✓, typecheck ✓, unit 278/278,
  worker 402/402, build ✓, doctor 10/10.

**ADR-004 amended** (orchestrator edit): requestHash is sha256 of raw body bytes (not canonical
JSON); secret-bearing endpoints redact-and-re-execute; strict batch only where a crash gap would
duplicate a business effect.

**Process notes.** QA + security review of the fixed state were performed by the orchestrator,
not independent subagents — seven agent report channels failed with API 400s this session. The
orchestrator did not author the fix code, but this is a weaker guarantee than independent review;
the user's manual local check is the compensating control. Subagent infra, not the rules, was the
constraint.

**Accepted LOW findings (recorded, not fixed).** (1) The secret endpoints' delete-then-re-execute
is not atomic: a concurrent same-key different-body request can execute instead of 409ing; same
actor only, no privilege impact. (2) A 409 response is an oracle for "this key was used by this
actor for this operation" — negligible. (3) Mark-read writes no `audit_events` row (pre-existing;
view-state, not a lifecycle transition).

**Deferred:** D-CAP-027-A — route-level idempotency orchestration is copy-pasted ~18× and the
mailboxes route owns raw batch SQL pending a tenancy-module batch API; a follow-up capability
introduces shared middleware/HOC.

## 2026-08-13 — CAP-027: Idempotency records on every mutating endpoint (ADR-004)

Implemented ADR-004 idempotency across all 17 mutating HTTP endpoints. Idempotency-Key header
required on POST/PATCH/DELETE; same key + same body replays stored response; same key + different
body returns 409 IDEMPOTENCY_KEY_REUSED. Migration 0009 creates `idempotency_records` table with
unique index on (actor_id, operation, idempotency_key) and expires_at index for future TTL purge.

**Implementation:**
- Setup endpoints (11): best-effort idempotency with lookup/replay before use case, write after.
  Actor is sha256_hex(session token). Natural guards (singularity, UNIQUE) prevent double-execution
  on retry.
- Auth endpoints (3): same best-effort pattern. Actor is sha256_hex(registration code) for register,
  sha256_hex(email) for login/refresh.
- User-facing endpoints (4): strict batch atomicity. Idempotency record appended to existing D1 batch
  in route handlers (compose, mailboxes, messages). Satisfies R-OUTBOUND-006.

**Files created:**
- `migrations/0009_idempotency_records.sql` + `.verify.sql` + `.md`
- `apps/worker/src/platform/idempotency.ts` + `.test.ts`
- `apps/worker/src/http/middleware/idempotency.ts`
- `work/active/CAP-027-idempotency/task.md` (workspace contract)

**Files modified:**
- `apps/worker/src/database/schema/admin.ts` — idempotencyRecords table
- `apps/worker/src/database/schema-version.ts` — bumped to '0009'
- `apps/worker/src/http/routes/setup.ts` — 11 POST routes with idempotency
- `apps/worker/src/http/routes/auth.ts` — 3 POST routes with idempotency
- `apps/worker/src/http/routes/admin.ts` — POST /invite-codes with idempotency
- `apps/worker/src/http/routes/compose.ts` — strict batch atomicity
- `apps/worker/src/http/routes/mailboxes.ts` — strict batch atomicity
- `apps/worker/src/http/routes/messages.ts` — strict batch atomicity

**Testing:** 44 new idempotency test cases across all route test files (missing key, replay,
409 reuse). R-OUTBOUND-005, R-OUTBOUND-006, R-API-004 citations present. Quality gates pass:
typecheck, lint, test:unit 278, test:worker 385, build, doctor 10/10, drizzle-kit check.

**Deferrals:** None from this capability. Resolves D-CAP-008-B, D-CAP-010-A, D-CAP-011-A.

**Next:** Independent review (architecture, code, QA, security), then client-side TanStack Query
UUID generation for Idempotency-Key (Phase 2).

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

## 2026-08-15 — CAP-028: Durable outbox — lease, attempts, reclaim

Closes the CAP-023→CAP-028 gap: an outbound job now survives a consumer crash mid-send.
`claimOutboundJob` takes the row `queued → sending` atomically with a 60s lease and a
per-invocation `lockedBy` UUID; every lock-holding write predicates on `locked_by = ?` so a
stale worker is a no-op. The scheduled dispatcher (every 2 min) reclaims expired leases
(`attempts >= max_attempts` → `failed RECLAIM_EXHAUSTED`, else → `queued`, never
attempts++), re-enqueues each reclaimed ID, and sweeps `queued` rows older than 5 min whose
enqueue was lost. `processOutboundJob` runs all pre-send steps in one retryable/terminal
catch and isolates the post-success writes (failure → `outbound.job_post_send_write_failed`
+ raw rethrow; lease expiry + reclaim recovers; R-OUTBOUND-004 dedupes the resend).

Process trail: 3-way parallel review (architecture + code + qa) surfaced 1 BLOCKER + 5 HIGH;
fix round 1 closed all; fresh re-reviews surfaced F1 (failed re-enqueue orphans a `queued`
row — HIGH) and F2 (post-success write failures burned attempts on a succeeded send —
MEDIUM), both introduced by round 1; fix round 2 closed both plus F3–F5; scoped verification
re-review confirmed closure with tests that fail on pre-fix code. All adjudications in
`work/archive/2026-08/CAP-028/task.md` §Decisions. Deferrals recorded as D-CAP-028-A..D
(adapter error taxonomy → CAP-029; reclaim N+1; `updateJobStatus` retention; pre-existing
cross-module `messages` write). Gates (orchestrator-run): typecheck ✓, lint ✓, unit 324/324,
worker 505/505, build ✓, doctor 10/10.

2026-08-20 — CAP-040: webhook secret boundary, early-event reconciliation, atomic status/audit, correlation IDs. Closes the four HIGH findings from the 2026-08-19 reality audit (ledger lines 61-64) plus D-CAP-029-A (atomic status/audit batch) and D-CAP-029-B (request-id propagation into audit rows). **Process trail** — implementer self-reported the slice as Implemented with all six gates green (the orchestrator re-ran all six independently and confirmed: `pnpm typecheck` clean after rebuilding contracts, `pnpm lint` clean, `pnpm scaffold doctor` 13/13, `pnpm test:unit` 484/484, `pnpm test:worker` 558/558 (+7 vs pre-CAP-040), `pnpm build` clean with `wrangler deploy --dry-run --outdir=dist` reporting all 9 bindings). 4-way parallel review (architecture + code + security + qa) ran blind against the working-tree diff because `work/active/CAP-040-*/task.md` had been cleaned before review started; reviewers challenged the implementation directly against `docs/rebuild/02-business-discovery/business-rules.md`. Architecture surfaced **2 HIGH + 5 MEDIUM + 4 LOW**; security surfaced **1 HIGH (false positive — already scoped to connectionId; rejected) + 2 MEDIUM + 1 LOW**; code surfaced **0 HIGH + 4 MEDIUM + 6 LOW**; qa **ACCEPT** with **0 HIGH + 0 MEDIUM + 1 LOW**. Orchestrator applied all HIGH/MEDIUM fixes in a single fix slice (HIGH-1 reconciliation gate dropped `jobAdvanced`; HIGH-2 closed-enum typing; MEDIUM-1 Drizzle `provider_message_id` column; MEDIUM-2 MEDIUM-M1 failure-injection test; MEDIUM-M2 reveal-403 test; MEDIUM-3 architecture.md outbound-mail → admin WRITE paragraph; MEDIUM-5 doc-comment softening; LOW-1 deleted unused `findUnmatchedDeliveries` export). The closed-enum typing fix surfaced a separate bug from CAP-035: `admin-role-policies.ts:163` used `action: 'role_policy.set'` which was missing from `auditActionSchema` — added. **What changed** — `migrations/0013_webhook_delivery_message_index.sql` + `.verify.sql` adds `provider_message_id TEXT GENERATED ALWAYS AS (json_extract(raw_payload, '$.messageId')) STORED` to `webhook_deliveries` plus a composite index `(provider_message_id, connection_id)` (trailing column enforces R-AUTHZ-004 connection scope, mirroring the CAP-029 H1 fix on `findJobByProviderMessageId`); `CURRENT_SCHEMA_VERSION` bumped to `'0013'` (`apps/worker/src/database/schema-version.ts`); migration imported into `packages/test-kit/src/migrationsDb.ts`. New cross-module WRITE seam `AuditEventWriter` in `packages/contracts/src/admin/audit.ts` (mirrors the `BlocklistReader`/`RolePolicyReader` pattern from CAP-035; uses a structural `D1StatementLike` interface so the contracts package stays free of Cloudflare runtime types); implementation at `apps/worker/src/modules/admin/audit-event-writer.ts` (`createAuditEventWriter(db)`); wired in `apps/worker/src/app-context.ts` next to the existing readers. Closed `auditActionSchema` extended with `role_policy.set` (CAP-035 gap surfaced by the typing), `webhook_delivery.reconcile`, and `webhook_secret.reveal`. `apps/worker/src/modules/admin/audit-event-repository.ts` — `AuditEventInput.action` is now `AuditAction` (closed), not `string`. R-SECRET-003 closure: `listProviderConnections` no longer returns `webhook_secret`; `GET /api/v1/admin/connections` returns `{ webhookConfigured: boolean, webhookUrl: string | null }` only and asserts `not.toHaveProperty('webhookSecret')` in `admin-webhooks.worker.test.ts`; new `POST /api/v1/admin/connections/:id/webhook-secret/reveal` endpoint gated by `requirePermission('provider.sync')` writes a `webhook_secret.reveal` audit row carrying actorUserId + connectionId + providerKey in metadata (NEVER the secret — R-LOG-001); 403 test confirms non-admin callers are rejected and no audit row lands for denied reveals. D-CAP-029-A atomic-batch closure: `verifyAndProcessEvent` is now a builder that returns prepared statements (`messages UPDATE` + `webhook_deliveries INSERT`); the route handler at `apps/worker/src/http/routes/webhooks.ts` appends the `audit_events` INSERT and runs a single `db.batch([...])`. `updateMessageStatus` was split into `updateMessageStatus` + `prepareUpdateMessageStatus` so the messages UPDATE can be folded into the batch. New contrapositive test at `webhooks.worker.test.ts` uses `vi.spyOn(createAuditEventWriter)` to inject a NULL `action` binding; the resulting 500 + zero-of-three-writes-visible assertion proves the batch is truly atomic (the previous test was named "atomic batch rollback" but only exercised the happy path). Reconciliation: new `reconcile-webhook-deliveries.ts` use case (`prepareReconciliationStatements` + `reconcileWebhookDeliveries`) finds unmatched deliveries via the composite index, back-fills `message_id` to the canonical id, and emits a `webhook_delivery.reconcile` audit row — called from `processOutboundJob` AFTER `markOutboundJobSent` and gated on `sendResult.providerMessageId` (D-CAP-040-ARCH-H1 fix — was previously gated on `jobAdvanced`, which left orphan delivery rows on the lock-stolen-mid-send divergence path). D-CAP-029-B logger guardrail: all new logger calls in `process-outbound-job.ts` and `apps/worker/src/entrypoints/queue.ts` catch use `error instanceof Error ? error.message : String(error)` — no `error.cause` traversal anywhere. Correlation IDs: HTTP audit rows pull `requestId` from `c.get('requestId')` (set by request-id middleware at `apps/worker/src/http/middleware/request-id.ts`); the inbound-email entrypoint, the queue consumer, and the scheduled handler each synthesise `requestId = systemIds.uuid()` per invocation and thread it through to audit rows + the `processOutboundJob` / `reclaimStaleJobs` dep signature (`requestId?: string`). **Final gates** (orchestrator-run, post-fixes): typecheck clean, lint clean, doctor 13/13, unit 484/484, worker **560/560** (+2 vs pre-fix 558: the failure-injection test and the reveal-403 test), build ✓, wrangler dry-run reports all 9 bindings. **Deferred items** (recorded at capability ledger §CAP-040 follow-ups): **D-CAP-040-A** — 30-day TTL purge for `webhook_deliveries` rows (schema + index land now; daily cron sweep deferred); **D-CAP-040-LOW-1..6** — webhook idempotency on provider event id, per-batch correlation UUID, audit metadata size cap, webhook body-size cap, `D1StatementLike` seam broadening, `requestId` required in `ProcessJobDeps`; **D-CAP-040-MED-3** — three identical seam casts at `{ statement: D1StatementLike }` boundary (architectural refactor; defer to a seam-cleanup follow-up).

2026-08-20 — CAP-041 (in progress): setup web vertical slice. Closes reality-audit BLOCKER #56 ("setup gate redirects users to a route the Worker does not serve") and reality-audit HIGH #60 ("Phase 1 user workflows are not implemented in the web client"). Contract written at `work/active/CAP-041-setup-web-vertical-slice/task.md` — 20 acceptance criteria, 8 R-* rules (R-WORKFLOW-001..004, R-AUDIT-002, R-SECRET-003, R-DATA-001, R-API-002). Scope: pure client slice. No backend changes. No new contract types. The wizard consumes `setupClaimRequestSchema`, `setupPreflightResponseSchema`, `setupAdministratorRequestSchema`, `setupDomainRequestSchema`/`domainNameSchema`, `setupBrevoRequestSchema`, `installationStateInfoSchema`/`installationStepSchema` from `@unimailbox/contracts` directly — no second contract model (D1). Implementation layers, in dependency order: design-token CSS → 5 shadcn-style primitives (`Input`, `Card`, `Toast`, `Spinner`, `Alert`) → API client (`infrastructure/api/{client,errors,retry}.ts`) with `Idempotency-Key` injection + Bearer header + exponential backoff (1s/2s/4s/8s/16s capped 30s, 5 attempts) + request-id propagation → Zustand `setup-session-store.ts` for the in-memory session token (D2 — never `localStorage`/`sessionStorage`/`IndexedDB`; verified by a unit test that asserts no `persist` middleware) → TanStack Query hooks (`setupStatusQuery`, `setupPreflightQuery`, `setupMutation` factory) → 9 step components under `features/setup/steps/` (`ClaimStep`, `PreflightStep`, `AdministratorStep`, `DomainStep`, `CloudflareVerifyStep`, `InboundSmokeStep`, `BrevoStep`, `OutboundSmokeStep`, `CompleteStep`) → `/setup/*` sub-router replacing the CAP-001 stub. Browser-context tests via `@testing-library/react` + `happy-dom` with mocked `globalThis.fetch` (D3 — Playwright belongs to CAP-045). The router's `beforeLoad` calls `setupStatusQuery`'s fetcher and redirects stale deep routes to the server's `currentStep` so R-WORKFLOW-001 cannot be bypassed by URL (D4). New client-side dependencies (pre-approved by `.claude/rules/coding.md` §Language and stack): `zod`, `react-hook-form`, `@hookform/resolvers`, `zustand` + dev deps `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`, `happy-dom`. Implementer dispatched 2026-08-20; review (architecture + code + frontend + security + qa) queued behind it. Final commit at capability boundary per D5.
