# CAP-045 — Preview verification gate (executable suite + operator runbook)

## Outcome

A Worker-pool integration suite that drives the seven-step preview-verification gate through
the existing HTTP surface (steps a/b/c/d/e in the harness, step f's pending-only-migrations
invariant via the `computePendingMigrations` fixture), plus an operator close-out runbook that
captures the things only a real Cloudflare preview can prove. CAP-045 closes PARTIAL locally
(the orchestrator-authorable subset) and FULL when the operator pastes the `pnpm test:worker`
output + runbook evidence back into the ledger.

Closes: Phase 0 + Phase 1 "Reopened" status (both return to **Verified** when CAP-045 closes
FULL). Depends on: CAP-039–CAP-044 (all Implemented at code level; CAP-044 closed
2026-08-24).

## Form (locked by user)

- Executable suite + operator close-out runbook.
- Worker HTTP + entrypoint round-trip via vitest workers pool.
- Provider HTTP live when `BREVO_API_KEY?.trim()` is set (operator-runs-the-gate); skipped with
  a `console.warn` when unset (orchestrator-runs-the-gate).
- Audit correlation is **strict `request_id` matching**, captured into a deferred-rows
  accumulator that asserts the EXACT six-action list of known gaps. Test stays GREEN; the
  closure ledger gets machine-readable entries.
- `scripts/send-test-brevo.ts` ships in this slice as a ≤50-line operator helper.
- `testing.md` §Mocking is NOT amended. Live-HTTP is conditional on env-var presence only.
- No credential in any committed file. Keys live in `apps/worker/.dev.vars` (gitignored) or
  shell env at runtime.

## Vertical slice

This is one slice — there is no vertical split because CAP-045 is a single capability
(verification infrastructure), and the user has chosen its form. Slice boundary: when the
suite + runbook + helper + doctor check are written, gates pass on the orchestrator-runnable
subset, and the 5-way review's fix pass lands, commit `chore(CAP-045): …` closes the
orchestrator's PARTIAL.

Closure (the FULL flip) happens when the operator pastes the test output + runbook evidence
back; that is a ledger-only update, no further code changes.

## Spike verdicts (pre-implementation)

Three spikes gate the implementer's authoring. Each produces a binary go/no-go + the
fallback shape if the spike fails. Spikes run BEFORE the suite is written; their verdicts
land here.

### V1 — MessageBatch stubbability (architecture B2)

**Verdict:** GREEN — no fallback required.

The `@cloudflare/workers-types` package at
`apps/worker/node_modules/@cloudflare/workers-types/index.d.ts:2445-2451`
declares:

```ts
interface MessageBatch<Body = unknown> {
  readonly messages: readonly Message<Body>[];
  readonly queue: string;
  readonly metadata: MessageBatchMetadata;
  retryAll(options?: QueueRetryOptions): void;
  ackAll(): void;
}
```

and the `Message<Body>` interface (lines 2430-2437) exposes
`id: string`, `timestamp: Date`, `body: Body`, `attempts: number`,
`retry(options?)`, `ack()`. Every member required by the queue-re
covery
sub-test (gate step 5d) is structurally constructible. The harness can
drive `entrypoints/queue.ts` directly with a typed stub — no seam
extraction in `entrypoints/queue.ts`. **No production code changes for V1.**

### V2 — fetch-spy intercepts worker-pool outbound (architecture H3)

**Verdict:** GREEN — no fallback required.

`vi.spyOn(globalThis, 'fetch').mockResolvedValue(...)` captures the
worker-pool's outbound fetch exactly as it does in the unit vitest
project. The spike at
`apps/worker/src/queue-fetch-spike.worker.test.ts` (deleted after the
verdict, see §Implementation trail) passed with `fetchSpy` invoked
once and the captured URL pointing at `api.brevo.com/v3/smtp/email`.
**No `vi.stubGlobal('fetch', fn)` needed.**

### V3 — Console-restore pattern (architecture H1)

**Verdict:** GREEN — pattern works in the worker pool as written.

The toggle pattern at the contract's V3 section works as written:
`vi.spyOn(console, 'log').mockImplementation(console.log.bind(console))`
in `beforeEach` re-binds the module-scope spy installed by
`apps/worker/test/setup.ts:23-26` to a recording implementation;
`vi.spyOn(console, 'log').mockImplementation(() => {})` in `afterEach`
re-silences. `restoreAllMocks` is never called. The spike at
`apps/worker/src/console-restore-spike.worker.test.ts` (deleted after
the verdict, see §Implementation trail) passed with one captured call.

Pattern (already decided; spike verifies it works in practice):

`test/setup.ts:23-26` installs the module-scope silence; the suite toggles the
`mockImplementation` to record vs silence. `restoreAllMocks` is NEVER called.

## Acceptance criteria

### Harness (orchestrator-authorable)

- [ ] 1. Pre-implementation verifications V1 + V2 + V3 are complete; verdicts recorded in
  §"Spike verdicts" above. If V1 falls back to the seam-extract option, the seam change is
  in this slice's diff.
- [ ] 2. `apps/worker/test/preview-gate.worker.test.ts` exists; `pnpm test:worker` discovers
  it under the `workers` project.
- [ ] 3. **Step (a) — gate routing + SPA fallback.** With installation `complete`, GET
  `/setup`, `/`, `/mailbox/:mailboxId`, `/admin/audit-events`, etc. → 200 +
  `Content-Type: text/html`. `run_worker_first: ["/api/*"]` precedence holds: a request to
  `/api/v1/anything` reaches the router, never the SPA shell.
- [ ] 4. **Step (b) — complete setup + authenticate.** POST `/api/v1/setup/complete` with
  `INSTALLATION_TOKEN` + Idempotency-Key + valid `administrator` body → asserts
  `installation_state.status = 'complete'`, `seedRolesAndPermissions` ran (21 permissions,
  administrator role holds all 21, member role holds the 5 documented perms — D-CAP-044-N
  proof), audit row `setup.complete` emitted. Then POST `/api/v1/auth/login` → asserts
  session cookie set + actor reads `audit.read` from `user_roles`.
- [ ] 5. **Step (c) — inbound, read, reply, provider/webhook.** Drive
  `entrypoints/inbound-email.ts`'s default export with a Cloudflare Email Routing-shaped
  `message` stub; assert message persists with `thread_id`. POST
  `/api/v1/mailboxes/:mailboxId/messages/send`; assert queue producer fires. Drive
  `entrypoints/queue.ts`'s default export with a structurally-stubbed `MessageBatch` (per
  V1's verdict); assert the adapter's `send` was called with `sender`/`to`/`subject` and
  `X-Idempotency-Key` header equals the message id; assert `provider_message_id`
  round-trip into D1. In live mode (BREVO_API_KEY set) the fetch spy captured the call; in
  skip mode the suite asserts the code-path shape and the runbook Step 4 covers the wire.
- [ ] 6. **Step (d) — retry/replay + unauthorized + early webhook + queue recovery.**
  - 6a: replay the same Idempotency-Key → 200 with identical body (R-OUTBOUND-004).
  - 6b: member token + `GET /api/v1/admin/audit-events` → 403 PERMISSION_DENIED.
  - 6c: drive `POST /api/v1/webhooks/:providerKey/:connectionId` with a valid signature
    BEFORE the send completes (no `provider_message_id` yet) → assert `webhook_deliveries`
    row persisted with `status = 'pending'` (D-CAP-040-A — early webhook durable retention),
    and the subsequent queue-handler run reconciles the row.
  - 6d: drive the queue handler with an adapter that throws → assert `msg.retry()` was
    called (NOT `msg.ackAll()`), `outbound_jobs.attempts` incremented, error recorded.
- [ ] 7. **Step (e) — audit correlation + log redaction.** After every transition in steps
  (b)–(d), query `GET /api/v1/admin/audit-events?actorUserId=...&resourceId=...` through
  `SELF.fetch`. For each action, collect the `(action, expectedRequestId, actualRequestId
  |null)` triple into a `deferredRows` accumulator. Assert
  `deferredRows.map(r => r.action)` equals EXACTLY the six named actions missing request_id
  today (`message.compose`, `mailbox.create`, `mailbox.assign`, `blocklist.add`,
  `blocklist.remove`, `role_policy.update` — names confirmed against the audit emit-points
  inventory). Closure ledger gets machine-readable entries from this accumulator.
  Log redaction: scan captured `console.error/warn/info` lines for forbidden patterns
  `/(password|salt|hash|credential|secret|token|inReplyTo|references|body|cookie)/i`.
  Any hit fails the test with the offending line. Asserts absence only.
- [ ] 8. **Step (f) — repeat deploy no-op (harness-side).** Run `computePendingMigrations`
  (from `scripts/deploy.ts`) twice against the same `d1_migrations` content; assert the
  second run's `pending` set is empty. Assert the suite's state from steps (b)–(e) is still
  readable after the second run. The real Cloudflare second-deploy is the runbook's Step 7.
- [ ] 9. **Mode gate.** Every step gated on `process.env.BREVO_API_KEY?.trim()` (NOT bare
  truthy check). When unset: `console.warn('[CAP-045] BREVO_API_KEY unset — wire-shape
  assertions skipped; runbook Step 4 covers the live verification')` + `it.skip()` for
  live-HTTP-dependent sub-assertions. When set: all sub-assertions run.
- [ ] 10. Doctor check 14 — `preview-gate-suite-present` — exists, is wired into the
  `checks` array, exits 0. Pure evaluator
  `evaluatePreviewGateSuitePresent({ fsRead })` takes a filesystem accessor for
  testability; asserts the suite file exists, the helper exists, the runbook exists, and
  the suite file does NOT contain forbidden patterns (`vi.mock('cloudflare:test')` or
  `mockResolvedValue` on `db.prepare`).
- [ ] 11. Operator runbook `work/reviews/CAP-045-preview-runbook.md` exists with seven
  steps in execution order, each capturing: command(s), expected output shape, evidence-
  folder path (with operator + date suffix — no shared folder), explicit "this step
  proves X that the harness cannot" annotation. Includes `<DEPLOYED_WORKER_URL>`
  placeholder and the second-terminal instruction for `wrangler tail`.
- [ ] 12. `scripts/send-test-brevo.ts` exists, ≤50 lines, fetch POST to
  `https://api.brevo.com/v3/smtp/email` using `BREVO_API_KEY` from env, with `--to` and
  `--templateId` flags.

### Gates (orchestrator-run subset)

- [ ] 13. `pnpm scaffold doctor` 14/14 (was 13/13).
- [ ] 14. `pnpm typecheck` clean.
- [ ] 15. `pnpm lint` clean.
- [ ] 16. `pnpm test:unit` all green — count grows by the new doctor test.
- [ ] 17. `pnpm test:worker` — 4 documented D-CAP-042 failures unchanged; the new suite's
  queue-handler / SPA-fallback / setup / audit-correlation / log-redaction sub-assertions
  RUN; live-mode sub-assertions skipped with the documented warn when key unset.
- [ ] 18. `pnpm build` EXIT=0.

### Closure (operator-driven, NOT orchestrator-runnable)

- [ ] 19. Operator runs `pnpm scaffold deploy --environment=preview`, captures
  `.cloudflare-resources.json` + the deploy URL, runs runbook Steps 1–7, drops evidence
  into `work/reviews/CAP-045-evidence-<OPERATOR>-<YYYY-MM-DD>/`, and pastes the
  `pnpm test:worker` output back into the ledger row's evidence section.

## File ownership

| File | Owner |
|---|---|
| `work/active/CAP-045-preview-verification/task.md` | Orchestrator (this contract) |
| `apps/worker/test/preview-gate.worker.test.ts` | `implementer-cap045` (NEW, runs V1+V2+V3 spikes first) |
| `apps/worker/src/queue-fetch-spike.worker.test.ts` | `implementer-cap045` (NEW, deleted after V2 verdict) |
| `scripts/send-test-brevo.ts` | `implementer-cap045` (NEW) |
| `scripts/doctor.ts` (new check 14 wired in) | `implementer-cap045` |
| `scripts/doctor.test.ts` (NEW test file for check 14) | `implementer-cap045` (NEW) |
| `work/reviews/CAP-045-preview-runbook.md` | `implementer-cap045` (NEW) |
| `docs/rebuild/capability-ledger.md` (CAP-045 row, deferred rows) | Orchestrator (closure) |
| `docs/rebuild/implementation-log.md` (closure entry) | Orchestrator (closure) |

## Review surface (5-way, parallel after implementer COMPLETE)

| Reviewer | Focus |
|---|---|
| `architecture-reviewer` (web-architect) | Did the implementer honor V1/V2/V3 spike verdicts? Suite entrypoint coverage? Miniflare-vs-Cloudflare drift? Runbook "harness cannot prove X" mapping honest? Deferred-rows accumulator list matches emit-point inventory? |
| `code-reviewer` (typescript-code-reviewer) | Test-craft: flaky-test risk, fetch-mock correctness, console-spy race conditions, beforeEach/afterEach isolation, queue-handler MessageBatch construction. |
| `security-reviewer` | Log assertion scope (regex catches every forbidden pattern?). Audit-row correlation correctness. Credential handling (suite never logs/echoes `BREVO_API_KEY`?). |
| `qa-reviewer` | AC traceability — every AC mapped to at least one `it()`. 4 documented worker failures still pass at baseline. Runbook commands work against current `scripts/deploy.ts` + `wrangler` CLI. |
| `frontend-reviewer` | **Not applicable** — no `apps/web/` changes this slice. Documented in this contract. |

After review, single-implementer fix pass on the consolidated criteria; then closure.

## Exit-criteria mapping (execution-plan.md:132-142)

| Execution-plan exit criterion | Where it lands |
|---|---|
| Recorded deployment URLs / config checks | Runbook Step 1 + operator evidence |
| Real inbound email | Runbook Step 4 + suite step (c) |
| Real provider reply | Runbook Step 5 + suite step (c) |
| Queue / crash recovery | Suite step 5d + runbook Step 6 |
| Audit trail | Suite step (e) (correlation + accumulator) |
| Second deploy | Runbook Step 7 + suite step (f) |

## Risks + open questions

- **V1 verdict may force a `handleQueueMessage` seam extraction** in `entrypoints/queue.ts`.
  One-line production change; lives in this slice's diff with its own review.
- **V2 verdict may force dropping the per-test fetch spy**, in which case live-mode is the
  only mode that proves wire shape. Acceptable per closure form.
- **D-CAP-044-N (upgrade-path re-seed)** lives in step (b) as a precondition. The suite's
  21-permission count assertion IS the proof the deferred row matters.
- **The six deferred-rows captured from step (e) may not be stable** — every code change
  that touches an emit point can add or remove an entry. The test asserts the EXACT list;
  a new entry surfaces as a deliberate diff in the test output. This is by design: silent
  green would hide regressions.

## Out of scope (deferred rows recorded at closure)

- **D-CAP-046-A** — Audit `request_id` correlation at six named call sites (compose.ts:262,
  mailboxes.ts:168, admin-blocklist.ts:121+232, admin-role-policies.ts:144,
  complete-setup.ts:72). Machine-readable from the suite's deferred-rows accumulator.
- **D-CAP-046-B** — Six standalone audit writes (compose.ts, webhooks.ts webhook_secret.reveal,
  inbound-email.ts:177, complete-setup.ts:72, claim-setup.ts:80) — crash-window gaps where
  the audit row runs AFTER the business write, not in the same D1 batch.
- **D-CAP-046-C** — `entrypoints/queue.ts` `msg.ack()` / `msg.retry()` direct coverage.
  Worker-pool currently tests `processOutboundJob`, not the queue handler's call sites
  (V1 may close this via the seam-extract fallback).
- **D-CAP-046-D** — Browser hydration evidence (TanStack Query hydration on /setup, /mail/*,
  /admin/*) — operator-runbook only.
- **D-CAP-046-E** — Real Cloudflare deploy execution (operator-only).
- **D-CAP-046-F** — Real email provider sign-up + domain verification + SPF/DKIM/DMARC
  publication (operator-only).
- **D-CAP-046-G** — `entrypoints/scheduled.ts` direct coverage. The CAP-045 gate exercises
  the cron entrypoint only via the queue-recovery path; the maintenance-job cron
  (`runMaintenanceJobs`, `purgeExpiredIdempotencyRecords`) is not invoked from the
  worker-pool suite. Reuse the V1 MessageBatch seam pattern (or a stubbed
  `ExecutionContext.waitUntil`) when this lands.
- **D-CAP-046-H** — Blocklist-rejection path on inbound mail (R-INBOUND-005). The CAP-045
  gate proves the audit chain when a blocklist decision is recorded, but does NOT drive
  the inbound-mail entrypoint with a from/subject/content match that returns 4xx to the
  relay. Belongs in a future capability alongside the remaining inbound-mail smoke paths.

(Names provisional; orchestrator renames against the next capability's task ID.)
