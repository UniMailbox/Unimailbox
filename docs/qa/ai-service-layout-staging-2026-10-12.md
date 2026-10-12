# AI service layout — staging QA

Date: 2026-10-12. Scope and local UI observations: [handoff](../../work/handoffs/ai-service-layout-2026-10-12.md).

## Release identity

- Origin: https://staging.unimailbox.tech.
- Revision: `38e723268e5e07e73d6bf42185491e2d1decc8eb` from a clean managed release worktree.
- Source digest: `32c2054219057691321d39fb0be047cd880ab3045f51e05b176f64121101f6b2`.
- Worker version: `0b8c0d4a-547d-4fe9-b9f6-35f023c8f957`.
- Previous version: `55a3b5ca-e36d-4ed2-9e00-cb6f951b4220`.
- Manifest phase: `verified`; dirty: `false`.

## Verification

- Canonical `pnpm deploy:staging` full gate passed: doctor 14/14, generated types,
  lint, TypeScript, builds, 1,330 non-Worker tests, 980 Worker tests and 24 migration
  fixtures (2,334 total). Focused AI UI suite: 8/8.
- Remote schema remains `0034`; 34 migration companions passed; no migration applied.
- Independent `/healthz` and `/readyz` returned 200/ok. Health version, source digest
  and revision matched the exact release manifest.
- Five served admin page chunks matched their built bytes exactly. AI chunk
  `AiSettingsPage-Cd7xUn9c.js` includes the corrected API Key control and modal behavior.
- Served stylesheet `index-C-9td8-Z.css` matched its built bytes exactly and includes
  the AI page summary and compact destructive-key-button rules.
- Users, mailbox catalogue, domains, settings and AI endpoints reject anonymous GET
  requests with 401 `AUTHENTICATION_REQUIRED` and `no-store`.
- Local synthetic browser observations at 1280 x 720 and 390 x 844 confirmed the
  header action, single content area, key-label-aligned compact removal button,
  Undo restoring the enabled state and no horizontal overflow.
- Scoped staged Gitleaks passed. Concurrent primary-checkout updates/docs were
  excluded from the release. Self-review only; no independent agent review.

## Boundary

Live checks establish published source/assets and the anonymous API boundary.
Interactive browser checks used synthetic local data. No actual stored token was
removed/replaced; no provider inference, real-account write or mail delivery was
performed. Production, push and PR publication were outside scope.

Private evidence is under `.tmp/ai-layout-*`; the recovery manifest is preserved
at `.tmp/ai-layout-release/release.json`.
