# CAP-063 — Skip remaining setup from Administrator onwards (lite)

> The shared contract for this capability. Every agent working on it reads this file first.
> Location: `work/archive/2026-08/CAP-063/task.md`.

**Phase:** 3 · **Status:** Implemented locally; independently reviewed with no findings · **Started:** 2026-08-30

## Goal

An operator at the setup wizard can complete the Administrator step (mandatory) and then
choose to skip any of the remaining tabs (Domain, Cloudflare Verify, Inbound Smoke, Brevo,
Outbound Smoke). Skipping finalises the installation via the existing
`POST /api/v1/setup/complete` endpoint and routes the operator to the app shell, where
provider / domain / role configuration can be done later from the existing admin pages
(which this CAP does NOT add — admin-page gaps are documented in the runbook).

## Scope

- One secondary `Skip remaining setup` button on the same six step components:
  `AdministratorStep`, `DomainStep`, `CloudflareVerifyStep`, `InboundSmokeStep`,
  `BrevoStep`, `OutboundSmokeStep`. The button is `variant="secondary"`, renders below
  the existing wizard action row, and is named identically everywhere
  (`data-testid="setup-skip-remaining"`).
- At `AdministratorStep`, the button is `disabled` until the admin form's `onSubmit`
  resolves successfully (the same success path that currently navigates to
  `/setup/domain`). After success the operator is auto-navigated to `/setup/domain`
  unchanged; the button state on the Administrator page is observable by anyone who
  stays on it.
- On the other five steps, the button is always enabled.
- Click handler posts to the existing `POST /api/v1/setup/complete` endpoint with an
  empty body, then invalidates `setupQueryKeys.status()` and navigates to `/`.
  Errors surface through the existing `ErrorPanel` (mirroring `CompleteStep`'s shape).
- Runbook at `docs/operations/post-setup-admin-urls.md` documenting:
  - existing admin URLs the operator can bookmark (`/admin`, `/admin/connections`,
    `/admin/users`, `/admin/audit-events`, `/admin/webhook-events`, plus `/mailbox`);
  - the gaps that are NOT yet wired to admin pages (Domain management, Role
    management, Signature management, general Settings) and the fact that this CAP
    does NOT add them — each is a separate capability tracked in the ledger;
  - the limitation that if the operator skips BEFORE creating the administrator the
    installation completes with no admin user; the runbook tells the operator to
    always complete the Administrator step first.
- Ledger entry, implementation-log entry, capability name registration.

## Out of scope

- New admin pages for Domain / Role / Signature / Settings management. Each gap is
  tracked separately (see Decisions section); CAP-063 does not commit them.
- Changes to the existing `/complete` endpoint shape (request body, response shape,
  error catalog). The skip button reuses the endpoint as-is.
- Wizard re-entry after `status === 'complete'` (would require a deliberate unlock
  flow and a separate capability; tracked as `D-CAP-063-A`).
- A `setup/skip-remaining` separate route or endpoint — the existing `/complete` is
  reused by design (single source of truth for the state flip).
- Re-styling the wizard action row or the existing step components beyond the
  minimum button addition.
- i18n beyond the existing English strings.

> This section prevents more drift than the Scope section does. Be generous with it.

## Business rules

| Rule ID | What it means for this slice |
|---|---|
| `R-WORKFLOW-001` | The server is the source of truth for `installation_state.status`; the button only POSTs and reacts to the response. |
| `R-WORKFLOW-002` | Skipping flips state to `complete` via the existing conditional UPDATE that lives in `completeSetup()` (a single D1 batch with a `setup.complete` audit row). The new code path goes through the same batch; no new branch. |
| `R-AUDIT-001` | The skip action's audit row carries the `request_id` the middleware stamped on the request (already enforced in `complete-setup.ts:75-85`). |
| `R-OUTBOUND-004` | Outbound is unconfigured post-skip until the operator connects a provider at `/admin/connections`. Provider-bound errors will surface to users until then; this is the documented pre-existing behaviour. |
| `R-INBOUND-008` | Inbound is unconfigured post-skip until domains are added (currently wizard-only — see gap section in the runbook). |
| `R-AUTH-005` | Administrator role assignment happens via the existing `completeSetup()` (it picks up the first user if one exists). If the operator skips before creating an admin, no admin role is granted — the runbook warns about this. |

Source: `docs/rebuild/02-business-discovery/business-rules.md`.

## Acceptance criteria

Objectively checkable. No "works correctly". Each maps to a test or a demonstrable behaviour.

- [x] 1. `AdministratorStep` renders a `Skip remaining setup` button with
       `data-testid="setup-skip-remaining"` below the existing
       `Create administrator` button, and the button is `disabled` on initial render.
- [x] 2. After a successful `/api/v1/setup/administrator` POST, the operator is
       auto-navigated to `/setup/domain` (unchanged existing behaviour) AND the skip
       button on `AdministratorStep` becomes `enabled` for any operator who manually
       returns to the page. (Test: after admin POST, `AdministratorStep` re-renders
       with skip button enabled.)
- [x] 3. `DomainStep`, `CloudflareVerifyStep`, `InboundSmokeStep`, `BrevoStep`,
       `OutboundSmokeStep` each render the skip button as enabled on mount.
- [x] 4. Clicking the skip button on any of the six steps POSTs
       `/api/v1/setup/complete` with an empty body and the appropriate
       `Idempotency-Key` header (key is generated per click — see
       `CompleteStep`'s shape at `apps/web/src/features/setup/steps/CompleteStep.tsx:42`).
- [x] 5. On 200 from `/complete`, the skip button's handler invalidates
       `setupQueryKeys.status()` and navigates to `/` (the SPA shell).
- [x] 6. On a non-200 from `/complete` (e.g. 401 SETUP_CLAIM_INVALID_TOKEN, 500),
       an `ErrorPanel` renders with the stable code + message and a retry button.
- [x] 7. A worker-pool test in `apps/worker/src/http/routes/setup.worker.test.ts`
       (or the existing `setup.test.ts`) covers the `/complete` round-trip from the
       wizard: preflight + administrator → POST `/complete` → 200 + audit row +
       `installation_state.status='complete'` + `current_step='complete'`.
- [x] 8. `docs/operations/post-setup-admin-urls.md` exists, lists every existing
       admin URL with a one-line purpose, and lists the four known gaps
       (Domain / Role / Signature / Settings) with a pointer to the capability
       ledger entry that owns each.
- [x] 9. `pnpm test:unit`, `pnpm test:worker`, `pnpm scaffold doctor`, `pnpm lint`,
       `pnpm typecheck`, `pnpm build` all pass at the close of this slice, with no
       new failures introduced.

### Verification note

The local unit, Web, doctor, lint, typecheck, format, build, and full Worker
checks pass. The Brevo setup and outbound route tests use the local live test
token; deterministic provider error and payload mapping remains in adapter unit
tests. A valid-login browser session observation is still required for the
separate Better Auth cookie follow-up.

## Vertical slice

Layers this touches, in dependency order:

- [x] client — `apps/web/src/features/setup/steps/{Administrator,Domain,CloudflareVerify,InboundSmoke,Brevo,OutboundSmoke}Step.tsx` (add button + handler)
- [x] client — `apps/web/src/features/setup/steps/{Administrator,Domain,CloudflareVerify,InboundSmoke,Brevo,OutboundSmoke}Step.test.tsx` (button + state tests)
- [x] worker test — `apps/worker/src/http/routes/setup.worker.test.ts` (existing setup round-trip covers the server contract)
- [x] runbook — `docs/operations/post-setup-admin-urls.md` (new file)
- [x] ledger — `docs/rebuild/capability-ledger.md` (CAP-063 entry + gap deferrals)
- [x] implementation log — `docs/rebuild/implementation-log.md` (CAP-063 entry)

No new module dependency edges; no contract schema changes (the `/complete` request
schema already accepts an empty body per `apps/worker/src/http/routes/setup.ts:780`).

## Delivery path

Trace the real invocation, not only the module calls:

`browser (SetupLayout → AdministratorStep / DomainStep / ...)` →
`POST /api/v1/setup/complete` (existing route handler at
`apps/worker/src/http/routes/setup.ts:779`) → `completeSetup()` use case at
`apps/worker/src/modules/onboarding/complete-setup.ts:40` → D1 batch
(`user_roles` INSERT + `installation_state` UPDATE + `audit_events` INSERT) →
`installation_state.status='complete'` → setup-gate middleware (CAP-006) stops
redirecting → browser lands at `/` (mailbox shell).

- Build/runtime configuration touched: none (no wrangler config or env-var changes).
- Fresh-deploy evidence required: no (no schema or migrations).
- Repeat-deploy/idempotency evidence required: no (no deployable artifact).

## Reference implementation

Use `None` when there is no external reference. Otherwise follow
`.claude/rules/reference-implementations.md`.

| Field | Value |
|---|---|
| Repository + pinned commit | None |
| License | n/a |
| Files inspected | n/a |
| Adopt | n/a |
| Adapt | n/a |
| Reject | n/a |
| Attribution needed | no |

The shape mirrors `CompleteStep`'s button at
`apps/web/src/features/setup/steps/CompleteStep.tsx:108-112` (success → `navigate({to:'/'})`)
and its error shape at `:95-101`.

## File ownership

One writer per file. Reading anything is fine; writing outside your list is not.

| Agent | Owns |
|---|---|
| implementer-1 | `apps/web/src/features/setup/steps/{Administrator,Domain,CloudflareVerify,InboundSmoke,Brevo,OutboundSmoke}Step.tsx` + matching `*.test.tsx` |
| implementer-1 | `docs/operations/post-setup-admin-urls.md` (new file) |
| implementer-2 (if worker test needs backfilling) | `apps/worker/src/http/routes/setup.worker.test.ts` (append-only — `/complete` round-trip test) |
| orchestrator (post-implementation) | `docs/rebuild/capability-ledger.md`, `docs/rebuild/implementation-log.md` |

## Reading list

Give each subagent exactly this — not the whole `docs/` tree.

- `CLAUDE.md` (the Claude Code entry point)
- this file
- `.claude/agents/implementer.md`
- `.claude/rules/coding.md`, `.claude/rules/architecture.md`, `.claude/rules/testing.md`
- `apps/web/src/features/setup/steps/CompleteStep.tsx` (button + handler shape to mirror)
- `apps/web/src/features/setup/steps/AdministratorStep.tsx` (current form + submit shape)
- `apps/web/src/app/router.tsx` lines 489-536 (the six step routes — for navigation context only)
- `apps/worker/src/http/routes/setup.ts` lines 776-829 (existing `/complete` route)
- `apps/worker/src/modules/onboarding/complete-setup.ts` (the use case — read only)
- `docs/rebuild/02-business-discovery/business-rules.md` (R-WORKFLOW-001/002, R-AUDIT-001)

## Dependencies

- Requires: CAP-041 (Setup web vertical slice) — Implemented. The skip button reuses
  the same step-component surface and the `/complete` endpoint introduced in CAP-041 +
  CAP-017 + CAP-046.
- Requires: CAP-017 (Roles & permissions seed) — Implemented. `completeSetup()` calls
  `seedRolesAndPermissions()` (idempotent INSERT OR IGNORE) and grants the
  `administrator` role to the first user if one exists.
- Requires: CAP-046 (Audit `request_id` correlation) — Implemented. The audit row
  the skip button's POST writes carries `request_id` for R-AUDIT-001.
- Blocks: nothing currently. Adds `D-CAP-063-A` (wizard re-entry) and admin-page gaps
  that future capabilities will own.

## Decisions made during this capability

- **D-CAP-063-1**: skip button reuses `/complete` rather than adding a new endpoint.
  The `/complete` endpoint already seeds roles, assigns admin role if a user exists,
  and flips state — it IS the "skip and finish" semantics, and a new endpoint would
  duplicate that audit-batch shape.
- **D-CAP-063-2**: skip button is disabled at `AdministratorStep` until admin form
  submits successfully. Skipping before admin creation would complete the
  installation with no admin user (no UI page can recover from this). The runbook
  repeats the same warning.
- **D-CAP-063-3**: no new admin pages in this CAP. Per the user's lite-path direction.
  Domain / Role / Signature / Settings management remain wizard-only until each gets
  its own capability (none currently exist; tracked as `D-CAP-063-B..E`).
- **D-CAP-063-4**: runbook lives at `docs/operations/post-setup-admin-urls.md`. The
  `docs/operations/` directory already exists (it has `deploy.md`).

## Open questions

None at contract time. The skip-button placement question
(Administrator only vs every post-admin step) was resolved with the user before the
contract was drafted; chosen design is "every post-admin step, disabled at
Administrator until admin form submits".
