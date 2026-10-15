# MCP KV request reduction

Requested 2026-10-13. Direct implementation and self-review, without delegation.

Remove idle personal MCP polling and redundant browser-session queries. Refresh
personal settings on opening, explicit refresh and credential mutations. Limit
browser authentication to ordinary API routes so MCP uses its existing D1
credential checks without a KV lookup. Preserve scopes, revocation, disabled
behavior, body/origin restrictions and rate limits; no global authentication or
maintenance redesign, migrations, key changes, real mail sends or production.

Verify request counts with controlled frontend timers and actual Worker binding
spies, including valid/invalid/revoked/disabled MCP and allowed/denied browser API
access. Run the canonical release gate, commit owned paths and deploy the same
previously authorized staging installation. Distinguish fixture call counts from
remote aggregate analytics and actual browser/agent evidence.

Completed: commit `e24bf27`, 2,393-test canonical release gate, all 36 schema
companions, staging publication and bounded live acceptance. Review was a
self-review; staged secret/diff checks passed. Evidence and remaining boundaries:
`docs/qa/mcp-kv-staging-2026-10-13.md`.
