# Execution Plan

This is the ordered implementation plan. Delivery status remains authoritative in
`capability-ledger.md`; business scope remains authoritative in the roadmap and business-rule
documents. Update this file when ordering or capability boundaries change, not after every code
edit.

## Recovery objective

Turn the current locally tested backend into a deployable, browser-usable, failure-safe business
loop before expanding Phase 2 or decomposing Phases 3–6.

The recovery gate is necessary because code inspection on 2026-08-19 found that Phase 0 and Phase 1
were described as complete while their delivery paths were absent or broken. Passing unit, Worker,
type, lint, and build gates remains required, but does not prove that a user can install and use the
product.

## Execution order

Only one capability is active at a time. Orders 0–3 are implemented and their workspaces are
closed. No capability is currently active; CAP-042 is next. A later capability starts only after
the current one completes review, ledger/log sync, cleanup, and acceptance.

| Order | Capability | Outcome | Depends on | Exit evidence |
|---|---|---|---|---|
| 0 | CAP-030 — lifecycle direction | Finish the current state-machine guard slice without mixing recovery changes into its diff. | CAP-029 | All required reviews; six local gates; ledger/log sync; active workspace cleaned |
| 1 | CAP-039 — deployment substrate | One build/deploy serves the real web bundle and client routes; queue consumer is declared; remote migrations apply pending files once and a second deploy is safe. | CAP-030 | Dry-run config inspection; asset and SPA route Worker tests; queue config assertion; fresh + repeat migration test |
| 2 | CAP-040 — webhook and audit reliability | Webhook secret is no longer returned by list APIs; early events are durably retained and reconciled; status change and delivery/audit evidence are atomic; request IDs reach audit events. | CAP-039 | Security, crash-window, early-event replay, cross-tenant, and atomicity tests |
| 3 | CAP-041 — setup web vertical slice | `/setup` renders a resumable wizard for every existing setup API step, with explicit loading/error/retry/success states. | CAP-039 | Browser test on fresh local bindings plus Worker route fallback tests |
| 4 | CAP-042 — auth and mailbox shell | Registration/login/logout/session recovery and authorized mailbox navigation work in the single web client. Missing API scope is either implemented or explicitly removed from Phase 1. | CAP-041 | Browser allowed/denied/expired-session tests and contract tests |
| 5 | CAP-043 — inbox and message reading | Authorized users can list mailboxes, open inbox, view message/thread, mark read, and perform the Phase 1 delete behavior. | CAP-042, CAP-034 if cursor contract is pulled forward | Browser loading/empty/error/success tests, IDOR tests, pagination evidence |
| 6 | CAP-044 — compose, reply, and admin surfaces | Compose/reply uses the durable outbox and idempotency contract; admin users can inspect users, webhook metadata, and audit events without receiving secrets. | CAP-040, CAP-043, CAP-033 if audit query is pulled forward | Browser mutation retry/replay tests; queue path; permission matrix; secret-leak scan |
| 7 | CAP-045 — preview delivery verification | A fresh preview deployment and a repeat deployment complete the real setup, inbound, read, reply, webhook, recovery, and audit loop. | CAP-039–CAP-044 | Recorded deployment URLs/config checks, real inbound email, real provider reply, queue/crash recovery, audit trail, second deploy |

CAP-033 (audit queries), CAP-034 (cursor pagination), and CAP-036 (JSON normalization) remain
allocated Phase 2 work. Pull CAP-033 or CAP-034 forward only when the corresponding vertical slice
needs its contract; otherwise execute them after CAP-045. This avoids a second backend-only pass.

## Capability boundaries

### CAP-039 — deployment substrate

- Replace the hand-written HTML asset reference with supported Worker/Vite asset or SSR wiring.
- Serve `/setup`, nested client routes, refreshes, and unknown client routes without intercepting
  `/api/v1/*`, email, queue, or scheduled entrypoints.
- Add the queue consumer (and dead-letter/retry settings if the design requires them) to the
  deployable Wrangler configuration and mirror the test configuration.
- Change remote deployment to read `d1_migrations` and apply only pending migrations. Demonstrate
  a clean first deploy and a no-op second deploy.
- Extend `pnpm scaffold doctor` so static assets, queue consumer topology, and migration strategy
  cannot silently regress.
- Use the pinned `agentic-inbox` Worker/UI integration as a Cloudflare pattern; retain the existing
  four-entrypoint modular monolith.

### CAP-040 — webhook and audit reliability

- Return only webhook configuration state and URL metadata from list APIs. Secret creation/rotation
  is a separate write-only response with audit evidence.
- Persist unmatched provider events with enough correlation data and process them after the
  provider message ID becomes known. Define expiry and poison-event behavior.
- Make message status advancement and webhook delivery/audit recording atomic.
- Propagate the request ID to all request-originated audit rows; define a correlation ID for email,
  queue, and scheduled events.
- Close D-CAP-029-A, D-CAP-029-B, and the early-event gap found by the recovery audit.

### CAP-041–CAP-044 — web vertical slices

- Follow the reference separation of transport, stable query keys, query hooks, and UI components.
- Derive all payloads from `packages/contracts`; the UI must not invent a second contract model.
- Every route implements loading, empty, error, success, unauthorized, and retry behavior where
  applicable.
- Server state stays in TanStack Query. Local UI state is limited to presentation and unsaved form
  state.
- Each slice includes its API gaps, authorization checks, browser behavior, and Worker tests. A
  “backend done, UI later” split is not accepted again.

### CAP-045 — verification gate

The gate runs against preview, not only Miniflare:

1. Provision a fresh environment and deploy.
2. Refresh `/setup` and every nested client route directly.
3. Complete setup and authenticate through the browser.
4. Receive a real inbound email, read it, reply, and observe provider/webhook status.
5. Exercise retry/replay, unauthorized access, an early webhook, and queue recovery.
6. Confirm every transition has correlated audit evidence and no secret/body appears in logs.
7. Deploy the same commit again; confirm migrations are a no-op and service remains healthy.

Phase 0 and Phase 1 may return to `Verified` only after this evidence is recorded. Phase 2 may close
only after its remaining acceptance criteria pass the same preview gate.

## Planning rules

- No percentage-complete estimates. Use `Pending`, `In Progress`, `Implemented`, and `Verified`
  with named evidence.
- A build artifact is not a deployed asset; an exported handler is not a configured trigger; an API
  is not a user workflow.
- Every capability names the upstream reference files it used and the behavior it rejected.
- The ledger, execution plan, implementation log, active workspace, and Git state are reconciled at
  each capability boundary.
- Phase 3 is not decomposed until the recovery gate and Phase 2 audit pass.
