# CAP-053 — Message detail attachment download controls

> Local-only frontend slice. CAP-052 exposes safe consumed-attachment metadata from the existing
> message-detail response and CAP-051 provides the authorized binary download route; this slice
> connects those two surfaces without adding storage, upload, or HTML/CID behavior.

**Phase:** 3 · **Status:** Implemented · **Started:** 2026-08-29 · **Closed:** 2026-08-29

## Goal

An authorized reader viewing a message detail can identify each consumed attachment and activate a
download through the existing mailbox-scoped CAP-051 endpoint.

## Scope

- Add a small Messages UI attachment list that consumes the shared `MessageDetail.attachments`
  descriptors from CAP-052.
- Render each descriptor once with filename, content type, human-readable size, disposition, and a
  download control.
- Build a relative link to
  `GET /api/v1/mailboxes/:mailboxId/attachments/:attachmentId/download`, encoding both path IDs.
- Preserve the API-provided order; do not fetch bytes, sort, deduplicate, or infer storage keys in
  the browser.
- Keep the detail page's existing loading, error, auth fallback, reply, thread, and mark-read
  behavior unchanged.

## Out of scope

- Worker routes, contracts, migrations, CACHE/KV/R2, queue, upload, compose, or provider changes.
- HTML body rendering, inline image/CID rewriting, blob previews, thumbnails, drag-and-drop, file
  pickers, attachment removal, or client-side byte fetching.
- New authorization decisions. The existing API route remains authoritative; the UI must not treat
  a visible link as proof of access.

## Business rules

| Rule ID | What it means for this slice |
|---|---|
| `R-ATTACHMENT-001` / `R-ATTACHMENT-006` | Render only the consumed attachment descriptors returned by the authorized message-detail read. |
| `R-SECRET-003` / `R-LOG-001` | Never place upload IDs, object keys, bytes, credentials, or idempotency material in the DOM, URL, or logs. |
| `R-API-001` / `R-API-002` | Consume the typed shared detail shape and preserve stable error/loading behavior. |

Source: `docs/rebuild/02-business-discovery/business-rules.md`, the archived CAP-051/CAP-052
contracts, and the existing web mailbox conventions.

## Acceptance criteria

- [x] 1. A populated message detail renders one attachment row per descriptor in the API-provided
  order, showing filename, content type, size, disposition, and an accessible download control.
- [x] 2. Each control points to the exact relative CAP-051 path with URL-encoded `mailboxId` and
  attachment `id`; no `uploadId`, object key, or byte content appears in the DOM or `href`.
- [x] 3. Empty and legacy details (missing or empty `attachments`) render a stable empty state or
  omit the list without throwing; existing message detail behavior remains intact.
- [x] 4. Filename and metadata are rendered as text, not interpreted as HTML; the UI does not sort,
  deduplicate, prefetch, or issue a `fetch` for attachment bytes before activation.
- [x] 5. Focused web tests cover populated order/link encoding, empty/legacy behavior, safe text
  rendering, and the no-prefetch boundary with rule IDs in test names.
- [x] 6. `pnpm scaffold doctor`, lint, typecheck, unit tests, Worker tests, format check, build,
  and `git diff --check` pass locally.

## Vertical slice

- [x] component — `apps/web/src/features/mailbox/MessageAttachments.tsx` (or an equivalent
  mailbox-owned presentational component)
- [x] page integration — `apps/web/src/features/mailbox/MessageDetailPage.tsx`
- [x] client query/contract — none; consume the existing shared `MessageDetail` type
- [x] route/backend — none; CAP-051 download route is already deployed in local code
- [x] tests — component/page tests under `apps/web/src/features/mailbox/`

New module dependency edges introduced: none. The UI remains inside the single existing
`apps/web` client and imports cross-boundary types only from `@unimailbox/contracts` through the
existing mailbox query boundary.

## Delivery path

CAP-052 detail query → `MessageDetailPage` → attachment metadata list → user activation → relative
CAP-051 download URL; the browser performs the authorized GET and handles the binary response.

- Build/runtime configuration touched: none
- Fresh-deploy evidence required: no; deployment is deferred by the local-only policy
- Repeat-deploy/idempotency evidence required: no; this slice is read-only UI navigation

## File ownership

| Agent | Owns |
|---|---|
| Claude Code | `apps/web/src/features/mailbox/MessageAttachments.tsx`; `apps/web/src/features/mailbox/MessageDetailPage.tsx`; focused mailbox tests and only necessary local styles |
| Codex | This contract, review coordination, quality gates, ledger/log, archive, and final commit |
| Grok | Independent frontend/security review of the completed slice |

## Dependencies

- Requires: CAP-051 — Implemented locally; CAP-052 — Implemented and archived locally.
- Blocks: inline image/CID rendering follow-up and any attachment UI beyond download controls.

## Decisions

- Use a same-origin relative `href` so the existing browser session/cookie/auth behavior and
  CAP-051 response headers remain authoritative. Do not download into JavaScript or expose a storage
  key.
- Inline attachments are listed like ordinary downloads in this slice. HTML/CID policy receives a
  separate contract after this small control surface is reviewed.

## Open questions

- A later CID capability must decide whether inline images are rewritten in the message body or
  rendered as a separate preview; neither decision is needed for CAP-053.
