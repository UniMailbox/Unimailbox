# CAP-056 — Safe message HTML rendering and inline CID substitution

> Local-only frontend slice. CAP-052 supplies consumed attachment metadata, CAP-051 supplies the
> authorized binary route, and CAP-055 previews standalone raster attachments. This slice renders
> the existing message `htmlBody` only after a maintained sanitizer pass and resolves known inline
> image CIDs to same-origin download URLs. It does not change the Worker or storage model.

**Phase:** 3 · **Status:** Implemented · **Started:** 2026-08-29 · **Completed:** 2026-08-30

## Goal

An authorized reader can see formatted message HTML and known inline images without allowing message
content to execute scripts, load arbitrary remote images, or expose attachment storage details.

## Scope

- Add `dompurify@3.4.14` as a direct dependency of `apps/web` and use it as the maintained HTML
  sanitizer; do not hand-roll an HTML sanitizer.
- Render `htmlBody` in the existing message-detail page when it is non-empty; keep the current plain
  `textBody` `<pre>` fallback when the HTML body is empty.
- Before/while sanitizing, resolve only `img[src="cid:..."]` values whose normalized content ID
  exactly matches one consumed attachment descriptor with `disposition='inline'` and a previewable
  raster type. Generate the same encoded CAP-051 download URL used by CAP-053.
- Leave unknown/unmatched CIDs and all non-CID image sources without a usable `src`, so the browser
  does not issue arbitrary remote image requests. Preserve safe `alt` text.
- Use an explicit HTML allowlist: common text/structure tags plus `a` and `img`; safe attributes
  only (`alt`, `height`, `href`, `rel`, `src`, `title`, `width`). Exclude scripts, event handlers,
  style attributes, SVG, iframe/object/embed/form tags, and unsafe URI schemes.
- Keep every CAP-053 attachment download/preview control and all existing detail loading, error,
  auth, mark-read, reply, and thread behavior unchanged.

## Out of scope

- Worker routes, contracts, migrations, CACHE/KV/R2, queue, upload, compose, provider, or deployment
  changes.
- Server-side HTML rewriting, provider-specific CID behavior, arbitrary remote image proxying,
  JavaScript-enabled email, CSS/style preservation, SVG/video/audio previews, iframe/object embeds,
  or a full email-client layout engine.
- New authorization decisions. CAP-051 remains authoritative for every generated image/download
  request; the client must not infer access from a visible URL.

## Security rules

| Rule ID | What it means for this slice |
|---|---|
| `R-ATTACHMENT-001` / `R-ATTACHMENT-006` | CID resolution uses only consumed inline descriptors already returned for this authorized message. |
| `R-ATTACHMENT-008` | Known inline CIDs become same-origin CAP-051 download URLs; unknown CIDs are not guessed or proxied. |
| `R-SECRET-003` / `R-LOG-001` | No upload IDs, object keys, bytes, credentials, or idempotency material enter markup, URLs, or logs. |
| `R-API-001` / `R-API-002` | The typed detail response and existing error/loading envelope remain stable. |

Source: `docs/rebuild/02-business-discovery/business-rules.md`, the archived CAP-051–CAP-055
contracts, and the security-review checklist for untrusted HTML.

## Acceptance criteria

- [x] 1. A non-empty `htmlBody` renders in a dedicated detail-body surface after DOMPurify
  sanitization; an empty HTML body still renders the existing plain-text fallback.
- [x] 2. Known `cid:` image sources resolve only when the CID matches a consumed inline previewable
  raster attachment; the generated `src` equals the encoded CAP-051 download path for that
  attachment.
- [x] 3. Unknown CIDs, external/http(s)/data/blob image sources, SVG, and non-inline attachments do
  not produce usable image sources; no remote image is proxied or fetched by JavaScript.
- [x] 4. Script/style/event-handler elements and attributes, unsafe links (`javascript:`, `data:`,
  protocol-relative), SVG/iframe/object/embed/form tags, and other non-allowlisted markup are absent
  from the rendered output. `htmlBody` is never inserted without the sanitizer boundary.
- [x] 5. Filename/alt/text content is rendered safely, API order and existing attachment controls
  remain unchanged, and no upload ID/object key/bytes/idempotency value appears in markup or logs.
- [x] 6. Focused Web tests cover HTML fallback, allowed tags/attributes, XSS payload removal,
  known/unknown CID behavior, encoded URL generation, blocked remote images, and no JS byte fetch,
  with rule IDs in test names.
- [x] 7. `pnpm scaffold doctor`, lint, typecheck, unit tests, Worker tests, format check, build,
  and `git diff --check` pass locally; the lockfile records the direct sanitizer dependency.

## Vertical slice

- [x] sanitizer/resolver — `apps/web/src/features/mailbox/` mailbox-owned helper/component using
  `dompurify`
- [x] page integration — `apps/web/src/features/mailbox/MessageDetailPage.tsx`
- [x] attachment controls — preserve CAP-053/CAP-055 `MessageAttachments` behavior
- [x] contract/query/backend — none; consume existing `MessageDetail` and CAP-051 route
- [x] tests — focused mailbox Web tests plus existing MessageDetailPage regression coverage

New module dependency edges introduced: none. The browser remains the only renderer; CAP-051 stays
the server-authoritative byte and authorization boundary.

## Delivery path

CAP-052 detail query → sanitized HTML/CID resolver → React safe HTML boundary → known inline image
`src` / text links → CAP-051 authorized download endpoint.

- Build/runtime configuration touched: `apps/web/package.json` and `pnpm-lock.yaml` only for
  `dompurify@3.4.14`
- Fresh-deploy evidence required: no; deployment is deferred by local-only policy
- Repeat-deploy/idempotency evidence required: no; this is read-only UI behavior

## File ownership

| Agent | Owns |
|---|---|
| Claude Code | `apps/web/package.json`, `pnpm-lock.yaml`, mailbox sanitizer/resolver/component, `MessageDetailPage.tsx`, and focused Web tests |
| Codex | This contract, review coordination, quality gates, ledger/log, archive, and final commit |
| Grok | Independent XSS/CID/architecture review of the completed slice |

## Dependencies

- Requires: CAP-051 — Implemented locally; CAP-052 — Implemented locally; CAP-053 — Implemented
  locally; CAP-055 — Implemented locally.
- Blocks: richer attachment preview behavior and any server-side/provider CID rewrite.

## Decisions

- Use DOMPurify with a narrow allowlist rather than a custom regex/DOM sanitizer. Rendering sanitized
  output through `dangerouslySetInnerHTML` is permitted only inside the dedicated component whose
  sole input is the sanitizer's returned string.
- Do not allow remote images or `data:`/`blob:` sources. Only generated same-origin CAP-051 URLs
  for known inline raster attachments may survive on an `<img>`.
- Normalize a CID token by trimming whitespace and removing one optional surrounding `<`/`>` pair;
  otherwise match content IDs exactly. An unmatched or ambiguous CID is removed rather than guessed.
