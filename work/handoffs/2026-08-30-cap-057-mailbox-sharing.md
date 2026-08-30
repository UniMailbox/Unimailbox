# CAP-057 — Mailbox sharing backend

## Status

Implemented locally on `master`; no preview deployment, push, or commit has been performed in this
handoff. The active contract is ready to archive after the final documentation update.

## Delivered behavior

- `POST /api/v1/mailboxes/:mailboxId/members` validates a strict normalized `{email, role}` body,
  accepts only active users, rejects owner/self and duplicate membership, and returns the safe
  five-field member projection.
- `GET /api/v1/mailboxes/:mailboxId/members` returns explicit members in deterministic
  `createdAt,userId` order through a credential-free Identity batch lookup.
- `DELETE /api/v1/mailboxes/:mailboxId/members/:userId` removes only explicit members and returns a
  safe removal result.
- Owner or global `mailbox.share` may manage a target mailbox. Missing, foreign, and unauthorized
  mailbox IDs collapse to `404 MAILBOX_NOT_FOUND`.
- Add and remove transitions write the membership change, correlated audit row, and idempotency
  record atomically. POST and DELETE same-key replays are byte-identical and concurrent races do
  not duplicate audit/member side effects.

## Evidence

- Focused Worker routes: 30/30 passed (`mailbox-members.worker.test.ts` + existing mailboxes tests).
- Contract tests: 375/375 passed.
- Full unit tests: 993/993 passed.
- Full Worker/test-kit suites: 880/880 passed.
- `pnpm scaffold doctor`: 14/14 passed.
- `pnpm lint`, `pnpm typecheck`, `pnpm format:check`, `pnpm build`, and `git diff --check`: passed.
- Independent architecture review: ACCEPT, no open findings.
- Codex security pass: no concrete remaining issue; reviewed auth/no-leak, parameter binding,
  safe projection, credential boundary, idempotency, race rollback, and audit metadata.

## Changed paths

- `packages/contracts/src/index.ts`
- `packages/contracts/src/index.test.ts`
- `packages/contracts/src/admin/audit.ts`
- `apps/worker/src/platform/errors.ts`
- `apps/worker/src/modules/identity/index.ts`
- `apps/worker/src/modules/identity/user-summary-repository.ts`
- `apps/worker/src/modules/tenancy/index.ts`
- `apps/worker/src/modules/tenancy/mailbox-repository.ts`
- `apps/worker/src/modules/tenancy/mailbox-member-service.ts`
- `apps/worker/src/http/routes/mailboxes.ts`
- `apps/worker/src/http/routes/mailbox-members.worker.test.ts`

## Deferred

Invitation delivery, member self-service, web UI, folders/stars, deployment verification, R2, and
additional KV namespaces remain separate capabilities. CAP-054 provider-idempotency preview evidence
also remains pending and is not changed by this local slice.
