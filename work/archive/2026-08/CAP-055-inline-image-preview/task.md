# CAP-055 — Inline image attachment preview

> Local-only frontend slice. CAP-052 exposes consumed attachment metadata and CAP-053 provides
> download controls. This slice adds a safe preview for a narrow raster-image allowlist without
> rendering arbitrary message HTML or rewriting `cid:` strings.

**Phase:** 3 · **Status:** Implemented · **Started:** 2026-08-29 · **Closed:** 2026-08-29

## Goal

An authorized reader can see inline raster-image attachments directly in the message-detail
attachment section while every other attachment continues to use the existing download control.

## Scope

- Extend the existing mailbox-owned attachment presentation from CAP-053.
- For `disposition === 'inline'` and an allowed raster media type (`image/png`, `image/jpeg`,
  `image/gif`, `image/webp`, or `image/avif`), render an `<img>` whose `src` is the existing
  mailbox-scoped CAP-051 download URL and whose `alt` is the filename.
- Keep a download link available for every attachment, including inline images and unsupported
  media types.
- Preserve API-provided order and render metadata as text.
- Leave `htmlBody` as text, do not use `dangerouslySetInnerHTML`, and do not rewrite `cid:` tokens;
  HTML rendering/sanitization and CID substitution are separate future capabilities.

## Out of scope

- Worker routes, contracts, migrations, CACHE/KV/R2, queue, upload, compose, or provider changes.
- Arbitrary HTML rendering, DOM parsing, sanitizer policy, iframe/object embedding, SVG previews,
  video/audio previews, blob URLs, client-side byte fetching, or attachment deletion.
- New authorization decisions. CAP-051 remains authoritative for every image/download request.

## Business rules

| Rule ID | What it means for this slice |
|---|---|
| `R-ATTACHMENT-001` / `R-ATTACHMENT-006` | Preview only descriptors already returned as consumed relations for the authorized message. |
| `R-SECRET-003` / `R-LOG-001` | No upload IDs, object keys, bytes, credentials, or idempotency material enter the DOM, URL, or logs. |
| `R-API-001` / `R-API-002` | Consume the typed shared detail shape and preserve stable page/error behavior. |

Source: `docs/rebuild/02-business-discovery/business-rules.md`, archived CAP-051/CAP-052/CAP-053
contracts, and the existing mailbox UI conventions.

## Acceptance criteria

- [x] 1. An inline attachment with an allowed raster type renders one `<img>` with the exact
  CAP-051 download `src`, filename `alt`, and an accompanying download control.
- [x] 2. Inline SVG/unknown media and ordinary `attachment` descriptors do not render an image
  preview, but retain their metadata and download control.
- [x] 3. Both the image source and download link use encoded mailbox and attachment IDs; no
  upload ID, object key, bytes, or idempotency material appears in rendered markup.
- [x] 4. Filenames remain text nodes; malformed/hostile filenames cannot create markup. `htmlBody`
  remains unrendered and `cid:` strings are not rewritten in this slice.
- [x] 5. API order is preserved, every attachment remains downloadable, and the component does not
  call `fetch`, create blob URLs, or make an authorization decision in JavaScript.
- [x] 6. Focused Web tests cover allowed raster preview, SVG/unsupported fallback, attachment
  fallback, encoded links, safe text/no-leak, and no-JavaScript-fetch behavior with rule IDs in
  test names.
- [x] 7. `pnpm scaffold doctor`, lint, typecheck, unit tests, Worker tests, format check, build,
  and `git diff --check` pass locally.

## Vertical slice

- [x] component — extend `apps/web/src/features/mailbox/MessageAttachments.tsx`
- [x] page integration — reuse CAP-053's `MessageDetailPage` integration without changing the
  detail query or server response
- [x] client query/contract — none; consume the existing shared `MessageDetail` type
- [x] route/backend — none; CAP-051 download route remains authoritative
- [x] tests — `apps/web/src/features/mailbox/MessageAttachments.test.tsx` and only necessary page
  assertions

New module dependency edges introduced: none. The UI remains inside the existing `apps/web` client;
the browser's native image/download request is the only byte transport.

## Delivery path

CAP-052 detail query → CAP-053 attachment list → allowed inline raster `<img src>` and download
link → browser activation/loader → CAP-051 authorized download endpoint.

- Build/runtime configuration touched: none
- Fresh-deploy evidence required: no; deployment is deferred by local-only policy
- Repeat-deploy/idempotency evidence required: no; this is read-only UI behavior

## File ownership

| Agent | Owns |
|---|---|
| Claude Code | `apps/web/src/features/mailbox/MessageAttachments.tsx`; focused component/page tests and only necessary local styles |
| Codex | This contract, review coordination, quality gates, ledger/log, archive, and final commit |
| Grok | Independent frontend/security review of the completed slice |

## Dependencies

- Requires: CAP-051 — Implemented locally; CAP-052 — Implemented locally; CAP-053 — Implemented
  locally.
- Blocks: HTML body rendering/CID substitution and richer attachment previews.

## Decisions

- SVG is intentionally excluded from the preview allowlist because an image response must not become
  an HTML/script execution surface. Users can still download it through the existing route.
- `contentId` is preserved as metadata for the later CID capability but is not interpreted here.
- Every preview also keeps a normal download link, so failed image loads have an explicit recovery
  path without adding JavaScript error handling or byte fetches.
