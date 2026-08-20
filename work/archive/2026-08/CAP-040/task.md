# CAP-040 — Webhook + Audit Reliability

> The shared contract for this capability. Every agent working on it reads this file first.

**Phase:** 2 · **Status:** Implemented · **Started:** 2026-08-20

## Goal

Make the webhook receiver, the audit_events table, and the admin secret surface
durable and tamper-evident: every status transition produces an atomic audit
row, every early provider event is reconciled to a canonical message once the
outbound provider id is known, and webhook signing secrets never leave a
reveal-only admin endpoint.

## Scope

- Webhook secret boundary: the admin list endpoint stops returning
  `webhook_secret` material; a new reveal endpoint replaces it and writes an
  audit row per call (R-SECRET-003 closure).
- Early-event reconciliation: a webhook delivered before the consumer has
  written `provider_message_id` to `outbound_jobs` is persisted with
  `message_id = NULL`, then back-filled by the consumer once the provider id
  is known (R-INBOUND-SIGNATURE + R-MESSAGE-007 + reality-audit HIGH-1).
- Atomic status/audit writes: the messages UPDATE, the
  `webhook_deliveries` INSERT, and the `audit_events` INSERT run in one
  D1 batch — a crash between them cannot leave an unaudited transition
  (D-CAP-029-A closure).
- Correlation IDs: every audit row carries the request_id the request-id
  middleware stamped on the inbound request, so the audit row can be
  cross-referenced with logs and traces.
- Closed `auditActionSchema` enum with two new entries
  (`webhook_delivery.reconcile`, `webhook_secret.reveal`) plus the missing
  CAP-035 entry (`role_policy.set`) so the closed enum is complete.

## Out of scope

- CAP-045 preview-deploy evidence — Phase 0/1 delivery verification
  reopens; CAP-045 owns the preview gate.
- Idempotency-key dedupe on the webhook receiver — Brevo retries are
  at-least-once; the current delivery row has no UNIQUE constraint on
  provider-supplied event id. Tracked as D-CAP-040-LOW-1.
- TTL purge of `webhook_deliveries` rows — the table grows by one row
  per received event; a daily cron for TTL is a follow-up. Tracked as
  D-CAP-040-A.
- Body-size enforcement on the webhook receiver — webhook payloads are
  exempt from the 1 MB cap (D-CAP-031-A); the route does not currently
  cap by Content-Length. Tracked as D-CAP-040-LOW-4.

## Business rules

| Rule ID | What it means for this slice |
|---|---|
| `R-SECRET-003` | Webhook signing secret is never returned by the list endpoint. Only the explicit reveal endpoint may return it, and only after writing `webhook_secret.reveal` to `audit_events`. |
| `R-AUDIT-001..004` | Every state transition writes an `audit_events` row. The action code is a closed enum (`auditActionSchema`). The audit row lives in the same D1 batch as the business write. |
| `R-MESSAGE-007` | When a webhook arrives before the consumer has written `provider_message_id` to `outbound_jobs`, the delivery row is persisted with `message_id = NULL` and reconciled back once the id is known. |
| `R-INBOUND-SIGNATURE` | Signature verification runs before JSON parse. The reconciliation lookup does not weaken this — the audit row for the inbound event is written before reconciliation. |
| `R-LOG-001` | Logs carry request id and job id only — no message bodies, no provider payloads, no secrets. |
| `R-AUTHZ-004` | `findJobByProviderMessageId` (CAP-029 H1) and the new reconciliation lookup (`findUnmatchedDeliveriesByProviderMessageId`) both require `connectionId` — provider_message_id alone would let one tenant back-fill another tenant's row. |
| `R-AUTHZ-002` | Authorization checks hit the database per request; the admin permission for the reveal endpoint is `provider.sync`. |

Source: `docs/rebuild/02-business-discovery/business-rules.md`.

## Acceptance criteria

- [x] 1. The admin list endpoint `/api/v1/admin/connections` returns
       `webhookConfigured` (boolean) and `webhookUrl` — never `webhookSecret`.
- [x] 2. A new admin endpoint
       `POST /api/v1/admin/connections/:id/webhook-secret/reveal` returns the
       signing key for one connection, requires `provider.sync`, and writes a
       `webhook_secret.reveal` audit row whose metadata carries
       `{connectionId, providerKey}` only.
- [x] 3. Every webhook POST that succeeds writes one `webhook.delivered`
       audit row in the same D1 batch as the messages UPDATE and the
       webhook_deliveries INSERT (D-CAP-029-A).
- [x] 4. If any statement in the batch fails (NOT NULL violation, FK
       mismatch, etc.) the entire batch rolls back — zero of the three
       writes are visible.
- [x] 5. The audit row carries the request correlation UUID stamped by the
       request-id middleware.
- [x] 6. A webhook that lands before the consumer writes
       `provider_message_id` is reconciled back once the consumer writes
       the id; the reconciliation is idempotent (a second pass finds no
       unmatched rows for the same `provider_message_id`).
- [x] 7. The reconciliation emits an audit row
       (`webhook_delivery.reconcile`) with `connectionId`,
       `providerMessageId`, `backfilled`, and `backfilledIds` in metadata.
- [x] 8. The reconciliation runs even when a reclaim stole the lock
       mid-send (the `jobAdvanced = false` path) — the canonical
       `providerMessageId` from `adapter.send()` is enough to back-fill,
       and an orphan `webhook_deliveries` row must not be left
       unreconciled.
- [x] 9. The Drizzle schema for `webhook_deliveries` declares the
       STORED generated column `provider_message_id` (typing only — the
       SQL migration owns the real column).
- [x] 10. `packages/contracts/src/admin/audit.ts` declares the closed
        `auditActionSchema` with the existing CAP-026/027/029/035 entries
        plus the two new CAP-040 entries; the repository-level
        `AuditEventInput` uses the closed enum (no `action: string`).
- [x] 11. `.claude/rules/architecture.md` documents the
        `outbound-mail → admin` WRITE seam (CAP-040 cross-module writer)
        alongside the existing inbound-mail READ seams.

## Vertical slice

Layers this touches, in dependency order:

- [x] contract schema — `packages/contracts/src/admin/audit.ts` (NEW: `AuditAction`, `AuditEventInput`, `AuditEventWriter`, `D1StatementLike`)
- [x] migration — `migrations/0013_webhook_delivery_message_index.sql` (+ `.verify.sql`); STORED generated column + composite index
- [x] repository — `apps/worker/src/database/schema/outbound-mail.ts` (Drizzle column declaration added)
- [x] repository — `apps/worker/src/modules/outbound-mail/webhook-repository.ts` (FIND already correctly scoped to `connectionId`; verified by reviewer)
- [x] use case — `apps/worker/src/modules/outbound-mail/reconcile-webhook-deliveries.ts` (NEW)
- [x] use case — `apps/worker/src/modules/outbound-mail/process-outbound-job.ts` (reconciliation call gated on `providerMessageId` presence, not `jobAdvanced`)
- [x] composition — `apps/worker/src/modules/admin/audit-event-writer.ts` (NEW); `apps/worker/src/app-context.ts` (wires writer into AppContext)
- [x] repository — `apps/worker/src/modules/admin/audit-event-repository.ts` (`action` typed as closed `AuditAction`)
- [x] route — `apps/worker/src/http/routes/webhooks.ts` (audit statement folded into D1 batch)
- [x] route — `apps/worker/src/http/routes/admin-webhooks.ts` (list omits secret; new reveal endpoint with audit)
- [x] rule — `.claude/rules/architecture.md` (outbound-mail → admin WRITE paragraph)
- [x] tests — `apps/worker/src/http/routes/webhooks.worker.test.ts` (atomic batch + contrapositive failure-injection test); `apps/worker/src/http/routes/admin-webhooks.worker.test.ts` (reveal happy/404/401/403)

New module dependency edges introduced: `outbound-mail → admin` (WRITE seam, via `packages/contracts`). The seam is the WRITE counterpart to the existing inbound-mail → admin READ seams (BlocklistReader, RolePolicyReader).

## Delivery path

`HTTP POST /api/v1/webhooks/:providerKey/:connectionId` (Brevo)
→ `http/routes/webhooks.ts` (HMAC verify → parse → resolve messageId)
→ `modules/outbound-mail/webhook-processor.ts` (UPDATE messages + INSERT webhook_deliveries)
→ `app-context.ts` → `audit-event-writer.ts` (audit statement)
→ D1 batch (all three writes atomic)
→ `200 { data: { ok: true } }`

`HTTP POST /api/v1/admin/connections/:id/webhook-secret/reveal` (operator dashboard)
→ `http/routes/admin-webhooks.ts` (requirePermission('provider.sync'))
→ `getWebhookSecretForConnection(db, connectionId)` (single-row lookup, connection-scoped)
→ `createAuditEvent(...)` (standalone emit, outside batch — secret reveal is a separate transaction from the read)
→ `200 { data: { id, providerKey, label, webhookSecret } }`

`queue.ts` → `processOutboundJob` → after `markOutboundJobSent` (or any path that yields a `providerMessageId`)
→ `reconcileWebhookDeliveries(db, {connectionId, providerMessageId, messageId, ...})`
→ D1 batch (per-row back-fill UPDATEs + audit row) — best-effort wrapper logs `outbound.reconcile_failed` on failure

- Build/runtime configuration touched: none (no `wrangler.jsonc` changes; new
  binding `AuditEventWriter` is wired into `app-context.ts`, not declared
  in wrangler).
- Fresh-deploy evidence required: yes — `pnpm build` exits 0; wrangler
  `dry-run` output is recorded in §Gates.
- Repeat-deploy/idempotency evidence required: no — the migration is a
  single `ALTER TABLE ... ADD COLUMN ... GENERATED ALWAYS AS ... STORED`
  plus an idempotent `CREATE INDEX IF NOT EXISTS`, both replay-safe.

## Reference implementation

None. No external code was adopted for this capability; the seams mirror
the existing `BlocklistReader` / `RolePolicyReader` (CAP-029 inbound-mail
→ admin) pattern.

## File ownership

One writer per file. Reading anything is fine; writing outside your list is not.

| Agent | Owns |
|---|---|
| implementer (CAP-040) | All paths below |

## Reading list

- `CLAUDE.md`
- this file
- `.claude/agents/implementer.md`
- `.claude/rules/architecture.md`
- `.claude/rules/security.md`
- `.claude/rules/testing.md`
- `.claude/rules/reference-implementations.md`
- `docs/rebuild/02-business-discovery/business-rules.md` (R-AUDIT-*, R-SECRET-*, R-INBOUND-SIGNATURE, R-MESSAGE-007, R-AUTHZ-004)
- `docs/rebuild/09-decisions/ADR-002-outbound-provider-registry.md`
- `docs/rebuild/09-decisions/ADR-004-idempotency.md`

## Dependencies

- Requires: CAP-039 (deployment substrate) — Implemented (closed 2026-08-20)
- Requires: CAP-029 (webhook receiver) — Implemented
- Blocks: CAP-044 (compose/reply and admin surfaces)
- Closes: D-CAP-029-A (atomic status/audit batch), D-CAP-029-B (request-id
  propagation into audit row)

## Decisions made during this capability

**D1 — Closed `auditActionSchema` enum, not open `string`.**
The audit action vocabulary is a closed set; adding a value is a deliberate
change. The seam declares `auditActionSchema` (zod enum) + the derived
`AuditAction` union. The repository-level `AuditEventInput` re-imports
`AuditAction` so the closed set lives in one place; calls that pass
untyped strings fail at typecheck. The closed-enum typing surfaced the
missing `role_policy.set` entry (CAP-035) — added to the enum during this
capability.

**D2 — Cross-module WRITE seam mirrors the existing READ seams.**
The outbound-mail route layer must fold an `audit_events` INSERT into the
same D1 batch as the messages UPDATE and `webhook_deliveries` INSERT
(D-CAP-029-A). The seam (`AuditEventWriter` interface in contracts,
implementation in `apps/worker/src/modules/admin/audit-event-writer.ts`,
wired in `app-context.ts`) is the WRITE counterpart to `BlocklistReader`
/ `RolePolicyReader`. Same composition-root pattern. Architecture rule
updated to document the parallel.

**D3 — STORED generated column over raw expression index.**
`provider_message_id` is `GENERATED ALWAYS AS
(json_extract(raw_payload, '$.messageId')) STORED` rather than a
`CREATE INDEX ... (json_extract(raw_payload, '$.messageId'))`. The
STORED column is inspectable in Drizzle and admin views (no JSON
re-parsing at query time) and is indexable; the expression index works on
recent SQLite but is unreadable in the audit view. The composite index
uses `(provider_message_id, connection_id)` as the leading and trailing
columns so the reconciliation lookup is a single index seek AND the
trailing column enforces the `R-AUTHZ-004` connection scope.

**D4 — Reconciliation gates on `providerMessageId` presence, not on
`jobAdvanced`.**
The canonical `providerMessageId` from `adapter.send()` is real whenever
the adapter reports success — even when a reclaim stole the lock
mid-send and `markOutboundJobSent` is a no-op (the divergence path).
Skipping reconciliation on the no-op path would orphan any
`webhook_deliveries` row that landed with `message_id = NULL`
(early-event case). The reconciliation is idempotent: a second pass
finds no unmatched rows for the same `provider_message_id`. (Was review
finding D-CAP-040-ARCH-H1.)

## Open questions

None. CAP-040 is closed; D-CAP-040-A (TTL purge) and D-CAP-040-LOW-1..6
are recorded as follow-ups.