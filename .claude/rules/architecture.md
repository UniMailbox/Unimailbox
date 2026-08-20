# Architecture Rules

Derived from `docs/rebuild/05-target-architecture/` and `docs/rebuild/03-domain-design/`, which
remain the source of truth. This file is the enforceable subset agents must not violate.

## Shape

Modular monolith. **One Worker, multiple entrypoints.** Not microservices.

```
apps/worker/          Cloudflare Worker
apps/web/             single React client (there is exactly one client)
packages/contracts/   shared types + zod schemas — the only types crossing module boundaries
packages/email-core/  pure RFC 5322 functions (no I/O)
packages/config/      shared config types
packages/test-kit/    fixtures + helpers
migrations/           SQL migrations are the deployable artifact (Drizzle schema is typing only)
scripts/
```

`apps/worker/src/`:

```
entrypoints/    http.ts | inbound-email.ts | queue.ts | scheduled.ts   — thin shells
http/           router.ts, middleware/{authn,authz,error,request-id}, errors.ts
modules/        identity onboarding tenancy messages inbound-mail outbound-mail
                provider-sync attachments signatures admin installation maintenance
integrations/   providers/{provider-registry.ts,brevo,resend,cf-sendmail}
                cloudflare/{control-plane.ts,oauth.ts}
platform/       config database object-store cache crypto logger clock ids errors
app-context.ts  composition root — the only place wiring happens
```

## Dependency direction

```
entrypoints ──▶ modules ──▶ domain ◀── integrations (via contracts interfaces)
```

**Allowed:**

| Module | May depend on |
|---|---|
| `identity` | `platform/*`, `contracts/*` |
| `onboarding` | `identity` |
| `tenancy` | `identity` |
| `messages` | `tenancy` |
| `inbound-mail` | `tenancy`, `messages`, `email-core/*`, `admin` (read-only, via `contracts/*`) |
| `outbound-mail` | `tenancy`, `messages`, `integrations/providers/*`, `email-core/*` |
| `provider-sync` | `messages`, `integrations/providers/*` |
| `attachments` | `messages`, `tenancy` |
| `signatures` | `tenancy` |
| `admin` | `identity`, `tenancy`, `messages`, `outbound-mail` |
| `installation` | `identity`, `tenancy`, `admin` |
| `maintenance` | `messages`, `tenancy`, `attachments` |

Every module may additionally depend on `platform/*` and `contracts/*`. **No cycles.** An edge
not in this table is the orchestrator's decision, not the implementer's.

The `inbound-mail → admin` edge is read-only and interface-only. `inbound-mail` consumes the
read interfaces (`BlocklistReader`, `RolePolicyReader`) declared in `packages/contracts`,
not the admin module's symbols. The implementations are wired in `app-context.ts` (composition
root), mirroring the outbound provider registry pattern (ADR-002). `inbound-mail` never imports
from `modules/admin/*` directly.

The `outbound-mail → admin` edge is the WRITE counterpart to those read seams (CAP-040). It
exists because the webhook route handler (`http/routes/webhooks.ts`) must fold an
`audit_events` INSERT into the same D1 batch as the business writes (R-AUDIT-001 +
D-CAP-029-A), and the outbound-mail module cannot import the admin module directly. The seam
declares `AuditEventWriter` (and its input type, the closed `AuditAction` enum) in
`packages/contracts/admin/audit.ts`. The implementation lives in
`apps/worker/src/modules/admin/audit-event-writer.ts` and is wired in `app-context.ts`.
`outbound-mail` (and any route that uses it) consumes `ctx.auditEventWriter` from `AppContext`,
never `modules/admin/*` directly. The same composition-root pattern applies: every reverse
direction (admin → outbound-mail) is still forbidden.

**Forbidden — a reviewer must block on any of these:**

- Domain code importing infrastructure. Domain depends only on `platform/` and `contracts/`.
- A module importing Hono, a Cloudflare `Request`/`Env` object, or a **provider SDK directly**.
  Modules call integrations through the `OutboundProviderAdapter` interface declared in
  `packages/contracts`. Adapters live in `integrations/providers/*` and own the SDK calls.
  (This is what the `integrations/providers/*` entries in the allowed table mean: a module may
  import an *adapter*, not an SDK.)
- `integrations/*` importing from `modules/*` (reverse direction).
- `modules/messages` importing `inbound-mail` or `outbound-mail` (reverse direction).
- Importing anything but a module's `index.ts`. Internal layout is private.
- Drizzle row types crossing a module boundary. Cross-boundary types come from `contracts`.
- A route handler calling a service or repository directly. Routes validate input and call **one**
  use case.
- Authorization checks inside repositories or services. They belong at route entry
  (`requirePermission(key)`) and use-case entry (`mailboxes.assertCan(...)`).

## Bounded contexts

`Identity` · `Onboarding` · `Tenancy` · `Messages` · `Inbound Mail` · `Outbound Mail` ·
`Administration`.

Ownership that agents get wrong: **mailbox identity is Tenancy, not Identity.** **Provider
connections and webhook processing are Outbound Mail, not Administration.** **Roles, permissions,
settings and audit are Administration.**

## Persistence ownership

A table has exactly one owning module. Cross-module reads go through the owner's public interface.

| Owner | Tables |
|---|---|
| identity | `users`, `sessions`, `idempotency_records` |
| onboarding | `installation_state`, `registration_keys` |
| tenancy | `managed_domains`, `signatures`, `mailboxes`, `mailbox_members` |
| messages | `messages`, `message_recipients`, `mailbox_messages`, `message_user_state`, `message_attachments`, `attachment_uploads`, `drafts` |
| outbound | `outbound_jobs`, `provider_connections`, `encrypted_credentials`, `webhook_deliveries`, `provider_message_state`, `webhook_events` |
| admin | `roles`, `permissions`, `role_permissions`, `user_roles`, `system_settings`, `audit_events`, `maintenance_jobs`, `blocklist_entries`, `role_policies` |

## API conventions

- Base path `/api/v1`. Resources are nouns; actions are sub-resources
  (`POST /api/v1/messages/send`, `PATCH /api/v1/messages/:id/read`).
- `PUT` only for `If-Match` optimistic concurrency on drafts.
- Success envelope `{ "data": T }`. Error envelope
  `{ "error": { "code", "message", "requestId" } }` with a **stable** machine-readable `code`.
- Status mapping: validation 400 · authn 401 · authz 403 · not found 404 · state conflict /
  idempotency reuse 409 · size limit 413 · rate limit 429 · provider failure 502 · lock contention 503.
- Headers: `Authorization: Bearer <accessToken>` on all non-public routes;
  `Idempotency-Key: <uuid>` on **all** mutating routes; `If-Match: <updatedAt>` on draft
  update/send; `Accept-Language: en | zh`.
- Pagination is cursor-based. The cursor encodes `(created_at, id)` and is HMAC-signed. Response
  `{ "data": { "items": [...], "nextCursor": string | null } }`. Offset pagination is forbidden.
- Webhooks: `POST /api/v1/webhooks/:providerKey/:connectionId`. **Signature verification runs
  before JSON parse.**
- While `installation_state.status !== 'complete'`, every non-`/setup` route 302s to `/setup`.

## Legacy anti-patterns — never reproduce

Each of these exists in the legacy system and is a blocking review finding here:

- Single-round SHA-256 password hashing; non-constant-time compare.
- String-concatenated SQL (legacy `public-service.addUser` injection).
- Plaintext API keys in a settings table.
- A god-object settings table (legacy `setting` had 57 columns) queried from every layer.
- JSON blobs in text columns. The new schema is relational.
- Two parallel sources of authorization truth; prefix-matched permission routes.
- A 300-line "send" function that is three services in one.
- Provider SDKs imported directly into a use case.
- A second web client. There is exactly one, in `apps/web/`.
- Zustand (or any store) used as an event bus. Server state invalidation is TanStack Query's job.
- `document.execCommand` in place of a real editor instance.

## Deliberately not building

Microservices · a general event bus (Kafka/NATS) · separate CQRS read/write models · a generic
plugin system · dynamic configuration · an external workflow engine · multi-tenant isolation beyond
per-deployment boundaries. If you think you need one, that is an ADR, not a commit.
