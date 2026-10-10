# CAP-060 — Web folder navigation and views

## Outcome

The Web mailbox surface now consumes the five folder views exposed by CAP-059: Inbox, Sent,
Drafts, Archive, and Trash. The route validates `folder` against the shared contracts enum and
falls back to Inbox for missing, empty, repeated, or unsupported values. Non-Inbox list requests
carry `?folder=<value>`; the default Inbox request remains unchanged for compatibility.

Folder is part of the authenticated mailbox message query key. Compose invalidates the mailbox's
folder family after a successful send, while read/star/delete cache writes target the active folder
key. The UI exposes native, keyboard-accessible links with `aria-current="page"` for the selected
view and keeps the existing Inbox behavior and copy.

## Evidence

- Focused Web: router, query-key, and InboxListPage tests — **39/39 passed**.
- Full unit suite — **1006/1006 passed**.
- `pnpm scaffold doctor` — **14/14 passed**.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` — passed.
- `pnpm build` — Web and Worker builds plus Wrangler dry-run passed.
- `git diff --check` — passed.

No Worker, database, migration, binding, R2, deployment, or remote operation changed. No secret
values or `.dev.vars` contents were inspected.

## Deferred next work

Draft IndexedDB crash recovery remains the next Phase 3 implementation slice. Sharing/invitation
UI, CAP-054 preview verification, R2 migration, and deployment remain separate operator or
capability work.
