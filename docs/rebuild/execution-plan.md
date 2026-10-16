# Execution plan

Current priorities as of 2026-10-16. The [ledger](capability-ledger.md#current-state)
owns status; user priorities determine the next authorized slice. No feature
capability is currently active.

CAP-071 measured D1 identity/thread queries and mailbox cache freshness are
locally implemented and validated. The new reader requires schema 0041 before
publication. Local scan reduction does not establish a live latency win; see
[query optimization](23-query-cache-optimization.md) and
[handoff](../../work/handoffs/query-cache-2026-10-16.md).

CAP-070 shared mail mutation use cases are locally implemented and validated:
HTTP and MCP draft/send entrypoints call common operations, while message state
mutations retain their transactional policies. See
[architecture](05-target-architecture/module-boundaries.md#shared-mail-mutation-use-cases)
and [handoff](../../work/handoffs/mail-use-cases-2026-10-16.md).

The selected two-section resource dashboard and inbound/outbound reliability slices are locally implemented. Resource analytics installation configuration and live dataset acceptance remain open; see [resource dashboard](22-resource-usage-dashboard.md).
Schemas 0038–0041, installation deployment and real-mail/provider recovery
acceptance remain unpublished. See [inbound recovery](20-inbound-recovery.md),
[outbound outcomes](21-outbound-submission-outcomes.md) and the
[outbound handoff](../../work/handoffs/outbound-outcomes-2026-10-16.md).

## Current ordering

1. Maintain the implemented mailbox/admin flows, self-hosted identity, shadcn UI,
   rich editor/R2 storage, localization and scheduled send. Use dated QA records
   and the current source rather than reopening the old recovery sequence.
2. Close the remaining comprehensive acceptance gaps with recorded allowed,
   denied, failure and recovery scenarios. Focused staging success does not close
   every case in the [acceptance catalog](../qa/acceptance-test-cases.md).
3. Complete controlled installation acceptance for the prepared reliability
   changes, including correlated callbacks/provider lookup and legacy unknown
   work reconciliation. Further selected provider work includes provider-side
   duplicate suppression proof, event-level webhook replay policy, synchronization
   contract and an SMTP adapter. Brevo is the only registered provider today.
4. Plan legacy data import and production cutover as separate work, with backup,
   migration mapping, isolation and rollback evidence. Existing legacy databases
   must not receive this application's migration chain directly.
5. Add scale/realtime coordination only after measurements justify it. Keep the
   accepted D1/R2/Queue design and the single five-minute Cron.

These are remaining work boundaries, not an instruction to expand the current
user request into deployment, data migration or speculative features.

## Superseded recovery sequence

The August plan below explains earlier CAP boundaries and decisions. Its "next"
statements, Better Auth runtime migration and phase status are historical. The
October integration decisions supersede that authentication direction: accounts
are admin-created, authentication uses application-owned D1 sessions, and Better
Auth material is retained only for migration compatibility.

---

# Historical recovery plan — 2026-08-19

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
closed. CAP-042 completed Slice 0 and its repository-owned 0014 additive migration; runtime
secret/config bindings and the request-scoped auth factory are next within the additive-substrate
slice. A later
capability starts only after the current one completes review, ledger/log sync, cleanup, and
acceptance.

| Order | Capability | Outcome | Depends on | Exit evidence |
|---|---|---|---|---|
| 0 | CAP-030 — lifecycle direction | Finish the current state-machine guard slice without mixing recovery changes into its diff. | CAP-029 | All required reviews; six local gates; ledger/log sync; active workspace cleaned |
| 1 | CAP-039 — deployment substrate | One build/deploy serves the real web bundle and client routes; queue consumer is declared; remote migrations apply pending files once and a second deploy is safe. | CAP-030 | Dry-run config inspection; asset and SPA route Worker tests; queue config assertion; fresh + repeat migration test |
| 2 | CAP-040 — webhook and audit reliability | Webhook secret is no longer returned by list APIs; early events are durably retained and reconciled; status change and delivery/audit evidence are atomic; request IDs reach audit events. | CAP-039 | Security, crash-window, early-event replay, cross-tenant, and atomicity tests |
| 3 | CAP-041 — setup web vertical slice | `/setup` renders a resumable wizard for every existing setup API step, with explicit loading/error/retry/success states. | CAP-039 | Browser test on fresh local bindings plus Worker route fallback tests |
| 4 | CAP-042 — Better Auth and authorized mailbox shell | Better Auth runs on Hono + D1 without replacing canonical user IDs or RBAC; existing users can authenticate; registration/login/logout/session recovery and authorized mailbox navigation work in the single web client. | CAP-041 | D1 compatibility and atomic-registration proof; migration verification; browser allowed/denied/expired-session tests; contract and rollback tests |
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

### CAP-042 — Better Auth and authorized mailbox shell

ADR-008 owns the architecture and migration decisions. CAP-042 remains one capability, executed as
ordered, independently reviewable slices. Do not start a later slice until the previous slice's
exit gate passes.

1. **Compatibility and atomicity spike.** Pin matching Better Auth core/Drizzle-adapter versions;
   generate the SQLite schema for review; prove Hono raw-request handling, D1 adapter behavior,
   Secrets Store access, cookie handling, bundle compatibility, custom ADR-006 PBKDF2 verification,
   and registration/setup-administrator transaction behavior in the Cloudflare Workers Pool.
   Reconcile each `R-AUTH-001` through `R-AUTH-009` rule with Better Auth and record any contract
   conflict, especially verified-email and password-bound drift. This slice makes no route cutover.
   An unproven atomicity story blocks sign-up work.
2. **Additive substrate.** Add the request-scoped auth factory, new secret/config bindings, Drizzle
   D1 adapter, typing declarations, repository-owned SQL plus verification migration, deploy-time
   secret provisioning, test bindings, and doctor configuration-parity checks. Reuse `users` as the
   canonical identity and create distinct `auth_accounts`, `auth_sessions`, and
   `auth_verifications` tables. Keep legacy password/session storage intact.
3. **Shadow session bridge.** Mount Better Auth at `/api/v1/auth/better/*`, with matching `basePath`,
   and resolve its cookie session into the existing Hono `userId`. Deny banned/deleted users and
   conflicting cookie/bearer principals. Prove existing `requirePermission` and mailbox
   authorization without changing their ownership.
4. **Existing-user credential migration.** Idempotently backfill Better Auth credential accounts
   from the existing PBKDF2 columns; verify counts, duplicates, orphan handling, case-insensitive
   email, and login without a forced password reset. Do not migrate legacy sessions.
5. **Registration and administrator cutover.** Enable Better Auth-backed credential creation only
   after tests prove user + credential + invite usage + role assignment atomicity, and the analogous
   setup-administrator transition. Retain the application-owned orchestration endpoint and its
   idempotency contract; Better Auth does not own invitation or role policy.
6. **Browser cookie cutover.** Add login/register routes and authorized mailbox navigation to the
   single React client. Use HttpOnly cookies, session recovery, explicit loading/error/unauthorized
   states, and logout; do not persist bearer or refresh tokens in browser storage. Close
   D-CAP-041-1 and D-CAP-041-9 before copying their query/router patterns into the mailbox shell.
7. **Local cutover and rollback proof.** Exercise `AUTH_PROVIDER=legacy|dual|better-auth`, invalidate
   legacy sessions only at the controlled switch, verify rollback to legacy on the same additive
   schema, and leave destructive legacy-table/column cleanup for a later capability after CAP-045
   preview evidence.

CAP-042 acceptance requires all `R-AUTH-001` through `R-AUTH-009` behaviors to be demonstrated or
explicitly re-decided before browser cutover. In particular, Better Auth defaults do not override
the ten-session limit, renewal rotation, revoke-all-on-password-change, banned/deleted denial,
verified-email policy, password limits, or case-insensitive email rules.

The delivery path is:

`Browser login/register` → `Hono Better Auth boundary` → `D1 auth tables + canonical users` →
`session bridge sets userId` → `existing RBAC/mailbox authorization` → `authorized mailbox shell`.

Security review is mandatory because this capability changes authentication, cookies, secrets,
password verification, and database identity records. Architecture, code, QA, and frontend reviews
remain required by the vertical-slice contract.

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
