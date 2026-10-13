# Scoped MCP service

Updated 2026-10-13. Local agents can connect to this installation through its
Streamable HTTP MCP endpoint. The service starts disabled. It does not create a
second Worker, listen on an additional TCP port or inherit an AI provider key.

## Administration and connection

Open **Admin → AI services** (`/admin/ai`). MCP has its own card on that page,
with a single service enable/disable switch. The old `/admin/mcp` bookmark redirects
to AI services; there is no separate navigation entry. `settings.read` permits
viewing the card and shared prompt; `settings.manage` permits changing the switch
and prompt. Configuration writes require a revision (`If-Match`) and an
idempotency key. Admin does not manage personal credentials on this card.

Administrators can view, edit, preview and reset the shared setup prompt even
while MCP is disabled. The template accepts up to 8,000 characters and requires
`{{endpoint}}`, replaced with the installation's actual URL when copied. A real
`umcp_` credential is rejected. Credential protection, untrusted-email and human
send-approval instructions are appended automatically. This validation detects
MCP credentials, not every possible secret; never enter provider keys or passwords.

1. An administrator enables MCP in the AI services card. There is no additional
   installation send switch or rate-limit form.
2. A signed-in user opens **Quick settings → MCP service → Manage agent access**.
   This personal API needs no `settings.read` or `settings.manage` permission.
   Select specific accessible mailboxes, a credential name and 1–90 day expiry.
   Read-only is the default. Draft/AI and sending are independent optional grants;
   both require write permission for every selected mailbox. A viewer can create
   a read credential without gaining write access.
3. Copy the one-time credential and store it privately in the agent's local
   environment as `UNIMAILBOX_MCP_TOKEN`. The server stores only its SHA-256 hash.
   Lost credentials cannot be recovered: revoke and replace them. A replay of
   the creation request returns metadata and `token: null`. Closing the personal
   dialog, Quick settings or switching accounts clears plaintext UI state.
4. Select **Copy prompt** after enabling the service. Admin and personal settings
   use the same saved template. The copied prompt contains no credential and
   points to Quick settings for credential creation. The agent must use its actual
   supported MCP configuration syntax.
5. Configure a Streamable HTTP client with the endpoint and request header
   `Authorization: Bearer <value of UNIMAILBOX_MCP_TOKEN>`. Clients must support
   custom Bearer headers. Automatic OAuth login is not provided in this phase.

Personal read/issue/revoke paths are `/api/v1/auth/me/mcp`,
`/api/v1/auth/me/mcp/tokens` and `/api/v1/auth/me/mcp/tokens/:id/revoke`.
They always derive the owner from the verified session, reject accounts requiring
password change, and cannot list or revoke another user's credentials. Issuance
requires the service to be enabled; owner revocation remains available through
the API while disabled. The UI shows no permission form or Copy prompt when the
service is disabled. Existing credential permissions are immutable; revoke and
create a replacement to change them.

The endpoint is `<APP_ORIGIN>/api/mcp`, using HTTPS port **443** by default.
Local Worker development can use its configured loopback origin/port (normally
8787). The UI shows the configured endpoint's actual port. No public port-opening
or additional Wrangler binding is required. Native stdio and the old separate
HTTP+SSE endpoint are not provided. The SDK supports current MCP requests and
2025 Streamable HTTP clients; legacy responses may use finite SSE streams.
The endpoint is stateless and has no persistent session identifier.

## Tools and independent send authorization

| Tool | Required credential grant | Behavior |
| --- | --- | --- |
| `list_mailboxes` | Read | Current accessible mailboxes intersected with the credential scope |
| `list_messages` | Read | Folder and signed cursor pagination, at most 50 messages per page |
| `read_message` | Read | Selected message, plain text capped at 24,000 characters, marked untrusted |
| `create_draft` | Draft | Create a server draft from plain text, without sending |
| `generate_ai_reply` | Draft and read | Existing configured AI reply service; may incur provider charges |
| `send_email` | Send | Existing audited compose/outbox/queue workflow |

Sending is allowed only if MCP is enabled, the credential grants send, the current account is active, its live global
`message.send` permission still exists, and its current mailbox ownership or
membership permits sending from that selected mailbox. Administration alone
never grants access to private mail. Draft access uses the application's existing
`message.send` permission but does not grant the MCP send tool. Credential send
access does not automatically grant draft/AI access.

Mutating tools require a stable caller `idempotencyKey` (8–40 letters, digits,
underscore or hyphen). Reuse it unchanged for the same operation on retries.
The server namespaces it by credential and mailbox before invoking existing
application routes; send authorization is checked before idempotent replay.
`send_email` requires at least one To recipient and `confirmed: true`. All body
input is bounded plain text; generated HTML escapes markup. This phase has no
attachment, scheduled-send, arbitrary HTTP, deletion or administrator tools.
Accepted sends return `queued`; provider delivery remains a separate stage.

## Security controls and limits

Security protections are necessary because a mail agent can read private content
and create external effects. This implementation supplies:

- A distinct opaque 256-bit MCP credential audience. Browser session tokens do
  not authenticate MCP, and MCP credentials do not authenticate ordinary APIs.
  MCP credentials are never forwarded upstream or to a caller-selected URL. AI
  and mail provider credentials remain inside their existing authorized adapters.
- Hash-only persistence, one-time disclosure, expiry and immediate rejection of
  subsequent requests after revocation, account deactivation, required password
  change or service disable. User permissions and mailbox grants are checked on
  every tool invocation. Disabling the service does not cancel already queued
  outbound mail or an operation that has already started.
- Trusted configured endpoint origin and exact Origin checking when present;
  invalid origins receive 403. Credentials in URL query strings are rejected.
  HTTPS is required outside local loopback development; no permissive CORS.
- Atomic D1 per-credential fixed-minute limits (default 30; existing stored limits
  are preserved, with no admin or personal rate-limit form),
  a bounded 128 KiB request reader, strict tool schemas and bounded output. JSON-RPC
  batch requests are rejected so batching cannot bypass the request limit.
- Audited configuration, credential lifecycle and tool-call outcomes. Tool audit
  rows contain the tool name, credential ID and outcome, never arguments, mail
  content or credentials. Existing mail writes retain their own atomic audit.
- `Cache-Control: no-store`; plaintext credentials remain only in transient UI
  state and are excluded from Query/Mutation caches, storage and Copy prompt.

Human confirmation and treating email as untrusted data are also included in
the server instructions and copied prompt. The `confirmed` flag expresses the
caller's assertion, rather than proving that a human approved it. A compromised
agent holding a send-enabled credential can still send within its grants; use
read/draft-only credentials when stronger human control is required. A future
server-side approval workflow can strengthen that boundary.

Per-credential limits do not replace account-level network abuse protection.
For installations exposed to sustained invalid-token traffic, consider a
Cloudflare WAF rate rule on `/api/mcp` before requests reach D1. This phase does
not silently create billing-dependent WAF rules or change Cloudflare Access.
Avoid logging Authorization headers in any reverse proxy or agent integration.

## Ownership, migration and provenance

Admin owns persistence for service configuration, the shared prompt, personal
credentials, mailbox scope relations and rate windows. Personal HTTP routes
expose owner-scoped credential operations without administrative permissions.
The HTTP adapter composes public tenancy/admin services and a private fixed-route
mail router with a verified identity injected directly into context. It reuses
existing permission checks, use cases, idempotency and outbound persistence;
there is no network request back to the application and no synthetic session.
Migration `0035_mcp_access.sql` seeds disabled configuration and records its own
`d1_migrations` row; its companion verifies the resulting schema. Raw partial
application and repeated execution preserve configuration. Migration `0036_mcp_prompt.sql` adds a replay-safe shared prompt table, records
its tracking row and preserves the service state, credential IDs/hashes/grants
and request limits. NULL means the application default prompt. Toggle, template,
revision, audit and replay response writes settle in one D1 batch. The legacy
`mcp_configuration.allow_send` column remains for schema compatibility but is no
longer an authorization gate. Read/draft credentials do not become send-enabled;
previously send-enabled credentials can send when MCP and their live permissions
allow it. Encryption keys are unchanged. Follow the release backup process before an
existing installation is migrated.

The official [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
is a dependency, pinned to `@modelcontextprotocol/server` **2.3.1**, upstream
commit `fcef852f6cdafea07f36cf6fae69b37c8adf85be` (tag `v2.3.1`), Apache-2.0.
Inspected installed files: `dist/index.mjs`, `dist/index.d.mts`,
`dist/createMcpHandler-D4NN8WsG.d.mts`, `dist/validators/cfWorker.d.mts` and
`dist/cfWorkerProvider-C03CSigr.d.mts`, plus official Web Standard/HTTP serving
documentation. The adopted pattern is a fresh server per HTTP request with a
Workers-safe JSON Schema validator. Generic upstream authorization, persistent
sessions and arbitrary downstream proxies were not adopted. No SDK source was
copied. `zod-mcp` pins Zod 4.4.3 for the SDK schemas while existing application
contracts retain Zod 3.

Focused Worker tests exercise transport negotiation, scopes, draft/send
idempotency, hash-only storage, replay redaction, origin/body/batch restrictions,
revocation/expiry, current permissions and concurrent limits. Web tests exercise
configuration revision, shared prompt editing, ordinary-user scoped creation,
read-only grants and credential-free Copy prompt. These
are local fixtures; they do not prove a real local agent or real mail delivery.
