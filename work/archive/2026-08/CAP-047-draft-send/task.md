# CAP-047 draft send slice

## Objective

Implement only the server-side `POST /api/v1/drafts/:draftId/send` path on top of the
committed draft create/read/PATCH slices. This is a bounded local Worker slice. Do not
implement delete, attachments, UI/Dexie, inbox folder filtering, compose-route refactors,
ledger closure, or deployment.

The send path queues the existing draft (`messages.status: draft -> queued`) and lets the
existing outbound consumer perform the provider call and later transition the message to
`sent`. Marking a draft `sent` before provider acceptance would make provider failures look
like successful sends and would bypass the existing queue lifecycle.

## Allowed files

- `apps/worker/src/http/routes/drafts.ts`
- `apps/worker/src/modules/messages/message-repository.ts`
- `apps/worker/src/modules/messages/index.ts`
- `apps/worker/test/drafts.worker.test.ts`
- `apps/worker/src/modules/outbound-mail/job-repository.ts`
- `apps/worker/src/modules/outbound-mail/index.ts`
- `packages/contracts/src/admin/audit.ts`
- `packages/contracts/src/index.test.ts`
- `work/active/CAP-047-draft-send/task.md`

Do not edit any other file. Do not commit; the orchestrator commits. Do not read `.dev.vars`,
deploy, access remotes, or add dependencies.

## Behaviour

Add `POST /api/v1/drafts/:draftId/send` to the already-mounted draft route app:

1. Require global `message.send`, `Idempotency-Key`, and an empty JSON body. Accept an empty
   request body as `{}` for clients that send no body; if a body is present it must parse through
   the existing strict `sendDraftSchema` (`{}` only). Hash the raw bytes before parsing so replay
   semantics remain byte-based.
2. Resolve every `mailbox_messages` association for the draft where `messages.status='draft'`.
   Iterate associations and authorize `assertCan(actor, mailboxId, 'send', isAdmin)`; choose the
   first authorized mailbox. Collapse missing, non-draft, and unauthorized rows to the existing
   `MESSAGE_NOT_FOUND` 404 no-leak envelope. Never accept a client mailbox ID.
3. Perform idempotency lookup for the distinct operation string
   `POST /api/v1/drafts/:draftId/send` before validation. The request fingerprint must include
   the raw body bytes plus the route `draftId`, so a key/body pair can never replay a different
   draft; same actor/operation/key + same draft/body replays the stored 202 byte-identically.
   Same key + different draft or bytes returns the existing `IDEMPOTENCY_KEY_REUSED` 409. A
   concurrent unique-key race must replay or conflict, never return an uncategorized 500.
4. Require an active provider connection using the existing local Phase 1 selection rule
   (`status='active'`, oldest `created_at`, one row). Return the existing
   `PROVIDER_CONNECTION_NOT_FOUND` 409 when none exists. Do not decrypt credentials or call the
   provider in this route; the queue consumer owns that work.
5. In one atomic D1 batch, in this order:
   - conditionally update the message through a messages-module prepared writer with
     `status='draft'` as the only allowed source and `status='queued'` as the target;
   - insert the idempotency response marker only when that update changed one row, using a
     request-specific marker UUID and a `changes() > 0`/new-status guard;
   - update the draft's mailbox association(s) from `folder='drafts'` to `folder='sent'`, guarded
     by this request's marker so a stale or concurrent loser cannot mutate folders;
   - insert exactly one `outbound_jobs` row in `queued` state for the selected active provider
     connection, guarded by the same marker (use an outbound-module prepared seam or an equally
     explicit guarded insert; do not leave an unguarded job insert in a race);
   - insert exactly one `audit_events` row with closed action `draft.sent`, resource `message`,
     request correlation ID, and no body/recipient metadata, guarded by the same marker.
6. The success response is `202 { data: { messageId: draftId, status: 'queued' } }` with
   `Content-Type: application/json` and `Location: /api/v1/messages/:draftId`. Store the exact
   response bytes in `idempotency_records`; replay restores the same status/body/content type.
   Enqueue exactly one `{ jobId }` message on `env.OUTBOUND` only after the D1 batch commits.
7. A stale/non-draft conditional update must leave message, mailbox folder, outbound job, audit,
   and idempotency counts unchanged. A same-key concurrent loser must replay the winner and must
   not create a second job/audit/folder mutation. A batch failure after the status statement must
   roll back every write; the queue must not be called on failure.
8. Keep existing POST draft, GET draft, PATCH draft, compose send, and queue-consumer behavior
   unchanged. Do not add a new migration or dependency.

## Required tests

Extend `apps/worker/test/drafts.worker.test.ts` with full-router Worker tests for:

- owner sends a draft with `{}` and with no body: exact 202 envelope, Location, message status
  `queued`, mailbox folder `sent`, one outbound job, one `draft.sent` audit, one idempotency row,
  and exactly one queue message containing the job ID;
- active provider connection is required and missing connection returns 409 without writes or
  queue calls;
- viewer/foreign actor gets the same 404 no-leak response and no writes;
- same idempotency key + same raw body replays byte-identical 202 and does not enqueue twice;
- reusing the same key/body on a different draft returns `IDEMPOTENCY_KEY_REUSED` and does not
  send or mutate the second draft;
- same key + different raw body returns 409 `IDEMPOTENCY_KEY_REUSED`;
- a stale/non-draft second send returns 404 (or same-key replay where applicable) and leaves all
  message/folder/job/audit/idempotency counts unchanged;
- a deterministic audit collision or other post-status batch failure returns 500 and rolls back
  the status, folder, job, audit, and idempotency writes; queue is not called;
- preserve every existing draft and compose/queue test; use real D1 and only spy on `OUTBOUND.send`
  at the binding boundary.

## Verification

Run and report:

```text
pnpm exec vitest run --project workers apps/worker/test/drafts.worker.test.ts
pnpm exec vitest run --project workers apps/worker/src/http/routes/compose.worker.test.ts
pnpm typecheck
pnpm lint
pnpm exec prettier --check apps/worker/src/http/routes/drafts.ts apps/worker/src/modules/messages/message-repository.ts apps/worker/src/modules/messages/index.ts apps/worker/src/modules/outbound-mail/job-repository.ts apps/worker/src/modules/outbound-mail/index.ts apps/worker/test/drafts.worker.test.ts
git diff --check
```

Stop after this server send slice and the listed checks.
