# MCP service handoff

Historical 2026-10-12 snapshot. The administration/personal-settings split and
current deployment are recorded in `work/handoffs/mcp-personal-settings-2026-10-13.md`.

Implemented and published to staging on 2026-10-12. Application commit `6701e04`;
Worker `7c94c494-ea3a-4875-9e34-96c55a9511c7`; schema 0035. Production was not
changed. Final standard release gate passed 2,381 tests and all 35 remote schema
companions after a D1 recovery bookmark was captured.

Use Admin → MCP service (`/admin/mcp`) to enable the HTTPS endpoint, adjust its
per-credential rate, create mailbox-scoped credentials and copy a credential-free
local-agent setup prompt. Read, drafts/AI replies and sending have independent
credential gates. Sending also requires the installation send switch and the
current user's actual global/mailbox permissions; the existing compose/outbox
workflow handles persistence, audit and idempotency. Credentials are hash-only,
expiring, one-time, revocable and restricted to the issuing user's selected mailboxes.

Live staging handshake/discovery, scoped mailbox listing, Origin denial,
revocation and final disabled-service boundary passed. The temporary credential
was revoked and original configuration restored: **MCP remains disabled**.
No private mail content was fetched and no real email was sent.

Design, exact SDK provenance and security limits:
`docs/rebuild/19-mcp-service.md`. Evidence and remaining acceptance:
`docs/qa/mcp-staging-2026-10-12.md`. Browser clipboard and actual local-agent
configuration are not proven by the synthetic Web tests. The explicit send
confirmation flag is a caller assertion, not a server-side human approval system.

Review was a main-agent self-review; no independent agent review occurred.
Committed source is local on `codex/admin-user-mailbox-access`; no upstream push
or pull request was created for this task.
