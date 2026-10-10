# CAP-050 — Attachment consume/send integration

> Local-only backend capability. CAP-049 stages binary bytes in the existing `CACHE` KV namespace;
> CAP-050 consumes those uploads during compose send and reconstructs them in the outbound queue.

**Phase:** 3 · **Status:** Implemented · **Started:** 2026-08-29 · **Closed:** 2026-08-29

## Goal

An authorized sender can attach one or more CAP-049 uploads to a composed message, with the upload
metadata and lifecycle transition committed atomically with the message and outbound job.

## Scope

- Add `attachmentUploadIds` to the compose request contract (maximum 10, unique UUIDs).
- Add the Messages-owned `message_attachments` table and migration 0022.
- Consume live, authorized CAP-049 uploads atomically with compose message creation.
- Keep attachment bytes in the existing `CACHE` KV namespace; read them through a platform byte-store
  seam in the queue consumer and pass provider-neutral attachments to the adapter.
- Add closed `attachment.consumed` audit events and race/rollback/no-write coverage.

## Out of scope

- R2 migration, presigned URLs, a second KV namespace, or deployment.
- Attachment download/render routes, CID rewriting, scheduled cleanup, or UI/client changes (CAP-051).
- Provider-specific attachment logic outside the existing adapter boundary.
- Changing the temporary CAP-049 5 MiB local KV cap to the roadmap's future R2 limit.

## Business rules

| Rule ID | What it means for this slice |
|---|---|
| `R-ATTACHMENT-001` | Each upload can be related to one message only. |
| `R-ATTACHMENT-002` | A message accepts at most 10 attachment upload IDs. |
| `R-ATTACHMENT-005` | Only a live `uploaded` upload with matching CACHE bytes can be consumed. |
| `R-ATTACHMENT-006` | Upload consumption is atomic with message creation. |
| `R-AUTHZ-003` / `R-AUTHZ-004` | Global send permission and target-mailbox/owner checks both apply; no IDOR. |
| `R-OUTBOUND-004` / `R-OUTBOUND-005` / `R-OUTBOUND-006` | Provider idempotency, request idempotency, and queued-job writes remain durable and atomic. |
| `R-OUTBOUND-007` / `R-OUTBOUND-008` | Queue processing remains claim/retry safe when attachment bytes are unavailable. |
| `R-AUDIT-001` | Every consumed upload produces one correlated `attachment.consumed` audit row in the same batch. |
| `R-SECRET-003` / `R-LOG-001` | Attachment bytes, filenames used as sensitive data, credentials, and idempotency material are not logged or returned. |
| `R-DATA-004` | SQL is parameterized and schema-level ownership/metadata guards reject invalid relations. |

Source: `docs/rebuild/02-business-discovery/business-rules.md`, the CAP-049 temporary KV contract,
and `docs/rebuild/05-target-architecture/data-model.md`.

## Acceptance criteria

- [x] 1. Compose without attachments preserves the existing 202/idempotency/queue behavior.
- [x] 2. A valid staged upload creates exactly one `message_attachments` row, transitions the upload to `consumed`, writes one message audit plus one attachment audit, and enqueues one job.
- [x] 3. Multiple uploads preserve canonical D1 metadata and inline/attachment disposition.
- [x] 4. Duplicate IDs and more than 10 IDs fail validation before writes.
- [x] 5. Missing, foreign, expired, consumed, KV-missing, and size-mismatched uploads return one stable unavailable envelope with no D1/KV/queue side effects.
- [x] 6. Same-key replay and concurrent same-key requests produce one message, relation set, job, audit set, idempotency row, and queue submission.
- [x] 7. Different-key reuse of one upload cannot consume it twice; D1 UNIQUE and trigger guards are independently exercised.
- [x] 8. Cross-owner direct relation attempts are rejected by the migration trigger, even when all client-visible metadata matches.
- [x] 9. A deterministic D1 failure rolls back all message, relation, upload, job, audit, and idempotency writes; staged KV bytes survive.
- [x] 10. Queue processing reads exact binary bytes through `AttachmentByteStore` and constructs the provider-neutral attachment payload; Brevo encodes each attachment once.
- [x] 11. Migration verification, contracts, unit, Worker, lint, typecheck, format, doctor, build, and diff checks pass locally.

## Vertical slice

- [x] migration — `migrations/0022_message_attachments.sql` and `.verify.sql`
- [x] repository — `apps/worker/src/modules/messages/attachment-consume-repository.ts`
- [x] route — `apps/worker/src/http/routes/compose.ts`
- [x] contract schema/audit — `packages/contracts/src/index.ts`, `packages/contracts/src/admin/audit.ts`
- [x] platform seam — `apps/worker/src/platform/cache.ts`
- [x] queue/outbound — `apps/worker/src/entrypoints/queue.ts`, `apps/worker/src/modules/outbound-mail/process-outbound-job.ts`
- [x] tests — `apps/worker/src/http/routes/compose-attachments.worker.test.ts` and contract/migration updates

New module dependency edges introduced: none; all imports follow the architecture dependency table.

## Delivery path

`POST /api/v1/mailboxes/:mailboxId/messages/send` → compose route authorization/validation → Messages
preflight and atomic D1 batch → `{ jobId }` on `OUTBOUND` → queue consumer reads D1 metadata and
`CACHE` bytes → provider adapter send.

- Build/runtime configuration touched: existing queue wiring only; no new binding.
- Fresh-deploy evidence required: no; deployment is deferred.
- Repeat/idempotency evidence required: yes; replay, same-key race, cross-key collision, and rollback tests pass.

## Reference implementation

None. The implementation adapts the existing CAP-027 compose/idempotency batch, CAP-046 audit writer,
and CAP-049 `AttachmentByteStore` seam.

## File ownership

| Agent | Owns |
|---|---|
| Claude Code | CAP-050 source, migration, schema, contract, test-kit, and focused test files |
| Codex | Review, gates, ledger/log updates, archive, and final commit |

## Dependencies

- Requires: CAP-049 — Implemented locally with existing CACHE KV staging.
- Blocks: CAP-051 — Attachment download/render and scheduled cleanup.

## Decisions made during this capability

- Keep bytes in the one existing `CACHE` namespace for local development; R2 remains untouched.
- Bind ownership and canonical upload metadata into the D1 consume trigger in addition to route preflight.
- Treat same-key races as stored-response replay and different-key reuse as a stable unavailable-upload response.

## Open questions

- Production migration from the temporary 5 MiB CACHE policy to the roadmap's R2/64 MiB design remains
  a later deployment decision and is not part of CAP-050.
