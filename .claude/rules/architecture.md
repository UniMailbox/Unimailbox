# Architecture rules

The current [module boundaries](../../docs/rebuild/05-target-architecture/module-boundaries.md)
own the dependency table. [API conventions](../../docs/rebuild/05-target-architecture/api-design.md)
own transport details. This file records the constraints to enforce in changes.

## Shape

One Cloudflare Worker, four entrypoints (HTTP, inbound email, Queue, scheduled),
and one React/Vite client. D1 owns relational state, R2 owns file bytes, Queue
drives outbound work, and KV holds temporary setup/cache/access-token data.
D1 sessions remain authentication authority. Do not add a mailbox Durable Object
without the evidence and decision required by document 14.

`apps/worker/src/app-context.ts` is the composition root. Modules expose their
public API through `index.ts`. Pure email functions live in `packages/email-core`;
shared transport types and integration interfaces live in `packages/contracts`.
SQL migrations and their verification files are deployable schema authority.

## Dependency direction

- Modules do not import HTTP handlers, entrypoints, Hono or provider SDKs.
- Integrations do not import modules, HTTP handlers or entrypoints.
- Cross-module consumers use the owning module's public entry point or a shared
  contract wired through the composition root. Internal files remain private.
- Messages do not depend on inbound-mail or outbound-mail. Do not introduce cycles.
- The admin module may use outbound-mail's public connection management API.
  Outbound-mail's audit writes use `AuditEventWriter` from contracts; they do not
  import admin directly. This distinction prevents the reverse import cycle.
- HTTP routes validate, authenticate and authorize transport input, then call
  public module operations. Atomic business writes belong in the use case.
  Do not inline private repository logic in routes.
- Mailbox access must also be checked at use-case entry against the target
  resource. Global administration does not grant private message access.

ESLint enforces layer restrictions; it does not enforce every module pair. Review
new edges against the canonical table and document a deliberate boundary change.

## Ownership and delivery

Identity owns users/sessions; tenancy owns domains, mailboxes and memberships;
signatures owns signatures; editor-assets owns uploads and durable usages.
Provider connections and jobs belong to outbound-mail. Roles, permissions,
settings and audit belong to admin. Shared idempotency helpers live in platform.
Do not copy persistence authority into another module or into R2/KV.

Brevo is the currently registered outbound/webhook adapter. SMTP, Resend and
Cloudflare-send adapters are future extensions, not shipped integrations.
Use the provider registry and its neutral contracts for additions.

## Legacy anti-patterns — never reproduce

Use parameterized SQL, encrypted provider credentials, constant-time secret
comparison, stable error codes, durable outbox and atomic audit/idempotency writes
where the operation requires them. Keep authorization and state transitions
explicit. Use the shared rich editor rather than `document.execCommand`; use
TanStack Query invalidation for server state rather than a store as an event bus.

Do not add a second web client, microservices, a generic event bus, external
workflow engine or speculative abstraction without an accepted design decision.
