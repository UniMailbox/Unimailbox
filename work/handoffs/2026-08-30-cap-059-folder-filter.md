# CAP-059 — Folder-filtered message list backend

## Outcome

The existing mailbox message list now supports the five closed folder views: `inbox`, `sent`,
`drafts`, `archive`, and `trash`. Missing `folder` defaults to `inbox`; invalid or empty values
return the canonical `VALIDATION_ERROR` response. The SQL filter runs after mailbox authorization
and caller-scoped soft-delete filtering, so CAP-058 per-user state behavior is preserved.

Messages cursors now include the signed scope `folder:<name>`. Scope-less and cross-folder cursors
are rejected with `INVALID_CURSOR`; same-folder pagination remains stable.

## Files

- `packages/contracts/src/index.ts` — `messageFolderSchema` and shared `MessageFolder` type;
  list/detail folder fields now use the closed vocabulary.
- `packages/contracts/src/cursor.ts` — optional endpoint `scope` field for signed cursors.
- `apps/worker/src/http/routes/messages.ts` — parse/default `folder` query parameter.
- `apps/worker/src/modules/messages/message-read-repository.ts` — folder predicate and cursor
  scope enforcement/signing; typed folder projections.
- `apps/worker/src/http/routes/messages.worker.test.ts` — real-D1 folder filtering, pagination,
  invalid input, cross-folder cursor, and scope-less cursor tests.
- `packages/contracts/src/index.test.ts` — folder and cursor-scope contract tests.

## Verification

- `pnpm scaffold doctor`: 14/14
- `pnpm typecheck`: pass
- `pnpm lint`: pass
- `pnpm format:check`: pass
- contracts: 380/380
- focused Messages Worker: 71/71
- full unit: 1002/1002
- full Worker: 888/888, zero skipped/failed
- `pnpm build`: pass, Wrangler dry-run only
- `git diff --check`: pass

## Explicitly deferred

This is only the backend filter slice. Web folder navigation/views, draft DELETE/discard and
IndexedDB recovery, sharing UI, R2 migration, preview verification, and deployment remain
separate work. No secrets were inspected and no remote operation occurred.
