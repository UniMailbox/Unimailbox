# Routine page content cleanup — 2026-10-07

Deployed `unimailbox-staging` version
`f9128075-81db-4d73-9e3e-92b92dcaadc8` to
<https://staging.unimailbox.tech>. Web changes only; no new migration, binding,
backend behavior or dependency.

Removed the duplicate All mailboxes folder-menu entry, sidebar group captions,
shared-header page names, routine admin introductions and repeated list/loading
explanations. Inbox mailbox context is beneath its folder title; mailbox lists
start with their rows. Empty folders use one icon and sentence without a nested
card. Login omits repeated instructions/footer; quick settings retains an
accessible description without its visible save-status introduction.

Local validation passed: 1,280 unit tests across 95 files, workspace TypeScript,
source ESLint, doctor 14/14, production web build and diff whitespace check.
Three initial assertions expected the previous heading/link placement; existing
tests now check mailbox context and the switcher's menu item. No test was skipped.
Worker tests were not rerun because this follow-up changes presentation only.
Source lint excludes existing scratch bundles, as in the preceding QA records.

Real staging browser verified desktop and 390 × 844 mobile navigation through
Switch mailbox → All mailboxes. The list page keeps usable folder links; Inbox
returns to the resolved mailbox. Mobile selection closes navigation and has no
horizontal overflow. The archive empty state has one folder heading, one card
and one empty message. Before/after screenshots and mobile screenshots were
inspected. Account language, theme, avatar and reading-pane preferences were used
without changing them; no mail or configuration mutation was performed.

Necessary upload constraints, permission/read-only explanations, configuration
limitations, destructive confirmation and operation feedback remain in place.
All nine administration routes rendered their page title without a repeated
intro; settings-policy and domain-verification notes were still present. Quick
settings retained its accessible description and avatar-size hint. No browser
page exceptions were reported.
The 390 px login page had no repeated form intro/footer and no overflow. The QA
session was signed out; its owned browser and temporary auth-vault profile were
closed/removed.
