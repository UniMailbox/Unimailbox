# Reduce redundant browser KV requests

Completed 2026-10-14 on `codex/kv-request-reduction-20261014`.

## Goal and scope

Reduce duplicate browser identity reads and absent-key logout deletes in the
existing authorized staging installation. Compare live staging KV analytics
against the previous daily-scan baseline before attributing any quota concern.
MCP remains independently authenticated by D1. No token architecture, polling,
schema, resource, key, mail or production changes are in scope.

## Rules and acceptance

- R-AUTH-005: valid logout still immediately revokes its D1 session and token;
  repeated, invalid and expired-token logout clears the cookie without KV delete.
- R-AUTHZ-002: UI identity snapshots may be reused for 60 seconds; server session,
  account, mailbox and permission checks remain fresh on every protected request.
- R-SECRET-003: metrics reports contain aggregate counts and public identities,
  never credentials or private mail.
- Additional session observers within 60 seconds do not issue `/auth/me`;
  stale mounts and explicit invalidation still refresh it. Production continues
  to disable focus refetch.
- Local focused tests and the canonical gate pass. Publish and verify only
  `staging.unimailbox.tech` in the user-specified account and CACHE namespace.
- Live counters remain aggregate evidence, not per-key attribution or a future
  usage guarantee. The operator's exact alert window/threshold remains unknown;
  this does not prevent the scoped source reduction and verified publication.

## Ownership, delivery and review

Main agent owns auth client/route, their tests and scoped documentation. No new
module edge, dependency or external reference implementation. Delivery is the
existing frontend bundle and Worker route. Perform a main-agent self-review;
no independent reviewer is claimed. Release via `pnpm deploy:staging`, preserve
schema 0036 and resource/encryption identities, and archive this task at closure.

## Evidence so far

Live GraphQL at 01:52 UTC (09:52 Asia/Shanghai) reports staging CACHE 67 reads
and zero deletes during the preceding 24 hours. UTC October 13: 135 reads,
one delete, 331 writes. October 14 UTC so far: zero reads/deletes, 25 writes.
The active Worker remains `fd7fa1b2-5d45-49ea-9e70-9b90753edf72` at 100%.
This disproves an ongoing idle-delete recurrence in the queried period; it does
not establish the time window or thresholds of the operator's separate alert.

Focused verification: Web identity/logout/router 76 passed; Worker auth/MCP/
account lifecycle 57 passed. An initial test-fixture error attempted JSON parsing
of an empty 204 response; its helper now follows the actual API client's 204
behavior and rerun passed. Self-review retains fresh admin entry `/me` checks,
per-request D1/session/account and permission gates, refresh-cookie clearing and
valid-token deletion. No new dependency, schema or runtime binding is needed.

The first canonical gate stopped before publication on two frontend tests:
the old inbox request-footprint expectation required two redundant identity
reads, and the detail fixture used `??` to replace an explicit null identity
with a logged-in value. Update the footprint to zero additional reads of the
already-fresh identity and preserve the fixture's explicit null. No product
authorization or expired-session behavior is relaxed for these corrections.

## Final acceptance

Application `72d86f6`, fixture/release source `79ceaf2`, Worker
`1e0bdd33-1a59-4698-834b-10946a7bc7eb`: 2,397 tests, doctor 14/14,
generated bindings, lint, TypeScript, builds and all 36 remote companions pass.
Standard staging publication and operations readiness/maintenance pass. No
migration, resource, key or production change. Live login/identity, valid,
repeated and invalid logout, and access/refresh credential denial pass; the
diagnostic session is logged out. No private mail read or mail sent.
All scoped criteria are met at their reported evidence layer. Native browser
request capture and a full post-release aggregate day remain unverified.
See `docs/qa/kv-request-reduction-2026-10-14.md` and
`work/handoffs/kv-request-reduction-2026-10-14.md`.
