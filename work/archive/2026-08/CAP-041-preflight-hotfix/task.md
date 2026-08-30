# CAP-041 — Preflight wizard-step hotfix

> Operator-reported bugs in the locally-running setup wizard. Both root causes
> were traceable to CAP-041 (the wizard implementation). Per operator decision
> (2026-08-30), this ships as a single fix commit hanging off `f1e23af` rather
> than a new CAP ID. Reviewers must still confirm the diff is correct and tests
> prove the new behaviour.

**Phase:** 2 · **Status:** In Progress · **Started:** 2026-08-30

## Goal

An operator at `/setup/preflight` (a) sees the preflight chip in the wizard
indicator rendered as the active step, and (b) clicking Continue actually
advances them to the administrator step.

## Scope

- Worker: preflight use case + route now advance `installation_state.current_step`
  from `'preflight'` → `'administrator'` when all bindings are present and the
  schema version matches the contracts package's `CURRENT_SCHEMA_VERSION`.
- Web: `requireSetupStep` hydrates the React Query cache so the layout's chip
  indicator sees `currentStep = 'preflight'` on first render instead of all
  steps flashing "upcoming".
- Tests on each side prove both behaviours and the failure paths.

## Out of scope

- Refactoring `runPreflight` into a multi-method module — keep one function,
  add the advance as a side-effect at the end.
- Adding a new HTTP endpoint (no `/preflight/acknowledge` etc.). The advance
  is part of the existing POST.
- Cleaning up the five stale directories under `work/active/`. The operator
  chose the hotfix path; drift reconciliation is a separate ledger task.
- Visual redesign of the wizard indicator. Behaviour-only.
- Any change to the other setup step flows (`claim`, `administrator`, …).

## Business rules

| Rule ID | What it means for this slice |
|---|---|
| `R-WORKFLOW-001` | Server is the source of truth for installation state. Client never mutates `currentStep` locally; preflight continue must reconcile with the server before the wizard can move on. |
| `R-WORKFLOW-002` | Each state transition is atomic — the `installation_state` UPDATE and the matching `audit_events` INSERT land in one D1 batch. Re-applying a transition (already past `preflight`) is a safe no-op, not a duplicate. |
| `R-AUDIT-001` | Every state transition writes an `audit_events` row (action, actor, resource, request ID). The preflight→administrator advance is a state transition. |
| `R-DATA-001` | The preflight response is the source of truth; the wizard does not re-validate the response. The same principle in reverse: the wizard does not infer server state, only reads it. |

## Acceptance criteria

- [ ] 1. **AC-1 — Active chip on first render.** Loading `/setup/preflight`
      while `installation_state.current_step = 'preflight'` renders the
      preflight chip with `data-state="current"` AND `aria-current="step"` on
      the very first paint (no flash of all-upcoming). Asserted by a router
      test that mounts `/setup/preflight` against an in-memory QueryClient
      pre-populated only via `beforeLoad`.
- [ ] 2. **AC-2 — All-green advances server state.** `POST /api/v1/setup/preflight`
      with all bindings present AND a matching schema version returns 200 and
      leaves `installation_state.current_step = 'administrator'` and writes
      one `audit_events` row with `action = 'setup.preflight.complete'` and
      `request_id = <c.get('requestId')>`. Asserted by a route test that
      diffs the DB before/after.
- [ ] 3. **AC-3 — Not all-green does NOT advance.** `POST .../preflight` with
      a missing binding (e.g. clear `BETTER_AUTH_SECRET`) returns 200 with
      `bindings.<name> = false`, leaves `current_step = 'preflight'`, and
      writes NO new `audit_events` row. Asserted by a route test.
- [ ] 4. **AC-4 — Schema drift does NOT advance.** Same shape as AC-3 but
      `d1_migrations` top row name does not match `CURRENT_SCHEMA_VERSION`.
      Returns 200, `current_step` unchanged, no audit row.
- [ ] 5. **AC-5 — Re-applying an already-advanced preflight is a no-op.**
      Caller-side: state is already `'administrator'`. POST `/preflight`
      with all-green returns 200 and writes NO new audit row, because the
      conditional UPDATE matches zero rows. Asserted by a route test.
- [ ] 6. **AC-6 — Idempotency replay returns the same response without
      re-running the use case.** Same `Idempotency-Key` + same body returns
      the stored response; second call writes no new audit row. Existing
      `preflight.worker.test.ts` idempotency cases must continue to pass,
      and a new assertion confirms no second `audit_events` row.
- [ ] 7. **AC-7 — Continue actually navigates.** With the fixes above, an
      operator passing preflight and clicking Continue reaches
      `/setup/administrator`. The layout's chip indicator now shows
      preflight as `complete` and administrator as `current`. Asserted by a
      router/integration test that simulates the navigation sequence.

## Vertical slice

- [ ] use case — `apps/worker/src/modules/onboarding/preflight.ts`
- [ ] route — `apps/worker/src/http/routes/setup.ts` (`POST /preflight` arm)
- [ ] router — `apps/web/src/app/router.tsx` (`requireSetupStep`)
- [ ] tests — `apps/worker/src/http/routes/preflight.worker.test.ts`,
            new `apps/web/src/app/router.setup.test.tsx` (or extend
            existing `router.test.tsx`)

New module dependency edges introduced: **none**. The advance lives inside
the existing `onboarding` module; the route already depends on the use case;
the web router only changes how it reads existing data through the existing
`queryClient`. No `import` edges cross forbidden directions.

## Delivery path

`browser click` → `PreflightStep.tsx Continue onClick` → `navigate({to:'/setup/administrator'})`
→ `administratorRoute.beforeLoad` → `requireSetupStep(context,'administrator')` →
`queryClient.fetchQuery(setupStatusQuery)` (now cache-populated by client
hydration) → state says `'administrator'` because the prior `POST /preflight`
advanced it → user lands on `/setup/administrator` with the chip indicator
updated.

For the active-chip fix specifically: `browser navigation` →
`preflightRoute.beforeLoad` → `requireSetupStep` (now uses
`queryClient.fetchQuery`) → cache populated → `SetupLayout` mounts,
`setupStatusQuery` reads cache synchronously → preflight chip renders
`data-state="current"` on first paint.

- Build/runtime configuration touched: **none**.
- Fresh-deploy evidence required: **no** (no schema or migration change).
- Repeat-deploy/idempotency evidence required: **yes** — replay AC-6.

## Reference implementation

**None.** Both fixes are inside existing CAP-041 code paths; no external
pattern is adopted.

## File ownership

| Agent | Owns |
|---|---|
| implementer-1 | `apps/worker/src/modules/onboarding/preflight.ts`, `apps/worker/src/http/routes/setup.ts`, `apps/worker/src/http/routes/preflight.worker.test.ts` |
| implementer-1 (web) | `apps/web/src/app/router.tsx`, `apps/web/src/app/router.test.tsx` (or new `router.setup.test.tsx`) |

Single implementer owns all five files. Review and audit happen on the full
diff in one round. (CAP-041 hotfix path — no parallelism inside the slice.)

## Reading list

Each implementer is given exactly this list:

- `CLAUDE.md`
- this file
- `.claude/agents/implementer.md`
- `.claude/rules/architecture.md` (esp. `entrypoints ──▶ modules ──▶ domain`)
- `.claude/rules/coding.md` (esp. `Data` and `Errors`)
- `.claude/rules/testing.md` (esp. "Every state transition")
- `.claude/rules/security.md` (esp. Idempotency ADR-004)
- The slice-specific code: `apps/worker/src/modules/onboarding/preflight.ts`,
  the `/preflight` arm of `apps/worker/src/http/routes/setup.ts`,
  `apps/web/src/app/router.tsx`, `apps/web/src/features/setup/steps/PreflightStep.tsx`,
  `apps/web/src/features/setup/setup-layout.tsx`
- `apps/worker/src/modules/onboarding/installation-state-repository.ts`
  (for `prepareUpdateInstallationStep` semantics)

Do not go read the rest of `docs/rebuild/` — the relevant design references
are inline in the files above.

## Dependencies

- Requires: CAP-041 (Implemented) — the buggy code path lives there.
- Blocks: nothing new. CAP-054 preview verification is the existing gate.

## Decisions made during this capability

- **Advance is conditional, not unconditional.** `UPDATE ... WHERE id = 1 AND
  current_step = 'preflight'`. Already-advanced callers see a zero-row
  update; no audit row. Cheap to reason about; matches the contracts drift
  guard's "don't promote stale state" pattern.
- **Advance lives inside `runPreflight`, not in the route handler.** Per
  architecture.md "Route handler: validate → call one use case → map result".
  Returning a `boolean advanced` flag in the result keeps the route handler
  one-line; the audit row is folded into the same batch as the UPDATE inside
  the use case, with a `requestId` parameter threaded down.
- **Do not introduce a separate `/preflight/complete` endpoint.** Adding a
  second route that mutates the same state risks split-brain idempotency;
  the existing POST already has idempotency machinery and a session
  middleware. Re-use it.

## Open questions

- The `additionalcontext` test-env pool: how does it surface
  `BETTER_AUTH_SECRET = 'test-secret'` etc. so the missing-binding case
  (AC-3) can be exercised without re-provisioning? **Implementer:** if the
  existing test-kit fixtures already provide a per-test `Env` override,
  use it; otherwise add one minimal `envWithMissing<K>(name)` helper inside
  `preflight.worker.test.ts`. Do not touch shared fixtures.
- `requestId` threading: `requireIdempotencyKey` middleware currently does
  not set `c.set('requestId')` (that's the request-id middleware). The
  audit row needs `requestId`. **Implementer:** if `c.get('requestId')`
  is set by upstream middleware in the real route, OK; otherwise thread
  `requestId` through `runPreflight` as an explicit parameter. Either
  shape is fine — the audit row must always carry a real `requestId`,
  never `null`.
