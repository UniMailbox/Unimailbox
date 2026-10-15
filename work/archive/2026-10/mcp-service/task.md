# Scoped MCP service

Status: Implemented; staging publication and read-only MCP protocol verified (2026-10-12).

User scope: administration toggle, an MCP endpoint/port, security controls and
Copy prompt for local agents. The user explicitly requested sending with an
independent permission. Existing commit/staging authorization persists; production
and real test-email recipients are outside this task.

Acceptance: default disabled; revision-checked administration; one-time hashed,
expiring and revocable credentials; mailbox scope and current user permission
checks; independent draft/send gates; functioning Streamable HTTP discovery/read,
draft and send; safe idempotency; bounded input; origin/batch/rate protections;
credential-free configuration prompt. Preserve existing provider/encryption and
installation identities. Actual local-agent setup and real provider delivery are
separate acceptance boundaries.

Design and reference provenance: `docs/rebuild/19-mcp-service.md`. Official SDK
2.3.1, pinned commit `fcef852f6cdafea07f36cf6fae69b37c8adf85be`, Apache-2.0;
installed distribution files and official serving docs listed there. Adopted the
Web Standard stateless adapter with Workers-safe validation; retained local
authorization/outbox ownership; rejected generic upstream auth, token passthrough,
arbitrary HTTP forwarding and mailbox sessions. No external SDK source copied.

Review: main-agent self-review; no independent delegated review. Focused Worker
tests passed seven scenarios, including one queued outbound job across retries,
live permission/grant removal, hash-only storage and parallel limits. Focused Web
and route guards passed 63 tests; migration fixtures passed 25 tests, including
raw partial/repeated 0035 SQL. Final standard staging release ran `pnpm verify`: 2,381 tests passed. Migration
0035 and all 35 remote companions passed after a recovery bookmark. Live read-only
handshake, scoped listing, Origin rejection and revocation passed. Original
disabled configuration restored; no real mail sent. QA:
`docs/qa/mcp-staging-2026-10-12.md`.

Authorized staging installation carried forward from this conversation:
`staging.unimailbox.tech`, account `6f215b03c5ff77ef28410254e9701d67`, existing
`unimailbox-staging` Worker and D1/R2/KV/Queue identities. Do not bootstrap or rotate
secrets. Standard deployment captures a D1 Time Travel bookmark before migration.
MCP starts disabled after the upgrade; live read-only protocol smoke may
temporarily enable it and must revoke the test credential and restore configuration.
