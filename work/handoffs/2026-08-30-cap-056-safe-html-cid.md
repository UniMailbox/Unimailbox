# CAP-056 — Safe message HTML and inline CID rendering

## Outcome

CAP-056 is implemented locally on `master`. Non-empty message HTML is rendered only by
`SanitizedMessageHtml`, which passes the body through DOMPurify 3.4.14 with explicit tag and
attribute allowlists. Empty or whitespace-only HTML keeps the existing plain-text fallback.

Known consumed inline raster CIDs are normalized and mapped to the encoded CAP-051 download route.
Duplicate or unknown CIDs, non-inline attachments, and external/http(s)/data/blob image sources do
not retain an image `src`. Link policy rejects unsafe, protocol-relative, backslash, control-character,
and obfuscated schemes. DOMPurify removes executable elements, event/style attributes, SVG, and
other forbidden markup. The sanitized fragment is serialized without reparsing raw input. Existing
CAP-053/CAP-055 attachment controls and detail-page flows remain intact.

## Review and verification

- Architecture review: ACCEPT, no findings. The reviewer confirmed DOMPurify owns tag/attribute
  removal, URI handling is scoped to `img`/`a`, duplicate CIDs fail closed, wrapper descendants are
  preserved, and no second raw HTML parse occurs.
- Focused Web tests: 3 files, 26/26 passed (sanitizer, detail page, attachment controls).
- Full unit tests: 989/989 passed.
- Worker tests: 870/870 passed, zero skipped or failed.
- `pnpm scaffold doctor`: 14/14 passed.
- `pnpm lint`, `pnpm typecheck`, `pnpm format:check`, `pnpm build`, and `git diff --check`: passed.

The test runner only reported that secrets are defined in `apps/worker/.dev.vars`; its contents were
not opened, inspected, or printed.

## Changed files

- `apps/web/package.json`, `pnpm-lock.yaml` — direct exact DOMPurify dependency.
- `apps/web/src/features/mailbox/sanitize-message-html.ts` — sanitizer, URI policy, CID index,
  duplicate handling, and safe-link policy.
- `apps/web/src/features/mailbox/SanitizedMessageHtml.tsx` — sole sanitized HTML insertion boundary.
- `apps/web/src/features/mailbox/message-attachment-media.ts` — shared raster/download helpers.
- `apps/web/src/features/mailbox/MessageAttachments.tsx` — reuses the shared helpers without changing
  controls or ordering.
- `apps/web/src/features/mailbox/MessageDetailPage.tsx` and its test — HTML/fallback integration.
- `apps/web/src/features/mailbox/SanitizedMessageHtml.test.tsx` — focused XSS, CID, URI, no-fetch,
  no-log, duplicate, and wrapper-descendant coverage.
- `docs/rebuild/capability-ledger.md`, `docs/rebuild/implementation-log.md` — closure state and log.
- `work/archive/2026-08/CAP-056-safe-html-cid/task.md` — archived contract.

## Deferred

No Worker, contracts, migration, storage, provider, R2, new KV, preview deployment, or production
deployment changes were made. Provider-specific/server-side CID rewriting, richer previews, and
preview verification remain future work. The existing CAP-054 preview-idempotency observation still
blocks a `Verified` designation for Phase 2; CAP-056 is `Implemented` locally, not preview-verified.
