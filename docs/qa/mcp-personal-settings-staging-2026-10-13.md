# MCP personal settings staging validation — 2026-10-13

This revision replaces the separate MCP administration page with a card in AI
services and moves personal agent permissions into Quick settings. Design and
API ownership: `docs/rebuild/19-mcp-service.md`. The 2026-10-12 report describes
the preceding version, including its superseded global sending switch.

## Published release

Target: the existing `https://staging.unimailbox.tech` installation in Cloudflare
account `6f215b03c5ff77ef28410254e9701d67`. No production publication, routing,
provider configuration, resource replacement or encryption-key rotation occurred.

- Application commit: `eb72db8a6b4c990b818e00dab5258ac1dd78b42d`.
- Source digest: `257addf20a00ba2a6a2d4a1e148e77c647212c14d69c946e450e485527bfc922`.
- Worker version: `b5a54cc1-476f-4ee8-9d9d-4e887916412b`.
- Previous Worker: `7c94c494-ea3a-4875-9e34-96c55a9511c7`.
- Frontend digest: `89610e05439f22ef08c8f7037984da5a7b1b253cedb9eed0c004f295531fce37`.
- The standard `pnpm deploy:staging` ran the full canonical gate against clean,
  committed release inputs: doctor 14/14, binding drift, lint, typecheck, build,
  1,367 non-Worker tests, 996 Worker tests and 26 migration fixture tests passed
  (**2,389 tests**).
- The publisher verified account membership, existing resources and secrets,
  captured a D1 Time Travel recovery bookmark, applied only `0036_mcp_prompt.sql`
  and passed all 36 SQL verification companions. Existing credentials, service
  state and request limits were preserved. Private recovery metadata remains in
  the ignored release directory.
- Exact health/version/source, readiness/schema 0036, completed setup, frontend
  assets/security headers, missing-file boundaries and anonymous admin denial
  passed. The live AI services asset contains the MCP card; the published main
  asset contains the personal credential API. These asset checks do not establish
  browser interaction evidence.
- `pnpm ops:check --environment staging` passed readiness and maintenance health.

## Authenticated API and MCP checks

A protected operator login created one temporary ordinary member account without
initial mailbox access. The test changed only that account's generated initial
password, assigned temporary viewer/sender access to one mailbox already
accessible to the operator, and never retrieved private mail content.

1. The Admin response contains only the service/prompt configuration, revision,
   trusted endpoint and management capability. It contains no personal tokens or
   mailbox list. A member receives 403 for Admin read/update.
2. A session requiring password change cannot open personal MCP settings. After
   its password change, the ordinary member can open those settings without
   administrative permissions.
3. The administrator's temporary custom prompt is visible in personal settings.
   Viewer mailbox metadata marks write access unavailable; a send-enabled
   credential request is denied with 403. A one-day read-only credential succeeds.
4. Streamable HTTP 2025-11-25 initialization, read-only tool discovery and scoped
   mailbox listing pass with `Cache-Control: no-store`.
5. The member cannot list the operator's credential or revoke it by ID (404).
6. Changing the temporary membership to sender permits a separate send credential.
   Its tools include `send_email` and exclude `create_draft`. No send tool was
   called; the live check proves grant/discovery, not provider delivery.
7. A hostile Origin receives 403. A revoked credential receives 401.
8. All three temporary credentials were revoked, the temporary mailbox membership
   was removed, and the test account was banned with its sessions revoked. The
   inactive account and audit metadata remain for traceability; no active test
   access remains.
9. The original toggle and prompt were restored. **MCP remains disabled** and its
   endpoint returns 503. No real email was sent and no private mail was read.

The operator login, temporary passwords, session values and plaintext credentials
are excluded from this report and Git.

## Local UI and security evidence

Component tests cover the single Admin switch, shared prompt view/edit/preview/
copy, revision headers, read-only administration, ordinary member credential
creation, viewer write restrictions, independent send grants, revocation,
one-time dismissal and dialog closure. Prompt copies contain the shared template
and protected instructions without credentials; plaintext is absent from Query
and Mutation caches. Router tests verify the old bookmark redirects to AI services
and existing authentication/setup guards remain intact.

Worker tests cover personal owner isolation, allowed/denied grants, live mailbox
and global permissions, enabled/disabled behavior and shared prompt persistence/
validation. Existing transport, rate, expiry, hash-only persistence, idempotency
and queued-send fixtures pass. Raw partial/repeated migration tests prove tracking
and preservation without fixture-managed migration registration.

Main-agent self-review, staged Gitleaks v8.30.1 and `git diff --check` passed.
There was no independent agent review. Actual browser clipboard use and real
local-agent configuration remain unverified. Real MCP mail delivery and a
server-side human approval workflow were not exercised; `confirmed: true` remains
a caller assertion as documented in the service guide.
