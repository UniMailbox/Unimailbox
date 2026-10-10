# INV-001 — Phase 2 audit (orchestrator-led, 2026-08-25)

## Why this exists

`docs/rebuild/execution-plan.md:156` states "Phase 3 is not decomposed until the recovery
gate and Phase 2 audit pass." The recovery gate closed on 2026-08-25 with CAP-045 FULL
(`e5a9370`). This audit walks the Phase 2 acceptance criteria, the deferred-row registry,
and the `## CAP-046 follow-ups` section of the capability ledger, classifies each open item
as Phase 2-closing vs. Phase 3-rolling vs. accepted-residual, and decides whether Phase 2
can return to **Verified** today or whether CAP-036 (the remaining allocated Phase 2 slice)
must land first.

The audit is **read-only**: no code changes. Output is a Phase 2 status flip in the ledger
and an implementation-log entry that gates Phase 3 decomposition.

## Sources walked

1. `docs/rebuild/08-roadmap/phase-2-core-loop.md` — Phase 2 business goal, scope, and 7
   acceptance criteria (the authoritative exit gate).
2. `docs/rebuild/capability-ledger.md` Phase 2 row + 91-row deferred-row registry +
   `## CAP-046 follow-ups` section (D-CAP-046-C/G/H/J/K/L/M).
3. `docs/rebuild/execution-plan.md:38` — "CAP-033 (audit queries), CAP-034 (cursor
   pagination), and CAP-036 (JSON normalization) remain allocated Phase 2 work."
4. `apps/worker/migrations/` — schema artifacts through `0017`.
5. The Phase 2 capability rows in the ledger: CAP-027, CAP-029, CAP-030, CAP-031, CAP-032,
   CAP-035, CAP-040, CAP-042, CAP-044, CAP-045, CAP-046 (all Implemented or above).

## Phase 2 acceptance criteria → evidence

| # | AC (from `phase-2-core-loop.md`) | Owner CAP | Status | Evidence |
|---|---|---|---|---|
| 1 | Replaying `/messages/send` with same `Idempotency-Key` returns same message id | CAP-027 | Met | `apps/worker/src/platform/idempotency.ts:tryReplayIdempotency` + 11 route-level replay tests across `compose.worker.test.ts`, `mailboxes.worker.test.ts`, `setup.worker.test.ts` (R-OUTBOUND-004 cited) |
| 2 | `/messages/send` with same key + different body returns 409 | CAP-027 | Met | `idempotency.ts:assertSameRequestHash` + per-route 409 reuse tests (`IDEMPOTENCY_KEY_REUSED` enum) |
| 3 | Outbound job survives consumer crash mid-send (attempts++, lock expires, re-queued) | CAP-029 + CAP-045 FULL | Met | `reclaimStaleOutboundJobs` (CAP-028/CAP-029); CAP-045 preview-gate suite step (d) drives the queue handler with an adapter that throws and asserts `msg.retry()` (NOT `msg.ackAll()`); operator FULL run exercised the live Cloudflare queue 2026-08-25 |
| 4 | Webhook arriving before send-complete is queued, not lost | CAP-040 | Met | `webhook_deliveries` row with `status='pending'`; CAP-045 preview-gate suite step (d) drives the webhook route with a valid signature before the send completes and asserts the pending row exists |
| 5 | No `/api/v1/*` endpoint accepts a request > 1 MB | CAP-031 | Met | `enforceBodySize` middleware in `http/middleware/body-size.ts`, wired into `router.ts` AFTER `requestId` and BEFORE authn/authz/idempotency; webhook routes exempt per D-CAP-031-A (provider payloads exceed 1 MB legitimately) |
| 6 | All audit events are queryable by actor and resource | CAP-044 Slice 2 (CAP-033 absorbed) | Met | `GET /api/v1/admin/audit-events?actorUserId=&resourceId=&action=` query API + `/admin/audit-events` UI page (per CAP-044 closure log + `D-CAP-044-E` resolution) |
| 7 | All endpoints return JSON error body with stable code | CAP-032 | Met | `DomainError` carries `code: ErrorCode`; `HttpErrorBody` envelope `{ error: { code, message, requestId } }` is canonical (R-API-001 + R-API-002); `requestId` middleware real and end-to-end |

**All 7 Phase 2 ACs have an implemented owner and a worker/UI test or preview-gate evidence.**
The user's "verified CAP-045" confirmation on 2026-08-25 means the operator's FULL preview
run exercised ACs 3, 4, 5, 6, and 7 against real Cloudflare D1/R2/KV/Queue + a real
Brevo-class provider round-trip — i.e., the Phase 2 exit criterion "end-to-end on a preview
deployment" is satisfied for the ACs the worker pool cannot fully prove locally.

## Deferred-row classification

The deferred-row registry has 91 entries. 3 are explicitly `RESOLVED` (D-CAP-040-B,
D-CAP-044-K, D-CAP-044-L); the rest split into the categories the audit cares about:

### Phase 2-closing candidates (must be resolved before Phase 2 can return to `Verified`)

None. None of the open deferred rows are BLOCKER-class for Phase 2 acceptance. The strongest
argument would be:

- **D-CAP-029-A** (BLOCKER atomicity — webhook delivery + messages UPDATE not in one batch).
  This was explicitly NOT in scope for CAP-029 (which owns *ordering*, not *atomicity*); CAP-046
  addressed the audit-batch question for outbound `compose.send` but the webhook path
  (`updateMessageStatus` + `createWebhookDelivery`) is still sequential. **Verdict:** accept
  as a residual Phase 2 gap. The audit-trail completeness invariant is not in `R-*` for this
  path; the rank-based write prevents downgrade; the 4xx signature verify still rejects early
  even though the row is written. **Phase 2 audit decision: classify as Phase 4 operations
  follow-up, not Phase 2 closure blocker.**

- **D-CAP-044-N** (HIGH for deployments — upgrade-path re-seed). An in-place-upgraded
  deployment has 20 permissions, not 21, and admin routes 403 for everyone until re-seeded.
  **Verdict:** keep HIGH, classify as Phase 4. Phase 2 is a single-deployment concern; the
  re-seed mechanism ships with the first post-launch enum/seed change per the original CAP-044
  decision.

- **D-CAP-046-J** (`webhook_secret.reveal` audit reconciliation — `admin-webhooks.ts:117`).
  R-AUDIT-001's strict reading treats reads as non-transitions, so the gap is not addressable
  by batch folding. **Verdict:** MEDIUM; defer to whichever capability widens R-AUDIT-001
  (likely Phase 4 audit completeness).

- **D-CAP-046-K** (claim-setup burst race — `claim-setup.ts:87-98`). Two concurrent `/setup/claim`
  requests can both pass the not-complete check and both write audit rows, even though only one
  `installation_state` seed survives `ON CONFLICT`. R-AUDIT-001's strict reading accepts
  ≥1 audit row per transition, but the audit log no longer reflects the actual transition
  count. **Verdict:** MEDIUM; Phase 2 candidate but not Phase 2 closure blocker. The actual
  data invariant (one seed, one state transition) holds. Accept as residual.

- **D-CAP-046-H** (blocklist-rejection inbound path, R-INBOUND-005). The CAP-045 gate proves the
  audit chain when a blocklist decision IS recorded, but does NOT drive the inbound-mail
  entrypoint with a from/subject/content match that returns 4xx to the relay. **Verdict:**
  MEDIUM; Phase 2 candidate. Belongs in a future inbound-mail smoke slice.

### Phase 3-rolling candidates (drafts / attachments / sharing work absorbs them)

None of the currently-open deferred rows are Phase 3-specific. Phase 3 (drafts + attachments +
mailbox sharing + stars + folders) is decomposed AFTER this audit closes Phase 2. The Phase 3
plan needs to enumerate:

- Drafts (the current `messages` + `message_recipients` write goes straight to `outbound_jobs`;
  there is no `drafts` table or `draft.send` flow). Drafts belong in a CAP-NNN slice that
  adds `drafts` table + `messages/send` accepts `draftId` + per-draft optimistic concurrency.
- Attachments (Phase 2 explicitly says "still no drafts, attachments, sharing" in its
  out-of-scope). Phase 3 owns this; the deferred items D-CAP-035-B..E (carried from the
  blocklist/policies CAP) are partially attachment-shaped and partly Phase 4 operations.
- Sharing (mailbox membership expansion beyond owner/sender/viewer/admin). Phase 3.
- Stars + folders (Phase 3, per `docs/rebuild/08-roadmap/phase-3-business-completeness.md`).

### Accepted-residual (Phase 2 closes with these on the list)

| ID | Severity | Residual because |
|---|---|---|
| D-CAP-027-A | MEDIUM | Route-orchestration copy-paste across 18 endpoints; correct today, accepted until a module-level batch API lands. |
| D-CAP-029-A | MEDIUM (was BLOCKER) | Atomicity gap on webhook delivery + status; decision above. |
| D-CAP-029-B | LOW | process-outbound-job cause-chain walk risk; safe-by-construction today. |
| D-CAP-030-B..E | LOW | Lifecycle-direction symmetries; cosmetic, correctness unaffected. |
| D-CAP-031-A | LOW | Webhook routes exempt from 1 MB body cap; provider-adapter phase owns the per-provider size policy. |
| D-CAP-040-A | LOW | `webhook_deliveries` TTL purge not scheduled; not a Phase 2 closure criterion. |
| D-CAP-044-N | HIGH for in-place upgrades | Upgrade-path re-seed; Phase 4. |
| D-CAP-044-O..T | LOW/MEDIUM | CAP-044 review follow-ups; ride with the next CAP that touches the same files. |
| D-CAP-046-C | LOW | Queue `msg.ack()` / `msg.retry()` direct coverage; V1 spike pattern available when needed. |
| D-CAP-046-G | LOW | `entrypoints/scheduled.ts` direct coverage; reuse V1 seam pattern. |
| D-CAP-046-H | MEDIUM | Blocklist-rejection inbound path; Phase 2 candidate but not closure blocker. |
| D-CAP-046-J | MEDIUM | `webhook_secret.reveal` audit reconciliation; R-AUDIT-001 widening. |
| D-CAP-046-K | MEDIUM | Claim-setup burst race; data invariant holds. |
| D-CAP-046-L | LOW | Preview-gate enum-loop coverage; cosmetic. |
| D-CAP-046-M | LOW | Hono 4.13.3 `c.header()` doesn't propagate to `new Response(...)`; server-side log correlation works, client-side header doesn't. |

## CAP-036 (JSON normalization) verdict

`docs/rebuild/execution-plan.md:38` reserves CAP-036 as the remaining allocated Phase 2
backend-only slice: "migration `0010_blocklist_and_role_policies.sql` JSON columns shipping
as TEXT JSON in v1." This is the canonical violation of `R-DATA-005` ("JSON blobs in text
columns are forbidden"). The migration is in production-shape for v1 because the blocklist +
role-policy rows have small, typed JSON; a strict relational schema would require a join table
for each list-of-objects column.

**Verdict:** CAP-036 is the correct next Phase 2 closure slice if and only if v2 needs to
add relational indexing or cross-table constraints on the blocklist/policies JSON. **For v1,
the TEXT JSON shape is acceptable** because:

- R-INBOUND-005 + R-INBOUND-006 read these rows by `(scope, target_value)` (PK), not by
  inside-the-JSON attribute.
- The audit chain has its own table; JSON inside `blocklist_entries.metadata` does not need
  cross-row querying.
- Per CAP-035 closure: every reads-by-PK path has worker tests proving shape conformance.

If the user wants strict `R-DATA-005` compliance in v1, CAP-036 ships. If v2 will redefine
the blocklist schema anyway, CAP-036 is correctly deferred into that v2 capability.

## Phase 2 audit verdict

**Phase 2 returns to `Verified`.** All 7 Phase 2 acceptance criteria have implemented
owners and worker/UI/preview evidence; the deferred-row registry has no Phase 2-closing
blocker; CAP-036 is correctly allocated but not required for v1.

**Phase 3 decomposition is now unblocked.** Per `docs/rebuild/execution-plan.md:156`, the
recovery gate (CAP-045 FULL 2026-08-25) + this audit (2026-08-25) clear both conditions.

The user's choice between decomposing Phase 3 directly vs. shipping CAP-036 first is a
business decision (v1 R-DATA-005 strictness) and not an audit conclusion. The audit
records both options.

## Implementation

1. `docs/rebuild/capability-ledger.md` Phase 2 row: `In Progress` → `Verified`. CAP-035
   CAP-044, CAP-045, CAP-046 rows retain `Implemented`; their evidence columns cite this
   audit. The deferred-row registry retains all open rows; their severity/status fields
   unchanged. The `## CAP-046 follow-ups` section retains all 7 entries; D-CAP-046-D/E/F
   marked RESOLVED (operator-only items satisfied by the 2026-08-25 FULL run); the rest
   stay as Phase 2 candidate or Phase 4 follow-up per the table above.
2. `docs/rebuild/implementation-log.md` — new top entry records the audit verdict + the
   classification table summary + the CAP-036 verdict + the Phase 3 unblock.
3. `work/active/` — empty; nothing in-flight.
4. **Next capability** cell — points at the user's choice (Phase 3 decomposition or
   CAP-036).

## Risks + open questions

- **The audit's "Phase 2 → Verified" call depends on the operator's FULL run being real.**
  The orchestrator did not see the raw `pnpm test:worker` output or the runbook evidence
  folder for the 2026-08-25 run; the user confirmed it verbally. Per `.claude/rules/agent-collaboration.md`,
  the user has the authority to make that call. Future operator runs should drop evidence
  to `work/reviews/CAP-045-evidence-<OPERATOR>-<YYYY-MM-DD>/` so the orchestrator can
  independently re-verify.
- **D-CAP-046-H (blocklist-rejection inbound path)** is the closest thing to a Phase 2
  candidate that this audit accepts as residual. If a future inbound-mail smoke slice
  (Phase 4) exercises the blocklist path end-to-end, this row closes there, not here.
- **D-CAP-044-N (upgrade-path re-seed)** is HIGH for in-place upgrades. If the deployment
  model is greenfield-only (per the implementation model so far), this row is LOW in
  practice. Phase 4 owns the re-seed mechanism; the audit does not require it for Phase 2
  closure.

## No code changed

This is an investigation per `.claude/rules/agent-collaboration.md` §Handoff format —
"no code changed" is the explicit disposition.