# Administration layout audit — staging QA

Date: 2026-10-12. Findings and local observations:
[handoff](../../work/handoffs/admin-layout-audit-2026-10-12.md).

## Release identity

- Origin: https://staging.unimailbox.tech.
- Revision: `530e555c346801995d5666dc34b49b60e3875bb9`, clean managed release worktree.
- Source digest: `6a2f3438c5b2191a701c5acf24462451ac195b7e0a50292940870fc901cfd12a`.
- Worker version: `26c88e52-3318-4389-8df7-cc7b0c83ae60`.
- Previous version: `0b8c0d4a-547d-4fe9-b9f6-35f023c8f957`.
- Manifest phase: `verified`; dirty: `false`.

## Verification

- Canonical `pnpm deploy:staging` passed doctor 14/14, generated binding types,
  lint, TypeScript, unit/web tests, builds, Worker tests and migration fixtures.
  Test totals: 1,332 non-Worker, 980 Worker and 24 migration fixtures = 2,336.
- Remote schema remains `0034`; all 34 migration companions passed; no migration
  was applied. The publication flow captured its recovery bookmark.
- Independent `/healthz` and `/readyz` returned HTTP 200 with `ok: true`.
  Health revision, source digest and Worker version matched the release manifest.
- All seven relevant served chunks matched their locally built bytes exactly:
  Users, Domains, Settings, AI Settings, Connections, Roles and Signatures.
  Each includes modal control and bottom action groups.
- Stylesheet `index-CY851ZQE.css` matched its built bytes exactly, including
  single-column configuration sections/fields, the existing user tags selector
  and AI key-button rules.
- Eight anonymous GET requests (users, mailbox catalogue, domains, settings,
  AI, roles, signatures and connections) returned 401
  `AUTHENTICATION_REQUIRED` with `Cache-Control: no-store`.
- Local synthetic browser observations confirmed desktop/mobile settings,
  domains, roles and signatures layouts; fixture-backed domain Save submitted
  successfully; role Cancel/reopen cleared unsaved input; the mock webhook Hide
  footer remained compact and restored trigger focus.
- Scoped staged Gitleaks and diff checks passed. Concurrent source/docs in the
  primary checkout were excluded. Self-review only.

## Boundary and evidence

Live checks establish exact published source/assets, health/readiness and the
anonymous authentication boundary. Interactive checks used local synthetic data;
no real administrator account write, provider call, routing acceptance, mail
delivery, upload or actual token/secret removal was performed. Overview and event
pages were source-inspected for these layout issues, not live-authenticated UI
acceptance. Production, push and PR publication were outside scope.

Private evidence: `.tmp/admin-layout-audit-deploy.log`,
`.tmp/admin-layout-audit-staging-smoke-20261012.json`, `.tmp/admin-audit-*.png`.
The recovery manifest is preserved privately at
`.tmp/admin-layout-audit-release/release.json` before archiving the release
worktree. Temporary browser tabs, local servers and viewport overrides were
cleaned up.
