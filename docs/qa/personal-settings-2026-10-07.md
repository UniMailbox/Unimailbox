# Personal settings, localization and error codes — 2026-10-07

Environment: https://staging.unimailbox.tech. Worker: `unimailbox-staging`.
Schema: 0031. Final version: `84e7cd30-60a2-4cd5-8c23-f85af7cb0fe8`.
Existing dirty work preserved; no commit, push or production operation.

Behavior and API/storage design: [personal settings](../rebuild/17-personal-settings-localization.md).

## Local checks

Evidence stays gitignored under `.tmp/personal-settings-20261007/`.

| Check | Result | Evidence |
|---|---|---|
| Unit / web / contracts / scripts | 95 files, 1,279 tests passed | `unit-final.log` |
| Worker binding-backed suite | 54 files, 888 tests passed | `worker-full.log` |
| Migration / test-kit Worker | 19 tests passed | `worker-full.log` |
| TypeScript, source ESLint | passed | `typecheck-final.log`, `lint-source-final.log` |
| Doctor | 14/14 passed | `doctor-final.log` |
| Production web build | passed | `web-build-final.log` |
| Source Worker dry-run and deployment | exited successfully | `bundle.log`, `deploy-final.log` |

Worker tests exercise actual D1/R2 bindings: own-user isolation, authentication,
forced-password-change gate, strict preference validation, mailbox authorization,
idempotent replay/conflict, audit failure rollback, private avatar bytes and
invalid/oversize uploads. Web tests cover server persistence, failed writes,
localized errors, exhaustive bilingual error-code coverage and updating a closed
select's label without changing its API value.

Root `pnpm lint` also scans pre-existing generated bundles under
`apps/worker/.tmp/`; those vendor bundles cause lint failures. Source validation
uses `eslint . --ignore-pattern '**/.tmp/**'`. No lint rule or production code was
weakened. A body-length validation test initially exposed a raw code at the
editor boundary; it now receives localized error text and the complete suite
passes. The final UI changes were followed by the complete non-Worker rerun;
the binding-backed Worker implementation is unchanged since its passing run.

## Staging acceptance

- Exported a private D1 SQL backup before migration (`staging-before.sql`, mode
  0600). Applied only pending 0031. All four verification assertions passed;
  `PRAGMA foreign_key_check` returned no rows. Existing bindings, secrets and
  domain routing were reused.
- Member preferences persisted after logout/relogin. Exact idempotent replay
  succeeded; changing the payload under the same key returned 409. Saving an
  inaccessible mailbox as default returned 403.
- A temporary read-only sharing grant exposed a second mailbox in the settings
  selector. The configured default opened through `/mailbox`; switching to the
  other mailbox did not change it. Removing the grant made the same entry route
  fall back to the member's available mailbox. The temporary grant is removed.
- Private avatar GET matched the uploaded PNG bytes and used private/no-store
  caching. Replacement, removal and browser upload worked; header/sidebar/panel
  used loaded Blob images. SVG and anonymous access were rejected.
- A dedicated temporary account accepted a six-character password. Changing it
  retained the current session, rejected the old password and revoked another
  session. The QA account was deleted; existing administrator passwords were
  never changed.
- An intentionally wrong current password produced INVALID_CREDENTIALS. The
  mounted error changed from English to Chinese when language changed, retaining
  the same code. Missing refresh credentials returned 401 / REFRESH_TOKEN_REQUIRED;
  an unknown API route returned the canonical NOT_FOUND envelope.
- Real browser verified English/Chinese mailbox, editor and account settings;
  language changes retained an unsent subject and mixed Chinese/English body.
  Raw mail subjects/bodies remained unchanged. Dark theme and bottom reading pane
  applied; the right pane opened only after an explicit message click.
- Desktop 1440 × 900: settings width 400 px, aligned to the 1425 px layout edge.
  Right pane grid measured approximately 463 + 602 px. Mobile 390 × 844: settings
  x=0, width=375 px, height=844 px; document width=375 px, without horizontal
  overflow. Selected mobile message detail measured 343 px and hid the list;
  closing it returned to the list.
- Admin general-settings UI was checked in Chinese. Its recipient-policy value
  and save button exposed translation omissions during acceptance; these were
  fixed and rechecked after the final deployment. Browser page-error log is empty.

Screenshots: `settings-english.png`, `settings-mobile.png`,
`reading-pane-desktop.png`, `admin-settings-zh-final.png`. The body screenshot on
mobile includes page height below the fixed viewport panel; bounds above are
measured from the actual viewport.

No new delivery was needed for this settings/localization change. This does not
replace the earlier real-mail evidence or claim completion of all 175 original
acceptance cases. Scheduled avatar orphan cleanup is configured and bounded in
code; an actual scheduled cleanup run was not observed in this acceptance.

Original member/admin account preferences and member avatar are restored and
verified. The unsent browser draft, temporary sharing grant, owned browser
sessions and saved QA auth profiles are removed. Private credentials and SQL
backup remain gitignored. No manual DNS, R2 or secret configuration is required.
