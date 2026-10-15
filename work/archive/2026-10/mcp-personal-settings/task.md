# MCP administration and personal settings revision

Requested 2026-10-13. Implement directly; no delegated work.

- Place the service toggle and editable shared setup prompt in a single AI services card; remove the separate MCP menu/page.
- Allow signed-in ordinary users to manage only their own mailbox-scoped credentials in Quick settings when enabled. Keep read, draft/AI and send grants independent and bounded by live global/mailbox permissions.
- Improve the form, show expiry/scope/status, expose the credential once without caching it, and copy the administrator's prompt without secrets only while enabled.
- Preserve deployed migration 0035, credentials, resource identities and keys. Add replay-safe 0036 for the prompt. Keep transport protection and server request limits.
- Verify allowed/denied personal access, ownership isolation, prompt persistence, disabled behavior and frontend flows. Run the canonical release gate, commit only owned paths, and deploy the same authorized staging installation. No production changes or real mail sends.

Acceptance: source, local gates and staging API checks separately recorded. Browser/local-agent configuration remains unverified unless observed.

Completed: application commit `eb72db8`, full 2,389-test release gate, migration
0036/all 36 companions, staging publication and ordinary-user MCP/API checks.
Self-review and staged secret checks passed. Evidence and remaining browser/agent
boundaries: `docs/qa/mcp-personal-settings-staging-2026-10-13.md`.
