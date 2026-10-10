# CAP-052 — Message detail attachment projection

> Local-only backend slice. CAP-050 persists consumed attachment relations and CAP-051 serves
> authorized bytes; this slice makes the consumed attachment metadata discoverable from the existing
> message-detail response so a later client slice can render download controls without guessing IDs.

**Phase:** 3 · **Status:** Implemented · **Started:** 2026-08-29 · **Closed:** 2026-08-29

## Goal

An authorized reader of a message detail receives a stable, metadata-only list of that message's
consumed attachments, including the attachment IDs needed to call the CAP-051 download route.

## Scope

- Extend the existing `GET /api/v1/mailboxes/:mailboxId/messages/:messageId` success payload with
  an `attachments` array.
- Return only persisted, consumed `message_attachments` rows, ordered by `created_at` then `id`.
- Expose only contract-safe metadata: attachment ID, filename, content type, size, disposition, and
  nullable content ID. Do not expose upload IDs, CACHE/R2 object keys, or bytes.
- Keep the existing message/mailbox authorization and per-user soft-delete behavior unchanged.
- Add contracts and real Worker coverage for empty, populated, non-consumed, cross-mailbox, and
  soft-deleted cases.

## Out of scope

- Upload, consume, expiry, CACHE, R2, queue, or migration changes.
- A new endpoint, download URL generation, inline CID rewriting, HTML rendering, file-picker, or
  other web-client changes; the next client slice owns those.
- Changing message authorization semantics, pagination, threading, folder/star state, or audit
  behavior. This is a read-only projection and adds no state transition.

## Business rules

| Rule ID | What it means for this slice |
|---|---|
| `R-ATTACHMENT-001` | The projection contains only attachments persisted for this message; each relation is represented once. |
| `R-AUTHZ-003` / `R-AUTHZ-004` | Existing global `message.read` and target-mailbox authorization remain required; no cross-mailbox IDOR. |
| `R-MESSAGE-003` / `R-MESSAGE-005` | Visibility follows the authorized mailbox relation and the requesting user's soft-delete state. |
| `R-SECRET-003` / `R-LOG-001` | No bytes, object keys, credentials, or idempotency material are returned or logged. |
| `R-DATA-004` | Attachment projection SQL is parameterized and remains inside the Messages-owned repository seam. |
| `R-API-001` / `R-API-002` | The existing success envelope remains stable and the additive `attachments` field has a typed contract. |

Source: `docs/rebuild/02-business-discovery/business-rules.md`,
`docs/rebuild/03-domain-design/aggregates.md`, `docs/rebuild/05-target-architecture/data-model.md`,
and the archived CAP-050/CAP-051 contracts.

## Acceptance criteria

- [x] 1. An authorized message-detail response always includes `attachments` as an array; no
  attachment returns `[]`.
- [x] 2. A message with multiple consumed relations returns each descriptor exactly once in stable
  `created_at ASC, id ASC` order with canonical filename/content type/size/disposition/content ID.
- [x] 3. Upload IDs, object keys, and bytes are absent from the descriptor and the repository never
  reads CACHE/R2 for this projection.
- [x] 4. A relation whose upload is not `consumed` is omitted; existing foreign-mailbox,
  nonexistent-message, and soft-deleted-message behavior remains the same safe 404.
- [x] 5. The additive contracts schema parses populated and empty attachment arrays while accepting
  legacy detail fixtures that omit the optional field during client rollout.
- [x] 6. Every implemented `R-*` rule has a named focused test; doctor, lint, typecheck, unit,
  Worker, format, build, migration, and diff gates pass locally.

## Vertical slice

- [x] domain — none; reuse the existing MessageAttachment projection
- [x] migration — none; CAP-050 migration 0022 already supplies the relation
- [x] repository — `apps/worker/src/modules/messages/message-read-repository.ts`
- [x] use case — none; extend the existing Messages read boundary used by the detail route
- [x] contract schema — `packages/contracts/src/index.ts`
- [x] route — existing `apps/worker/src/http/routes/messages.ts`; no new route
- [x] client — none in this slice; next attachment-render capability consumes the field
- [x] tests — `apps/worker/src/http/routes/message-detail-attachments.worker.test.ts`,
  `packages/contracts/src/index.test.ts`

New module dependency edges introduced: none. The existing route → Messages read boundary and
Messages-owned `message_attachments`/`attachment_uploads` reads remain within
`.claude/rules/architecture.md`.

## Delivery path

`GET /api/v1/mailboxes/:mailboxId/messages/:messageId` → request ID/setup/authn → global
`message.read` + mailbox `read` → existing Messages detail read boundary → parameterized D1
message/attachment projection → `{ data: { ..., attachments } }`.

- Build/runtime configuration touched: none
- Fresh-deploy evidence required: no; deployment is deferred by the local-only policy
- Repeat-deploy/idempotency evidence required: no; this is a read-only GET projection

## Reference implementation

None. Adapt the existing CAP-050 `message_attachments` schema and CAP-051 download metadata while
rejecting their internal `uploadId`/`objectKey` fields at this public read boundary.

## File ownership

| Agent | Owns |
|---|---|
| Claude Code | `apps/worker/src/modules/messages/message-read-repository.ts`; `packages/contracts/src/index.ts`; `packages/contracts/src/index.test.ts`; `apps/worker/src/http/routes/messages.worker.test.ts` or a new focused test under `apps/worker/src/http/routes/` |
| Codex | This contract, review, quality gates, ledger/log, archive, and final commit |

## Reading list

- `CLAUDE.md`
- this file
- `.claude/agents/implementer.md`
- `.claude/rules/architecture.md`
- `.claude/rules/security.md`
- `.claude/rules/testing.md`
- `docs/rebuild/02-business-discovery/business-rules.md`
- `docs/rebuild/03-domain-design/aggregates.md`
- `docs/rebuild/05-target-architecture/data-model.md`
- `work/archive/2026-08/CAP-050/task.md`
- `work/archive/2026-08/CAP-051-attachment-download-cleanup/task.md`

## Dependencies

- Requires: CAP-050 — Implemented locally and merged to `master`; CAP-051 — Implemented locally and merged to `master`.
- Blocks: attachment download/render UI and inline CID follow-up.

## Decisions made during this capability

- The field is additive and optional in the shared parser during rollout so existing client fixtures
  remain valid; the Worker always emits an array, including `[]`.
- The public descriptor deliberately excludes `uploadId` and storage keys. The client uses the
  message-detail mailbox ID plus descriptor `id` with CAP-051's existing download route.

## Open questions

- The next client capability must decide whether inline images are rendered from `contentId` or
  shown as ordinary downloads; no HTML/CID behavior is introduced here.
