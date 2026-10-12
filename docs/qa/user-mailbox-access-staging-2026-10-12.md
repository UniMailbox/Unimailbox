# User mailbox access staging release — 2026-10-12

## Published source

- Origin: https://staging.unimailbox.tech
- Feature commit: `e5b1941`; released revision: `7bd65c6152585fa49d38418269d09467a93142c6`.
- Worker version: `ce628a61-f6a0-4785-9b36-7ce9120ac776`.
- Source digest: `743cf05ec5b5c5dfc7596d3bc7cc0b1fc62ac9c06c9ff43c25db33f69b66f77b`.
- Clean branch: `codex/admin-user-mailbox-access`.
- Publication used `pnpm deploy:staging`, the canonical staging target and exact
  checked source/assets. Previous version: `7747f536-f15e-42c5-a0a7-41d0c53be2b2`.

## Checks and live evidence

The publication gate passed doctor 14/14, generated binding drift checks,
ESLint, TypeScript, frontend/Worker builds and all 2,323 tests: 1,319
unit/frontend/contracts/scripts, 980 Worker and 24 migration fixtures.
Redacted Gitleaks 8.30.1 scans passed for the staged feature and design/handoff
changes. All 34 remote migration companions passed; no migration was pending
or applied. Schema remains 0034. Existing resource identities and active
secret metadata passed the release checks; no resource bootstrap or secret
rotation was performed.

The standard deployment smoke passed exact version/source digest, readiness,
completed installation, frontend entry/security headers, immutable JavaScript
asset serving, missing asset/source-map/API 404 behavior and protected admin
API authentication. An additional independent HTTP pass confirmed:

- `/healthz` and `/readyz` return 200; health revision, version and source digest
  match the prepared release, and readiness reports schema 0034.
- Unauthenticated GET `/api/v1/admin/mailboxes`, GET
  `/api/v1/admin/users/:id/mailboxes`, PUT
  `/api/v1/admin/users/:id/mailboxes/:mailboxId`, and GET
  `/api/v1/mailboxes/:id/members` return 401 `AUTHENTICATION_REQUIRED` with
  `Cache-Control: no-store`. UUIDs were synthetic; no authenticated grant was
  created or changed during this check.
- Published `UsersPage-BqH28P_x.js` contains the new assignment catalogue path,
  full-access default copy and permission controls. The published main entry
  includes the Chinese assignment labels.

Private release manifest/recovery bookmark and raw logs remain in ignored
`.tmp/releases/`. Safe HTTP result: `.tmp/user-mailbox-staging-smoke-20261012.json`.
Deployment log: `.tmp/user-mailbox-staging-deploy-20261012.log`.

## Acceptance boundary

This establishes staging publication, schema/readiness, frontend delivery and
unauthenticated HTTP enforcement. The earlier desktop/mobile browser checks
used synthetic local APIs, while Worker tests used local workerd/D1 bindings.
Authenticated staging creation, permission change/revocation and ordinary-user
403 scenarios have not been exercised against real accounts during this release.
No real account grants, mailbox ownership, message content or provider settings
were modified for verification. Production was not published, and source was
not pushed.

Behavior and local evidence: [handoff](../../work/handoffs/user-mailbox-access-2026-10-12.md).
