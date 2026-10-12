# Administrator operation modals staging release — 2026-10-12

## Published source

- Origin: https://staging.unimailbox.tech
- Feature commit: `409ab7d`; restore-copy correction: `f4088ee`.
- Released revision: `f4088ee6f0ac0dfdc186aa22db5b2922533358ce`; clean `codex/admin-user-mailbox-access`.
- Worker version: `b562ed68-afb0-4cd0-999d-392ceab327a9`; previous version: `ce628a61-f6a0-4785-9b36-7ce9120ac776`.
- Source digest: `d38ec49553a361ce4d9a9d40ebef1a9bf7ed8f9df21897f42fe478b9b3d57c32`.
- Published through `pnpm deploy:staging`; manifest phase `verified`.

## Validation

The exact-source publication gate passed doctor 14/14, generated bindings,
ESLint, TypeScript, frontend/Worker builds and 2,330 tests: 1,326 non-Worker,
980 Worker and 24 migration fixtures. All 34 remote migration companions passed;
no migration was applied, schema remains 0034. Target account/resources and active
secret metadata checks passed. No bootstrap or credential rotation was performed.
Scoped staged Gitleaks scans passed for the feature, copy correction and documents.

Canonical release smoke passed installation status, health/readiness, release
identity, frontend/security headers, immutable hashed JavaScript, missing
asset/source-map/API handling and unauthenticated admin access. Independent live
HTTP checks confirmed:

- Health/readiness return 200; version/revision/source digest match this release.
- Users, mailbox catalogue, domains, settings and AI admin GET endpoints reject
  unauthenticated requests with 401 `AUTHENTICATION_REQUIRED` and `no-store`.
- All five changed admin page chunks return 200 and include the expected modal
  controls. Published main JavaScript includes the new Chinese editor/confirmation copy.

Published frontend resources:

| Page | Asset |
| --- | --- |
| Users | `UsersPage-B5g2lUua.js` |
| Domains | `DomainsPage-DpnAiQjV.js` |
| Settings | `SettingsPage-B_qoQHOJ.js` |
| AI | `AiSettingsPage-DcxCVjB4.js` |
| Connections | `ConnectionsPage-D2e08BXl.js` |

Private manifests/recovery bookmarks and raw logs remain under ignored `.tmp/`.
Safe result: `.tmp/admin-modal-staging-smoke-20261012.json`.

## Acceptance boundary

Desktop/mobile modal interactions were observed against synthetic local HTTP
fixtures, not real staging accounts. The exact published frontend and unauthenticated
HTTP enforcement are verified live. Authenticated staging create/reset/status,
mailbox grants and configuration writes were not exercised in this release. No
real user grants, passwords, mailbox ownership, provider/AI configuration or mail
content were changed for verification. Production was not published; source was
not pushed. Self-review only, no independent agent review.

Behavior and local observations: [handoff](../../work/handoffs/admin-operation-modals-2026-10-12.md).
