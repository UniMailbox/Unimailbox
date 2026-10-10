# CAP-047 draft-read slice

## Objective

Implement only the server-side GET-draft read path on top of the committed create-draft slice.
This is a bounded local Worker slice. Do not implement PATCH, send, delete, attachments, UI,
ledger closure, or deployment changes.

## Allowed files

- `apps/worker/src/http/routes/drafts.ts`
- `apps/worker/test/drafts.worker.test.ts`

Do not edit router wiring, contracts, migrations, Wrangler config, frontend, capability ledger,
implementation log, dependencies, or any other file. Do not commit; the orchestrator commits.

## Behaviour

Add `GET /api/v1/drafts/:draftId` to the already-mounted `draftRoutes()` app:

1. Require global `message.read` permission. Resolve the draft by joining `messages` to
   `mailbox_messages`; only `messages.status='draft'` is a draft. A missing/non-draft ID returns
   the existing `MESSAGE_NOT_FOUND` 404 envelope.
2. Authorize against the resolved mailbox with `assertCan(actorUserId, mailboxId, 'read', isAdmin)`.
   Do not authorize against a client-supplied mailbox. A foreign actor must receive the same 404
   `MESSAGE_NOT_FOUND` envelope (no draft existence leak); owner, viewer member, sender member,
   and global admin may read.
3. Return 200 `{ data: { id, mailboxId, subject, body_text, body_html, to, cc, bcc,
   status, created_at, updated_at } }`. `to`/`cc`/`bcc` are arrays of normalized address strings,
   with empty arrays when no recipients exist. Do not return audit metadata or unrelated message
   headers. Keep the CAP-047 wire names `body_text`/`body_html` and `created_at`/`updated_at`.
   Return timestamps as RFC-3339 strings consistent with the create response; use a local helper
   to convert the stored SQLite `YYYY-MM-DD HH:MM:SS` values without exposing implementation
   details. `status` must be the stored `draft` value.
4. GET is read-only: no idempotency record, audit row, recipient mutation, queue call, or other
   write. Use parameterized SQL and preserve the no-PII logging posture.

## Required tests

Extend `apps/worker/test/drafts.worker.test.ts` with full-router Worker tests for:

- owner GET returns the exact envelope, body fields, mailbox ID, RFC-3339 timestamps, status
  `draft`, and all three recipient arrays; no write-side counts change;
- empty recipient arrays are returned as `[]`;
- foreign actor reading another mailbox's draft gets 404 `MESSAGE_NOT_FOUND` (not 403);
- viewer member can read a draft; unauthenticated GET is 401;
- a non-draft existing message and an unknown draft ID both return 404;
- response has no extraneous body/header fields (in particular no message-id/reply headers).

Keep the existing POST coverage and assertions unchanged. Do not weaken exact audit-action pins or
remove the create-route tests. Do not mock queues or read `.dev.vars`.

## Verification

Run and report:

```text
pnpm exec vitest run --project workers apps/worker/test/drafts.worker.test.ts
pnpm typecheck
pnpm lint
pnpm exec prettier --check apps/worker/src/http/routes/drafts.ts apps/worker/test/drafts.worker.test.ts
git diff --check
```

No remote migrations, deploys, Wrangler writes, secret access, or `.dev.vars` reads. Stop after
the two allowed source/test files and the listed checks.

## Completion handoff (2026-08-28)

- Claude implemented the GET slice in the two allowed source/test files.
- Grok first found two medium and two low issues; Claude applied bounded fixes:
  - iterate and authorize every mailbox association before selecting the wire mailbox;
  - add sender-member and global-administrator read coverage;
  - validate stored SQLite timestamps before conversion;
  - assert `messages` and `mailbox_messages` counts remain unchanged on GET.
- Final Grok re-review: `PASS`, no findings.
- Verification: focused draft Worker tests 21/21, `pnpm typecheck`, `pnpm lint`,
  Prettier check, and `git diff --check` all passed.
- No deploy, remote write, or secret-bearing file access.
