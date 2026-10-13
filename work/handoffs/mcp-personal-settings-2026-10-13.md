# MCP personal settings revision

Implemented and published to the existing staging installation on 2026-10-13.
Application commit `eb72db8`; Worker `b5a54cc1-476f-4ee8-9d9d-4e887916412b`;
schema 0036. The full release gate passed 2,389 tests and all 36 remote schema
companions, after capturing a D1 recovery bookmark. Production was not changed.

Admin → AI services now contains one MCP card: service toggle plus shared prompt
view/edit/preview/reset. No separate MCP menu or personal credential form remains
in Admin. Ordinary users use Quick settings → MCP service to create scoped,
expiring read credentials and optionally grant drafts/AI and sending separately.
Write permissions are bounded by live global/mailbox access. Both screens copy
the same configured prompt only while enabled; credential protection and human
send-confirmation instructions are always appended without a secret.

Staging API/MCP evidence includes an ordinary member, viewer send denial, custom
prompt propagation, read handshake/discovery/scope, cross-user credential denial,
independent send discovery, hostile Origin and revoked credential rejection.
Temporary credentials were revoked, mailbox access removed and the test account
banned. Original toggle/prompt restored: MCP remains disabled. No private mail
content was read and no real mail was sent. Readiness and maintenance are healthy.

Design: `docs/rebuild/19-mcp-service.md`. Exact release, checks and limitations:
`docs/qa/mcp-personal-settings-staging-2026-10-13.md`. Browser clipboard, actual
local-agent configuration and real MCP delivery remain unverified. Review was a
main-agent self-review. Commits remain local; no push or PR was created.
