# CAP-057 — Mailbox sharing backend

> Bounded Phase 3 backend slice. This contract adds the tenancy-owned member-management API;
> it does not include the web UI, folders, stars, deployment, or a storage change.

**Phase:** 3 · **Status:** Implemented · **Started:** 2026-08-30 · **Completed:** 2026-08-30

## Goal

An authorized mailbox owner or globally authorized operator can add, list, and remove mailbox
members with explicit viewer/sender/admin roles, durable audit evidence, and replay-safe mutation.

## Scope

- Add `POST /api/v1/mailboxes/:mailboxId/members` with normalized email and closed role validation.
- Add `GET /api/v1/mailboxes/:mailboxId/members` with a stable, safe member projection.
- Add `DELETE /api/v1/mailboxes/:mailboxId/members/:userId` for explicit members only.
- Authorize every operation for the target mailbox: its owner is always allowed; otherwise the
  actor must have the global `mailbox.share` permission. Do not grant sharing merely because the
  actor is a mailbox admin.
- Resolve target users through a narrow Identity public interface; active users only. Do not cross
  the tenancy/identity boundary with password-bearing rows or direct users-table SQL.
- Write each membership mutation, its audit event, and its mutating-endpoint idempotency record
  atomically in one D1 batch. Removal audits only an actual deletion and leaves no stale side effects.
- Add focused real-D1 Worker and contract tests for every acceptance criterion and rule ID.

## Out of scope

- Web/client UI, invitation email delivery, registration, role-policy editing, or Better Auth work.
- Folders, stars, per-user message state, mailbox rename/delete, or changes to mailbox ownership.
- New migrations or schema changes; `mailbox_members` already exists and the audit table accepts
  the new closed action strings.
- R2, CACHE/KV, Queue, providers, preview/deployment, remote operations, and secret handling.
- Storing the owner in `mailbox_members`; ownership remains implicit on `mailboxes.owner_user_id`.

## Business rules

| Rule ID | What it means for this slice |
|---|---|
| `R-MAILBOX-003` | The owner is implicit and cannot be added as a member. |
| `R-MAILBOX-004` | The owner can manage members without a global sharing permission. |
| `R-MAILBOX-005` / `R-MAILBOX-006` / `R-MAILBOX-007` | Stored viewer/sender/admin roles retain their read/send/manage semantics for subsequent mailbox authorization. |
| `R-AUTHZ-001` / `R-AUTHZ-003` / `R-AUTHZ-004` | Require an authenticated actor, keep global `mailbox.share` separate from target-mailbox scope, and authorize against the path mailbox ID. |
| `R-DATA-001` / `R-DATA-004` | Normalize emails case-insensitively and use parameterized SQL with enforced foreign keys. |
| `R-AUDIT-001` / `R-AUDIT-004` | Every add/remove transition has one actor/resource/request-correlated audit row in the same mutation batch. |
| `R-API-001` / `R-API-002` / `R-API-003` / `R-API-004` / `R-API-006` | Use canonical success/error envelopes, closed stable codes, real statuses, validated bodies, and an idempotent POST. |

Source: `docs/rebuild/02-business-discovery/business-rules.md`, W-8 in
`docs/rebuild/02-business-discovery/workflows.md`, and the tenancy/authorization rules in
`.claude/rules/architecture.md` and `.claude/rules/testing.md`.

## Acceptance criteria

- [x] 1. Contracts define a strict add request (`email`, `role`), member item/list response, and
  stable errors for unknown user, duplicate member, owner self-add, missing member, invalid input,
  and denied access. The audit action vocabulary contains exactly `mailbox.member_added` and
  `mailbox.member_removed` for these transitions.
- [x] 2. Owner can add/list/remove a member without global `mailbox.share`; a non-owner without
  that global permission is denied; a globally permitted actor can manage a mailbox they do not
  own. Missing/foreign mailbox outcomes do not disclose membership or user data.
- [x] 3. Add accepts only an existing active user found by normalized email, rejects owner
  self-add, invalid email/role, and duplicate `(mailboxId,userId)`, and never returns password or
  credential fields. The owner remains absent from the member list.
- [x] 4. A successful add writes exactly one `mailbox_members`, one `audit_events` row with actor,
  mailbox/member resource, request ID, and no secrets, plus one idempotency record in one D1 batch.
  A same-key/same-body replay returns the stored identical response with no duplicate rows; a
  same-key/different-body request returns the stable idempotency conflict.
- [x] 5. GET returns only `userId`, `email`, `displayName`, `role`, and `createdAt`, in a stable
  deterministic order, and applies the same owner/global-share authorization and mailbox IDOR
  protections.
- [x] 6. DELETE requires `Idempotency-Key`, removes only an explicit member, returns the canonical
  success envelope/status, and writes exactly one `mailbox.member_removed` audit row plus one
  idempotency record for an actual removal. A same-key replay is identical and side-effect-free;
  absent/owner/unauthorized requests return the stable missing/denied error without audit or other
  writes.
- [x] 7. Focused real-D1 Worker tests are named with every implemented `R-*` ID and cover allowed
  and denied paths, cross-mailbox IDOR, no-write failures, duplicate/idempotency races as relevant,
  safe projection, audit correlation, and response envelopes. Contract tests pin closed schemas,
  roles, actions, and error codes.
- [x] 8. `pnpm scaffold doctor`, `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`,
  `pnpm test:worker`, `pnpm format:check`, `pnpm build`, and `git diff --check` pass locally. No
  preview/deployment evidence is required for this local-only slice.

## Vertical slice

Layers this touches, in dependency order:

- [ ] domain — existing tenancy role semantics; no new domain state machine
- [ ] migration — none; existing `mailbox_members` schema is sufficient
- [ ] repository — `apps/worker/src/modules/tenancy/mailbox-repository.ts` (+ public tenancy index)
- [ ] use case — tenancy member-management use-case seam as needed; keep route thin
- [ ] contract schema — `packages/contracts/src/index.ts`, `packages/contracts/src/admin/audit.ts`,
  and the closed error catalog surface
- [ ] route — `apps/worker/src/http/routes/mailboxes.ts` or a tenancy-owned route mounted by the
  existing API router
- [ ] client — none
- [ ] tests — `apps/worker/src/http/routes/mailbox-members.worker.test.ts` and focused contract tests

New module dependency edges introduced: `tenancy → identity` is already allowed; identity lookup
must use a public narrow summary interface. Audit writes must use the existing contract/writer seam
or composition-root pattern approved by the architecture rules, not a new reverse module import.

## Delivery path

`authenticated HTTP request` → API router → mailbox member route → tenancy authorization/use case →
Identity summary lookup + tenancy repository → atomic D1 membership/audit/idempotency writes →
canonical JSON response; GET reads a safe projection; DELETE returns the removal result.

- Build/runtime configuration touched: none
- Fresh-deploy evidence required: no (local-only policy)
- Repeat-deploy/idempotency evidence required: POST replay/conflict and D1 batch atomicity are
  required in Worker tests; no remote repeat-deploy

## Reference implementation

`None` — use the existing UniMailbox route, idempotency, audit, tenancy, and identity seams. The W-8
workflow is the product reference; no external code is copied.

## File ownership

One writer per file. Reading anything is fine; writing outside your list is not.

| Agent | Owns |
|---|---|
| Claude Code | `packages/contracts/src/index.ts`, `packages/contracts/src/admin/audit.ts`, `apps/worker/src/platform/errors.ts`, `apps/worker/src/modules/identity/*` (narrow summary export only), `apps/worker/src/modules/tenancy/*` (member repository/authorization/use case), `apps/worker/src/http/routes/mailboxes.ts`, and focused tests under `apps/worker/src/http/routes/` plus contract tests required by the slice |
| Codex | This contract, ledger/log, review coordination, quality gates, archive, and final commit |
| Grok | Independent architecture/security review; no source edits |

## Reading list

- `CLAUDE.md`
- this file
- `.claude/agents/implementer.md`
- `.claude/rules/architecture.md`
- `.claude/rules/testing.md`
- `.claude/rules/security.md`
- `docs/rebuild/02-business-discovery/business-rules.md`
- `docs/rebuild/02-business-discovery/workflows.md` (W-8)
- `docs/rebuild/05-target-architecture/data-model.md`
- `apps/worker/src/http/routes/mailboxes.ts`
- `apps/worker/src/modules/tenancy/index.ts`
- `apps/worker/src/modules/tenancy/mailbox-repository.ts`
- `apps/worker/src/modules/tenancy/authorizer.ts`
- `apps/worker/src/modules/identity/index.ts`
- `apps/worker/src/modules/identity/user-repository.ts`

## Dependencies

- Requires: CAP-020 mailbox persistence — Implemented; CAP-017 authorization — Implemented; CAP-040
  audit seam — Implemented; CAP-042 idempotency/auth boundary — Implemented.
- Blocks: mailbox-sharing UI and richer member administration; folders/stars remain separate Phase 3
  capabilities.

## Decisions made during this capability

- 2026-08-30: Provider-side CID handling remains deferred because R2 is disabled and Brevo's current
  attachment contract does not expose a Content-ID field; CAP-057 is the next unblocked local slice.
- 2026-08-30: Sharing authority follows W-8/Q10: owner OR global `mailbox.share`; mailbox-admin role
  alone does not grant cross-mailbox sharing authority.
- 2026-08-30: Member-management routes collapse missing, foreign, and unauthorized mailbox IDs to
  the same 404 envelope; this prevents mailbox-existence enumeration while preserving global-share
  and owner access.
- 2026-08-30: POST hashes the validated normalized request, and service-level preflight rechecks the
  idempotency record so a same-key loser replays the committed response even when it observes the
  member row before reaching the batch.

## Open questions

- None for this bounded slice. Invitation delivery and member self-service are future capabilities.
