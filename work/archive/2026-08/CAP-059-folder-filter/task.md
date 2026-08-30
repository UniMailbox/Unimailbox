# CAP-059 — Folder-filtered message list (backend slice)

**Phase:** 3
**Status:** Implemented locally
**Started:** 2026-08-30
**Completed:** 2026-08-30

## Objective

Add a server-authoritative folder filter to the existing mailbox message list. This is the
backend half of the Phase 3 folder views; the Web navigation and view composition remain a
separate follow-up slice.

## Scope

- Add the closed message-folder contract: `inbox`, `sent`, `drafts`, `archive`, `trash`.
- Accept `folder` on `GET /api/v1/mailboxes/:mailboxId/messages`; default to `inbox`.
- Filter `mailbox_messages.folder` after the existing mailbox/user/soft-delete predicates.
- Bind the selected folder into messages cursors so a cursor cannot silently cross folder views.
- Preserve caller-scoped `message_user_state` star/read/delete behavior and existing authorization.

## Acceptance criteria

- [x] `folder` parses only the five supported values; missing means `inbox`; invalid/empty input
  returns the canonical 400 validation envelope before the message data query.
- [x] A mailbox list returns only rows in the selected folder, with stable ordering and existing
  per-user state projection.
- [x] Cursors minted for one folder cannot be replayed against another folder; pagination within
  one folder remains deterministic.
- [x] Existing mailbox authorization, soft-delete filtering, and no-write behavior are unchanged.
- [x] Contract and real-D1 Worker tests are named with the applicable rule IDs and pass.

## Implementation evidence

- `messageFolderSchema` is the closed `inbox | sent | drafts | archive | trash` vocabulary;
  list/detail contracts and Messages read models use the shared `MessageFolder` type.
- The list route defaults missing `folder` to `inbox` and returns `VALIDATION_ERROR` for an
  unsupported value. The Messages repository filters `mm.folder` after mailbox and caller
  soft-delete predicates.
- Messages cursors carry `scope=folder:<name>` in the signed payload. Scope-less or cross-folder
  cursors are rejected as `INVALID_CURSOR`; same-folder cursor pagination remains stable.
- Focused evidence: contracts 380/380; real-D1 Messages Worker 71/71; typecheck, lint, focused
  format check, and `git diff --check` all pass.
- No migration, binding, R2, KV, deployment, or remote operation was added.

## Verification

```text
pnpm exec vitest run --project contracts packages/contracts/src/index.test.ts
pnpm exec vitest run --project workers apps/worker/src/http/routes/messages.worker.test.ts
pnpm typecheck
pnpm lint
pnpm format:check
git diff --check
```

## Out of scope

Web folder navigation/views, draft IndexedDB recovery, sharing UI, R2, new KV namespaces,
preview/deployment, and remote operations.
