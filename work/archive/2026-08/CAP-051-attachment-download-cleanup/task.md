# CAP-051 — Attachment download and local expiry cleanup

> Local-only backend slice. CAP-049 stages bytes in the existing `CACHE` KV namespace and CAP-050
> consumes them into `message_attachments`; this slice exposes an authorized download path and
> expires unconsumed upload metadata/bytes through the existing scheduled entrypoint.

**Phase:** 3 · **Status:** Implemented · **Started:** 2026-08-29 · **Closed:** 2026-08-29

## Goal

An authorized mailbox reader can download a consumed attachment, while expired unused uploads are
marked `expired` and their CACHE objects are removed by the scheduled job.

## Scope

- Add `GET /api/v1/mailboxes/:mailboxId/attachments/:attachmentId/download`.
- Authorize download with global `message.read` and mailbox-scoped `read`; collapse missing,
  foreign, soft-deleted, and inaccessible attachment/message states to one 404 envelope.
- Read canonical filename/content type/disposition/object key from Messages-owned D1 data and fetch
  exact binary bytes through the existing `AttachmentByteStore`; return safe content headers and no
  body/metadata in logs.
- Add an attachments expiry use case that lists expired `uploaded` rows, deletes their CACHE bytes,
  and atomically marks each row `expired` with one correlated `attachment.expired` audit event.
- Wire expiry into the existing scheduled entrypoint without adding a cron, KV namespace, or R2 path.
- Add focused Worker/route/scheduled tests for authorization, binary response shape, missing bytes,
  cleanup idempotency, audit correlation, and cleanup failure retryability.

## Out of scope

- R2 migration, presigned URLs, another KV namespace, or deployment/preview verification.
- Changing CAP-049's temporary 5 MiB CACHE cap or one-hour TTL; consumed bytes remain subject to
  that local policy and a later R2 capability owns durable retention.
- Inline `cid:` rewriting, attachment UI/file-picker changes, message-detail schema expansion, and
  browser rendering; these require a separate client/render slice after the backend download
  contract is stable.
- Downloading an unconsumed upload directly; only a persisted `message_attachments` relation is
  downloadable.

## Business rules

| Rule ID | What it means for this slice |
|---|---|
| `R-ATTACHMENT-001` | A download targets one persisted message attachment; an upload cannot be exposed before consume. |
| `R-ATTACHMENT-005` | The download uses canonical D1 metadata and exact CACHE bytes; missing bytes are a stable 404. |
| `R-ATTACHMENT-007` | Expired unused uploads are cleaned by the scheduled job and transition to `expired`. |
| `R-AUTHZ-003` / `R-AUTHZ-004` | Global read permission and mailbox-scoped read authorization both apply; no IDOR or existence leak. |
| `R-AUDIT-001` | The `uploaded → expired` transition writes one actor/resource/request-correlated audit row atomically with the D1 update. |
| `R-SECRET-003` / `R-LOG-001` | Attachment bytes, filenames, object keys, credentials, and idempotency material never reach logs or error bodies. |
| `R-DATA-004` | Attachment/message lookups and lifecycle updates are parameterized and remain behind Messages' public seam. |

Source: `docs/rebuild/02-business-discovery/business-rules.md`,
`docs/rebuild/05-target-architecture/data-model.md`, and the CAP-049/CAP-050 archived contracts.

## Acceptance criteria

- [x] 1. A mailbox owner can download a consumed attachment and receives exact binary bytes with
  canonical content type, length, and safe attachment/inline disposition headers.
- [x] 2. A viewer/sender/admin with `message.read` can download only from an authorized mailbox;
  missing, foreign, soft-deleted, and nonexistent attachment/message cases all return identical 404
  envelopes and perform no writes.
- [x] 3. Missing CACHE bytes return the same 404 without returning D1 metadata or partial bytes.
- [x] 4. Unconsumed expired uploads are deleted from CACHE and marked `expired`; one
  `attachment.expired` audit event is written per transition with no filename/bytes/key metadata.
- [x] 5. Cleanup is repeat-safe: a second tick does not duplicate audits or writes, and a failed KV
  delete leaves the row `expired` (with the D1 transition/audit already committed) for a later
  byte-delete retry. A failed D1 transition leaves the row `uploaded` and preserves its bytes.
- [x] 6. The existing scheduled entrypoint runs outbound reclaim plus attachment cleanup with the
  current cron and no new binding/resource.
- [x] 7. Focused tests cover every implemented `R-*` rule; doctor, lint, typecheck, unit, Worker,
  format, build, migration, and diff gates pass locally.

## Vertical slice

- [x] repository — Messages-owned attachment download/expiry queries and prepared writers in
  `apps/worker/src/modules/messages/attachment-consume-repository.ts` or a sibling public seam
- [x] use case — `apps/worker/src/modules/attachments/` download and expiry orchestration
- [x] contract/audit — `packages/contracts/src/admin/audit.ts` and contract tests for `attachment.expired`
- [x] route — `apps/worker/src/http/routes/attachments.ts`
- [x] scheduled — `apps/worker/src/entrypoints/scheduled.ts`
- [x] platform — reuse `apps/worker/src/platform/cache.ts`; do not expose `KVNamespace` to modules
- [x] tests — focused attachment Worker/route/scheduled tests and any contract tests needed

New module dependency edges introduced: none. `attachments → messages`, `attachments → tenancy`,
and `attachments → platform/*` already appear in `.claude/rules/architecture.md`.

## Delivery path

`GET /api/v1/mailboxes/:mailboxId/attachments/:attachmentId/download` → request ID/setup/authn →
`message.read` + mailbox `read` → attachments download use case → Messages D1 projection + CACHE
byte-store → binary HTTP response.

`scheduled(c)` → existing `reclaimStaleJobs` → attachments expiry use case → one guarded D1
status/audit batch per expired upload → CACHE delete (with retry on a later tick).

- Build/runtime configuration touched: existing `apps/worker/src/entrypoints/scheduled.ts` only;
  no new binding or cron.
- Fresh-deploy evidence required: no; deployment is deferred by the local-only policy.
- Repeat/idempotency evidence required: scheduled cleanup must be safe on repeated ticks; GET is
  read-only and has no idempotency record.

## Reference implementation

None. Adapt the existing CAP-049 `AttachmentByteStore`, CAP-050 Messages repository seam, CAP-046
audit writer, and CAP-028 scheduled entrypoint pattern.

## File ownership

| Agent | Owns |
|---|---|
| Claude Code | `apps/worker/src/http/routes/attachments.ts`; `apps/worker/src/modules/attachments/**`; `apps/worker/src/modules/messages/attachment-consume-repository.ts`; `apps/worker/src/modules/messages/index.ts`; `apps/worker/src/entrypoints/scheduled.ts`; `packages/contracts/src/admin/audit.ts`; relevant focused Worker/contract tests |
| Codex | This contract, review, quality gates, ledger/log, archive, and final commit |

## Reading list

- `CLAUDE.md`
- `.claude/agents/implementer.md`
- `.claude/rules/architecture.md`
- `.claude/rules/security.md`
- `.claude/rules/testing.md`
- `docs/rebuild/02-business-discovery/business-rules.md` (R-ATTACHMENT/R-AUTHZ/R-AUDIT/R-LOG)
- `docs/rebuild/05-target-architecture/data-model.md`
- `docs/rebuild/08-roadmap/phase-3-business-completeness.md`
- `work/archive/2026-08/CAP-049-attachments-kv/task.md`
- `work/archive/2026-08/CAP-050/task.md`

## Dependencies

- Requires: CAP-050 — Implemented locally and merged to `master`.
- Blocks: client/render follow-up and later durable R2 retention work.

## Decisions made during this capability

- Keep the public download route mailbox-scoped (`/mailboxes/:mailboxId/...`) so authorization is
  against an explicit target mailbox, while preserving the roadmap's `attachments/:id/download`
  behavior under that prefix.
- Continue using the one existing CACHE namespace for local development; R2 remains disabled.
- Treat consumed bytes as subject to CAP-049's temporary one-hour KV policy; durable retention is
  intentionally not invented in this slice.

## Open questions

- A future capability must define durable retention and R2 key migration before downloads need to
  work after the temporary CACHE TTL or across a production deployment.
