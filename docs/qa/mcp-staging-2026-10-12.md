# MCP staging validation — 2026-10-12

Target: the existing `staging.unimailbox.tech` installation in Cloudflare account
`6f215b03c5ff77ef28410254e9701d67`. No production, routing, provider configuration,
resource replacement or key rotation occurred.

## Release evidence

- Application commit: `6701e048c96193c41ed07b3fba644e66f8954258`.
- Source tree digest: `9fcaeae49663c8d76050cb3c710b2c766ea2162fa761f2d3d0afe3a73269cac4`.
- Worker version: `7c94c494-ea3a-4875-9e34-96c55a9511c7`.
- Previous Worker: `01d1bd24-80b1-473c-be4f-2edc16d4765f`.
- Frontend digest: `a00a21dd87172fa5b86ced72cce91d7ecb2ffb81c4816437aee6eaeb56de9d24`.
- Standard `pnpm deploy:staging` completed with a clean committed source snapshot.
  It ran `pnpm verify`: doctor 14/14, binding generation drift, lint, typecheck,
  1,362 non-Worker tests, build, 994 Worker tests and 25 migration fixture tests
  passed: **2,381 tests total**.
- The standard publisher captured a D1 Time Travel recovery bookmark before
  migration, applied only `0035_mcp_access.sql`, verified all 35 SQL companions,
  and passed exact source/version, readiness/schema, completed-installation,
  frontend-assets, security-header and API/static-file boundary smoke checks.
  Protected recovery metadata remains in the ignored release directory.

The first full run found an old readiness test pinned to schema 0034; it now uses
the canonical schema constant. During a subsequent run, a newly added no-store
assertion saw the runner's previously loaded SDK module; the final fresh release
gate verified the committed explicit no-store response protection. Existing
bundle-size, source-map and local Worker-pool network warnings did not fail the
final gate.

## Authenticated live MCP evidence

A protected operator login authenticated against the real staging API. A temporary
credential used one mailbox already accessible to that operator and read access
only. No mailbox grants were changed and no mail content was retrieved.

1. Administration returned the disabled default, safe credential metadata and
   `https://staging.unimailbox.tech/api/mcp`.
2. Temporarily enabled MCP with sending disabled; issued a one-day read-only
   credential through the protected administration API.
3. A 2025-11-25 Streamable HTTP client request initialized successfully and
   advertised exactly `list_mailboxes`, `list_messages` and `read_message`.
   Successful protocol responses carried `Cache-Control: no-store`.
4. `list_mailboxes` returned exactly the credential's single granted mailbox.
   An unrelated Origin was rejected with 403.
5. Revoked the credential through the admin API. A subsequent request using it
   returned 401.
6. Restored the original configuration. The service is **disabled**, the temporary
   credential is **revoked**, and the endpoint returns 503 `MCP_DISABLED`.

No actual provider email was sent. Temporary configuration changes and revocation
remain in the application's audit trail; the credential's plaintext and operator
login are not part of this report.

## Verification boundaries

React tests exercised revision-checked saves, disabled/read-only controls, mailbox
selection, one-time credential dismissal and credential-free Copy prompt without
placing secret bytes in Query/Mutation caches. Router tests covered administrative
guards. These are synthetic component tests, not real browser interaction proof.

Local Worker tests proved independently gated send/draft capabilities, a single
queued job across send retries, rejected send retries after live permission loss,
mailbox-scope/ownership checks, expiry/account/password/revocation/service gates,
one-time disclosure/replay redaction, bounded bodies, rejected batches and exact
concurrent per-token limits. Migration tests executed raw partial/repeated SQL
without relying on fixture tracking writes.

Real local-agent application configuration, browser clipboard interaction,
provider delivery through MCP and a server-side human approval workflow remain
unverified or outside this phase. A caller's `confirmed: true` asserts approval;
it does not technically prove human consent. See the security boundaries in
`docs/rebuild/19-mcp-service.md`.
