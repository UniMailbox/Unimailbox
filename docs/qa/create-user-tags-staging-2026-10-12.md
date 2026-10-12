# Create-user tags and single-column layout — staging QA

Date: 2026-10-12. Scope and browser geometry: [handoff](../../work/handoffs/create-user-tags-2026-10-12.md).

## Published source

- Origin: https://staging.unimailbox.tech.
- Revision: `44f28b48880446d77fbaa753b24080acbd08dd22` from a clean managed release worktree.
- Source digest: `6a69296713a7691c40993fa91a7f1dab5ce7e5edf38b2f684e1d819eeb0a461f`.
- Worker version: `55a3b5ca-e36d-4ed2-9e00-cb6f951b4220`.
- Previous version: `b562ed68-afb0-4cd0-999d-392ceab327a9`.
- Manifest phase: `verified`; dirty: `false`.

## Evidence

- Canonical `pnpm deploy:staging` ran the full `pnpm verify` gate successfully:
  1,328 non-Worker tests, 980 Worker tests, 24 migration fixtures (2,332 total).
- Remote schema remains `0034`; all 34 verification companions passed;
  no pending migration was applied.
- Independent `/healthz` and `/readyz` requests returned 200/ok. Health revision,
  source digest and Worker version matched the verified manifest exactly.
- Users, mailbox catalogue, domains, settings and AI endpoints rejected
  unauthenticated GET requests with 401 `AUTHENTICATION_REQUIRED` and `no-store`.
- Five served admin page chunks matched their built bytes exactly.
  `UsersPage-Boju1JRA.js` contains the tags selector and search labels.
- Served `index-d-a38DId.css` matched built bytes exactly and includes the
  single-column create-user form and tags-control rules.
- Local synthetic browser observations at 1280 x 720 and 390 x 844 confirmed one
  column, footer below fields/options, no form horizontal overflow, search and
  removable tags. The related account/assignment test files passed 22/22.
- Staged secret scanning passed. Concurrent primary-checkout software-update and
  documentation edits were excluded from the clean release.

## Acceptance boundary

The live checks prove the published source/assets and unauthenticated API boundary.
The interactive browser checks used synthetic local accounts, not staging account
creation or live mailbox grants. No provider delivery or real mail flow was tested
for this UI correction. Production, push and PR publication were not performed.

Private logs and safe results remain under `.tmp/create-user-tags-*`. Recovery
manifest is preserved privately at `.tmp/create-user-tags-release/release.json`.
