# CAP-068 — Signature administration

> Archived capability contract. Implemented locally on 2026-09-01.

## Goal

Give an administrator a safe, auditable way to configure the one signature
owned by each managed domain. The configured projection must be available to
the future outbound compose use case without exposing unrelated provider or
credential data.

## Delivered scope

- Added the tenancy-owned `domain_signatures` table and typed Drizzle declaration.
- Added strict contracts for the signature projection and create/update/delete requests.
- Added `modules/signatures` repository/use-case exports for listing, creating, updating, and deleting.
- Added `/api/v1/admin/signatures` CRUD routes with `signature.read` and `signature.manage` authorization.
- Required `Idempotency-Key` for every mutation and batched business write, audit, and idempotency evidence.
- Sanitized HTML with an explicit formatting/link allowlist and rejected content empty after sanitization.
- Added `/admin/signatures`, its query/mutation client, router entry, landing link, and accessible states.
- Exposed `findEnabledSignature(domainId)` for the later outbound composition slice.
- Added `If-Match` optimistic concurrency for PATCH; stale updates return `412 STALE_IF_MATCH`.

## Explicit exclusions

- Automatic signature injection into compose, reply, or provider payloads. BF-060–BF-062 remain the next outbound integration contract.
- Multiple signatures per domain, per-mailbox/user overrides, templates, variables, image uploads, or rich-editor dependencies.
- Preview deployment, Brevo/provider changes, and unrelated setup/Brevo worktree changes.

## Acceptance result

The signature administration surface is complete at code level. Server-side permission checks protect every route; one signature per domain is enforced by a unique foreign-key table; strict contracts, HTML sanitization, atomic audit/idempotency, byte-identical replay, and stale-write rejection are covered. The Web route is session-guarded, parses responses strictly, hides denied cached data, and never renders HTML.

## Verification

- Focused Worker signature routes: 9 tests passed.
- Focused Web/admin/router: 61 tests passed.
- Contracts: 386 tests passed; sanitizer unit tests: 3 passed.
- Full unit: 82 files, 1189 tests passed.
- Full Worker: 53 files, 913 tests passed against real D1/workerd; live Brevo/outbound tests use the configured token and passed without provider mocks.
- `pnpm scaffold doctor` 14/14, lint, typecheck, format, `git diff --check`, and `pnpm build` passed. Build retained the existing Vite bundle-size warning only.
- A bounded independent subagent review found the concurrent-update race, which was fixed with `If-Match`; its tenant-scope concern was not applicable to the single-installation global managed-domain model. A requested post-fix re-review timed out without a conclusion. The review record is in `subagent-review.md`.
- No preview verification, deployment, push, or provider/token change was performed.
