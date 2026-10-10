# Appearance controls staging acceptance — 2026-10-07

Deployed `unimailbox-staging` version
`9a946919-ee50-43c8-a357-f08c4c7238c7` to
<https://staging.unimailbox.tech>. This follow-up changes web controls only;
schema remains 0031 and bindings are unchanged.

Language and theme use adjacent Lucide icon buttons in the auth/setup and
mailbox/admin headers. Quick settings reuses them under Appearance. The login
form no longer has a separate language row. Authenticated choices save to the
account; anonymous choices use the existing browser preferences.

Real browser checks covered anonymous English/Chinese and dark login, authenticated
header changes surviving reload, and language/theme saves from the quick-settings
panel. API reads independently confirmed the saved values. The panel initially
occluded its portaled menu at z-index 50; preference menus now render at 80 above
the rail at 70. Actual pointer hit-testing and successful panel saves verified
the correction after deployment.

At 390 × 844, language/theme buttons are both 36 × 36, aligned with a 4 px gap;
login and mailbox have no horizontal overflow. Desktop checks used 1440 × 900.
Screenshots were inspected. No browser page exceptions were reported.
The administrator's settings page also showed the same button pair; administrator
preferences were not changed. The member's original preferences were restored and
verified by API after acceptance.

Local validation: 1,280 unit tests, workspace TypeScript, source ESLint, doctor
14/14 and production web build passed. After the layer correction, the three
focused preference tests, focused ESLint and production build passed again.
Failure coverage verifies that an unsuccessful account update retains its saved
theme and open menu with a localized error. Worker code was unchanged and its
tests were not rerun for this follow-up. The source lint exclusion for preexisting
scratch bundles is documented in the preceding personal-settings QA record.

Credentials were verified through real login without resetting the password;
credentials are excluded from this record. No email, migration, commit or push.
