# CAP-069 — General settings administration

**Archived:** 2026-09-01
**Status:** Implemented locally

## Goal

Give an administrator a safe, auditable `/admin/settings` surface for the
deployment's typed system-policy values, with read-only environment metadata
and no access to provider credentials.

## Delivered scope

- Added strict contracts and a closed typed projection over the existing
  `system_settings` key/value table.
- Added repeat-safe migration `0025_system_settings_revision.sql` to seed and
  normalize the internal revision row used by full-document `If-Match` writes.
- Added `GET/PATCH /api/v1/admin/settings` with independent
  `settings.read`/`settings.manage` authorization.
- Added strict field bounds, malformed-storage fail-closed handling, request
  hash idempotency, byte-identical replay, atomic settings/audit/idempotency
  writes, and stale-write rejection.
- Added `/admin/settings`, user-scoped query state, accessible loading/error/
  read-only/success states, conflict refresh/retry recovery, and navigation.
- Updated the post-setup operator URL runbook and capability ledger.

## Explicit exclusions

- Brevo/provider credentials, encrypted credentials, webhook secrets, blocklist
  administration, deployment, preview verification, and push.
- Runtime enforcement of the policy fields and retention cleanup consumers;
  those remain with their owning capabilities / Phase 4.
- Setup wizard re-entry remains `D-CAP-063-A`.

## Acceptance result

All seven acceptance criteria and the full vertical slice are complete. The
API exposes only the documented typed fields and runtime environment, while
the Web page never renders arbitrary system settings or secrets. Reader access
is read-only, denied permissions do not reveal cached data, and stale conflict
recovery cannot re-enable the old form before the latest values are installed.

## Verification

- SettingsPage focused Web tests: 6/6.
- Focused Worker settings routes: 10/10.
- Focused migration tests: 17/17.
- Full unit suite: 85 files, 1203/1203 tests.
- Full Worker/D1 suite: 54 files, 925/925 tests; existing live Brevo tests
  passed using the configured local token.
- `pnpm scaffold doctor`: 14/14; lint, typecheck, format, and `git diff --check`
  passed; build passed with the existing Vite bundle-size warning only.
- Independent final subagent review: `NO FINDINGS`. Earlier findings on same-key
  idempotency/CAS ordering, stale refresh recovery, revision migration
  normalization, and refresh synchronization were fixed and re-reviewed.
- No preview verification, deployment, provider/token change, or push.
