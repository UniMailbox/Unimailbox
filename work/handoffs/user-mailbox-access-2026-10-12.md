# User mailbox access — 2026-10-12

## Scope and behavior

Branch: `codex/admin-user-mailbox-access`, started from clean
`codex/leanda-mail-production` at `3a9d411`. Feature commit: `e5b1941`.
Staging published from revision `7bd65c6`; source has not been pushed.
See [staging QA](../../docs/qa/user-mailbox-access-staging-2026-10-12.md).

- Mailbox sidebar and inbox header no longer link to member management.
  Legacy `/mailbox/:id/members` bookmarks redirect administrators to Admin Users;
  ordinary users return to their mailbox.
- Mailbox ownership and membership never grant authority to assign permissions.
  Legacy membership list/add/remove APIs require global `mailbox.share`, enforce
  password-change restrictions, and retain their audit/idempotency guarantees.
- Admin Users offers mailbox selection during creation. Every selected mailbox
  receives the existing `admin` mailbox role (read/send/rename, with normal per-user
  message organization). Unselected mailboxes are not granted. This is mailbox
  operation access, not the global administrator role or member administration.
- Account, default member role, selected grants, content-free audit metadata and
  idempotency record are created in one D1 transaction. Initial passwords retain
  the one-time response contract and are redacted from persistence.
- Per-user Mailbox access supports no access, view only, view/send and full mailbox
  operation access. Each save affects one mailbox. Revocation removes the explicit
  membership immediately. Owned mailboxes show fixed implicit full access;
  ownership transfers and hard deletion are outside this change.

## Transport and boundaries

- `POST /api/v1/admin/users` accepts optional unique `mailboxIds` (up to 100).
  Granting selected mailboxes requires `user.manage` plus `mailbox.share`.
- `GET /api/v1/admin/mailboxes` lists active mailbox metadata on active domains.
- `GET /api/v1/admin/users/:id/mailboxes` projects that catalogue with the selected
  active user's current role (`owner`, `viewer`, `sender`, `admin`, or null).
  Both reads require `user.read` plus `mailbox.share`.
- `PUT /api/v1/admin/users/:id/mailboxes/:mailboxId` requires `user.manage`,
  `mailbox.share` and an Idempotency-Key; strict `{ role }` accepts viewer/sender/admin
  or null. Membership, `mailbox.member_access_changed` audit and idempotency are
  atomic. Replays do not mutate; changed bodies with the same key return 409.
- Tenancy owns mailbox grants and credential-free Identity summaries. Admin
  catalogue permissions never bypass private message authorization.
- Existing tables and roles are reused; no schema migration or existing-data
  rewrite. English/Chinese controls are provided. Query keys scope grants by both
  actor and target; successful saves update cached roles before refresh.

## Evidence

`pnpm verify` passed doctor 14/14, generated binding drift, ESLint, TypeScript,
web build, Worker dry build and 2,323 tests: 1,319 non-Worker, 980 Worker and
24 migration fixtures. Local Worker tests use actual workerd D1/KV bindings;
provider delivery is not part of this change. The final frontend cache/style
refinement passed focused tests (5/5), ESLint, TypeScript and web build.
`git diff --check` passed. Self-review only.

Worker coverage includes owner/member/admin denials, both required administrative
permissions, multi-mailbox default grants and isolation, viewer send denial,
sender send authorization, grant changes/revocation, invalid/owner/inactive
inputs, creation/grant rollback on audit failure, exact idempotency replay,
changed-body conflicts and concurrent same-key mutation.

Cua browser checks used the real React application with an explicitly synthetic
local API fixture. Creation selected two mailboxes and showed full access for
both; the third mailbox initially had no access, was assigned view/send, and a
selected mailbox was downgraded to view only. Chinese labels and desktop/mobile
layouts passed; the narrow layout had equal scroll/client width (375px).
Ordinary-user mailbox navigation showed no Members or Admin entry, and a legacy
member bookmark redirected to `/mailbox`.

Ignored local artifacts: `.tmp/user-mailbox-access-verify.log`,
`.tmp/user-mailbox-access-final-build.log`,
`.tmp/user-mailbox-access-desktop.png`, `.tmp/user-mailbox-access-mobile.png`,
and `.tmp/user-mailbox-browser-fixture.mjs`. Fixture accounts and displayed
password were synthetic only; no real account or mail access was changed.

## Acceptance boundary

Staging publication and independent HTTP smoke passed on 2026-10-12; all 34
remote migration companions passed without applying a migration. Worker version:
`ce628a61-f6a0-4785-9b36-7ce9120ac776`. Authenticated staging creation, grant
edit/revoke and ordinary-user denied cases still need real-account acceptance.
Production was not published.
Existing read-only/send grants remain unchanged; the full-access default applies
to mailboxes explicitly selected during new account creation.
