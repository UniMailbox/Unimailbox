# MCP KV reduction

Published application commit `e24bf27` to the existing staging installation as
Worker `fd7fa1b2-5d45-49ea-9e70-9b90753edf72`; schema remains 0036. The standard
release gate passed 2,393 tests and all 36 schema companions. No migrations,
resources, keys, provider configuration or production changes were made.

Personal/Admin MCP cards use their parent's user ID. They read on opening,
explicit refresh and mutations, with no interval, focus/reconnect fetch or
automatic client/Query retries. Browser authn now applies only to `/api/v1/*`;
MCP's independent D1 credential checks no longer incur a browser-token KV miss.

Worker binding spies show zero CACHE operations for MCP discovery/read/draft,
invalid credentials, hostile Origin, revocation and disabled service, with a
positive authenticated browser control still reading its token once. Frontend
controlled-time tests show one initial request across an idle hour and explicit
refresh/reopening behavior. These are local operation-count proofs, not a full
day of remote analytics or native browser/agent evidence.

Live initialization/scope/discovery/Origin/audience/revocation passed. The single
temporary read credential was revoked, original config retained/restored and
diagnostic login logged out. The final live service remains enabled. No private
mail was read and no real mail was sent. Readiness and maintenance are healthy.

Design: `docs/rebuild/19-mcp-service.md`. Release/count/acceptance evidence and
limits: `docs/qa/mcp-kv-staging-2026-10-13.md`. Self-review only; no delegation,
independent review, push or PR. General browser authentication and maintenance
costs remain outside this narrow reduction.
