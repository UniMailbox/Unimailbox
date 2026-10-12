# Create-user form and mailbox tags — 2026-10-12

## Behavior

Implementation: `44f28b48880446d77fbaa753b24080acbd08dd22`.

- The create-user modal uses one column at every width. Cancel/Create are the final
  form row; creation errors appear above those buttons.
- Mailbox assignment uses a searchable multiple-selection combobox. Selected
  existing mailboxes appear as removable tags. Filtering matches address or display
  name, ignores case, and never creates a mailbox or submits typed text as an ID.
- Arrow keys move the active option and scroll it into view. Enter toggles selection
  without submitting the account form. Escape first closes expanded options, then
  closes the modal. Pending creation disables the selector and removal controls.
- Creation still submits selected mailbox UUIDs through the existing API. Selected
  mailboxes retain the previously implemented default full-access assignment.
  Closing/reopening clears selection. Existing per-user permission editing is retained.

## Evidence

- Focused account/assignment tests: 22/22, including filtered multi-selection,
  removal, submitted IDs, keyboard non-submission, nested Escape and fresh reopen.
- TypeScript, lint and scoped staged Gitleaks passed.
- Browser checks used a synthetic local HTTP fixture, without creating real accounts
  or changing real grants. Desktop 1280 x 720: a single 622px form column, fieldset
  bottom 568.75px, footer top 592.75px. Mobile 390 x 844: a single 308px column,
  fieldset bottom 657.5px, footer top 681.5px and footer bottom 717.5px.
  Both had no form horizontal overflow. Search, selection, tag removal and Escape
  were observed. Screenshots are private `.tmp/create-user-tags-desktop.png` and
  `.tmp/create-user-tags-mobile.png`; temporary browser/servers were closed.
- Self-review only. No independent agent review.

## Release

The release is prepared from a clean managed worktree at the implementation commit,
excluding concurrent documentation/software-update work in the primary checkout.
The canonical `pnpm deploy:staging` completed its full exact-source gate: doctor
14/14, generated types, lint, TypeScript, builds, 1,328 non-Worker tests, 980 Worker
tests and 24 migration fixtures (2,332 total). All 34 remote migration companions
verified; no migration was applied. The [staging QA record](../../docs/qa/create-user-tags-staging-2026-10-12.md)
records exact release identity and independent live asset checks. Shared ledger/log
files already contain concurrent work and were left untouched; this scoped handoff
records the correction separately.

Production, source push and PR publication are outside this correction. Synthetic
browser evidence is not real-account acceptance or live mail-delivery evidence.
