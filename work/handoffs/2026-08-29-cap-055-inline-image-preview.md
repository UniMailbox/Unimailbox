# CAP-055 — Inline image attachment preview

## Outcome

Implemented and independently reviewed on local `master`. The CAP-053 attachment list now offers
safe previews for a narrow raster-image allowlist while preserving a download control for every
attachment.

## Behavior

- `inline` PNG, JPEG, GIF, WebP, and AVIF descriptors render an `<img>` using the existing CAP-051
  authorized download URL.
- SVG, unknown media, and ordinary `attachment` descriptors do not render an image preview.
- Every row remains downloadable; API order and encoded mailbox/attachment IDs are preserved.
- Filename and metadata are rendered as text. No upload IDs, object keys, bytes, credentials, or
  idempotency values enter the DOM, URL, or logs.
- `htmlBody` is still rendered as text, and no `cid:` substitution or arbitrary HTML parsing was
  introduced.

## Verification

| Check | Result |
|---|---:|
| CAP-055 focused Web tests | 19/19 |
| Full unit/Web tests | 982/982 |
| Full Worker tests | 870/870 |
| Scaffold doctor | 14/14 |
| Lint/typecheck/format/build/diff check | pass |
| Grok architecture/security review | ACCEPT |

The test runner reported loading `apps/worker/.dev.vars`; no values were inspected, printed,
copied, or changed. No push, deploy, R2 change, extra KV namespace, or production operation was
performed.

## Deferred

HTML body rendering, sanitizer policy, and CID substitution are a separate future capability.
Durable R2 retention and CAP-054 preview/provider verification remain deferred.
