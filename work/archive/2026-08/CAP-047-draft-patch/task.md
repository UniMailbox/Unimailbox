# CAP-047 draft PATCH slice

## Objective

Implement only the server-side `PATCH /api/v1/drafts/:draftId` path on top of the committed
create and read slices. This is a bounded local Worker slice. Do not implement send, delete,
attachments, UI/Dexie, ledger closure, or deployment. Migration work is limited to the 0020
response-size migration, its verification, and the schema/test wiring required by this slice.

## Allowed files

- `apps/worker/src/http/routes/drafts.ts`
- `apps/worker/test/drafts.worker.test.ts`
- `apps/worker/src/platform/errors.ts`
- `apps/worker/src/database/schema-version.ts`
- `packages/contracts/src/admin/audit.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/index.test.ts`
- `packages/test-kit/src/migrationsDb.ts`
- `packages/test-kit/src/migrationsDb.worker.test.ts`
- `migrations/0020_idempotency_response_size.sql`
- `migrations/0020_idempotency_response_size.verify.sql`
- `migrations/0009_idempotency_records.verify.sql`
- `work/active/CAP-047-draft-patch/task.md`

Do not edit any other file. Do not commit; the orchestrator commits. Do not read `.dev.vars`,
deploy, access remotes, or add dependencies.

## Behaviour

Add `PATCH /api/v1/drafts/:draftId` to the already-mounted draft route app:

1. Require global `message.send` permission and mailbox-scoped `assertCan(actorUserId,
   resolvedMailboxId, 'send', isAdmin)`. Resolve all mailbox associations as GET does; select the
   first association the actor may send from, and collapse missing/non-draft/unauthorized rows to
   the existing `MESSAGE_NOT_FOUND` 404 no-leak envelope.
2. Require `Idempotency-Key` via the existing middleware. Hash the raw body and replay a stored
   response for the same actor/operation/key + identical bytes; a different body returns the
   existing `IDEMPOTENCY_KEY_REUSED` 409. Use a distinct operation string for PATCH.
3. Require `If-Match` containing exactly the RFC-3339 `updated_at` value returned by GET (the
   strict second-precision `...SS.000Z` form). Missing header returns 400 `IF_MATCH_REQUIRED`;
   malformed/weak/quoted/non-canonical header returns 400 `IF_MATCH_INVALID`. Add these closed
   error codes to `ERROR_CODES` and add HTTP status 412 to `HttpStatusCode`; stale concurrency
   returns 412 `STALE_IF_MATCH`.
4. Parse the raw JSON with `updateDraftSchema` (strict; all fields optional). Omitted fields keep
   their current values; supplied `subject`, `body_text`, `body_html` replace the corresponding
   values; supplied `to`, `cc`, or `bcc` replaces that recipient category (including `[]`).
5. Enforce the optimistic predicate in the actual write: `UPDATE messages ... WHERE id = ? AND
   status = 'draft' AND updated_at = ?`. The new SQLite timestamp must be strictly greater than
   the old one even when two requests occur within one second (advance by one second when needed).
6. Update message fields, recipient replacements, audit event `draft.updated`, and idempotency
   record in ONE atomic D1 batch. Every side-effect statement after the conditional UPDATE must
   be guarded by the successful new timestamp (or equivalent), so a stale/no-op UPDATE cannot
   delete/insert recipients or write audit/idempotency rows. Inspect batch metadata to return 412
   when the conditional UPDATE changed zero rows. No queue call.
7. Return 200 with an exact GET-compatible `{ data: { id, mailboxId, subject, body_text,
   body_html, to, cc, bcc, status: 'draft', created_at, updated_at } }` envelope; replay is byte
   identical and restores `Content-Type`. `updated_at` must equal the new If-Match value for the
   next edit. Keep response free of audit/message headers and preserve POST/GET behavior.
8. Register `draft.updated` in the closed `auditActionSchema` and update the exact action-list
   contract test. Do not cast around the closed enum; the route must pass the typed action directly.
9. Because the GET-compatible PATCH replay body can legally exceed the legacy 65,536-character
   idempotency CHECK, add migration `0020_idempotency_response_size.sql` (with its verify companion)
   rebuilding `idempotency_records` while preserving all rows and indexes and raising only the
   `response_json` limit to 524,288. Add a focused Worker test for a schema-legal large body and
   byte-identical replay; do not weaken the existing limit checks for other columns.
10. If the pre-validation `updated_at` comparison discovers a stale value after the initial
    idempotency lookup, perform the same winner lookup/replay-or-conflict disambiguation as the
    post-batch zero-update path before returning `STALE_IF_MATCH`.

## Required tests

Extend `apps/worker/test/drafts.worker.test.ts` with full-router tests for:

- owner PATCH updates subject/body and returns exact GET-compatible envelope with newer timestamp;
- partial patch preserves omitted fields; each provided recipient category replaces rows and `[]`
  clears it;
- missing, malformed, weak, and quoted `If-Match` return 400 with the correct closed code;
- stale `If-Match` returns 412 `STALE_IF_MATCH` and leaves message, recipients, audit, and
  idempotency counts unchanged;
- sender member may patch; viewer/foreign actor is denied without a write;
- same idempotency key + same raw body replays byte-identical 200; same key + different body is
  409 `IDEMPOTENCY_KEY_REUSED`;
- a deterministic batch failure after the message update rolls back the message, recipient,
  audit, and idempotency writes (no queue row), proving atomicity;
- preserve every existing POST and GET test and do not mock queues or production D1 writes.

## Verification

Run and report:

```text
pnpm exec vitest run --project workers apps/worker/test/drafts.worker.test.ts
pnpm typecheck
pnpm lint
pnpm exec prettier --check apps/worker/src/http/routes/drafts.ts apps/worker/test/drafts.worker.test.ts apps/worker/src/platform/errors.ts
git diff --check
```

Stop after this slice and the listed checks.
