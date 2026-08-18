# First-party MCP server — operator runbook

> This runbook covers the first-party MCP server shipped in PR #1–#8 of
> the `feat/email-mcp-server` worktree. The MCP route lives at
> `/mcp`; the discovery endpoints at `/.well-known/{mcp.json,
oauth-protected-resource, oauth-authorization-server}`; agent
> token CRUD at `/api/v1/agent_tokens`.

This document tells you how to:

1. Inspect the MCP server locally with the official MCP inspector.
2. Flip the route on in development (production deployments leave the
   route disabled until an operator opts in).
3. Issue an agent token through the web UI.
4. Diagnose the three most common failure modes (`401`, `403`, rate
   limit).

If you only want to know "does this work end-to-end", jump to
[§2 Local smoke test](#2-local-smoke-test). §1 is for operators who
need to change the route flags; §3–§4 are for the on-call engineer
facing a bug report.

---

## 1. Architecture recap

```
                 ┌───────────────────────────────────────────────────────┐
                 │ Cloudflare Worker (unimailbox)                         │
                 │                                                       │
Claude / Cursor ─┤  POST /mcp        ← Streamable HTTP transport         │
   or self      │  GET  /.well-known/mcp.json                           │
   host agent    │  GET  /.well-known/oauth-protected-resource           │
                 │  GET  /.well-known/oauth-authorization-server         │
                 │                                                       │
                 │  /api/v1/agent_tokens           ← admin token CRUD    │
                 │  /api/v1/agent_tokens/:id                             │
                 │                                                       │
                 │  modules/mcp/auth     Bearer agent_token | JWT        │
                 │  modules/mcp/tools/*  Read + write tools (PR #3–#5)   │
                 └───────────────────────────────────────────────────────┘
```

The MCP server shares the existing Hono router so it inherits the
bootstrap gate, request-id header, CORS handling, and structured
logger. The MCP entrypoint itself is force-disabled until a runtime
flag is set — see [§2.2 Enable the route](#22-enable-the-route).

---

## 2. Local smoke test

### 2.1 Start the dev server

```bash
pnpm dev:worker
```

`wrangler dev` binds the worker to `http://127.0.0.1:8787` by default.
If you want a remote preview, run `pnpm release:preview` instead; the
deploy script prints the public URL once it completes.

### 2.2 Enable the route

The MCP route is intentionally cold at boot. Two ways to flip it on:

| Context                | How                                                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wrangler dev` (local) | In the dev server JavaScript console, run `globalThis.MCP_ENABLED = true` and reload the page. The route becomes reachable immediately.                                                                                                           |
| Integration tests      | `apps/worker/test/integration/mcp/http.test.ts` sets `globalThis.MCP_ENABLED = true` before constructing the Hono app.                                                                                                                            |
| Production             | PR #8 ships the discovery endpoints unconditionally, but the `/mcp` endpoint itself stays gated by the same flag. Operators must redeploy with `MCP_ENABLED=true` in the environment (e.g. via a `wrangler secret put MCP_ENABLED`) to expose it. |

Discovery endpoints (`/.well-known/*`) are **always reachable** —
clients cache them before authenticating, so gating them would
brick onboarding flows.

### 2.3 Run the MCP inspector

The official `@modelcontextprotocol/inspector` ships a CLI and a
local web UI; either works against the worker:

```bash
npx @modelcontextprotocol/inspector \
  --url http://127.0.0.1:8787/mcp \
  --transport http
```

If the inspector supports `--auth` / `--bearer`, paste an agent token
issued from the UI. Otherwise, paste it into the inspector UI's
"Bearer token" field. Without a token the server returns `401
unauthorized` with a `WWW-Authenticate: Bearer` header pointing at
the PRM endpoint.

The inspector should immediately list 17 tools (`hello_mcp` plus the
read / write / schedule / attachment tools wired in PR #3–#5) and 7
resources (mailboxes, messages, threads, drafts, labels,
attachments, plus their templates). If you see only `hello_mcp`,
double-check that `globalThis.MCP_ENABLED` is set on the same Worker
instance as the inspector is pointed at.

### 2.4 Issue an agent token through the UI

> Requires the `user.manage` permission (Administrator role in the
> seeded `0002_seed_permissions.sql`).

1. Sign in to the web UI.
2. Navigate to **Settings → Model context tokens**.
3. Fill in a name (e.g. `Cursor on my laptop`), pick a subset of
   scopes, optionally set an `expires_at`, then click **Issue
   token**.
4. The plaintext token is shown **once**. Copy it into your
   password manager before navigating away — the server only stores
   the SHA-256 hash, so a forgotten token cannot be recovered.
5. Use the token as a Bearer credential in the inspector or any
   other MCP client:
   `Authorization: Bearer <paste-token>`.

### 2.5 Quick cURL probe

```bash
# 1. PRM metadata (always 200, no auth)
curl -s http://127.0.0.1:8787/.well-known/oauth-protected-resource | jq

# 2. Discovery document (always 200, no auth)
curl -s http://127.0.0.1:8787/.well-known/mcp.json | jq

# 3. tools/list (requires bearer token)
curl -s http://127.0.0.1:8787/mcp \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq
```

---

## 3. Troubleshooting

### 3.1 `401 Unauthorized` (token missing or invalid)

Symptoms:

- Inspector reports "401 Unauthorized".
- Raw `curl` returns `WWW-Authenticate: Bearer
realm="unimailbox", error="invalid_token"`.

Likely causes:

1. **Token not set.** The inspector and your client must both send
   `Authorization: Bearer <token>` on every request; the MCP
   transport is stateless, so re-authentication is per-request.
2. **Token revoked.** Tokens carry a `revoked_at` timestamp in the
   `agent_tokens` table. Once revoked, the auth path
   (`apps/worker/src/modules/mcp/auth.ts::verifyAgentToken`) rejects
   the lookup before the principal is built. Issue a new token.
3. **Token expired.** Set the `expires_at` column on the row;
   `verifyAgentToken` rejects any token whose `expires_at < now`.
4. **JWT mismatch.** The auth path prefers `agent_token` over JWT.
   If the same Bearer string is both a valid JWT and a valid agent
   token (extremely unlikely — different shapes), the agent_token
   branch wins.

Diagnostic queries:

```sql
SELECT id, name, scopes, expires_at, revoked_at, last_used_at
FROM agent_tokens
WHERE user_id = '<user-id>'
ORDER BY created_at DESC;
```

### 3.2 `403 Forbidden` (scope missing)

Symptoms:

- Tool call returns `McpToolError("forbidden")` with the missing
  permission key in the error data.

Cause: the agent token's `scopes` array does not include the
permission required by the tool. The token's `scopes` array is the
intersection of the issuing user's permissions and the operator's
selection. To fix:

1. Re-issue a token with the missing scope selected.
2. **Do not** widen the issuing user's permissions without an
   audit; the principle of least privilege is intentional.

For per-tool scope requirements, see
[`docs/architecture/email-mcp-implementation-plan.md` §4.2](../architecture/email-mcp-implementation-plan.md#42-tools).

### 3.3 Rate limited

The MCP rate-limit module
(`apps/worker/src/modules/mcp/rate-limit.ts`) enforces three
buckets:

| Bucket  | Per-minute | Per-hour     | Notes                                                          |
| ------- | ---------- | ------------ | -------------------------------------------------------------- |
| `read`  | 60 / user  | 1 000 / user | All read tools and resources                                   |
| `write` | 10 / user  | 100 / user   | `send_message`, `move_message`, `trash_message`, etc.          |
| `ai`    | 20 / user  | 200 / user   | `summarize_thread`, `classify_message`, `extract_action_items` |

A throttled call surfaces as `McpToolError("rate_limited")`. The
counter keys are `rate:mcp:<bucket>:<user-id>:<unix-minute>` and
expire after 2 minutes — back off for at least one window before
retrying.

Production-grade automation should implement exponential backoff
rather than hammering the endpoint. The web UI never triggers the
MCP rate-limit; the bucket is per-user, not per-process.

### 3.4 Other failure modes

- **`agent_tokens` table missing.** The MCP auth path depends on
  migration `0010_agent_tokens.sql`. If the table is absent, every
  call returns `401 Unauthorized` (the auth path cannot resolve a
  hash). Re-run `pnpm db:migrate`.
- **`MCP_ENABLED` never flipped on.** Inspector returns
  `MCP endpoint disabled` (404). See [§2.2](#22-enable-the-route).
- **Discovery document missing `mcp` endpoint.** Check that the
  Worker route registered without clobbering `/.well-known/*`; if
  another Hono route claims the prefix, this runbook's `cURL`
  examples will 404.

---

## 4. Observability

The MCP server writes structured logs via
`apps/worker/src/platform/logger.ts`. Each tool invocation stamps
the following `safeFields` keys:

```
mcp.tool           e.g. "send_message"
mcp.decision       "allow" | "deny"
mcp.duration_ms    wall-clock handler latency
mcp.principal_hash SHA-256(user_id)
mcp.request_id     correlates with the `x-request-id` response header
mcp.error_code     present only on failure
```

Search Sentry by `mcp.request_id` to trace a single client call
through the worker. Never expect to see raw message bodies, addresses,
or tokens in these logs — the safeFields filter drops them at write
time.

`/health` reports an `mcp` segment when `globalThis.MCP_ENABLED` is
true. Operators can scrape this endpoint to confirm the route is
live without round-tripping a tools/list call.

---

## 5. Related documents

- [`docs/architecture/email-mcp-implementation-plan.md`](../architecture/email-mcp-implementation-plan.md)
  — the original design doc, including the OAuth 2.1 + RFC 9728 +
  RFC 8414 roadmap.
- [`docs/architecture/email-mcp-server-impl.md`](../architecture/email-mcp-server-impl.md)
  — implementation sequencing, the per-PR breakdown, and the
  `pnpm verify` gate each stage must clear.
- [`docs/runbooks/observability-alerts.md`](observability-alerts.md) —
  on-call paging rules; MCP alerts share the same Sentry project.
- [`docs/runbooks/migration-recovery.md`](migration-recovery.md) —
  the `0010_agent_tokens.sql` migration lives here.
