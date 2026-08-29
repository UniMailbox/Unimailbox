# CAP-049 — Attachment upload staging in the existing KV namespace

> Bounded local-only backend slice. R2 remains declared but is not used by this capability.

**Phase:** 3 · **Status:** In Progress · **Started:** 2026-08-28

## Goal

An authenticated mailbox sender can stage one binary attachment in the existing `CACHE` KV
namespace, with D1 metadata and an enforced size/TTL contract, without creating another Cloudflare
binding.

## Scope

- Add the `attachment_uploads` D1 table and typed schema for an upload owned by a user/mailbox.
- Add a Worker route for an authenticated sender to upload raw bytes and receive an upload descriptor.
- Store bytes under a unique `attachment:<uploadId>` KV key in `CACHE` using a 5 MiB hard limit and
  one-hour TTL.
- Enforce the limit from both `Content-Length` and the actual raw body bytes; do not base64-encode
  binary data into JSON.
- Use an idempotency record for the upload response, with the mailbox ID in the operation namespace.
- Add focused Worker/migration/contract tests against the real worker-pool KV and D1 bindings.

## Out of scope

- R2 upload URLs, R2 reads/deletes, or removing the existing `ATTACHMENTS` binding.
- Merging `SETUP_SESSION` into `CACHE`; this slice adds no KV namespace and leaves auth/session
  topology unchanged.
- Attaching an upload to a message/draft, provider serialization, recipient download, inline CID
  rewriting, scheduled D1 cleanup, or UI/client work (CAP-050/051 follow-ups).
- Deployment, preview verification, real secrets, or real email delivery.

## Business rules

| Rule ID | What it means for this slice |
|---|---|
| `R-ATTACHMENT-001` | Each staged upload has one owner and mailbox association in D1; no client-supplied owner is trusted. |
| `R-ATTACHMENT-003` | Interim KV cap is **5 MiB (5 × 1024 × 1024 bytes)** per upload; larger requests return 413 before persistence. This is a temporary stricter cap than the future R2 rule. |
| `R-ATTACHMENT-005` | A staged upload is represented by an `attachment_uploads` row in `uploaded` status only after its bytes are present in KV. |
| `R-ATTACHMENT-007` | KV bytes receive a one-hour TTL; D1 expiry/cleanup is deferred to CAP-051 and must not be claimed complete here. |
| `R-AUDIT-001` | Creation of the `uploaded` lifecycle state writes one `attachment.uploaded` audit row in the same D1 batch, carrying actor, resource ID, and request ID but no bytes or filename. |
| `R-AUTHZ-003` / `R-AUTHZ-004` | Require global `message.send` and mailbox-scoped `send`; resolve authorization from the path mailbox and authenticated user. |
| `R-API-004` / `ADR-004` | Upload is mutating and requires `Idempotency-Key`; same key + canonical metadata + raw bytes replays, while any changed metadata or bytes returns 409. |
| `R-API-005` | Return 413 for an advertised or actual body over the attachment cap; the normal 1 MiB API middleware must not truncate this route. |
| `R-DATA-004` | All D1 writes use parameterized statements; metadata is canonical in D1 while KV is byte storage only. |
| `R-LOG-001` / `R-SECRET-003` | Never log attachment bytes, filenames containing secrets, bearer/cookie material, or raw request bodies. |

Source: `docs/rebuild/02-business-discovery/business-rules.md`, existing API/security rules, and
the temporary KV decision recorded in this contract and the implementation log.

## Acceptance criteria

- [ ] 1. `POST /api/v1/mailboxes/:mailboxId/attachments/uploads` with a valid sender, raw bytes,
  filename/content-type metadata, and `Idempotency-Key` stores exactly one `attachment_uploads`
  row (`status='uploaded'`), one `attachment:<uploadId>` value in `CACHE`, and one correlated
  `attachment.uploaded` audit row, returning 201 with `{ data: { uploadId, sizeBytes, expiresAt, ... } }`
  and no bytes in the response.
- [ ] 2. A body exactly at 5 MiB succeeds; a body one byte over is rejected with 413 whether or
  not `Content-Length` is present (the omitted-length path is rejected by a bounded stream reader
  before retaining more than the cap), and neither D1 nor KV contains a record for the rejected upload.
- [ ] 3. Missing/invalid filename or content type, empty body, malformed metadata, and missing
  `Idempotency-Key` return the existing 400 envelope before any D1/KV write.
- [ ] 4. A user without `message.send`, a user without mailbox `send`, and a different user's
  mailbox ID all receive the existing auth/authz/not-found response and produce zero D1/KV writes.
- [ ] 5. Repeating the same key and byte-identical request returns the stored byte-identical
  response without a second upload row or KV write; reusing the key with different raw bytes
  returns 409 `IDEMPOTENCY_KEY_REUSED`.
- [ ] 6. If the D1 batch fails after the KV put, the route checks whether the batch committed before
  deleting bytes; it deletes only when absence is positively observed, otherwise preserves bytes
  for TTL cleanup. No partial `uploaded` row/audit/idempotency state is accepted.
- [ ] 7. The focused route tests prove `attachment.uploaded` is emitted exactly once on first write,
  not on replay, and that the audit row is request-correlated without sensitive metadata.
- [ ] 8. The success test proves the KV key exposes an expiration approximately one hour after
  upload (in addition to the D1 expiry), and the focused migration/contract/Worker tests plus all
  standard local gates
  pass. No preview/deploy step is required for this local-only slice.

## Vertical slice

Layers touched, in dependency order:

- [ ] domain/storage policy — `apps/worker/src/modules/attachments/`
- [ ] migration — `migrations/0021_attachment_uploads.sql` + `.verify.sql`
- [ ] repository/use case — `apps/worker/src/modules/attachments/` + `apps/worker/src/modules/messages/`
- [ ] contract schema — `packages/contracts/src/attachments.ts` + `src/index.ts`
- [ ] audit contract — `packages/contracts/src/admin/audit.ts` + its enum test
- [ ] route — `apps/worker/src/http/routes/attachments.ts` + `src/http/router.ts`
- [ ] tests — `apps/worker/test/attachments.worker.test.ts`, module/contract tests as needed
- [ ] client — none (deferred)

No disallowed module dependency edges are introduced. `attachments` uses only the allowed
`platform/*`, `contracts/*`, `messages`, and `tenancy` edges from `.claude/rules/architecture.md`;
the route calls the attachment use case only.

## Delivery path

`HTTP POST` → global request/setup/config/auth middleware → attachment sibling sub-app with the
5 MiB body middleware → `attachments.upload` use case → parameterized D1 metadata + `CACHE` KV
bytes → 201 upload descriptor.

- Build/runtime configuration touched: `apps/worker/src/http/router.ts` only; reuse existing
  `CACHE` binding, no new Wrangler binding and no R2 enablement.
- Fresh-deploy evidence required: no (local-only; migration verify and Wrangler build only).
- Repeat-deploy/idempotency evidence required: idempotency replay and same-key/different-body
  Worker tests; no remote deploy.

## Reference implementation

None. Cloudflare KV limits are platform constraints, not a copied implementation. The 5 MiB cap is
an explicit temporary policy chosen below the KV 25 MiB value limit and aligned with the roadmap's
5 MB acceptance fixture; it must be revisited before any R2-to-KV production use.

## File ownership

| Agent | Owns |
|---|---|
| Claude implementer | `migrations/0021_attachment_uploads.sql`, `migrations/0021_attachment_uploads.verify.sql`, `apps/worker/src/database/schema/attachments.ts`, `apps/worker/src/database/schema/index.ts`, `apps/worker/src/database/schema-version.ts`, `apps/worker/src/modules/attachments/**`, `apps/worker/src/modules/messages/attachment-upload-repository.ts`, `apps/worker/src/modules/messages/index.ts`, `apps/worker/src/platform/cache.ts`, `packages/contracts/src/attachments.ts`, `packages/contracts/src/admin/audit.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/index.test.ts`, `packages/test-kit/src/migrationsDb.ts`, `packages/test-kit/src/migrationsDb.worker.test.ts`, `apps/worker/src/http/routes/attachments.ts`, `apps/worker/src/http/router.ts`, `apps/worker/test/attachments.worker.test.ts`, `apps/worker/test/preview-gate.worker.test.ts`, focused contract/module tests |
| Codex orchestrator | this contract, ledger/implementation-log/ADR or business-rule persistence, gate execution, final staging/commit |
| Grok reviewer | no writes; review the Claude diff and test evidence for architecture/security/acceptance gaps |

## Reading list

- `CLAUDE.md`
- this contract
- `.claude/agents/implementer.md`
- `.claude/rules/architecture.md`
- `.claude/rules/security.md`
- `.claude/rules/testing.md`
- `docs/rebuild/02-business-discovery/business-rules.md`
- `docs/rebuild/05-target-architecture/data-model.md`
- `docs/rebuild/08-roadmap/phase-3-business-completeness.md`
- Cloudflare KV limits and read/write API references supplied by the orchestrator

## Dependencies

- Requires: CAP-047 draft server/send slices (Implemented locally); CAP-054 code slice (Implemented,
  preview observation still pending).
- Blocks: CAP-050 attachment consume/send integration and CAP-051 download/cleanup.

## Decisions made during this capability

- Interim bytes use the existing `CACHE` namespace with an `attachment:` key prefix. No third KV
  namespace is introduced; `SETUP_SESSION` remains separate because merging auth/session storage
  is a different migration.
- The temporary cap is 5 MiB per attachment, measured on actual bytes, with one-hour KV TTL.
- D1 metadata is authoritative for owner/mailbox/status/expiry; KV is not an authorization source.

## Open questions

- Before production or R2 removal, decide whether the 5 MiB interim cap becomes a configurable
  policy and whether the canonical R2 64 MiB rule is restored. This does not block local work.
