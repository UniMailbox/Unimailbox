# AI service layout and saved-key control — 2026-10-12

## Behavior

Implementation: `38e723268e5e07e73d6bf42185491e2d1decc8eb`.

- AI services has one full-width configuration summary. The former description
  column and editing-action column are merged into PageHeader. Permission-aware
  editing stays in the page header; read-only operators retain the summary.
- Loading and failure states retain the page title and description. The editor
  remains a bounded modal using the existing API, revision and credential rules.
- Saved-key removal is a compact destructive-text button alongside the API Key
  label, instead of a standalone full-width action below the input. It appears only
  when a key exists for the unchanged backend destination.
- Clicking Remove marks removal, clears any typed replacement, disables AI and
  shows the existing pending-removal message. No request occurs until Save. Undo
  restores the previous enabled state and preserves the stored key. Cancel discards
  pending removal. Saving explicit removal still sends `apiKey: null`.
- Changing destination clears the typed key as before. Blank unchanged key input
  preserves the saved key. Credentials are never returned or cached as form data.

## Local evidence

- AI configuration tests: 8/8, including explicit removal, Undo preserving key and
  enabled state, no removal for an absent key/changed destination, cancelled edits,
  stale revision, read-only access, and mutation/query secret omission.
- Synthetic local browser at 1280 x 720: old column wrappers absent, editing action
  inside PageHeader, summary width 889.22px in a 939.22px main content area.
- At 390 x 844, main client/scroll width both 358px; modal key-row and input width
  both 308px. Removal button width 161.95px, alongside its label above the input.
  No horizontal overflow. Remove/Undo and cancellation were observed; Undo restored
  the enabled switch. No real account or live credential was used or modified.
- Private screenshots: `.tmp/ai-layout-page-desktop.png`,
  `.tmp/ai-layout-page-mobile.png`, `.tmp/ai-layout-modal-desktop.png`,
  `.tmp/ai-layout-modal-mobile.png`. Temporary browser/servers were closed.
- Scoped staged secret scan passed. Self-review only, no independent agent review.

## Delivery

A clean managed release worktree excludes concurrent documentation/software-update
work in the primary checkout. Canonical `pnpm deploy:staging` completed its full exact-source gate: doctor
14/14, generated types, lint, TypeScript, builds, 1,330 non-Worker tests, 980 Worker
tests and 24 migration fixtures (2,334 total). All 34 remote migration companions
verified; none was applied. See the [staging QA record](../../docs/qa/ai-service-layout-staging-2026-10-12.md)
for release identity and independent live HTTP/asset evidence.
Shared ledger/log files contain concurrent edits and are preserved; this scoped
handoff records the correction separately.

Production, source push and PR publication are outside this correction. Browser
observations are synthetic local UI evidence; they do not establish live key
removal, provider inference or real-mail acceptance.
