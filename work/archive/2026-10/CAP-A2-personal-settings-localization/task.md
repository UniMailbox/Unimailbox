# Personal settings and localization

User-requested follow-up: replace the account dropdown with a Gmail-inspired right settings panel; avatar, password, default mailbox, theme, list density and reading pane; persistent English / Simplified Chinese language and shared error codes. Preserve unrelated dirty files. No new dependencies. Identity owns user_preferences; avatars use private R2 objects, never provider email attachments. Own settings require authentication, not administrator permission. Partial updates, audit and idempotency share one atomic D1 batch. Verify local gates, real staging API and browser; record limitations separately.

Reference: https://workspaceupdates.googleblog.com/2020/05/new-gmail-quick-settings-optimize-inbox.html

Completed: account panel, private R2 avatar, password form, persistent default
mailbox/display preferences, English/Simplified Chinese UI and shared error-code
catalog. Local gates and staging API/browser acceptance recorded in
`docs/qa/personal-settings-2026-10-07.md`; design promoted to
`docs/rebuild/17-personal-settings-localization.md`. Final staging checks and
temporary-account/session/settings cleanup are complete; archived for audit.
