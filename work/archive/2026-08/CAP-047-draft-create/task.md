# CAP-047 server draft-create slice

## Objective

Implement only the server-side create-draft vertical slice on the local Worker test topology.
This is the first runtime slice after the archived shared contracts preflight. It must not claim
CAP-047 closure or remove the existing CAP-054 preview gate.

## Allowed files

- `apps/worker/src/http/routes/drafts.ts` (new)
- `apps/worker/src/http/router.ts` (mount the route)
- `apps/worker/test/drafts.worker.test.ts` (new focused Worker-pool tests)
- `packages/contracts/src/admin/audit.ts` (add the closed `draft.created` action)
- `packages/contracts/src/index.test.ts` (update the exact audit-action pin)
- `apps/worker/test/preview-gate.worker.test.ts` (add `draft.created` to the production-action pin)

Do not edit any other source, migration, Wrangler config, frontend, capability ledger, or
implementation log file. Do not add dependencies. Do not commit.

## Behaviour

Add `POST /api/v1/mailboxes/:mailboxId/drafts`:

1. Require `message.send` permission and `assertCan(..., 'send')` against the path mailbox. Missing
   auth is 401; a non-member/viewer is denied; an owner/sender can create.
2. Require `Idempotency-Key`. Hash the raw request bytes before parsing. A same actor + operation +
   key + same bytes replays the stored 201 response; the same key with different bytes returns the
   existing 409 `IDEMPOTENCY_KEY_REUSED` contract. Handle an idempotency UNIQUE race with the
   existing platform replay helper.
3. Parse with the already-exported `createDraftSchema` (wire names `body_text`/`body_html`, email
   strings). Look up the mailbox address; never trust a client-supplied sender.
4. Write all create-side effects in one D1 batch using the existing message batch seam:
   `messages` row with `status='draft'`, mailbox address as `from_address`, supplied body fields,
   authenticated `created_by_user_id`, and timestamps; one `message_recipients` row for every
   `to`/`cc`/`bcc` address; one `mailbox_messages` row with `folder='drafts'`; one
   `audit_events` row with action `draft.created`, resource type `message`, path message id,
   request id, and no body/recipient metadata; one idempotency record. Do not enqueue a job.
5. Return HTTP 201 with JSON `{ data: { messageId, status: 'draft', updatedAt } }` and a
   `Location: /api/v1/drafts/<messageId>` header. Use one clock instant; keep DB timestamp format
   consistent with existing `sqliteTimestamp` while returning the existing API's RFC-3339 wire
   timestamp convention. Replays must preserve the stored body/status.

## Required tests

The new Worker test file must exercise the full router with local D1 and cover at minimum:

- authenticated owner creates a draft; response shape/status/location and DB rows (message,
  recipients for all three recipient kinds, mailbox folder/status, audit action/request id,
  idempotency row) are asserted;
- empty `to` is allowed for a draft, while malformed/over-limit body is a stable 400;
- same idempotency key + same raw body replays the same message id without duplicate rows;
- same key + changed body returns 409 `IDEMPOTENCY_KEY_REUSED`;
- unauthenticated request, foreign mailbox, and viewer member are denied; sender member succeeds;
- no outbound queue send occurs on draft creation;
- a failing business statement proves the D1 batch leaves no partial draft/audit/idempotency rows.

Update the two existing exact closed-audit-action assertions for `draft.created`; do not weaken them
or replace them with a derived self-check.

## Verification commands

Run and report:

```text
pnpm exec vitest run --project workers apps/worker/test/drafts.worker.test.ts
pnpm exec vitest run packages/contracts/src/index.test.ts
pnpm typecheck
pnpm lint
pnpm exec prettier --check apps/worker/src/http/routes/drafts.ts apps/worker/src/http/router.ts apps/worker/test/drafts.worker.test.ts packages/contracts/src/admin/audit.ts packages/contracts/src/index.test.ts apps/worker/test/preview-gate.worker.test.ts
git diff --check
```

Do not run remote migrations, deploy, Wrangler writes, secret access, or read `.dev.vars`. Stop
after the listed files and checks and report changed files, tests, and any blocked command.

## Completion handoff (2026-08-28)

- Claude Code implemented the create-draft route, router mount, audit action pin, and focused
  Worker tests. The orchestrator applied only the bounded Grok findings after Claude's follow-up
  process became inactive: replay responses now restore `Location`, the rollback test fails a
  later business `audit_events` statement, and queue mocking was removed in favor of an
  `outbound_jobs` assertion.
- Grok final re-review: **PASS**, no blocker/high/medium findings. Remaining low notes are that
  the test does not enter the live UNIQUE-race catch branch and the rollback test depends on the
  current request-id/message/audit UUID call order; both are covered by the current contract and
  are not release blockers for this slice.
- Verification: draft Worker 11/11, contracts 359/359, typecheck, lint, Prettier on all six
  allowed files, and `git diff --check` all passed. No remote migrations/deploys/secrets were used.

This slice is complete and ready to archive. It does not close CAP-047 or update the capability
ledger; the next slice should cover draft GET/PATCH/send behavior under a new bounded contract.
