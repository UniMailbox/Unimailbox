# CAP-041 — Setup Web Vertical Slice

> The shared contract for this capability. Every agent working on it reads this file first.

**Phase:** 1 closure / 2 in-progress · **Status:** In Progress · **Started:** 2026-08-20

## Goal

The `/setup` wizard in the single React client renders every existing setup API step
(12 endpoints, 9 logical stages) as a resumable sequence of routes, with explicit
loading/error/retry/success states, derived entirely from `packages/contracts` —
so a fresh deployment can complete setup end-to-end in a real browser.

## Scope

- One wizard at `/setup`, with sub-routes `/setup/<step>` for each stage.
- Resume-after-refresh: the current step survives a hard reload, and a refresh on
  a deep sub-route lands on the same sub-route.
- API client with Idempotency-Key propagation, error normalization, retry/backoff
  policy, request-id header propagation.
- Server state via TanStack Query. Setup session token held in memory only
  (Zustand store, no `localStorage`) per R-SECRET-003 spirit.
- Forms via React Hook Form + zod (the schema is the contracts zod schema).
- UI primitives: `Input`, `Card`, `Toast`, `Spinner`, `Alert` — minimal, shadcn-style
  on top of the existing `Button` and the design-token CSS already in place.
- 9 step components covering the full Phase 1 flow.
- Browser-context tests (`@cloudflare/vitest-pool-workers`'s `SELF.fetch` flow + a
  happy-dom UI test for each form's happy + error path).
- The `/setup` route is the **only** client route this slice ships; `/` and the
  auth/mailbox shell land with CAP-042.

## Out of scope

- Auth/login/register UI — CAP-042.
- Authorized mailbox shell, inbox, message detail — CAP-043.
- Compose/reply, admin users/webhook/audit surfaces — CAP-044.
- Browser E2E (Playwright) — there is no Playwright project in this repo yet; the
  CAP-041 deliverable is component-level happy-dom tests plus route-fallback Worker
  tests. Browser E2E belongs to CAP-045 (preview deploy verification).
- Any new backend capability or contract gap. If the implementer finds one,
  record it as **D-CAP-041-N** in §Deferred items; do NOT silently extend scope.
- Changing the existing API contracts — the wizard consumes the API as-is.
- A second `apps/web/` client. There is exactly one; the slice works in that one.
- Zustand as an event bus. Server state is TanStack Query's job. Zustand holds
  only the in-memory setup session token.

## Business rules

| Rule ID | What it means for this slice |
|---|---|
| `R-WORKFLOW-001` | Setup steps advance strictly in declared order. The wizard's router reads `/api/v1/setup/status` on every mount and redirects to the current step — a stale URL never allows skipping ahead. |
| `R-WORKFLOW-002` | Setup state changes are atomic on the server (optimistic concurrency on `stateVersion`). The client never locally mutates `currentStep` — it re-fetches status after every successful POST. |
| `R-WORKFLOW-003` | Setup completes only after both inbound and outbound smoke tests succeed. The `complete` step is reached by server logic, not by the client assuming success. |
| `R-WORKFLOW-004` | A setup repair session is granted only to authenticated administrators. Out of scope for CAP-041 (CAP-042+); do not build the repair flow. |
| `R-AUDIT-002` | Every setup mutation writes an `audit_events` row on the server. The wizard surfaces nothing audit-related in the UI — this is a server invariant. |
| `R-SECRET-003` | Secrets are never returned by list APIs and never logged. The wizard must (a) keep the setup session token in memory only, (b) keep the Brevo API key value in form state only (never echo it back into a `success` message), (c) never write either to `localStorage` or `sessionStorage`. |
| `R-DATA-001` | Email and domain names are case-insensitive. The `domainNameSchema` lowercases input before validation; the wizard should display the normalized form, not the user-typed form. |
| `R-API-002` | Domain error codes are stable across releases. The wizard's error UI must surface the machine-readable `code` field to the operator (e.g. as a sub-line under the human message), and the retry button must respect it (no retry on a 4xx other than 409/429). |

Source: `docs/rebuild/02-business-discovery/business-rules.md`.

## Acceptance criteria

Objectively checkable. No "works correctly". Each maps to a test or a demonstrable
behaviour.

- [ ] 1. `pnpm --filter @unimailbox/web build` exits 0; the built bundle is served
       by the Worker (CAP-039 wiring unchanged — confirmed by the asset-binding
       doctor check).
- [ ] 2. Visiting `/setup` while `installation_state.status === 'complete'` redirects
       to `/` (which currently renders the CAP-001 stub; the slice does NOT replace
       the index page — CAP-042 does).
- [ ] 3. Visiting `/setup/<step>` for a step ahead of the server's
       `currentStep` redirects to `/setup/<server-current-step>` (no skipping ahead).
- [ ] 4. After every successful mutation POST, the wizard re-fetches
       `GET /api/v1/setup/status` and renders the new current step. Refresh on
       any deep route lands on the same route (router uses
       `loader: setupStatusQuery`).
- [ ] 5. `POST /api/v1/setup/claim` — input: INSTALLATION_TOKEN; on success, the
       wizard stores the returned `sessionToken` in a Zustand store and advances
       to `/setup/preflight`.
- [ ] 6. `POST /api/v1/setup/preflight` — wizard shows bindings (one row per
       binding, green/red) and `schemaVersion`. Button "Continue" enabled when
       all bindings are present AND schema version equals the worker's
       `CURRENT_SCHEMA_VERSION`.
- [ ] 7. `POST /api/v1/setup/administrator` — wizard collects `email`,
       `password` (min 8, max 72), optional `displayName`. On success, advances
       to `/setup/domain`.
- [ ] 8. `POST /api/v1/setup/domain` — wizard collects `domain` (validated by
       `domainNameSchema`). On success, advances to `/setup/cloudflare-verify`.
- [ ] 9. `/setup/cloudflare-verify` — wizard calls
       `POST /api/v1/setup/cloudflare/dashboard-link`, opens the returned URL in
       a new tab, then accepts the operator's confirmation and POSTs
       `/cloudflare/verify`. On success, advances to `/setup/inbound-smoke`.
- [ ] 10. `/setup/inbound-smoke` — wizard POSTs `/inbound-smoke-test` to start,
        then polls `/inbound-smoke-test/check` every 5 s (R-WORKFLOW-003) until
        status = `received`. On success, advances to `/setup/brevo`.
- [ ] 11. `/setup/brevo` — wizard collects `apiKey` (Brevo API key). The value is
        held in form state only; the success view does not echo it back. Advances
        to `/setup/outbound-smoke`.
- [ ] 12. `/setup/outbound-smoke` — wizard POSTs `/outbound-smoke-test`. On
        success (which advances `currentStep` to `complete` on the server),
        the wizard moves to `/setup/complete`.
- [ ] 13. `/setup/complete` — final POST to `/complete` flips
        `installation_state.status` to `complete`. Wizard shows a success card
        with a "Go to app" link to `/` (CAP-042 will replace the index stub).
- [ ] 14. Every mutation POST sends `Idempotency-Key: <uuid>` (ADR-004) and
        `Authorization: Bearer <sessionToken>` (after `/claim`). The API client
        is the only place that adds these headers.
- [ ] 15. Every error path renders: human message + machine `code` sub-line +
        Retry button (no auto-retry). 5xx and 429 → exponential backoff (1s,
        2s, 4s, capped 30s, 5 attempts) via the API client; 4xx (except 409/429)
        → no retry.
- [ ] 16. The setup session token is NEVER written to `localStorage`,
        `sessionStorage`, or `IndexedDB`. A `grep -r "localStorage\|sessionStorage\|indexedDB"`
        over `apps/web/src/` finds no hits in setup feature code. (Verified by a
        unit test that imports the store and asserts no persistence.)
- [ ] 17. Every setup form's payload is parsed by the contracts zod schema
        (`setupClaimRequestSchema`, `setupAdministratorRequestSchema`, etc.) —
        the UI does not invent a second contract model. Form errors surface the
        zod path + message.
- [ ] 18. Server state lives in TanStack Query. The setup session token is the
        only piece of state in the Zustand store. The session-token store is
        not used as an event bus.
- [ ] 19. The deliverable includes a per-step `*.test.tsx` happy-dom test that
        mocks `SELF.fetch`, mounts the step component with React Testing Library,
        fills the form, submits, asserts the next-step navigation. Plus the
        existing worker-pool tests continue to pass (no API contract change).
- [ ] 20. All six quality gates pass: `pnpm scaffold doctor`, `pnpm lint`,
        `pnpm typecheck`, `pnpm test:unit`, `pnpm test:worker`, `pnpm build`.

## Vertical slice

Layers this touches, in dependency order:

- [ ] contracts — none new; consume existing `setupClaimRequestSchema`,
      `setupPreflightResponseSchema`, `setupAdministratorRequestSchema`,
      `setupDomainRequestSchema` / `domainNameSchema`, `setupBrevoRequestSchema`,
      `installationStateInfoSchema` / `installationStepSchema` from
      `packages/contracts/src/index.ts`.
- [ ] route — none; CAP-039 SPA fallback unchanged.
- [ ] client primitives — `apps/web/src/components/ui/{Input,Card,Toast,Spinner,Alert}.tsx`.
- [ ] client infrastructure — `apps/web/src/infrastructure/api/{client.ts,errors.ts,retry.ts}`.
- [ ] client state — `apps/web/src/features/setup/setup-session-store.ts` (Zustand).
- [ ] client query hooks — `apps/web/src/features/setup/setup-queries.ts`
      (TanStack Query: `setupStatusQuery`, `setupPreflightQuery`,
      `setupMutation` factory that injects `Idempotency-Key` + `Authorization`).
- [ ] client router — `apps/web/src/app/router.tsx` extended with the
      `/setup/*` subtree (CAP-001 stub `setupRoute` is replaced).
- [ ] client step components — `apps/web/src/features/setup/steps/<StepName>.tsx`,
      one per logical stage:
      - `ClaimStep` (claim)
      - `PreflightStep` (preflight)
      - `AdministratorStep` (administrator)
      - `DomainStep` (domain)
      - `CloudflareVerifyStep` (cloudflare-verify)
      - `InboundSmokeStep` (inbound-smoke)
      - `BrevoStep` (brevo)
      - `OutboundSmokeStep` (outbound-smoke)
      - `CompleteStep` (complete)
- [ ] client tests — `apps/web/src/features/setup/steps/<StepName>.test.tsx`,
      `apps/web/src/infrastructure/api/{client,errors,retry}.test.ts`,
      `apps/web/src/features/setup/setup-session-store.test.ts`.

New module dependency edges introduced: none on the backend (pure client slice).
Client-side dependencies added to `apps/web/package.json`: `zod`,
`react-hook-form`, `@hookform/resolvers`, `zustand`, plus dev deps
`@testing-library/react`, `@testing-library/user-event`, `happy-dom`.
All are pre-approved by `.claude/rules/coding.md` §Language and stack.

## Delivery path

`Browser navigates to /setup` → `apps/web/src/app/router.tsx` → `setupRoute`
loader fires `setupStatusQuery` → `GET /api/v1/setup/status` → Hono `setupRoutes().get('/status')`
returns `InstallationStateInfo` → router renders `<SetupLayout>` with the
sub-route for the current step.

`Operator submits a step form` → React Hook Form `handleSubmit` → `setupMutation.mutateAsync`
→ `apiClient.fetch(...)` injects `Idempotency-Key` + `Authorization` →
`Hono POST /api/v1/setup/<step>` → use case advances `installation_state.current_step`
→ `setupStatusQuery.invalidate()` → router re-renders the new sub-route.

- Build/runtime configuration touched: `apps/web/package.json` (add deps).
- Fresh-deploy evidence required: `pnpm --filter @unimailbox/web build` exits
  0; built bundle is served by the Worker (doctor self-test confirms asset
  binding). Browser smoke at preview lives with CAP-045.
- Repeat-deploy/idempotency evidence required: no (no deploy-side change).

## Reference implementation

None. The slice consumes the existing API; no external code is adopted.
The pattern reference is the Agentic Inbox setup wizard at
`agentic-inbox@48039bb6785af34e592c2966f87cde2b255c4c80` (Apache-2.0) — see
`docs/rebuild/11-agentic-inbox-adaptation.md` for what we adopted (resumable
wizard via server-side `currentStep` redirect) and rejected (their Vite + Hono
monorepo organization does not match ours).

| Field | Value |
|---|---|
| Repository + pinned commit | `agentic-inbox@48039bb6785af34e592c2966f87cde2b255c4c80` (pattern only) |
| License | Apache-2.0 (pattern only, no copied code) |
| Files inspected | `apps/web/` setup wizard routes |
| Adopt | "Wizard resumes from server-side `currentStep`, not from URL alone" |
| Adapt | "TanStack Router code-based routes (not file-based); zod schemas from `packages/contracts`" |
| Reject | "Vite file-based routing; localStorage for setup session token" |
| Attribution needed | no (pattern only, no code copied) |

## File ownership

One writer per file. Reading anything is fine; writing outside your list is not.

| Agent | Owns |
|---|---|
| implementer (CAP-041) | All paths under `apps/web/` listed in §Vertical slice. Also `apps/web/package.json`, `apps/web/vite.config.ts` if config needs change. |

## Reading list

Give the implementer exactly this — not the whole `docs/` tree.

- `CLAUDE.md`
- this file
- `.claude/agents/implementer.md`
- `.claude/rules/architecture.md`
- `.claude/rules/coding.md`
- `.claude/rules/testing.md`
- `.claude/rules/security.md`
- `.claude/rules/reference-implementations.md`
- `packages/contracts/src/index.ts` (lines 510-650 for setup schemas)
- `apps/worker/src/http/routes/setup.ts` (the API surface the wizard consumes)
- `docs/rebuild/02-business-discovery/business-rules.md`
- `docs/rebuild/03-domain-design/state-machines.md` (installation state machine, lines 60-75)
- `docs/rebuild/08-roadmap/phase-1-minimal-loop.md` (Phase 1 / CAP-041 context)
- `docs/rebuild/11-agentic-inbox-adaptation.md` (pinned reference decisions)
- `apps/web/src/styles/tokens.css` (existing design tokens)

## Dependencies

- Requires: CAP-039 (deployment substrate) — Implemented (closed 2026-08-20)
- Requires: CAP-016 (setup wizard backend, all 9 steps) — Implemented
- Blocks: CAP-042 (auth/session and mailbox shell)
- Closes: Reality-audit BLOCKER #56 ("setup gate redirects users to a route the
  Worker does not serve") and reality-audit HIGH #60 ("Phase 1 user workflows
  are not implemented in the web client").

## Decisions made during this capability

**D1 — Derive all payloads from `packages/contracts`; no second contract model.**
Per `.claude/rules/coding.md` §Language and stack, the UI does not invent a
second contract. Every form's payload is parsed by the contracts zod schema.
The contracts package is the single source of truth for setup request shapes;
the wizard consumes it via `@unimailbox/contracts`.

**D2 — Session token in Zustand store, in-memory only.**
Per R-SECRET-003 spirit (setup session token is sensitive — equivalent to the
INSTALLATION_TOKEN, which is the deploy-time secret). Never `localStorage`,
never `sessionStorage`. Lost on full page reload — the operator restarts the
wizard at `/setup/claim` if they refresh hard. The wizard re-derives
"resumability" from the server's `currentStep` (which is not sensitive), not
from the session token.

**D3 — Browser-context tests, not Playwright.**
The repo has no Playwright project yet; introducing it as part of CAP-041 would
bloat scope. Component-level happy-dom tests using React Testing Library +
`SELF.fetch` mocking cover each step's happy + error path. Browser E2E belongs
to CAP-045, which adds Playwright as its own concern.

**D4 — `currentStep` redirect on stale deep routes.**
R-WORKFLOW-001 says steps advance in declared order. The router's loader
calls `setupStatusQuery` on every mount and, if the URL's sub-route is ahead
of the server's `currentStep`, redirects to the server's current step. A
stale URL from a previous session can never skip ahead.

**D5 — One PR / one commit at capability boundary.**
Per `.claude/rules/git.md`, the orchestrator commits. The implementer reports
changed files; the orchestrator stages explicitly (no `git add -A`) and
creates the commit.

## Open questions

None at contract time. If the implementer surfaces an API gap (e.g. a UI step
needs a field the API doesn't return), record as **D-CAP-041-N** in
§Deferred items and stop — do NOT extend the API. The orchestrator decides
whether to pull a follow-up capability forward.

## Deferred items

- **D-CAP-041-1** — Duplicate `/status` fetch on every `/setup/*` mount (QA re-review MEDIUM). `router.tsx:140` calls `fetchSetupStatus(apiClient)` directly in `beforeLoad`, AND `setup-layout.tsx:53` calls `setupStatusQuery()` via `useQuery` which fires its own fetch. Two GET /status requests per navigation. Fix scope: thread `queryClient` through the router context, replace the direct `fetchSetupStatus(apiClient)` call with `queryClient.fetchQuery({ queryKey: setupQueryKeys.status(), queryFn: ... })` so the result lands in the cache, and have the layout read from cache (either drop the useQuery or set `staleTime: Infinity`). Decision: defer to a follow-up capability (small absolute cost, functional correctness preserved) OR fix inline at capability close per user direction.

- **D-CAP-041-2** — `/api/v1/setup/inbound-smoke-test/check` is a POST that the wizard polls every 5s (`InboundSmokeStep`). The wizard polls a POST for idempotency reasons (each poll gets a fresh `Idempotency-Key`), but the server accumulates one idempotency row per poll with no semantic value. The contract should be a GET. Decision: deferred — server contract is owned by CAP-016, not for CAP-041 to extend. Record in CAP-016 follow-ups.

- **D-CAP-041-3** — `PreflightStep` does not exercise the 401-after-hard-reload scenario. The `setupSession` middleware on the worker's POST /preflight will 401 if the session token is gone; the re-claim affordance is in place but untested. Add a test that asserts the error path lands on the re-claim flow.

- **D-CAP-041-4** — AC #4 contract wording says "router uses `loader: setupStatusQuery`" but the implementation uses `beforeLoad`. TanStack Router's `beforeLoad` is the correct hook for redirect-on-mount guards; the AC template should say "beforeLoad or loader — whichever TanStack Router version requires for redirects". Document in next capability contract template.

- **D-CAP-041-5** — 1 MB body cap runs AFTER `JSON.stringify` (security re-review risk note). Wasteful for huge bodies (allocates a multi-MB string just to throw it away) but the guard fires before fetch. Optimize later: stream-length-check or pre-serialize with a budget. Acceptable for CAP-041's payload sizes.

- **D-CAP-041-6** — `crypto.randomUUID` fallback in `client.ts:211-215` uses `Math.random` (security re-review risk note). Not cryptographically strong; acceptable because Idempotency-Key and x-request-id are correlation-only. Remove fallback if either ever becomes security-bearing.

- **D-CAP-041-7** — InboundSmokeStep POSTing `/inbound-smoke-test/check` every 5s means one idempotency row per poll in the server's `idempotency_records` table. The 24-hour TTL eventually purges them; for now, this is wasted storage on every wizard run. Consider a server-side `check`-specific idempotency key that doesn't write to `idempotency_records` (CAP-016 territory).

- **D-CAP-041-8** — Dark-mode contrast for `.alert[data-variant='success']` (~3.4:1) and `[data-variant='danger']` (~2.7:1) is under WCAG AA 4.5:1 for normal text (frontend re-review LOW). Fix scope: darken the `*-foreground` token or bump the `*-soft` lightness above 30% so text/background clears 4.5:1. Deferred to a follow-up since the wizard still meets minimum readability; check via real AXE audit when a Playwright stack is added in CAP-045.

- **D-CAP-041-9** — `renderStep` (apps/web/src/test-utils.tsx) builds a parallel router tree that does NOT include `setupRoute.beforeLoad`. The B1 BLOCKER fix (`useApiClient()` removed from `beforeLoad`; reads via `context.apiClient`) could regress silently because no test exercises the router's `beforeLoad`. The new `mountAppRouter` helper exists for this purpose but is unused. Decision: in CAP-042 or CAP-045, add at least one router-context test that asserts `setupRoute.beforeLoad` calls `fetchSetupStatus(apiClient)` from context and redirects stale URLs.

- **D-CAP-041-10** — REMOVED. Fixed inline during the orchestrator's commit-preparation pass. `router.tsx:160-164` now `throw redirect({ to: '/setup/${activeStep}' as const });` when `subIndex === -1`, falling back to the server's current step instead of rendering an empty `<Outlet />`. Architecture re-review MEDIUM resolved. No follow-up needed.