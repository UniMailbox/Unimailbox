# Personal settings and localization

The account avatar and sidebar identity open the same right-hand quick-settings
panel. Changes save independently to the signed-in account; failed writes retain
the last saved value and expose a retry. The panel includes private avatar upload,
default mailbox, language, system/light/dark theme, comfortable/compact density,
no/right/bottom reading pane and an inline password form. It uses the existing
shadcn Sheet, Avatar, Button and form primitives without new dependencies.

Language and theme share adjacent ghost icon buttons (Lucide Languages and
Sun/Moon) in the auth/setup and mailbox/admin headers. Quick settings reuses the
same pair under Appearance instead of a separate language row and theme radios.
Authenticated choices save through the account preference API. Anonymous theme
and locale choices remain browser preferences. A failed account write keeps the
menu open with a localized code-based error and preserves the saved choice.
Portaled preference menus render above the quick-settings rail so their options
remain visible and clickable inside the panel.

## Persistence and access

Migration 0031 adds identity-owned `user_preferences`, keyed by user ID. Language
is `en` or `zh-CN`; initial values are English, system theme, comfortable density,
no reading pane and automatic mailbox selection. Partial preference updates and
avatar metadata writes commit with audit and idempotency records in one D1 batch.
User deletion cascades; mailbox deletion sets the default reference to null.

The default mailbox must be active and readable by the current user when saved.
The login landing route waits for account preferences, then resolves against the
current accessible mailbox list. Revoked, deleted or inactive defaults fall back
to an available mailbox. Temporary mailbox switching does not change the account
default. Automatic selection prefers the user's own address, ownership, then the
first active mailbox. All mailboxes remains directly accessible in navigation.

Avatar uploads validate MIME, raster signature and actual byte count (2 MiB).
Immutable private R2 keys are never exposed in API projections. Authenticated
GET returns private/no-store bytes; the frontend shares a short-lived Blob URL
between header, sidebar and panel and revokes it on replacement/unmount. Old
objects are removed after metadata commits. A bounded scheduled sweeper removes
unreferenced objects older than 24 hours, retaining ambiguous recent uploads.

Existing password-change behavior is reused: 6–30 characters, current password
required, current session retained and other sessions revoked. First-login forced
password change remains a separate guarded route.

## Language and errors

`infrastructure/i18n/locale.ts` provides live English/Simplified Chinese switching,
interpolation and localized dates. Authenticated language comes from D1. Only the
last public locale hint is cached locally so login can use the same language.
Mail bodies, subjects, addresses, identifiers and API enum values remain raw data.
Compose stays mounted while account language/theme/layout changes.

`packages/contracts/src/errors.ts` owns all stable error codes. Worker platform
reexports it; `error-messages.ts` has an exhaustive bilingual mapping. ApiError,
ErrorPanel, input validation, auth recovery and render-error fallbacks use codes
instead of comparing or displaying backend English messages. Unknown codes,
network failures and non-JSON responses have safe localized fallbacks. Unknown
Worker routes return the normal error envelope; missing refresh credentials use
401 / REFRESH_TOKEN_REQUIRED.

Reading-pane selection is local to the mailbox/folder. Only an explicit message
click opens details; right/bottom desktop panes scroll independently. Narrow
screens show the selected detail with a close action returning to the list.
Drafts keep their existing recovery flow. Modified clicks retain normal links.

Deployment and acceptance: [QA record](../qa/personal-settings-2026-10-07.md).
The compact controls follow-up is recorded in
[appearance controls QA](../qa/appearance-controls-2026-10-07.md).
