# Administration layout audit

Date: 2026-10-12. Implementation: `530e555c346801995d5666dc34b49b60e3875bb9`.

## Scope and changes

The audit follows the user creation and AI service layout corrections. It checks
the other administration pages for split editor forms, misplaced or stretched
action buttons, and cancellation behavior.

| Area | Finding and final behavior |
| --- | --- |
| General settings | Section explanations were beside two-column fields. Each section now places its heading above a single column of fields. Cancel and Save are adjacent in the bottom save bar. |
| Domains | Configuration Save was above the routing instructions and routing confirmation stretched across the dialog. Routing confirmation now belongs to the routing card; global Cancel/Save follow all content and feedback. Save retains native form association. Add-domain errors precede its footer and have the referenced error ID. |
| Roles | Create/edit lacked a bottom Cancel action. Both now use a bottom Cancel/submit group. Cancel discards unsaved edits; closing a new-role modal also clears values and permission selections. |
| Signatures | Fields were already single-column. Create/edit now have a bottom Cancel/submit group, and cancellation restores saved values or clears the new form. |
| Connections | One-time webhook display now has a separate compact Hide action at the bottom. Closing still clears the displayed value and restores focus. |
| Users | The one-time password Done button now belongs to a bottom action group instead of stretching across a grid row. Other user editors already use the corrected single-column layout and mailbox tags selector. |
| AI configuration | The footer now follows conflict/error feedback and sits outside the disabled fieldset, allowing Cancel during a revision conflict. Save remains blocked until refresh. The page header/summary and key removal control retain the previous correction. |
| Overview, audit events, webhook events | Source inspection found no matching split editor or modal action-layout issue. These are summaries or event filters rather than editor forms. |
| Destructive confirmations | Shared AlertDialog already places Cancel and the confirmation action in its footer; retained. |

No backend or API contract changes are part of this implementation. Concurrent
upstream-update code and documentation changes in the primary checkout are
excluded from the release.

## Local evidence

- Administration web suite in the primary checkout passed: 17 files, 125 tests.
  This count includes the concurrent untracked UpdatePanel suite; it is not the
  clean release gate count. New coverage checks role/signature cancellation;
  existing AI conflict coverage now verifies that Cancel remains enabled and
  closes the dialog.
- Synthetic local browser checks used an isolated fixture, mock account/domain
  records and fake webhook text. Settings, domains, roles and signatures were
  observed at 1280 x 720 and 390 x 844.
- Settings section headings and fields each resolve to one grid column; the
  mobile form has equal client/scroll widths and its save bar remains visible.
- Domain Save is below the routing card, confirmation has a natural 90px width,
  and the external form-associated Save submits and closes the modal successfully
  against the fixture. The mobile modal has equal client/scroll widths.
- Cancel/reopen of a new role clears its name. Its long permission catalogue
  remains scrollable; permissions are a checklist, not a split form editor.
- Signature fields remain one column with no horizontal dialog overflow and
  bottom Cancel/Add actions. The fixture has no upload policy, so its upload
  controls show an unavailable-policy state; uploads were not exercised.
- The synthetic webhook display has a 54px Hide button in its own bottom action
  group; hiding removes the mock value and restores the reveal trigger focus.
- Password footer and existing edit forms were inspected in source and covered
  by the user suite, rather than an additional interactive account creation.
- Scoped staged Gitleaks and `git diff --check` passed. Self-review only.

Private screenshots and fixture logs are under `.tmp/admin-audit-*` and
`.tmp/admin-layout-audit-*`. Temporary browser tabs and local servers were closed.

Published release identity and independent live checks are recorded in
[staging QA](../../docs/qa/admin-layout-audit-staging-2026-10-12.md).

## Verification boundary

Interactive observations used local synthetic data. They do not prove real
administrator writes, provider operations, routing/delivery, upload behavior or
actual credential disclosure/removal. Live release checks establish published
source/assets, health/readiness and anonymous access rejection. No production,
push or PR publication is part of this task.
